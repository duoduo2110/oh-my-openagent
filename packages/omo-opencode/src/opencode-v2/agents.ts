/**
 * S3a: materialize the ten built-in agents as markdown that OpenCode V2 discovers.
 *
 * Why files: V2's `agent.transform` has no `add()` — it can only edit agents that already exist.
 * A new agent has to be a markdown file (`<dir>/.opencode/agent/<name>.md`) or a config entry.
 *
 * What is reused: the V1 factories, through the same assembly the V1 `agent-config-handler` runs
 * (`createBuiltinAgents` + `maybeCreateAtlasConfig` + `createSisyphusJuniorAgentWithOverrides`).
 * Prompts are never re-authored here, so V1 and V2 cannot drift; only the transport differs.
 *
 * What is deliberately NOT done (S3b): model-specific prompt sections re-rendered per session. The
 * file carries the base prompt the factory produced for the resolved model, and says so in its
 * header, so a later `session.hook("context")` stage can rebuild the model-specific tail.
 *
 * Discovery, measured on V2.1.4 (`/api/agent`):
 *   - `~/.config/opencode/agent/<name>.md`  → always discovered (global scope).
 *   - `<location>/.opencode/agent/<name>.md` → discovered when the location is a real project
 *     (git worktree root); it WINS over the global file of the same name.
 *   - Files are picked up without a host restart or `/api/location/reload`.
 * Default scope is `global`: the project directory belongs to the user's repository (`.gitignore`
 * in this repo protects nothing in *their* project), so writing there by default would leave ten
 * untracked files in every location the plugin is opened in. `OMO_V2_AGENT_SCOPE=project` opts back
 * in; a global directory that cannot be written falls back to the project scope with a warning
 * instead of failing setup.
 */
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { AgentConfig } from "@opencode-ai/sdk"
import type { Context } from "@opencode/plugin/promise/plugin"

import { createBuiltinAgents } from "../agents/builtin-agents"
import { maybeCreateAtlasConfig } from "../agents/builtin-agents/atlas-agent"
import { getFirstFallbackModel } from "../agents/builtin-agents/model-resolution"
import { createAtlasAgent } from "../agents/atlas"
import { createSisyphusJuniorAgentWithOverrides, SISYPHUS_JUNIOR_DEFAULTS } from "../agents/sisyphus-junior"
import type { OhMyOpenCodeConfig } from "../config"
import { loadPluginConfig } from "../plugin-config"
import { AGENT_MODEL_REQUIREMENTS } from "../shared/model-requirements"
import { migrateDisabledAgents } from "../shared/disabled-agents"
import { mergeCategories } from "../shared/merge-categories"
import { isTaskSystemEnabled } from "../shared/task-system-enabled"
import { log } from "../shared/logger"
import { isManagedAgentMarkdown, renderAgentMarkdown } from "./agents/agent-markdown"
import {
  overlaysForAgent,
  resolveAgentToolPermissionOverlay,
  withToolPermissionOverlay,
} from "./config-domains/agent-tool-overlay"

export const AGENTS_LOG_PREFIX = "[omo-v2-agents]"

/** The ten built-in agents, in V1 registration order (`src/agents/types.ts` BuiltinAgentName). */
export const V2_BUILTIN_AGENT_NAMES = [
  "sisyphus",
  "hephaestus",
  "oracle",
  "librarian",
  "explore",
  "multimodal-looker",
  "metis",
  "momus",
  "atlas",
  "sisyphus-junior",
] as const

export type V2BuiltinAgentName = (typeof V2_BUILTIN_AGENT_NAMES)[number]

export type V2AgentScope = "project" | "global"

export const V2_AGENT_SCOPE_ENV = "OMO_V2_AGENT_SCOPE"

/**
 * `global` unless `OMO_V2_AGENT_SCOPE=project`: the project directory belongs to the user's
 * repository, so the opt-in is the scope that writes there.
 */
