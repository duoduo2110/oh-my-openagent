/**
 * `skill` and `skill_mcp` on V2 (S1b).
 *
 * Both V1 factories are reused untouched; the only additions are the dependency set (see
 * `./deps`) and the permission mapping for `ctx.ask({ permission: "skill" })`, which
 * `adaptContext` in `../tool-bridge` now translates onto `ctx.permission.assert`.
 *
 * `nativeSkills` is built from the V1 client, whose `_client` the shim does not provide, so it
 * resolves to an empty list and logs why. That is the V1 behaviour when the v2 SDK client is
 * unavailable, and it does not hide skills: the merged loader list (bundled + config + project +
 * shared) is what the S3b config domain publishes to the host as well.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

import { createSkillMcpTool } from "../../tools/skill-mcp"
import { createSkillTool } from "../../tools/skill"
import type { GroupBToolDeps } from "./deps"

export const SKILL_TOOL_NAMES = ["skill", "skill_mcp"] as const

export function createSkillTools(deps: GroupBToolDeps): Record<string, ToolDefinition> {
  const { pluginConfig, skillContext } = deps
  const pluginsEnabled = pluginConfig.claude_code?.plugins ?? true
  const enabledPluginsOverride = pluginConfig.claude_code?.plugins_override

  const skill = createSkillTool({
    directory: deps.directory,
    commands: [...deps.commands],
    skills: skillContext.mergedSkills,
    getLoadedSkills: deps.getLoadedSkills,
    mcpManager: deps.skillMcpManager,
    getSessionID: deps.getSessionID,
    gitMasterConfig: pluginConfig.git_master,
    browserProvider: skillContext.browserProvider,
    disabledSkills: skillContext.disabledSkills,
    teamModeEnabled: pluginConfig.team_mode?.enabled ?? false,
    nativeSkills: deps.nativeSkills,
    pluginsEnabled,
    enabledPluginsOverride,
    includeSkillsInDescription: true,
  })

  const skillMcp = createSkillMcpTool({
    manager: deps.skillMcpManager,
    getLoadedSkills: deps.getLoadedSkills,
    getSessionID: deps.getSessionID,
  })

  return { skill, skill_mcp: skillMcp }
}
