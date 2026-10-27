/**
 * A-group V2 tool assembly (S1a).
 *
 * These are the tools that only need a directory and a config: `grep`, `glob`, `task_get`,
 * `task_list` and the goal trio (`create_goal` / `update_goal` / `get_goal`). They reuse the V1
 * factories untouched — the V1 engine files are not modified by the V2 port — and are handed to the
 * bridge in `./tool-bridge`.
 *
 * `edit` is deliberately off by default: the V1 hashline editor has its own validation loop and is
 * not part of the A group, so it stays behind `OMO_V2_ENABLE_EDIT=1` until a later stage.
 *
 * Tools that need the V1 manager graph (task delegation, background jobs, skills, tmux) are NOT
 * built here: constructing `createCoreTools` would drag in managers the V2 runtime does not provide
 * yet and would register a dozen tools outside the A group.
 */
import type { PluginInput } from "@opencode-ai/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"

import type { OhMyOpenCodeConfig } from "../config"
import type { ToolsRecord } from "../plugin/types"

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
  type BridgeRegistrationResult,
  type V2ToolEditorLike,
} from "./tool-bridge"

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
 * Registers the A group on the V2 host and proves it afterwards.
 *
 * Every failure is surfaced twice: through the plugin log (so `e2e-s1a` can assert on it) and
 * through `console.error` (so it is visible in the host's own output instead of disappearing).
 */
export async function registerOpenCodeV2Tools(
  context: Context,
  options: { readonly enableEdit?: boolean } = {},
): Promise<V2ToolRegistrationReport> {
  const directory = String(context.location.directory)
  setToolBridgeDirectory(directory)

  const pluginConfig = loadPluginConfig(directory, process.env)
  const enableEdit = options.enableEdit ?? readEnableEdit()
  const record = createV2ToolsRecord({ directory, pluginConfig, enableEdit })
  const expectedNames = Object.keys(record).sort()

  // The host may invoke the transform again on reload; the report keeps the first pass, which is the
  // one that actually crossed the built-in/plugin boundary.
  const registeredByName = new Map<string, BridgeRegistrationResult>()
  const failuresByName = new Map<string, string>()

  await context.tool.transform((editor) => {
    const v2Editor = editor as unknown as V2ToolEditorLike
    for (const [name, definition] of Object.entries(record)) {
      if (registeredByName.has(name)) continue
      try {
        registeredByName.set(name, registerBridgedTool(v2Editor, definition, { name }))
        failuresByName.delete(name)
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
  const missing = expectedNames.filter((name) => !toolNames.includes(name))

  const descriptions: Record<string, string> = {}
  for (const entry of listed) {
    if (!expectedNames.includes(entry.name)) continue
    descriptions[entry.name] = entry.description.slice(0, DESCRIPTION_PREFIX_LENGTH)
  }

  log(`${BRIDGE_LOG_PREFIX} tools`, { count: toolNames.length, tools: toolNames })
  log(`${BRIDGE_LOG_PREFIX} tool bridge`, {
    directory,
    enableEdit,
    expected: expectedNames,
    registered,
    failures,
    missing,
  })
  log(`${BRIDGE_LOG_PREFIX} tool descriptions`, descriptions)

  if (missing.length > 0) {
    const message = `${BRIDGE_LOG_PREFIX} tools missing from ctx.tool.list(): ${missing.join(", ")}`
    console.error(message)
    log(`${BRIDGE_LOG_PREFIX} tools missing`, { missing })
  }

  return { registered, tools: toolNames, missing, descriptions }
}
