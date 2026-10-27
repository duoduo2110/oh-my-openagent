/**
 * V2 tool assembly (S1a A group, S1b B group).
 *
 * A group — tools that only need a directory and a config: `grep`, `glob`, `task_get`, `task_list`
 * and the goal trio (`create_goal` / `update_goal` / `get_goal`). They reuse the V1 factories
 * untouched — the V1 engine files are not modified by the V2 port — and are handed to the bridge in
 * `./tool-bridge`.
 *
 * B group (S1b) — the ten tools that need the V1 runtime graph for their dependencies
 * (`session_*`, `skill`, `skill_mcp`, `look_at`, `task_create`, `task_update`, `interactive_bash`).
 * They are built in `./tools/`, one dependency set per registration, and registered through the same
 * bridge. They are *not* part of `createV2ToolsRecord` (the A record stays the seven names `e2e-s1a`
 * pins); `registerOpenCodeV2Tools` merges the two records for registration only.
 *
 * `edit` is deliberately off by default: the V1 hashline editor has its own validation loop and is
 * not part of the A group, so it stays behind `OMO_V2_ENABLE_EDIT=1` until a later stage.
 *
 * Still not bridged here: task delegation (`task`), background jobs and team/monitor tools — they
 * need managers and a prompt pipeline the V2 port does not expose yet.
 */
import type { PluginInput } from "@opencode-ai/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"

import type { OhMyOpenCodeConfig } from "../config"
import type { ToolsRecord } from "../plugin/types"
import type { V2ContextLike } from "./adapter/types"

import { createGoalController } from "../hooks/goal/controller"
import { createGoalTools } from "../hooks/goal/tools"
import { loadPluginConfig } from "../plugin-config"
import { trimToolsToCap } from "../plugin/tool-registry-trimming"
import { filterDisabledTools } from "../shared/disabled-tools"
import { log } from "../shared/logger"
import { createGlobTools } from "../tools/glob"
import { createHashlineEditTool } from "../tools/hashline-edit"
import { createGrepTools } from "../tools/grep"
import { createTaskGetTool, createTaskList } from "../tools/task"
import {
  BRIDGE_LOG_PREFIX,
  getToolBridgeSessionID,
  registerBridgedTool,
  setToolBridgeDirectory,
  setToolBridgePermission,
  type BridgeRegistrationResult,
  type V2ToolEditorLike,
} from "./tool-bridge"
import {
  V2_GROUP_B_TOOL_NAMES,
  createV2GroupBToolsRecord,
  type V2GroupBSkip,
} from "./tools/index"

/** Always-on A group. `edit` is the optional eighth tool. */
export const V2_GROUP_A_TOOL_NAMES = [
  "grep",
  "glob",
  "task_get",
  "task_list",
  "create_goal",
  "update_goal",
  "get_goal",
] as const

export const V2_OPTIONAL_EDIT_TOOL_NAME = "edit" as const
export const V2_ENABLE_EDIT_ENV = "OMO_V2_ENABLE_EDIT"

const DESCRIPTION_PREFIX_LENGTH = 80

export type CreateV2ToolsArgs = {
  readonly directory: string
  readonly pluginConfig: Partial<OhMyOpenCodeConfig>
  readonly enableEdit?: boolean
}

export type V2ToolRegistrationReport = {
  readonly registered: readonly BridgeRegistrationResult[]
  readonly tools: readonly string[]
  readonly missing: readonly string[]
  readonly skipped: readonly V2GroupBSkip[]
  readonly descriptions: Readonly<Record<string, string>>
}

/**
 * V1 factories only read `ctx.directory` for these tools; `client`/`project` are never touched on
 * the A-group code paths, so a narrow stand-in is enough (and keeps the V1 engine files untouched).
 */
function createCompatPluginInput(directory: string): PluginInput {
  return { directory } as unknown as PluginInput
}

export function createV2ToolsRecord(args: CreateV2ToolsArgs): ToolsRecord {
  const { directory, pluginConfig, enableEdit = false } = args
  const ctx = createCompatPluginInput(directory)
  const goalController = createGoalController({ projectDir: directory })

  const tools: ToolsRecord = {
    ...createGrepTools(ctx),
    ...createGlobTools(ctx),
    task_get: createTaskGetTool(pluginConfig),
    task_list: createTaskList(pluginConfig),
    ...createGoalTools({
      controller: goalController,
      getSessionID: getToolBridgeSessionID,
    }),
  }

  if (enableEdit) {
    tools[V2_OPTIONAL_EDIT_TOOL_NAME] = createHashlineEditTool(ctx)
  }

  const filteredTools = filterDisabledTools(tools, pluginConfig.disabled_tools)
  const maxTools = pluginConfig.experimental?.max_tools
  if (maxTools) {
    trimToolsToCap(filteredTools, maxTools)
  }

  return filteredTools
}

function readEnableEdit(): boolean {
  return process.env[V2_ENABLE_EDIT_ENV] === "1"
}