export function resolveV2AgentScope(env: NodeJS.ProcessEnv = process.env): V2AgentScope {
  return env[V2_AGENT_SCOPE_ENV]?.trim().toLowerCase() === "project" ? "project" : "global"
}

/** `$XDG_CONFIG_HOME/opencode/agent` (the directory V2 itself scans for global agents). */
export function globalAgentDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const configHome = env["XDG_CONFIG_HOME"]?.trim()
  const base = configHome !== undefined && configHome.length > 0
    ? configHome
    : path.join(env["HOME"] ?? os.homedir(), ".config")
  return path.join(base, "opencode", "agent")
}

/** `<location>/.opencode/agent` — project scope, next to the config V2 reads for that location. */
export function projectAgentDirectory(locationDirectory: string): string {
  return path.join(locationDirectory, ".opencode", "agent")
}

/**
 * Proves the directory can actually receive a file. Permission bits alone are not enough (the
 * e2e container runs as root, where a read-only directory still accepts writes), so the check
 * writes and removes a probe file.
 */
function ensureWritableDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true })
  const probe = path.join(directory, `.omo-write-probe-${process.pid}`)
  fs.writeFileSync(probe, "", "utf8")
  fs.unlinkSync(probe)
}

export type V2AgentScopeResolution = {
  /** The scope actually used; `project` when the global directory is unusable. */
  readonly scope: V2AgentScope
  readonly directory: string
  readonly warnings: readonly string[]
}

/**
 * Resolves the scope to a directory and degrades `global` -> `project` when the global agent
 * directory cannot be written (`XDG_CONFIG_HOME` on a read-only mount, a regular file in place of
 * the directory, ...). A degraded scope is reported, never silently swapped.
 */
export function resolveAgentScopeDirectory(input: {
  readonly locationDirectory: string
  readonly scope?: V2AgentScope
  readonly env?: NodeJS.ProcessEnv
}): V2AgentScopeResolution {
  const scope = input.scope ?? resolveV2AgentScope(input.env)
  const project = projectAgentDirectory(input.locationDirectory)
  if (scope === "project") {
    return { scope, directory: project, warnings: [] }
  }

  const global = globalAgentDirectory(input.env)
  try {
    ensureWritableDirectory(global)
    return { scope: "global", directory: global, warnings: [] }
  } catch (error) {
    const warning = `global agent directory ${global} is not writable (${String(error)}); falling back to project scope ${project}`
    log(`${AGENTS_LOG_PREFIX} scope fallback`, { requested: "global", used: "project", global, project })
    return { scope: "project", directory: project, warnings: [warning] }
  }
}

function agentDirectory(scope: V2AgentScope, locationDirectory: string, env?: NodeJS.ProcessEnv): string {
  return scope === "global" ? globalAgentDirectory(env) : projectAgentDirectory(locationDirectory)
}

export type V2AgentStorage = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
  readonly remove: (key: string) => Promise<void>
}

export type V2AgentFileAction = "written" | "skipped" | "removed" | "missing"

export type V2AgentFileEntry = {
  readonly name: string
  readonly mode: string
  readonly model?: string
  readonly file: string
  readonly action: V2AgentFileAction
}

export type V2AgentMaterializationReport = {
  readonly scope: V2AgentScope
  readonly directory: string
  readonly written: readonly string[]
  readonly skipped: readonly string[]
  readonly removed: readonly string[]
  readonly missing: readonly string[]
  readonly warnings: readonly string[]
  readonly agents: readonly V2AgentFileEntry[]
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex")
}

function storageKey(scope: V2AgentScope, name: string): string {
  return `v2-agents/${scope}/${name}`
}

function readTextIfExists(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8")
  } catch {
    return undefined
  }
}

