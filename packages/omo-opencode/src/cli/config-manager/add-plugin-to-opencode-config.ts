import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { applyEdits, modify } from "jsonc-parser"
import type { ConfigMergeResult } from "../types"
import {
  PLUGIN_NAME,
  LEGACY_PLUGIN_NAME,
  getPluginEntryName,
  withPluginEntryName,
  type PluginEntry,
} from "../../shared"
import { isOpenCodeV2Host } from "./v2-host"
import { backupConfigFile } from "./backup-config"
import { getConfigDir } from "./config-context"
import { ensureConfigDirectoryExists } from "./ensure-config-directory-exists"
import { formatErrorWithSuggestion } from "./format-error-with-suggestion"
import { detectConfigFormat, type ConfigFormat } from "./opencode-config-format"
import { parseOpenCodeConfigFileWithError, type OpenCodeConfig } from "./parse-opencode-config-file"
import { getPluginNameWithVersion } from "./plugin-name-with-version"
import { ensureV2CliPluginEntry, findOurV2PluginSpec, withV2PluginEntry } from "./v2-plugin-config"
import { checkVersionCompatibility, extractVersionFromPluginEntry } from "./version-compatibility"

type ConfigTarget = {
  readonly format: ConfigFormat
  readonly path: string
  readonly primary: boolean
}

/** A write also reports the spec that ended up in the config, so `cli.json` can reuse it. */
type TargetWrite = {
  readonly result: ConfigMergeResult
  readonly entrySpec: string | null
}

function detectConfigFormatInDir(configDir: string): { readonly format: ConfigFormat; readonly path: string } {
  const configJsonc = join(configDir, "opencode.jsonc")
  const configJson = join(configDir, "opencode.json")

  if (existsSync(configJsonc)) {
    return { format: "jsonc", path: configJsonc }
  }
  if (existsSync(configJson)) {
    return { format: "json", path: configJson }
  }
  return { format: "none", path: configJson }
}

function getParentConfigDirForProfile(configDir: string): string | null {
  const parentDir = dirname(configDir)
  if (basename(parentDir) !== "profiles") return null
  return dirname(parentDir)
}

function listProfileConfigDirs(rootConfigDir: string): string[] {
  const profilesDir = join(rootConfigDir, "profiles")
  if (!existsSync(profilesDir)) return []

  return readdirSync(profilesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(profilesDir, entry.name))
    .filter((profileDir) => detectConfigFormatInDir(profileDir).format !== "none")
}

function getConfigTargets(): ConfigTarget[] {
  const primaryConfigDir = getConfigDir()
  const rootConfigDir = getParentConfigDirForProfile(primaryConfigDir) ?? primaryConfigDir
  const targetDirs = new Set<string>([primaryConfigDir])

  if (rootConfigDir !== primaryConfigDir && detectConfigFormatInDir(rootConfigDir).format !== "none") {
    targetDirs.add(rootConfigDir)
  }

  for (const profileConfigDir of listProfileConfigDirs(rootConfigDir)) {
    targetDirs.add(profileConfigDir)
  }

  return Array.from(targetDirs).map((configDir) => {
    const detected = detectConfigFormatInDir(configDir)
    return {
      ...detected,
      primary: configDir === primaryConfigDir,
    }
  })
}

function isSourceOmoPluginEntry(plugin: PluginEntry): boolean {
  const normalized = getPluginEntryName(plugin).toLowerCase().replaceAll("\\", "/")
  if (!normalized.startsWith("file://")) return false

  return /\/(omo(?:-[^/]*)?|oh-my-opencode|oh-my-openagent)\/(src|dist)\/index\.(ts|js)$/.test(normalized)
}

function isPackageOmoPluginEntry(plugin: PluginEntry): boolean {
  const name = getPluginEntryName(plugin)
  return name === PLUGIN_NAME || name.startsWith(`${PLUGIN_NAME}@`) ||
    name === LEGACY_PLUGIN_NAME || name.startsWith(`${LEGACY_PLUGIN_NAME}@`)
}

function isOurPlugin(plugin: PluginEntry): boolean {
  return isPackageOmoPluginEntry(plugin) || isSourceOmoPluginEntry(plugin)
}

function findOurPluginEntry(plugins: readonly PluginEntry[]): PluginEntry | undefined {
  return plugins.find(isOurPlugin)
}

function findSourcePluginEntryInTarget(target: ConfigTarget): PluginEntry | null {
  if (target.format === "none") return null

  const parseResult = parseOpenCodeConfigFileWithError(target.path)
  const plugins = parseResult.config?.plugin ?? []
  return plugins.find(isSourceOmoPluginEntry) ?? null
}