/**
 * Registers the A group and then the B group on the V2 host, and proves both afterwards.
 *
 * Every failure is surfaced twice: through the plugin log (so `e2e-s1a` / `e2e-s1b` can assert on
 * it) and through `console.error` (so it is visible in the host's own output instead of
 * disappearing). A failing B dependency set never costs the A group: the A record is built first and
 * is handed to the transform regardless.
 */
export async function registerOpenCodeV2Tools(
  context: Context,
  options: { readonly enableEdit?: boolean } = {},
): Promise<V2ToolRegistrationReport> {
  const directory = String(context.location.directory)
  setToolBridgeDirectory(directory)
  // `ctx.permission.assert` is the V2 counterpart of the V1 `ctx.ask()` (see `adaptContext`).
  setToolBridgePermission((context as unknown as { readonly permission?: unknown }).permission)

  const pluginConfig = loadPluginConfig(directory, process.env)
  const enableEdit = options.enableEdit ?? readEnableEdit()
  const record = createV2ToolsRecord({ directory, pluginConfig, enableEdit })

  // B group: reuses the V1 factories, needs the semantic shim + the skill list. Its own failures are
  // reported per tool by `createV2GroupBToolsRecord` and never abort this function.
  const groupB = await createV2GroupBToolsRecord({
    context: context as unknown as V2ContextLike,
    directory,
    pluginConfig,
  })
  const filteredGroupB = filterDisabledTools(groupB.tools, pluginConfig.disabled_tools)
  const recordWithGroupB: ToolsRecord = { ...record, ...filteredGroupB }
  const expectedNames = Object.keys(recordWithGroupB).sort()
  const before = (await context.tool.list()).map((entry) => entry.name).sort()

  // The host may invoke the transform again on reload; the report keeps the first pass, which is the
  // one that actually crossed the built-in/plugin boundary.
  const registeredByName = new Map<string, BridgeRegistrationResult>()
  const failuresByName = new Map<string, string>()

  await context.tool.transform((editor) => {
    const v2Editor = editor as unknown as V2ToolEditorLike
    for (const [name, definition] of Object.entries(recordWithGroupB)) {
      if (registeredByName.has(name)) continue
      try {
        const result = registerBridgedTool(v2Editor, definition, { name })
        registeredByName.set(name, result)
        failuresByName.delete(name)
        log(`${BRIDGE_LOG_PREFIX} tool registered ${name}`, {
          mode: result.mode,
          replacedBuiltin: result.replacedBuiltin,
          group: (V2_GROUP_B_TOOL_NAMES as readonly string[]).includes(name) ? "b" : "a",
        })
        continue
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failuresByName.set(name, message)
        console.error(`${BRIDGE_LOG_PREFIX} failed to register tool ${name}: ${message}`)
        log(`${BRIDGE_LOG_PREFIX} failed to register tool ${name}`, { error: message })
      }
    }
  })

  // `transform` only *registers* the callback; the host may invoke it right after the promise
  // resolves. Reading the maps only after `tool.list()` guarantees the callback already ran.
  const listed = await context.tool.list()
  const registered = [...registeredByName.values()]
  const failures = [...failuresByName.entries()].map(([name, error]) => ({ name, error }))
  const toolNames = listed.map((entry) => entry.name).sort()
  const skippedNames = groupB.skipped.map((entry) => entry.name)
  const missing = expectedNames.filter(
    (name) => !toolNames.includes(name) && !skippedNames.includes(name),
  )

  const descriptions: Record<string, string> = {}
  for (const entry of listed) {
    if (!expectedNames.includes(entry.name)) continue
    descriptions[entry.name] = entry.description.slice(0, DESCRIPTION_PREFIX_LENGTH)
  }

  // Before/after of the host's own tool list: the proof that the bridge added names to the host,
  // not just to its own bookkeeping. The names are logged because a name that the host already owned
  // (`grep`, `glob`, `skill`) is *replaced* by us and never appears in `added`.
  const added = toolNames.filter((name) => !before.includes(name))
  const removed = before.filter((name) => !toolNames.includes(name))
  log(`${BRIDGE_LOG_PREFIX} tool list delta`, {
    directory,
    before: before.length,
    after: toolNames.length,
    beforeNames: before,
    afterNames: toolNames,
    added,
    removed,
  })

  log(`${BRIDGE_LOG_PREFIX} tools`, { count: toolNames.length, tools: toolNames })
  log(`${BRIDGE_LOG_PREFIX} tool bridge`, {
    directory,
    enableEdit,
    expected: expectedNames,
    registered,
    failures,
    missing,
    skipped: groupB.skipped,
    groupB: groupB.deps,
  })
  log(`${BRIDGE_LOG_PREFIX} tool descriptions`, descriptions)

  if (missing.length > 0) {
    const message = `${BRIDGE_LOG_PREFIX} tools missing from ctx.tool.list(): ${missing.join(", ")}`
    console.error(message)
    log(`${BRIDGE_LOG_PREFIX} tools missing`, { missing })
  }

  return { registered, tools: toolNames, missing, skipped: groupB.skipped, descriptions }
}
