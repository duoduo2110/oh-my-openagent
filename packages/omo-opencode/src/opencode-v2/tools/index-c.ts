/**
 * Group-C V2 tool assembly (S1c): delegation, background jobs, monitors and team mode.
 *
 * Twenty names, four groups. Each group is built from its V1 factories (no business logic is
 * re-implemented) and every name is registered through the same `registerBridgedTool` as A and B,
 * with three C-specific bridge settings:
 *
 *   errorMode: "content"   these tools sit on optional subsystems (tmux, a model provider, an
 *                          existing team run). A rejection becomes a readable `Error: <tool>: ...`
 *                          string, which is how V1 answers most of these paths already; the model
 *                          never gets an empty result. The conversion is logged.
 *   collisionPolicy        "override" for the nineteen names no V2 built-in owns. `task` keeps
 *                          `COLLISION_POLICY`'s "skip" unless the operator sets
 *                          `OMO_V2_TASK_TOOL=override`, so the host's own spawner survives by
 *                          default.
 *   preprocess             `team_create.inline_spec` is `object | string` in V1; the JSON-string
 *                          branch is parsed into the object branch before the schema parse.
 *
 * Failure isolation is per group: a group that cannot be built costs exactly its own names, which
 * are reported (console + plugin log) with the reason. The A and B groups have already registered by
 * the time this runs.
 */
import type { OhMyOpenCodeConfig } from "../../config"
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { ToolsRecord } from "../../plugin/types"
import { log } from "../../shared/logger"
import type { V2ContextLike } from "../adapter/types"
import { BRIDGE_LOG_PREFIX, type BridgeMeta } from "../tool-bridge"
import { BACKGROUND_TOOL_NAMES, createBackgroundToolsC } from "./background"
import { createGroupCToolDeps, describeGroupCSubsystems, type GroupCSubsystems } from "./deps-c"
import type { GroupBToolDeps } from "./deps"
import { createDelegateTools, DELEGATE_REQUIREMENT, DELEGATE_TOOL_NAMES } from "./delegate"
import { createMonitorToolsC, MONITOR_REQUIREMENT, MONITOR_TOOL_NAMES } from "./monitor"
import { createTeamTools, preprocessTeamCreateArgs, TEAM_REQUIREMENT, TEAM_TOOL_NAMES } from "./team"

/** The twenty names of S1c, in the order the task spec lists them. */
export const V2_GROUP_C_TOOL_NAMES: readonly string[] = [
  "task",
  "call_omo_agent",
  "background_output",
  "background_cancel",
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
  "team_create",
  "team_delete",
  "team_shutdown_request",
  "team_approve_shutdown",
  "team_reject_shutdown",
  "team_send_message",
  "team_task_create",
  "team_task_list",
  "team_task_update",
  "team_task_get",
  "team_status",
  "team_list",
]

export type V2GroupCToolSkip = {
  readonly name: string
  readonly reason: string
}

