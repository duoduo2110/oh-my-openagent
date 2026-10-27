/**
 * Group-C tool dependencies (S1c): delegation, background jobs, monitors and team mode.
 *
 * The C group is the first one that needs *managers*, not just a directory and a skill list. The V1
 * registry builds them in `create-managers`/`create-tools`; under V2 the setup context owns the host,
 * so this module builds one dependency set per registration from what the shim can supply:
 *
 *   client            the S4 V1 client shim (`createV1PluginInput`), reused from the B group's set
 *                     when it exists so the two groups share one shim, one skill list, one manager
 *                     for skill MCPs.
 *   background        one `BackgroundManager` per registration. It replaces nothing: the V1 runtime
 *                     assembled by S2a has its own, and its tools are not registered on the V2 host,
 *                     so no task is ever tracked twice. Constructor-only (no polling until a task
 *                     exists), and it registers itself for process cleanup.
 *   tmux              one `TmuxSessionManager`, created only when a tmux binary actually exists.
 *                     Without tmux there is nothing to lay out; team mode then works without
 *                     visualization instead of spawning panes that cannot be attached (see the
 *                     `requires tmux` line in the registration log).
 *   monitor           one `MonitorManager`. Cheap: the constructor only registers cleanup; a monitor
 *                     process starts on `monitor_start`. Registered even when `monitor.enabled` is
 *                     false, because `monitor_list`/`monitor_output` must still answer and
 *                     `monitor_start` fails closed with the V1 "feature disabled" reason.
 *   team              `TeamModeConfig` from the plugin config plus the live `team_mode.enabled` flag.
 *                     The team tools read/write team-core files, so they answer on explicit
 *                     `teamRunId`s; `team_create` is the one that must not run with the feature off.
 *
 * A failure here costs the C group only: `createV2GroupCToolsRecord` reports it per group and the A
 * and B groups are already registered by then.
 */
import type { PluginInput } from "@opencode-ai/plugin"

import type { AvailableCategory } from "../../agents/dynamic-agent-prompt-builder"
import type { OhMyOpenCodeConfig } from "../../config"
import { TeamModeConfigSchema } from "../../config/schema/team-mode"
import type { TeamModeConfig } from "../../config/schema/team-mode"
import { createRuntimeTmuxConfig } from "../../create-runtime-tmux-config"
import { BackgroundManager } from "../../features/background-agent"
import { createMonitorManager, type MonitorManager } from "../../features/monitor"
import { lookupTeamSession } from "../../features/team-mode/team-session-registry"
import { selectTmuxManagerEnvironmentPredicate } from "../../features/tmux-subagent"
import { TmuxSessionManager } from "../../features/tmux-subagent/manager"
import type { LoadedSkill } from "../../features/opencode-skill-loader/types"
import {
  createModelFallbackControllerAccessor,
  type ModelFallbackControllerAccessor,
} from "../../hooks/model-fallback"
import { createAvailableCategories } from "../../plugin/available-categories"
import { createNativeSkills } from "../../plugin/native-skills"
import { createSkillContext, type SkillContext } from "../../plugin/skill-context"
import { log } from "../../shared/logger"
import { getTmuxPath } from "../../tools/interactive-bash/tmux-path-resolver"
import { createV1PluginInput } from "../adapter/plugin-input"
import type { V2ContextLike } from "../adapter/types"
import type { GroupBToolDeps } from "./deps"

export const GROUP_C_DEPS_LOG_PREFIX = "[omo-v2] tool deps c"

export type GroupCToolDeps = {
  readonly input: PluginInput
  readonly directory: string
  readonly pluginConfig: OhMyOpenCodeConfig
  readonly backgroundManager: BackgroundManager
  /** Absent when no tmux binary exists: team layout is then skipped, not faked. */
  readonly tmuxSessionManager?: TmuxSessionManager
  readonly monitorManager: MonitorManager
  readonly modelFallbackControllerAccessor: ModelFallbackControllerAccessor
  readonly skillContext: SkillContext
  readonly availableCategories: readonly AvailableCategory[]
  readonly getLoadedSkills: () => Promise<LoadedSkill[]>
  readonly nativeSkills: ReturnType<typeof createNativeSkills>
  readonly teamConfig: TeamModeConfig
  readonly teamModeEnabled: boolean
  readonly tmuxAvailable: boolean
}

/** What the registration log and the e2e assert on: which optional subsystem really came up. */
export type GroupCSubsystems = {
  readonly tmuxAvailable: boolean
  readonly monitorEnabled: boolean
  readonly teamModeEnabled: boolean
  readonly categories: number
  readonly skills: number
}

