/**
 * `task` and `call_omo_agent` on V2 (S1c).
 *
 * Both V1 factories are reused as-is; this module only supplies the dependency set the V1 registry
 * builds in `plugin/tool-registry-core-tools.ts`, and wraps each tool in the abort guard from
 * `./guards` so a host cancel (`v2ctx.signal` -> V1 `ctx.abort`) ends the wait.
 *
 * Result shape: V1 answers `{ title, output, metadata }`, and `normalizeResult` in the bridge turns
 * that into `{ content: <output>, metadata }` — the V2 contract. Nothing is remapped here.
 *
 * `task` is registered only when the operator opts into overriding the host's own `task` tool
 * (`OMO_V2_TASK_TOOL=override`, see `COLLISION_POLICY`); by default the host keeps its spawner and
 * this definition is skipped with a log line. `call_omo_agent` has no host counterpart.
 *
 * Degradation: without a model provider (no credentials, no `model` domain on the host) the V1
 * resolution path answers with its own error text. Under V2 that text reaches the model as
 * `{ content }` because the C group registers with `errorMode: "content"`; the model sees the
 * reason instead of an empty failure.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

import { log } from "../../shared/logger"
import { createCallOmoAgent } from "../../tools/call-omo-agent"
import { createDelegateTask } from "../../tools/delegate-task"
import { loadPluginConfig } from "../../plugin-config"
import { getSisyphusJuniorModelOverride } from "../../plugin/tool-registry-team-tools"
import type { GroupCToolDeps } from "./deps-c"
import { guardToolCall } from "./guards"

export const DELEGATE_TOOL_NAMES = ["task", "call_omo_agent"] as const

export const DELEGATE_REQUIREMENT = "requires a model provider"

export function createDelegateTools(deps: GroupCToolDeps): Record<string, ToolDefinition> {
  const delegateTask = createDelegateTask({
    manager: deps.backgroundManager,
    client: deps.input.client,
    directory: deps.directory,
    userCategories: deps.pluginConfig.categories,
    agentOverrides: deps.pluginConfig.agents,
    // Reload model-bearing config per call, exactly like the V1 registry: an edit to
    // `omo.jsonc` must be honoured without rebuilding the tool set.
    loadCurrentModelConfig: () => {
      const current = loadPluginConfig(deps.directory, process.env)
      return { agents: current.agents, categories: current.categories }
    },
    gitMasterConfig: deps.pluginConfig.git_master,
    sisyphusJuniorModel: getSisyphusJuniorModelOverride(deps.pluginConfig.agents?.["sisyphus-junior"]),
    browserProvider: deps.skillContext.browserProvider,
    disabledSkills: deps.skillContext.disabledSkills,
    teamModeEnabled: deps.teamModeEnabled,
    availableCategories: [...deps.availableCategories],
    availableSkills: deps.skillContext.availableSkills,
    nativeSkills: deps.nativeSkills,
    getLoadedSkills: deps.getLoadedSkills,
    sisyphusAgentConfig: deps.pluginConfig.sisyphus_agent,
    claudeCodeAgentsEnabled: deps.pluginConfig.claude_code?.agents ?? true,
    syncPollTimeoutMs: deps.pluginConfig.background_task?.syncPollTimeoutMs,
    modelFallbackControllerAccessor: deps.modelFallbackControllerAccessor,
    onSyncSessionCreated: async (event) => {
      const tmuxSessionManager = deps.tmuxSessionManager
      if (tmuxSessionManager === undefined) return
      try {
        await tmuxSessionManager.onSessionCreated({
          type: "session.created",
          properties: { info: { id: event.sessionID, parentID: event.parentID, title: event.title } },
        })
      } catch (error) {
        // A missing pane is a degraded layout, not a failed delegation.
        log("[omo-v2] delegate task tmux layout failed", {
          sessionID: event.sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  })

  const callOmoAgent = createCallOmoAgent(
    deps.input,
    deps.backgroundManager,
    deps.pluginConfig.disabled_agents ?? [],
    deps.pluginConfig.agents,
    deps.pluginConfig.categories,
    deps.modelFallbackControllerAccessor,
  )

  return {
    task: guardToolCall(delegateTask, { name: "task" }),
    call_omo_agent: guardToolCall(callOmoAgent, { name: "call_omo_agent" }),
  }
}