function writeAtomically(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.omo.tmp`
  fs.writeFileSync(temporary, content, "utf8")
  try {
    fs.renameSync(temporary, filePath)
  } catch (error) {
    try {
      fs.unlinkSync(temporary)
    } catch {
      // best effort: the rename failure is the error worth reporting
    }
    throw error
  }
}

/**
 * Reads the models the host can actually serve. V2 exposes no read-only list on the promise API,
 * so the list is captured from a pass-through transform. An empty list means "no providers
 * configured" — writing any `provider/model` then would point at a model the host cannot load.
 */
async function readHostModels(context: Context): Promise<readonly string[]> {
  const models: string[] = []
  await context.model.transform((editor) => {
    for (const model of editor.list()) models.push(`${String(model.providerID)}/${String(model.id)}`)
  })
  return models
}

function pickModel(
  name: string,
  config: AgentConfig,
  hostModels: readonly string[] | undefined,
  warnings: string[],
): string | undefined {
  const resolved = (config as { model?: unknown }).model
  if (typeof resolved !== "string" || resolved.length === 0) {
    warnings.push(`${name}: V1 model chain resolved no model; writing the file without \`model\``)
    return undefined
  }
  if (hostModels === undefined) {
    warnings.push(`${name}: host model list unavailable; omitting \`model\` (${resolved})`)
    return undefined
  }
  if (hostModels.length === 0) {
    warnings.push(`${name}: host has no configured models; omitting \`model\` (${resolved})`)
    return undefined
  }
  if (!hostModels.includes(resolved)) {
    warnings.push(`${name}: \`${resolved}\` is not in the host model list; omitting \`model\``)
    return undefined
  }
  return resolved
}

export type MaterializeAgentMarkdownsArgs = {
  /** `ctx.location.directory` of the host. */
  readonly locationDirectory: string
  readonly scope: V2AgentScope
  readonly agents: ReadonlyMap<string, AgentConfig>
  readonly disabled?: readonly string[]
  /** Models the host can serve; `undefined` = unknown (write no model). */
  readonly hostModels?: readonly string[]
  readonly storage?: V2AgentStorage
  readonly env?: NodeJS.ProcessEnv
}

/**
 * Writes (or leaves untouched) one markdown file per agent, and deletes the file of every agent
 * that `disabled_agents` turned off. Idempotent: identical content is never rewritten, so a second
 * `setup` reports `skipped` for every agent.
 */
export async function materializeAgentMarkdowns(args: MaterializeAgentMarkdownsArgs): Promise<V2AgentMaterializationReport> {
  const { locationDirectory, scope, agents, hostModels, storage, env } = args
  const disabled = new Set((args.disabled ?? []).map((name) => name.toLowerCase()))
  const directory = agentDirectory(scope, locationDirectory, env)
  const warnings: string[] = []
  const written: string[] = []
  const skipped: string[] = []
  const removed: string[] = []
  const missing: string[] = []
  const entries: V2AgentFileEntry[] = []

  for (const name of V2_BUILTIN_AGENT_NAMES) {
    if (disabled.has(name)) continue
    const config = agents.get(name)
    if (config === undefined) {
      missing.push(name)
      entries.push({ name, mode: "unknown", file: path.join(directory, `${name}.md`), action: "missing" })
      continue
    }

    const model = pickModel(name, config, hostModels, warnings)
    const content = renderAgentMarkdown(config, {
      name,
      ...(model === undefined ? {} : { model }),
      onUnsupported: (key, reason) => warnings.push(`${name}: ${key} ${reason}`),
    })
    const file = path.join(directory, `${name}.md`)
    const mode = String((config as { mode?: unknown }).mode ?? "subagent")

    if (readTextIfExists(file) === content) {
      skipped.push(name)
      entries.push({ name, mode, ...(model === undefined ? {} : { model }), file, action: "skipped" })
    } else {
      writeAtomically(file, content)
      written.push(name)
      entries.push({ name, mode, ...(model === undefined ? {} : { model }), file, action: "written" })
    }

    log(`${AGENTS_LOG_PREFIX} file`, {
      name,
      action: entries[entries.length - 1]?.action,
      mode,
      model: model ?? null,
      file,
      hash: sha256(content),
    })

    if (storage !== undefined) {
      await storage.set(storageKey(scope, name), {
        hash: sha256(content),
        file,
        scope,
        mode,
        model: model ?? null,
        writtenAt: new Date().toISOString(),
      }).catch((error: unknown) => {
        warnings.push(`${name}: could not persist the content hash (${String(error)})`)
      })
    }
  }

  // Only files this plugin generated are removed; a user-authored `<name>.md` stays.
  for (const name of V2_BUILTIN_AGENT_NAMES) {
    if (!disabled.has(name)) continue
    for (const candidateScope of ["project", "global"] as const) {
      const file = path.join(agentDirectory(candidateScope, locationDirectory, env), `${name}.md`)
      const existing = readTextIfExists(file)
      if (existing === undefined || !isManagedAgentMarkdown(existing, name)) continue
      try {
        fs.unlinkSync(file)
        removed.push(name)
        log(`${AGENTS_LOG_PREFIX} removed`, { name, scope: candidateScope, file })
      } catch (error) {
        warnings.push(`${name}: could not remove ${file} (${String(error)})`)
      }
    }
    if (storage !== undefined) {
      await storage.remove(storageKey(scope, name)).catch(() => undefined)
    }
  }

  return { scope, directory, written, skipped, removed, missing, warnings, agents: entries }
}