export function describeGroupCSubsystems(deps: GroupCToolDeps): GroupCSubsystems {
  return {
    tmuxAvailable: deps.tmuxAvailable,
    monitorEnabled: deps.pluginConfig.monitor?.enabled === true,
    teamModeEnabled: deps.teamModeEnabled,
    categories: deps.availableCategories.length,
    skills: deps.skillContext.availableSkills.length,
  }
}

export async function createGroupCToolDeps(args: {
  readonly context: V2ContextLike
  readonly directory: string
  readonly pluginConfig: OhMyOpenCodeConfig
  /** The B group's set, reused when it loaded so both groups read one shim and one skill list. */
  readonly shared?: GroupBToolDeps
}): Promise<GroupCToolDeps> {
  const { context, directory, pluginConfig, shared } = args

  const input = shared?.input ?? createV1PluginInput(context).input
  const skillContext = shared?.skillContext ?? (await createSkillContext({ directory, pluginConfig }))
  const nativeSkills = shared?.nativeSkills ?? createNativeSkills({ client: input.client, directory })
  const getLoadedSkills = shared?.getLoadedSkills ?? (async (): Promise<LoadedSkill[]> => skillContext.mergedSkills)
  const availableCategories = createAvailableCategories(pluginConfig)
  const tmuxConfig = createRuntimeTmuxConfig(pluginConfig)
  const tmuxPath = await getTmuxPath()
  const tmuxAvailable = tmuxPath !== null && tmuxPath.length > 0

  // Team members must not be tracked as ordinary subagents (the V1 runtime does the same): their
  // panes belong to the team layout, and polling them would close panes under it.
  const tmuxSessionManager = tmuxAvailable
    ? new TmuxSessionManager(
      input,
      tmuxConfig,
      { isInsideTmux: selectTmuxManagerEnvironmentPredicate(tmuxConfig.isolation) },
      { shouldSkipSession: (sessionID: string) => lookupTeamSession(sessionID) !== undefined },
    )
    : undefined

  const modelFallbackControllerAccessor = createModelFallbackControllerAccessor()
  const backgroundManager = new BackgroundManager({
    pluginContext: input,
    config: pluginConfig.background_task,
    tmuxConfig,
    onSubagentSessionCreated: async (event) => {
      if (tmuxSessionManager === undefined) return
      // A layout failure must not fail the spawn that triggered it: the child session exists and is
      // already tracked by the background manager, so this is a degraded pane, not a lost task.
      try {
        await tmuxSessionManager.onSessionCreated({
          type: "session.created",
          properties: { info: { id: event.sessionID, parentID: event.parentID, title: event.title } },
        })
      } catch (error) {
        log(`${GROUP_C_DEPS_LOG_PREFIX} tmux session-created callback failed`, {
          sessionID: event.sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    onSubagentSessionDeleted: async (event) => {
      if (tmuxSessionManager === undefined) return
      try {
        await tmuxSessionManager.onSessionDeleted(event)
      } catch (error) {
        log(`${GROUP_C_DEPS_LOG_PREFIX} tmux session-deleted callback failed`, {
          sessionID: event.sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
    // The V1 gate is the `background-notification` hook. Keeping the same gate here means a config
    // that switched the notification off does not get a second, manager-level notifier.
    enableParentSessionNotifications: !(pluginConfig.disabled_hooks ?? []).includes("background-notification"),
    modelFallbackControllerAccessor,
  })

  const monitorManager = createMonitorManager({
    pluginContext: { client: input.client, directory },
    config: pluginConfig.monitor,
  })

  const teamConfig = TeamModeConfigSchema.parse(pluginConfig.team_mode ?? {})
  const teamModeEnabled = pluginConfig.team_mode?.enabled === true

  log(`${GROUP_C_DEPS_LOG_PREFIX} ready`, {
    directory,
    tmuxAvailable,
    tmuxConfigEnabled: tmuxConfig.enabled,
    monitorEnabled: pluginConfig.monitor?.enabled === true,
    teamModeEnabled,
    categories: availableCategories.length,
    skills: skillContext.availableSkills.length,
  })

  return {
    input,
    directory,
    pluginConfig,
    backgroundManager,
    ...(tmuxSessionManager === undefined ? {} : { tmuxSessionManager }),
    monitorManager,
    modelFallbackControllerAccessor,
    skillContext,
    availableCategories,
    getLoadedSkills,
    nativeSkills,
    teamConfig,
    teamModeEnabled,
    tmuxAvailable,
  }
}