export type V2GroupCToolsResult = {
  readonly tools: ToolsRecord
  readonly skipped: readonly V2GroupCToolSkip[]
  readonly subsystems: GroupCSubsystems | undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Same shape as the B aggregator's helper: a failing group becomes "these names are unavailable". */
function buildGroup(args: {
  readonly group: string
  readonly names: readonly string[]
  readonly skipped: V2GroupCToolSkip[]
  readonly build: () => Record<string, ToolDefinition>
}): ToolsRecord {
  try {
    return args.build()
  } catch (error) {
    const reason = `${args.group} group failed: ${errorMessage(error)}`
    for (const name of args.names) {
      args.skipped.push({ name, reason })
      console.error(`${BRIDGE_LOG_PREFIX} tool skipped ${name}: ${reason}`)
    }
    log(`${BRIDGE_LOG_PREFIX} tool group failed`, { group: args.group, error: reason })
    return {}
  }
}

/**
 * Bridge settings for a C-group name, or `undefined` for any other tool. `tools.ts` merges the
 * result into the registration meta, so the collision policy still comes from `COLLISION_POLICY`
 * (which is what keeps `task` skipped by default).
 */
export function groupCBridgeMetaFor(name: string): BridgeMeta | undefined {
  if (!V2_GROUP_C_TOOL_NAMES.includes(name)) return undefined
  const meta: BridgeMeta = { name, errorMode: "content" }
  if (name === "team_create") return { ...meta, preprocess: preprocessTeamCreateArgs }
  return meta
}

export async function createV2GroupCToolsRecord(args: {
  readonly context: V2ContextLike
  readonly directory: string
  readonly pluginConfig: OhMyOpenCodeConfig
  /** The B group's dependency set, reused when it loaded (one shim, one skill list). */
  readonly shared?: GroupBToolDeps
}): Promise<V2GroupCToolsResult> {
  const skipped: V2GroupCToolSkip[] = []

  let deps: Awaited<ReturnType<typeof createGroupCToolDeps>> | undefined
  try {
    deps = await createGroupCToolDeps({
      context: args.context,
      directory: args.directory,
      pluginConfig: args.pluginConfig,
      ...(args.shared === undefined ? {} : { shared: args.shared }),
    })
  } catch (error) {
    const reason = `dependency set failed: ${errorMessage(error)}`
    for (const name of V2_GROUP_C_TOOL_NAMES) {
      skipped.push({ name, reason })
      console.error(`${BRIDGE_LOG_PREFIX} tool skipped ${name}: ${reason}`)
    }
    log(`${BRIDGE_LOG_PREFIX} tool group failed`, { group: "deps-c", error: reason })
    return { tools: {}, skipped, subsystems: undefined }
  }

  const resolved = deps
  const tools: ToolsRecord = {
    ...buildGroup({
      group: "delegate",
      names: DELEGATE_TOOL_NAMES,
      skipped,
      build: () => createDelegateTools(resolved),
    }),
    ...buildGroup({
      group: "background",
      names: BACKGROUND_TOOL_NAMES,
      skipped,
      build: () => createBackgroundToolsC(resolved),
    }),
    ...buildGroup({
      group: "monitor",
      names: MONITOR_TOOL_NAMES,
      skipped,
      build: () => createMonitorToolsC(resolved),
    }),
    ...buildGroup({
      group: "team",
      names: TEAM_TOOL_NAMES,
      skipped,
      build: () => createTeamTools(resolved),
    }),
  }

  const subsystems = describeGroupCSubsystems(resolved)

  for (const entry of skipped) {
    log(`${BRIDGE_LOG_PREFIX} tool skipped ${entry.name}`, { reason: entry.reason })
  }
  log(`${BRIDGE_LOG_PREFIX} tool requires a model provider ${DELEGATE_TOOL_NAMES.join(",")}`, {
    requirement: DELEGATE_REQUIREMENT,
    note: "always registered on V2; a missing provider answers with the V1 resolution error as content",
  })
  log(`${BRIDGE_LOG_PREFIX} tool requires monitor.enabled monitor_start`, {
    requirement: MONITOR_REQUIREMENT,
    note: "registered even when monitor.enabled is false; monitor_start fails closed, list/output still answer",
  })
  log(`${BRIDGE_LOG_PREFIX} tool requires tmux team`, {
    requirement: TEAM_REQUIREMENT,
    tmuxAvailable: subsystems.tmuxAvailable,
    note: subsystems.tmuxAvailable
      ? "tmux manager created; team pane layout is available"
      : "no tmux binary: team state and tasks work, team_create refuses when tmux_visualization is requested",
  })
  log(`${BRIDGE_LOG_PREFIX} tool group c`, {
    directory: args.directory,
    built: Object.keys(tools).sort(),
    skipped,
    subsystems,
  })

  return { tools, skipped, subsystems }
}