export type BuiltinAgentConfigArgs = {
  readonly directory: string
  readonly pluginConfig: Partial<OhMyOpenCodeConfig>
}

/**
 * Builds the same ten configs the V1 handler registers, including the two that `createBuiltinAgents`
 * leaves to its caller (Atlas needs an orchestrator context; Sisyphus-Junior inherits Atlas' model).
 */
export async function buildBuiltinAgentConfigs(
  args: BuiltinAgentConfigArgs,
): Promise<{ agents: Map<string, AgentConfig>; warnings: string[] }> {
  const { directory, pluginConfig } = args
  const warnings: string[] = []
  const disabled = migrateDisabledAgents(pluginConfig.disabled_agents)
  const overrides = pluginConfig.agents ?? {}
  const useTaskSystem = isTaskSystemEnabled(pluginConfig)
  const disableOmoEnv = pluginConfig.experimental?.disable_omo_env ?? false
  const browserProvider = pluginConfig.browser_automation_engine?.provider ?? "playwright"
  const mergedCategories = mergeCategories(pluginConfig.categories)
  const isDisabled = (name: string): boolean => disabled.some((entry) => entry.toLowerCase() === name)

  const built = await createBuiltinAgents(
    disabled,
    overrides,
    directory,
    undefined,
    pluginConfig.categories,
    pluginConfig.git_master,
    [],
    undefined,
    browserProvider,
    undefined,
    new Set(pluginConfig.disabled_skills ?? []),
    useTaskSystem,
    disableOmoEnv,
    pluginConfig.team_mode?.enabled ?? false,
  )
  const agents = new Map<string, AgentConfig>(Object.entries(built))

  if (!isDisabled("atlas") && !agents.has("atlas")) {
    // Cold host (no model list, no system default): `maybeCreateAtlasConfig` refuses to resolve,
    // exactly as it would in V1. Atlas still has a model requirement chain, so materialize it from
    // that chain instead of dropping an agent the user expects to exist.
    const fromHandler = maybeCreateAtlasConfig({
      disabledAgents: disabled,
      agentOverrides: overrides,
      availableModels: new Set<string>(),
      availableAgents: [],
      availableSkills: [],
      mergedCategories,
      directory,
      ...(pluginConfig.categories === undefined ? {} : { userCategories: pluginConfig.categories }),
      useTaskSystem,
    })
    const fallbackModel = getFirstFallbackModel(AGENT_MODEL_REQUIREMENTS["atlas"])?.model
      ?? SISYPHUS_JUNIOR_DEFAULTS.model
    const atlas = fromHandler ?? createAtlasAgent({
      model: fallbackModel,
      ...(pluginConfig.categories === undefined ? {} : { userCategories: pluginConfig.categories }),
    })
    warnings.push(`atlas: model resolution fell back to ${String((atlas as { model?: string }).model)}`)
    agents.set("atlas", atlas)
  }

  if (!isDisabled("sisyphus-junior")) {
    const atlasModel = (agents.get("atlas") as { model?: string } | undefined)?.model
    agents.set(
      "sisyphus-junior",
      createSisyphusJuniorAgentWithOverrides(
        overrides["sisyphus-junior"],
        atlasModel,
        useTaskSystem,
      ),
    )
  }

  const ordered = new Map<string, AgentConfig>()
  // S3b: the V1 `tools` / `permission` switches have no V2 domain; they ride on the agent
  // markdown frontmatter instead. Only explicitly configured entries are folded in.
  const overlay = resolveAgentToolPermissionOverlay(pluginConfig)
  for (const name of V2_BUILTIN_AGENT_NAMES) {
    if (isDisabled(name)) continue
    const config = agents.get(name)
    if (config === undefined) {
      warnings.push(`${name}: no config was produced (disabled or dropped by its model requirement)`)
      continue
    }
    const overlays = overlaysForAgent(overlay, name)
    const merged = withToolPermissionOverlay(config, overlays)
    if (merged !== config) {
      log(`${AGENTS_LOG_PREFIX} tools/permission overlay`, {
        agent: name,
        overlays: overlays.map((entry) => ({ tools: entry.tools, permission: entry.permission, renames: entry.renames })),
      })
    }
    ordered.set(name, merged)
  }
  return { agents: ordered, warnings }
}

