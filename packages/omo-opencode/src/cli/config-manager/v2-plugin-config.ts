import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

import {
  LEGACY_PLUGIN_NAME,
  PLUGIN_NAME,
  getOpenCodeConfigDir,
  parseJsonc,
} from "../../shared"
import { writeFileAtomically } from "../../shared/write-file-atomically"
import { isOurFilePluginEntry } from "../doctor/checks/tui-plugin-config"

/**
 * OpenCode 2 splits its configuration in two files:
 *
 * - `opencode.json` → `plugins: [{ package }]` — what the *server* loads.
 * - `cli.json`     → `plugins: ["<spec>"]`   — what the *TUI* host loads, and the only way the
 *   sidebar/prompt-footer slots of this plugin are reachable for a V2 user.
 *
 * V1 config (`plugin: [...]` in `opencode.json`, TUI in `tui.json`) is written by
 * `add-plugin-to-opencode-config.ts` / `add-tui-plugin-to-tui-config.ts` and is untouched here.
 */
export type V2PluginEntry = { package: string }

export type EnsureV2CliPluginEntryResult = {
  readonly changed: boolean
  readonly reason: "added" | "already-present" | "malformed" | "no-entry"
}

const OUR_PLUGIN_NAMES = [PLUGIN_NAME, LEGACY_PLUGIN_NAME] as const

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/")
}

/** `oh-my-openagent@5.1.48` -> `oh-my-openagent`; `file:/a/b` stays as it is. */
export function pluginSpecName(spec: string): string {
  const normalized = normalizeSlashes(spec.trim())
  if (normalized.startsWith("file:")) return normalized
  const versionSeparator = normalized.lastIndexOf("@")
  if (versionSeparator <= 0) return normalized
  return normalized.slice(0, versionSeparator)
}

export function isOurPluginSpec(spec: unknown): spec is string {
  if (typeof spec !== "string" || spec.length === 0) return false
  const name = pluginSpecName(spec)
  if ((OUR_PLUGIN_NAMES as readonly string[]).includes(name)) return true
  if (name.startsWith("file:") && isOurFilePluginEntry(name)) return true
  return false
}

function entrySpec(entry: unknown): string | null {
  if (typeof entry === "string") return entry
  if (entry && typeof entry === "object" && !Array.isArray(entry)) {
    const packageSpec = (entry as { package?: unknown }).package
    if (typeof packageSpec === "string") return packageSpec
  }
  return null
}

export function isOurV2PluginEntry(entry: unknown): boolean {
  const spec = entrySpec(entry)
  return spec !== null && isOurPluginSpec(spec)
}

export function toV2PluginEntry(spec: string): V2PluginEntry {
  return { package: spec }
}

/** Every package spec the V2 server config declares, in declaration order. */
export function readV2PluginSpecs(config: Record<string, unknown>): string[] {
  const plugins = config.plugins
  if (!Array.isArray(plugins)) return []
  const specs: string[] = []
  for (const entry of plugins) {
    const spec = entrySpec(entry)
    if (spec !== null) specs.push(spec)
  }
  return specs
}

/** The first entry of ours in a V2 server config, as the raw spec string. */
export function findOurV2PluginSpec(config: Record<string, unknown>): string | null {
  return readV2PluginSpecs(config).find(isOurPluginSpec) ?? null
}

/**
 * `plugins` (V2) is written; our entries are also dropped from the V1 `plugin` key when a config
 * carries both, so a migrated config cannot load this plugin twice.
 */
export function withV2PluginEntry(
  config: Record<string, unknown>,
  spec: string,
): { config: Record<string, unknown>; plugins: V2PluginEntry[] } {
  const existing = Array.isArray(config.plugins) ? config.plugins : []
  const foreign = existing.filter((entry) => !isOurV2PluginEntry(entry))
  const plugins = [...foreign.map((entry) => entry as V2PluginEntry), toV2PluginEntry(spec)]

  const next: Record<string, unknown> = { ...config, plugins }

  if (Array.isArray(config.plugin)) {
    const remaining = config.plugin.filter((entry) => {
      const name = typeof entry === "string" ? entry : Array.isArray(entry) ? entry[0] : null
      return typeof name !== "string" || !isOurPluginSpec(name)
    })
    if (remaining.length === config.plugin.length) {
      // Nothing of ours in the V1 key: keep it exactly as the user wrote it.
    } else if (remaining.length === 0) {
      delete next.plugin
    } else {
      next.plugin = remaining
    }
  }

  return { config: next, plugins }
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = parseJsonc<unknown>(readFileSync(path, "utf-8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  return null
}

/**
 * Idempotently adds our entry to `cli.json` (`plugins: [spec]`), which is what makes the plugin's
 * `./tui` export — and so the sidebar — reachable in OpenCode 2. Foreign entries keep their order
 * and shape; a config that is not an object, or whose `plugins` is not an array, is left alone.
 */
export function ensureV2CliPluginEntry(opts: { configDir?: string; entry?: string } = {}): EnsureV2CliPluginEntryResult {
  const entry = opts.entry?.trim()
  if (!entry) return { changed: false, reason: "no-entry" }

  const configDir = opts.configDir ?? getOpenCodeConfigDir({ binary: "opencode", version: null })
  const cliJsonPath = join(configDir, "cli.json")

  const existingConfig = existsSync(cliJsonPath) ? readJsonObject(cliJsonPath) : {}
  if (existingConfig === null) return { changed: false, reason: "malformed" }
  if (existingConfig.plugins !== undefined && !Array.isArray(existingConfig.plugins)) {
    return { changed: false, reason: "malformed" }
  }

  const existingPlugins = Array.isArray(existingConfig.plugins) ? existingConfig.plugins : []
  const foreign = existingPlugins.filter((candidate) => !isOurV2PluginEntry(candidate))
  const isOnlyOurEntry =
    existingPlugins.length === foreign.length + 1 && existingPlugins.some((candidate) => {
      const spec = entrySpec(candidate)
      return spec !== null && isOurPluginSpec(spec)
    })
  if (isOnlyOurEntry && entrySpec(existingPlugins.find(isOurV2PluginEntry)) === entry) {
    return { changed: false, reason: "already-present" }
  }

  writeFileAtomically(
    cliJsonPath,
    `${JSON.stringify({ ...existingConfig, plugins: [...foreign, entry] }, null, 2)}\n`,
  )
  return { changed: true, reason: "added" }
}
