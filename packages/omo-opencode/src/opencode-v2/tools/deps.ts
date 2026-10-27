/**
 * Group-B tool dependencies (S1b).
 *
 * The B group (`session_*`, `skill`, `skill_mcp`, `look_at`, `task_create`, `task_update`,
 * `interactive_bash`) cannot be built from a directory alone: the session tools need the 1.x SDK
 * client, the skill tools need the merged skill list and an MCP manager, `look_at` needs a session
 * capable client, and the task tools need the session todo channel. Under V2 all of those arrive
 * through the setup context, so this module builds *one* dependency set per registration and hands
 * it to the per-tool builders in this folder.
 *
 * The dependency choices mirror `plugin/tool-registry-core-tools.ts` one for one, so the V2 port
 * behaves like the V1 registry for these ten tools:
 *
 *   client        V1 `PluginInput.client` from `createV1PluginInput` (the S4 semantic shim), which is
 *                 also what makes `isSqliteBackend()` take the SDK path for `session_*`.
 *   skills        `createSkillContext` — the same merged list the S3b config-domain projection and the
 *                 V1 assembly publish, so `skill` lists what the host already told the model about.
 *   skill MCP     one `SkillMcpManager` for this registration. The V1 runtime builds its own, but the
 *                 runtime's tools are not registered on the V2 host, so nothing is spawned twice; an
 *                 unused manager opens no connection.
 *   commands      `discoverCommandsSync(directory, ...)`, exactly the call `createCoreTools` makes.
 *   session id    `getToolBridgeSessionID()` — the V2 bridge records the calling session on every
 *                 execute, which is the closest V2 equivalent of the V1 main-session registry.
 *
 * A failure here is not fatal: `createV2GroupBToolsRecord` reports it and the A group still loads.
 */
import type { PluginInput } from "@opencode-ai/plugin"

import type { OhMyOpenCodeConfig } from "../../config"
import type { LoadedSkill } from "../../features/opencode-skill-loader/types"
import { SkillMcpManager } from "../../features/skill-mcp-manager"
import { createNativeSkills, getPluginInputNativeSkills } from "../../plugin/native-skills"
import { createRuntimeSkillsResolver, readRuntimeHostSkills } from "../../plugin/runtime-skill-resolver"
import { createSkillContext, type SkillContext } from "../../plugin/skill-context"
import { log } from "../../shared/logger"
import { discoverCommandsSync } from "../../tools/slashcommand/command-discovery"
import type { CommandInfo } from "../../tools/slashcommand/types"
import { createV1PluginInput } from "../adapter/plugin-input"
import type { V2ContextLike } from "../adapter/types"
import { getToolBridgeSessionID } from "../tool-bridge"

export const GROUP_B_DEPS_LOG_PREFIX = "[omo-v2] tool deps"

export type GroupBToolDeps = {
  readonly input: PluginInput
  readonly directory: string
  readonly pluginConfig: OhMyOpenCodeConfig
  readonly skillContext: SkillContext
  readonly skillMcpManager: SkillMcpManager
  readonly getLoadedSkills: () => Promise<LoadedSkill[]>
  readonly nativeSkills: ReturnType<typeof createNativeSkills>
  readonly commands: readonly CommandInfo[]
  readonly getSessionID: () => string | undefined
}

export async function createGroupBToolDeps(args: {
  readonly context: V2ContextLike
  readonly directory: string
  readonly pluginConfig: OhMyOpenCodeConfig
}): Promise<GroupBToolDeps> {
  const { context, directory, pluginConfig } = args
  const { input } = createV1PluginInput(context)
  const skillContext = await createSkillContext({ directory, pluginConfig })
  const nativeSkills = getPluginInputNativeSkills(input) ?? createNativeSkills({
    client: input.client,
    directory,
  })
  const getLoadedSkills = createRuntimeSkillsResolver({
    baseSkills: skillContext.mergedSkills,
    readRuntimeHostSkills: () => readRuntimeHostSkills(input.client),
    buildMergedSkills: async (hostSkills) =>
      (await createSkillContext({ directory, pluginConfig, hostSkills })).mergedSkills,
  })
  const commands = discoverCommandsSync(directory, {
    pluginsEnabled: pluginConfig.claude_code?.plugins ?? true,
    enabledPluginsOverride: pluginConfig.claude_code?.plugins_override,
  })
  // No connection is opened here: `SkillMcpManager` connects on the first `callTool`/`readResource`.
  const skillMcpManager = new SkillMcpManager({
    onEnvironmentNotice: (message: string): void => {
      log(`${GROUP_B_DEPS_LOG_PREFIX} skill mcp notice`, { message })
    },
  })

  log(`${GROUP_B_DEPS_LOG_PREFIX} ready`, {
    directory,
    skills: skillContext.mergedSkills.length,
    commands: commands.length,
    browserProvider: skillContext.browserProvider,
    disabledSkills: [...skillContext.disabledSkills].length,
  })

  return {
    input,
    directory,
    pluginConfig,
    skillContext,
    skillMcpManager,
    getLoadedSkills,
    nativeSkills,
    commands,
    getSessionID: getToolBridgeSessionID,
  }
}
