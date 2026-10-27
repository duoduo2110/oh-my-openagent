/**
 * The twelve team-mode tools on V2 (S1c).
 *
 * Every definition comes from `features/team-mode/tools/*` untouched; this module supplies what the
 * V1 registry supplies — the parsed `TeamModeConfig`, the S4 client shim, the background manager,
 * the tmux manager — and fixes the two things the V2 host changes:
 *
 *   directory    `createTeamListTool` resolves team specs against `process.cwd()`. Under V2 the
 *                project is `ctx.location.directory` (in the e2e host `/repo` is not the project),
 *                so the list tool gets query deps bound to the registration directory instead. The
 *                cached `team-core` functions are called with that root; `process.cwd()` is never
 *                consulted.
 *   tmux         Team *state* lives in team-core files; only the optional pane layout needs tmux.
 *                Without a tmux binary the manager is `undefined` (see `./deps-c`), and
 *                `team_create` refuses — with a readable string — when the config asks for
 *                visualization that cannot be delivered. It never throws for a missing binary.
 *
 * Feature gate: `team_create` is the only tool that spawns members, so it is the only one gated on
 * `team_mode.enabled`. The other eleven operate on an explicit `teamRunId` and keep their V1
 * answers (including their own "lead-only" / "team run not found" errors) — deleting or inspecting
 * a run that already exists must not require the spawner to be switched on.
 *
 * `inline_spec` is `object | string` in V1. `preprocessTeamCreateArgs` (exported for the bridge)
 * turns the JSON-string branch into the object branch *before* the schema parse, so a model that
 * stringifies the spec still reaches `parseInlineTeamSpec` as an object; an unparseable string is
 * left alone so the V1 string branch reports it.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

import { listActiveTeams } from "@oh-my-opencode/team-core/team-state-store/store"
import { loadTeamSpec } from "@oh-my-opencode/team-core/team-registry/loader"
import { discoverTeamSpecs } from "@oh-my-opencode/team-core/team-registry/paths"

import type { TeamModeConfig } from "../../config/schema/team-mode"
import { getSisyphusJuniorModelOverride } from "../../plugin/tool-registry-team-tools"
import {
  createTeamApproveShutdownTool,
  createTeamCreateTool,
  createTeamDeleteTool,
  createTeamRejectShutdownTool,
  createTeamShutdownRequestTool,
} from "../../features/team-mode/tools/lifecycle"
import { createTeamSendMessageTool } from "../../features/team-mode/tools/messaging"
import { createTeamListTool, createTeamStatusTool } from "../../features/team-mode/tools/query"
import {
  createTeamTaskCreateTool,
  createTeamTaskGetTool,
  createTeamTaskListTool,
  createTeamTaskUpdateTool,
} from "../../features/team-mode/tools/tasks"
import { aggregateStatus } from "../../features/team-mode/team-runtime/status"
import { log } from "../../shared/logger"
import type { GroupCToolDeps } from "./deps-c"

export const TEAM_TOOL_NAMES = [
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
] as const

export const TEAM_REQUIREMENT = "requires tmux"

export const TEAM_DISABLED_MESSAGE =
  "Error: team_create is unavailable: team_mode is disabled in this project's configuration. " +
  "Set team_mode.enabled = true and restart OpenCode to create teams."

export const TEAM_TMUX_REQUIRED_MESSAGE =
  "Error: team_create cannot honour team_mode.tmux_visualization: no tmux binary was found on PATH. " +
  "Install tmux (apt-get install -y tmux) and restart OpenCode, or set team_mode.tmux_visualization = false " +
  "to create teams without panes."

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * `team_create.inline_spec` union handling: a JSON *string* becomes the object the V1 schema
 * expects; an object (or an unparseable string) passes through so the V1 validation can speak.
 */
export function preprocessTeamCreateArgs(rawArgs: unknown): unknown {
  if (!isRecord(rawArgs)) return rawArgs
  const inlineSpec = rawArgs["inline_spec"]
  if (typeof inlineSpec !== "string") return rawArgs
  const trimmed = inlineSpec.trim()
  if (!trimmed.startsWith("{")) return rawArgs
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (!isRecord(parsed)) return rawArgs
    log("[omo-v2] team_create inline_spec parsed from JSON string", { keys: Object.keys(parsed) })
    return { ...rawArgs, inline_spec: parsed }
  } catch (error) {
    log("[omo-v2] team_create inline_spec is not valid JSON; leaving it for V1 validation", {
      error: error instanceof Error ? error.message : String(error),
    })
    return rawArgs
  }
}

/** Refuses (with a string) unless the feature is on and a requested layout can be delivered. */
function guardTeamCreate(definition: ToolDefinition, deps: GroupCToolDeps): ToolDefinition {
  const execute = definition.execute as unknown as (args: unknown, context: unknown) => Promise<unknown>
  const guarded = async (args: unknown, context: unknown): Promise<unknown> => {
    if (!deps.teamModeEnabled) return TEAM_DISABLED_MESSAGE
    if (deps.teamConfig.tmux_visualization && !deps.tmuxAvailable) return TEAM_TMUX_REQUIRED_MESSAGE
    return execute(args, context)
  }
  return { ...definition, execute: guarded as unknown as ToolDefinition["execute"] }
}

export function createTeamTools(deps: GroupCToolDeps): Record<string, ToolDefinition> {
  const config: TeamModeConfig = deps.teamConfig
  const client = deps.input.client
  const backgroundManager = deps.backgroundManager
  const tmuxSessionManager = deps.tmuxSessionManager
  const directory = deps.directory

  // Bound to the registration directory, not `process.cwd()`: see the module header.
  const directoryBoundQueryDeps = {
    aggregateStatus,
    discoverTeamSpecs: (teamConfig: TeamModeConfig, _projectRoot: string) =>
      discoverTeamSpecs(teamConfig, directory),
    loadTeamSpec: (name: string, teamConfig: TeamModeConfig, _projectRoot: string) =>
      loadTeamSpec(name, teamConfig, directory),
    listActiveTeams,
  }

  const executorConfig = {
    userCategories: deps.pluginConfig.categories,
    sisyphusJuniorModel: getSisyphusJuniorModelOverride(deps.pluginConfig.agents?.["sisyphus-junior"]),
    agentOverrides: deps.pluginConfig.agents,
    claudeCodeAgentsEnabled: deps.pluginConfig.claude_code?.agents ?? true,
  }

  const createTool = createTeamCreateTool(
    config,
    client,
    backgroundManager,
    tmuxSessionManager,
    executorConfig,
  )

  return {
    team_create: guardTeamCreate(createTool, deps),
    team_delete: createTeamDeleteTool(config, client, backgroundManager, tmuxSessionManager),
    team_shutdown_request: createTeamShutdownRequestTool(config, client),
    team_approve_shutdown: createTeamApproveShutdownTool(config, client),
    team_reject_shutdown: createTeamRejectShutdownTool(config, client),
    team_send_message: createTeamSendMessageTool(config, client),
    team_task_create: createTeamTaskCreateTool(config, client),
    team_task_list: createTeamTaskListTool(config, client),
    team_task_update: createTeamTaskUpdateTool(config, client),
    team_task_get: createTeamTaskGetTool(config, client),
    team_status: createTeamStatusTool(config, client, backgroundManager),
    team_list: createTeamListTool(config, client, directoryBoundQueryDeps),
  }
}
