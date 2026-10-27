/**
 * V2 tool assembly (S1a A group, S1b B group, S1c C group).
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
 * pins); `registerOpenCodeV2Tools` merges the records for registration only.
 *
 * C group (S1c) — the twenty delegation / background / monitor / team tools, built in `./tools/`
 * from a manager set (`./tools/deps-c`). They add three bridge settings (see `./tools/index-c`):
 * errors become readable `{ content }`, the `task` name keeps the host's built-in unless
 * `OMO_V2_TASK_TOOL=override`, and `team_create.inline_spec` gets its union preprocessed.
 *
 * `edit` is deliberately off by default: the V1 hashline editor has its own validation loop and is
 * not part of the A group, so it stays behind `OMO_V2_ENABLE_EDIT=1` until a later stage.
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
  type BridgeMeta,
  type BridgeRegistrationResult,
  type V2ToolEditorLike,
} from "./tool-bridge"
import {
  V2_GROUP_B_TOOL_NAMES,
  createV2GroupBToolsRecord,
  type V2GroupBSkip,
} from "./tools/index"
import {
  V2_GROUP_C_TOOL_NAMES,
  createV2GroupCToolsRecord,
  groupCBridgeMetaFor,
  type V2GroupCToolSkip,
  type V2GroupCToolsResult,
} from "./tools/index-c"

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
/**
 * `task` collides with the host's own delegating tool. The V1 definition replaces it only when the
 * operator says so; by default the host keeps the name and ours is skipped (and logged).
 */
export const V2_TASK_TOOL_ENV = "OMO_V2_TASK_TOOL"

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
  /** C-group skips are reported separately: `skipped` stays the B group's contract. */
  readonly skippedC: readonly V2GroupCToolSkip[]
  readonly subsystemsC: V2GroupCToolsResult["subsystems"]
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

function readTaskToolOverride(): boolean {
  const value = process.env[V2_TASK_TOOL_ENV]?.trim().toLowerCase()
  return value === "override" || value === "1" || value === "true"
}

function toolGroupOf(name: string): "a" | "b" | "c" {
  if (V2_GROUP_C_TOOL_NAMES.includes(name)) return "c"
  if ((V2_GROUP_B_TOOL_NAMES as readonly string[]).includes(name)) return "b"
  return "a"
}

/**
 * Bridge settings for one name: the C group contributes its error mode and its union preprocessor,
 * and the `task` opt-in is decided here so the policy shows up in one place.
 *
 * Exported for the S1c selftest, which registers through the same function the host setup uses —
 * a test that re-implemented the policy could pass while the port skipped the wrong name.
 */
export function v2ToolBridgeMeta(name: string, taskOverride: boolean): BridgeMeta {
  const groupC = groupCBridgeMetaFor(name)
  const meta: BridgeMeta = { name, ...(groupC === undefined ? {} : groupC) }
  if (name !== "task") return meta
  // `task` is *our* name for the host's `subagent`: without the opt-in, register nothing at all.
  return taskOverride
    ? { ...meta, collisionPolicy: "override" }
    : { ...meta, skipUnlessEnabled: true }
}

/**
 * Registers the A group, then B, then C on the V2 host, and proves all three afterwards.
 *
 * Every failure is surfaced twice: through the plugin log (so `e2e-s1a` / `e2e-s1b` / `e2e-s1c` can
 * assert on it) and through `console.error` (so it is visible in the host's own output instead of
 * disappearing). A failing B or C dependency set never costs the A group: the A record is built first
 * and is handed to the transform regardless.
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

  // C group (S1c): delegation, background, monitor, team. Shares the B dependency set when it
  // loaded, so one client shim and one skill list serve both groups.
  const groupC = await createV2GroupCToolsRecord({
    context: context as unknown as V2ContextLike,
    directory,
    pluginConfig,
    ...(groupB.bridgeDeps === undefined ? {} : { shared: groupB.bridgeDeps }),
  })
  const filteredGroupC = filterDisabledTools(groupC.tools, pluginConfig.disabled_tools)

  const recordWithGroups: ToolsRecord = { ...record, ...filteredGroupB, ...filteredGroupC }
  const expectedNames = Object.keys(recordWithGroups).sort()
  const before = (await context.tool.list()).map((entry) => entry.name).sort()
  const taskOverride = readTaskToolOverride()

  // The host may invoke the transform again on reload; the report keeps the first pass, which is the
  // one that actually crossed the built-in/plugin boundary.
  const registeredByName = new Map<string, BridgeRegistrationResult>()
  const failuresByName = new Map<string, string>()

  await context.tool.transform((editor) => {
    const v2Editor = editor as unknown as V2ToolEditorLike
    for (const [name, definition] of Object.entries(recordWithGroups)) {
      if (registeredByName.has(name)) continue
      try {
        const result = registerBridgedTool(v2Editor, definition, v2ToolBridgeMeta(name, taskOverride))
        registeredByName.set(name, result)
        failuresByName.delete(name)
        log(`${BRIDGE_LOG_PREFIX} tool registered ${name}`, {
          mode: result.mode,
          replacedBuiltin: result.replacedBuiltin,
          group: toolGroupOf(name),
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
  const skippedNames = [...groupB.skipped, ...groupC.skipped].map((entry) => entry.name)
  // A name the bridge deliberately did not register (`task` by default) is not "missing": the host
  // owns that capability, and the policy line above says which one.
  const skippedByPolicy = registered.filter((entry) => entry.mode === "skip").map((entry) => entry.name)
  const missing = expectedNames.filter(
    (name) =>
      !toolNames.includes(name) &&
      !skippedNames.includes(name) &&
      !skippedByPolicy.includes(name),
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
  log(`${BRIDGE_LOG_PREFIX} task tool policy`, {
    policy: taskOverride ? "override" : "skip",
    env: V2_TASK_TOOL_ENV,
    reason: taskOverride
      ? "the operator asked for the V1 delegation tool to replace the host built-in"
      : "the host owns `task`; the V1 definition is registered only with OMO_V2_TASK_TOOL=override",
  })
  log(`${BRIDGE_LOG_PREFIX} tool bridge`, {
    directory,
    enableEdit,
    expected: expectedNames,
    registered,
    failures,
    missing,
    skipped: groupB.skipped,
    skippedC: groupC.skipped,
    skippedByPolicy,
    groupB: groupB.deps,
    groupC: groupC.subsystems,
  })
  log(`${BRIDGE_LOG_PREFIX} tool descriptions`, descriptions)

  if (missing.length > 0) {
    const message = `${BRIDGE_LOG_PREFIX} tools missing from ctx.tool.list(): ${missing.join(", ")}`
    console.error(message)
    log(`${BRIDGE_LOG_PREFIX} tools missing`, { missing })
  }

  return {
    registered,
    tools: toolNames,
    missing,
    skipped: groupB.skipped,
    skippedC: groupC.skipped,
    subsystemsC: groupC.subsystems,
    descriptions,
  }
}