/**
 * Entry point called from the V2 `setup`. Reads the plugin config for this location, writes the ten
 * agent files, deletes the files of disabled agents, then makes Sisyphus the default agent.
 */
export async function materializeOpenCodeV2Agents(context: Context): Promise<V2AgentMaterializationReport> {
  const locationDirectory = String(context.location.directory)
  const scopeResolution = resolveAgentScopeDirectory({ locationDirectory })
  const scope = scopeResolution.scope
  const warnings: string[] = [...scopeResolution.warnings]
  let report: V2AgentMaterializationReport

  try {
    const pluginConfig = loadPluginConfig(locationDirectory, context)
    const { agents, warnings: buildWarnings } = await buildBuiltinAgentConfigs({ directory: locationDirectory, pluginConfig })
    warnings.push(...buildWarnings)

    let hostModels: readonly string[] | undefined
    try {
      hostModels = await readHostModels(context)
    } catch (error) {
      warnings.push(`host model list unavailable: ${String(error)}`)
    }

    report = await materializeAgentMarkdowns({
      locationDirectory,
      scope,
      agents,
      disabled: migrateDisabledAgents(pluginConfig.disabled_agents),
      ...(hostModels === undefined ? {} : { hostModels }),
      storage: context.storage as unknown as V2AgentStorage,
    })
    warnings.push(...report.warnings)
  } catch (error) {
    warnings.push(`materialization failed: ${String(error)}`)
    log(`${AGENTS_LOG_PREFIX} failed`, { error: String(error), locationDirectory, scope })
    return {
      scope,
      directory: agentDirectory(scope, locationDirectory),
      written: [],
      skipped: [],
      removed: [],
      missing: [...V2_BUILTIN_AGENT_NAMES],
      warnings,
      agents: [],
    }
  }

  const sisyphusMaterialized = report.agents.some(
    (entry) => entry.name === "sisyphus" && (entry.action === "written" || entry.action === "skipped"),
  )
  if (sisyphusMaterialized) {
    try {
      await context.agent.transform((editor) => {
        if (editor.get("sisyphus") !== undefined) editor.default("sisyphus")
      })
    } catch (error) {
      warnings.push(`could not set sisyphus as the default agent: ${String(error)}`)
    }
  } else {
    warnings.push("sisyphus is disabled or missing; the host keeps its own default agent")
  }

  log(`${AGENTS_LOG_PREFIX} summary`, {
    scope: report.scope,
    directory: report.directory,
    written: report.written,
    skipped: report.skipped,
    removed: report.removed,
    missing: report.missing,
    agents: report.agents,
    warnings,
  })

  return { ...report, warnings }
}