function choosePluginEntry(params: {
  readonly existingEntry: PluginEntry | undefined
  readonly fallbackEntry: string
  readonly preferredSourceEntry: PluginEntry | null
}): PluginEntry {
  if (params.existingEntry && isSourceOmoPluginEntry(params.existingEntry)) {
    return params.existingEntry
  }
  if (params.preferredSourceEntry) {
    return params.preferredSourceEntry
  }
  if (params.existingEntry) {
    return withPluginEntryName(params.existingEntry, params.fallbackEntry)
  }
  return params.fallbackEntry
}

function writePluginEntryToTarget(params: {
  readonly target: ConfigTarget
  readonly currentVersion: string
  readonly fallbackEntry: string
  readonly preferredSourceEntry: PluginEntry | null
}): TargetWrite {
  if (isOpenCodeV2Host()) {
    return writeV2PluginEntryToTarget(params)
  }
  return writeV1PluginEntryToTarget(params)
}

/**
 * OpenCode 2 writes `plugins: [{ package }]` and drops our entry from the V1 `plugin` key, so a
 * config that carries both shapes cannot load this plugin twice. Everything else about the write
 * (backup, version check, foreign entries) matches the V1 path.
 */
function writeV2PluginEntryToTarget(params: {
  readonly target: ConfigTarget
  readonly currentVersion: string
  readonly fallbackEntry: string
  readonly preferredSourceEntry: PluginEntry | null
}): TargetWrite {
  const { target, currentVersion, fallbackEntry, preferredSourceEntry } = params

  try {
    if (target.format === "none") {
      const { config } = withV2PluginEntry({}, fallbackEntry)
      writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n")
      return { result: { success: true, configPath: target.path }, entrySpec: fallbackEntry }
    }

    const parseResult = parseOpenCodeConfigFileWithError(target.path)
    if (!parseResult.config) {
      return {
        result: {
          success: false,
          configPath: target.path,
          error: parseResult.error ?? "Failed to parse config file",
        },
        entrySpec: null,
      }
    }

    const config = parseResult.config as unknown as Record<string, unknown>
    const existingSpec = resolveExistingV2Spec(config)
    const nextEntry = choosePluginEntry({
      existingEntry: existingSpec ?? undefined,
      fallbackEntry,
      preferredSourceEntry,
    })
    const nextSpec = getPluginEntryName(nextEntry)

    if (existingSpec && !preferredSourceEntry) {
      const installedVersion = extractVersionFromPluginEntry(getPluginEntryName(existingSpec))
      const compatibility = checkVersionCompatibility(installedVersion, currentVersion)

      if (!compatibility.canUpgrade) {
        return {
          result: {
            success: false,
            configPath: target.path,
            error: compatibility.reason ?? "Version compatibility check failed",
          },
          entrySpec: null,
        }
      }

      const backupResult = backupConfigFile(target.path)
      if (!backupResult.success) {
        return {
          result: {
            success: false,
            configPath: target.path,
            error: `Failed to create backup: ${backupResult.error}`,
          },
          entrySpec: null,
        }
      }
    }

    const { config: nextConfig, plugins } = withV2PluginEntry(config, nextSpec)

    if (target.format === "jsonc") {
      const content = readFileSync(target.path, "utf-8")
      const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" as const }
      const edits = modify(content, ["plugins"], plugins, { formattingOptions })
      if (Object.hasOwn(config, "plugin")) {
        edits.push(
          ...modify(content, ["plugin"], nextConfig.plugin, {
            formattingOptions,
            getInsertionIndex: () => 0,
          }),
        )
      }
      writeFileSync(target.path, applyEdits(content, edits))
    } else {
      writeFileSync(target.path, JSON.stringify(nextConfig, null, 2) + "\n")
    }

    return { result: { success: true, configPath: target.path }, entrySpec: nextSpec }
  } catch (err) {
    return {
      result: {
        success: false,
        configPath: target.path,
        error: formatErrorWithSuggestion(err, "update opencode config"),
      },
      entrySpec: null,
    }
  }
}

/** Our entry, whether the config already uses the V2 `plugins` key or still carries V1 `plugin`. */
function resolveExistingV2Spec(config: Record<string, unknown>): string | null {
  const v2Spec = findOurV2PluginSpec(config)
  if (v2Spec) return v2Spec

  const v1Plugins = config.plugin
  if (!Array.isArray(v1Plugins)) return null
  const entry = (v1Plugins as PluginEntry[]).find(isOurPlugin)
  return entry ? getPluginEntryName(entry) : null
}

