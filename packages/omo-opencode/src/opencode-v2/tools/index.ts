/**
 * Group-B V2 tool assembly (S1b).
 *
 * Ten tools whose V1 definitions need more than a directory: the session reader, the skill pair,
 * multimodal look-at, the task write pair and tmux. Each is built from its V1 factory (no business
 * logic is re-implemented here) and every one of them is registered through the same
 * `registerBridgedTool` as the A group, so the V2 contract — one object schema, an object result,
 * signal and callID mapping — is enforced in one place.
 *
 * Assembly is per *group*, not per tool: a failing dependency set (skills unreadable, config
 * broken) costs exactly the tools that need it, and the rest still load. Every skipped tool is
 * reported with its reason, both through `console.error` and the plugin log, so a missing name in
 * `ctx.tool.list()` is never a mystery.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

import type { OhMyOpenCodeConfig } from "../../config"
import type { ToolsRecord } from "../../plugin/types"
import { log } from "../../shared/logger"
import { BRIDGE_LOG_PREFIX } from "../tool-bridge"
import type { V2ContextLike } from "../adapter/types"
import { createGroupBToolDeps, type GroupBToolDeps } from "./deps"
import { INTERACTIVE_BASH_REQUIREMENT, createInteractiveBashTool } from "./interactive-bash"
import { createLookAtTools, isLookAtDisabled } from "./look-at"
import { createSessionTools } from "./session"
import { createSkillTools } from "./skill"
import { createTaskWriteTools } from "./task"

export const V2_GROUP_B_TOOL_NAMES = [
  "session_list",
  "session_read",
  "session_search",
  "session_info",
  "skill",
  "skill_mcp",
  "look_at",
  "task_create",
  "task_update",
  "interactive_bash",
] as const

export type V2GroupBSkip = {
  readonly name: string
  readonly reason: string
}

export type V2GroupBToolsResult = {
  readonly tools: ToolsRecord
  readonly skipped: readonly V2GroupBSkip[]
  /** Diagnostics the e2e asserts on: what the dependency set actually loaded. */
  readonly deps: {
    readonly skills: number
    readonly commands: number
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Builds one group, converting a failure into "these names are unavailable, here is why". */
function buildGroup(args: {
  readonly group: string
  readonly names: readonly string[]
  readonly skipped: V2GroupBSkip[]
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

export async function createV2GroupBToolsRecord(args: {
  readonly context: V2ContextLike
  readonly directory: string
  readonly pluginConfig: OhMyOpenCodeConfig
}): Promise<V2GroupBToolsResult> {
  const skipped: V2GroupBSkip[] = []
  const tools: ToolsRecord = {}

  let deps: GroupBToolDeps | undefined
  try {
    deps = await createGroupBToolDeps(args)
  } catch (error) {
    const reason = `dependency set failed: ${errorMessage(error)}`
    for (const name of V2_GROUP_B_TOOL_NAMES) {
      skipped.push({ name, reason })
      console.error(`${BRIDGE_LOG_PREFIX} tool skipped ${name}: ${reason}`)
    }
    log(`${BRIDGE_LOG_PREFIX} tool group failed`, { group: "deps", error: reason })
  }

  if (deps !== undefined) {
    const resolved = deps
    Object.assign(tools, buildGroup({
      group: "session",
      names: ["session_list", "session_read", "session_search", "session_info"],
      skipped,
      build: () => createSessionTools(resolved.input),
    }))
    Object.assign(tools, buildGroup({
      group: "skill",
      names: ["skill", "skill_mcp"],
      skipped,
      build: () => createSkillTools(resolved),
    }))
    if (!isLookAtDisabled(resolved)) {
      Object.assign(tools, buildGroup({
        group: "look_at",
        names: ["look_at"],
        skipped,
        build: () => createLookAtTools(resolved),
      }))
    } else {
      // Intentional: a disabled multimodal-looker agent means no child agent to run anything in.
      skipped.push({ name: "look_at", reason: "multimodal-looker agent is disabled" })
    }
    Object.assign(tools, buildGroup({
      group: "task",
      names: ["task_create", "task_update"],
      skipped,
      build: () => createTaskWriteTools({
        pluginConfig: resolved.pluginConfig,
        input: resolved.input,
        storage: args.context.storage,
      }),
    }))
    Object.assign(tools, buildGroup({
      group: "interactive_bash",
      names: ["interactive_bash"],
      skipped,
      build: () => ({ interactive_bash: createInteractiveBashTool() }),
    }))
  }

  for (const entry of skipped) {
    log(`${BRIDGE_LOG_PREFIX} tool skipped ${entry.name}`, { reason: entry.reason })
  }
  log(`${BRIDGE_LOG_PREFIX} tool requires tmux interactive_bash`, {
    requirement: INTERACTIVE_BASH_REQUIREMENT,
    note: "always registered on V2; a missing tmux binary answers with an error string",
  })
  log(`${BRIDGE_LOG_PREFIX} tool group b`, {
    directory: args.directory,
    built: Object.keys(tools).sort(),
    skipped,
    skills: deps?.skillContext.mergedSkills.length ?? 0,
    commands: deps?.commands.length ?? 0,
  })

  return {
    tools,
    skipped,
    deps: {
      skills: deps?.skillContext.mergedSkills.length ?? 0,
      commands: deps?.commands.length ?? 0,
    },
  }
}