function writeV1PluginEntryToTarget(params: {
  readonly target: ConfigTarget
  readonly currentVersion: string
  readonly fallbackEntry: string
  readonly preferredSourceEntry: PluginEntry | null
}): TargetWrite {
  const { target, currentVersion, fallbackEntry, preferredSourceEntry } = params
  const pluginEntry = choosePluginEntry({
    existingEntry: undefined,
    fallbackEntry,
    preferredSourceEntry,
  })

  try {
    if (target.format === "none") {
      const config: OpenCodeConfig = { plugin: [pluginEntry] }
      writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n")
      return { result: { success: true, configPath: target.path }, entrySpec: getPluginEntryName(pluginEntry) }
    }

    const parseResult = parseOpenCodeConfigFileWithError(target.path)
    if (!parseResult.config) {
      return {
        result: {
          success: false,
          configPath: target.path,
          error: parseResult.error ?? "Failed to parse config file",
        },
        entrySpec: null,
      }
    }

    const config = parseResult.config
    const plugins = config.plugin ?? []
    const existingEntry = findOurPluginEntry(plugins)
    const nextPluginEntry = choosePluginEntry({
      existingEntry,
      fallbackEntry,
      preferredSourceEntry,
    })

    if (existingEntry && !preferredSourceEntry) {
      const installedVersion = extractVersionFromPluginEntry(getPluginEntryName(existingEntry))
      const compatibility = checkVersionCompatibility(installedVersion, currentVersion)

      if (!compatibility.canUpgrade) {
        return {
          result: {
            success: false,
            configPath: target.path,
            error: compatibility.reason ?? "Version compatibility check failed",
          },
          entrySpec: null,
        }
      }

      const backupResult = backupConfigFile(target.path)
      if (!backupResult.success) {
        return {
          result: {
            success: false,
            configPath: target.path,
            error: `Failed to create backup: ${backupResult.error}`,
          },
          entrySpec: null,
        }
      }
    }

    const normalizedPlugins = plugins.filter((plugin) => !isOurPlugin(plugin))
    normalizedPlugins.push(nextPluginEntry)

    config.plugin = normalizedPlugins

    if (target.format === "jsonc") {
      const content = readFileSync(target.path, "utf-8")
      const edits = modify(content, ["plugin"], normalizedPlugins, {
        formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
        getInsertionIndex: () => 0,
      })
      writeFileSync(target.path, applyEdits(content, edits))
    } else {
      writeFileSync(target.path, JSON.stringify(config, null, 2) + "\n")
    }

    return { result: { success: true, configPath: target.path }, entrySpec: getPluginEntryName(nextPluginEntry) }
  } catch (err) {
    return {
      result: {
        success: false,
        configPath: target.path,
        error: formatErrorWithSuggestion(err, "update opencode config"),
      },
      entrySpec: null,
    }
  }
}

export async function addPluginToOpenCodeConfig(currentVersion: string): Promise<ConfigMergeResult> {
  try {
    ensureConfigDirectoryExists()
  } catch (err) {
    return {
      success: false,
      configPath: getConfigDir(),
      error: formatErrorWithSuggestion(err, "create config directory"),
    }
  }

  const primaryTarget = detectConfigFormat()
  const targets = getConfigTargets()
  const preferredSourceEntry = targets
    .map((target) => findSourcePluginEntryInTarget(target))
    .find((entry): entry is PluginEntry => entry !== null) ?? null
  const pluginEntry = await getPluginNameWithVersion(currentVersion, PLUGIN_NAME)

  let primaryResult: ConfigMergeResult | null = null
  const writtenSpecs: { configDir: string; spec: string }[] = []
  for (const target of targets) {
    const { result, entrySpec } = writePluginEntryToTarget({
      target,
      currentVersion,
      fallbackEntry: pluginEntry,
      preferredSourceEntry,
    })

    if (!result.success) return result
    if (entrySpec) {
      writtenSpecs.push({ configDir: dirname(target.path), spec: entrySpec })
    }
    if (target.primary) {
      primaryResult = result
    }
  }

  // OpenCode 2 reads the TUI plugin list from `cli.json`; without it the sidebar/footer slots of
  // this plugin are unreachable even though the server side loaded. V1 keeps using `tui.json`
  // (written by `ensureTuiPluginEntry`), so this branch only runs on a 2.x host.
  if (isOpenCodeV2Host()) {
    for (const { configDir, spec } of writtenSpecs) {
      try {
        ensureV2CliPluginEntry({ configDir, entry: spec })
      } catch {
        // The server config is already written and working; a TUI config that cannot be
        // updated is reported by the caller's own warning path, never as a failed install.
      }
    }
  }

  return primaryResult ?? { success: true, configPath: primaryTarget.path }
}
