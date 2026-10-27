/**
 * OpenCode V2 host adapter (S2a): assemble the V1 runtime on a V2 setup context.
 *
 * The port keeps exactly one owner per subsystem: OpenCode V2 owns the host, and the V1 engine
 * keeps owning hooks, managers and tools. This adapter only does the wiring:
 *
 *   V2 Context -> V1 PluginInput (./adapter/plugin-input, ./adapter/client-shim)
 *               -> serverPlugin(input, options) from ../testing/create-plugin-module
 *               -> { hooks, tools, managers, dispose }
 *
 * The V1 engine files (create-managers, create-tools, create-hooks, plugin-interface) are not
 * modified. Managers and the tool result are captured through the module's own dependency
 * overrides, which exist for exactly this kind of instrumentation.
 *
 * Failure policy: setup must never take the host down. Every assembly error is logged through the
 * plugin logger and `console.error`, and `createOpenCodeV2Runtime` resolves `undefined`.
 *
 * Lifetime: the assembled runtime is a module-level singleton with a reference count. A second
 * `setup` (V2 may call it once per location) reuses the instance instead of double-installing
 * hooks/managers; the V1 `dispose` runs once, when the last reference is released.
 */
import type { Hooks } from "@opencode-ai/plugin"

import { BuiltinAgentNameSchema } from "../config/schema/agent-names"
import { createManagers as createV1Managers, type Managers } from "../create-managers"
import { createTools as createV1Tools } from "../create-tools"
import { createPluginModule } from "../testing/create-plugin-module"
import { log } from "../shared/logger"
import { createV1PluginInput, type PluginInputReport } from "./adapter/plugin-input"
import type { V2ContextLike } from "./adapter/types"

export const RUNTIME_LOG_PREFIX = "[omo-v2] runtime"

export type OpenCodeV2RuntimeReport = {
  readonly directory: string
  readonly worktree: string
  readonly projectID: string
  readonly hasServerUrl: boolean
  readonly hookCount: number
  readonly hookKeys: readonly string[]
  readonly toolCount: number
  readonly toolNames: readonly string[]
  readonly managerNames: readonly string[]
  readonly skillCount: number
  readonly agentCount: number
  readonly durationMs: number
}

export type OpenCodeV2Runtime = {
  readonly hooks: Hooks
  readonly tools: Readonly<Record<string, unknown>>
  readonly managers: Managers
  readonly report: OpenCodeV2RuntimeReport
  /** Releases this reference; the V1 `dispose` runs when the last one goes. Safe to call twice. */
  readonly dispose: () => Promise<void>
}

type AssemblyCapture = {
  managers?: Managers
  toolCount?: number
  skillCount?: number
}

type RuntimeState = {
  readonly runtime: OpenCodeV2Runtime
  references: number
}

let state: RuntimeState | undefined

/** Hook keys the port counts as hooks; `tool` and `dispose` are lifecycle, not hook entries. */
const NON_HOOK_KEYS = new Set(["tool", "dispose"])

function hookKeysOf(hooks: Hooks): string[] {
  return Object.keys(hooks)
    .filter((key) => !NON_HOOK_KEYS.has(key))
    .sort()
}

function managerNamesOf(managers: Managers): string[] {
  return Object.entries(managers)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key]) => key)
    .sort()
}

function toolsOf(hooks: Hooks): Record<string, unknown> {
  const tool = hooks.tool
  if (tool === undefined) return {}
  return tool as unknown as Record<string, unknown>
}

function errorDetail(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { message: error.message }
      : { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

/**
 * Runs the V1 assembly. Exported for the selftest and for a future stage that needs a second,
 * isolated instance; production code goes through `createOpenCodeV2Runtime`.
 */
export async function assembleV1RuntimeOnV2(context: V2ContextLike): Promise<OpenCodeV2Runtime> {
  const startedAt = Date.now()
  const { input, report } = createV1PluginInput(context)
  const capture: AssemblyCapture = {}

  const pluginModule = createPluginModule({
    createManagers: (args) => {
      const managers = createV1Managers(args)
      capture.managers = managers
      return managers
    },
    createTools: async (args) => {
      const result = await createV1Tools(args)
      capture.toolCount = Object.keys(result.filteredTools).length
      capture.skillCount = result.mergedSkills.length
      return result
    },
  })

  const hooks = await pluginModule.server(input, {})

  const managers = capture.managers
  if (managers === undefined) {
    throw new Error("[omo-v2] V1 assembly did not build managers; runtime is unusable")
  }

  const tools = toolsOf(hooks)
  const hookKeys = hookKeysOf(hooks)
  const managerNames = managerNamesOf(managers)
  const agentCount = BuiltinAgentNameSchema.options.length
  const durationMs = Date.now() - startedAt

  let disposed = false
  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    try {
      await hooks.dispose?.()
    } catch (error) {
      log("[omo-v2] runtime dispose failed", errorDetail(error))
    }
    log("[omo-v2] runtime disposed")
  }

  const runtimeReport: OpenCodeV2RuntimeReport = {
    ...summaryOf(report),
    hookCount: hookKeys.length,
    hookKeys,
    toolCount: Object.keys(tools).length,
    toolNames: Object.keys(tools).sort(),
    managerNames,
    skillCount: capture.skillCount ?? 0,
    agentCount,
    durationMs,
  }

  return {
    hooks,
    tools,
    managers,
    report: runtimeReport,
    dispose,
  }
}

function summaryOf(report: PluginInputReport): Pick<
  OpenCodeV2RuntimeReport,
  "directory" | "worktree" | "projectID" | "hasServerUrl"
> {
  return {
    directory: report.directory,
    worktree: report.worktree,
    projectID: report.projectID,
    hasServerUrl: report.hasServerUrl,
  }
}

/**
 * One structured, greppable line per assembly (S2a acceptance reads it verbatim), plus a detail
 * line with the payloads an operator needs when a count looks wrong.
 */
function logAssembly(runtime: OpenCodeV2Runtime, references: number): void {
  const report = runtime.report
  log(
    `${RUNTIME_LOG_PREFIX} assembled hooks=${report.hookCount} hookKeys=${report.hookKeys.join(",")} tools=${report.toolCount} managers=${report.managerNames.join(",")} agents=${report.agentCount}`,
  )
  log(`${RUNTIME_LOG_PREFIX} assembled detail`, {
    directory: report.directory,
    worktree: report.worktree,
    projectID: report.projectID,
    hasServerUrl: report.hasServerUrl,
    hookCount: report.hookCount,
    hookKeys: report.hookKeys,
    toolCount: report.toolCount,
    toolNames: report.toolNames,
    managers: report.managerNames,
    skillCount: report.skillCount,
    agentCount: report.agentCount,
    durationMs: report.durationMs,
    references,
  })
}

/**
 * Assembles (or reuses) the V1 runtime for a V2 host location. Returns `undefined` when assembly
 * fails, after logging the full error: a broken port must degrade to "plugin loaded, engine
 * inactive", never to a host that refuses to start.
 */
export async function createOpenCodeV2Runtime(
  context: V2ContextLike,
): Promise<OpenCodeV2Runtime | undefined> {
  if (state !== undefined) {
    state.references += 1
    const reused = state.runtime
    log(`${RUNTIME_LOG_PREFIX} reused`, {
      references: state.references,
      directory: reused.report.directory,
      hookCount: reused.report.hookCount,
      toolCount: reused.report.toolCount,
    })
    return { ...reused, dispose: createRelease() }
  }

  try {
    const runtime = await assembleV1RuntimeOnV2(context)
    state = { runtime, references: 1 }
    logAssembly(runtime, state.references)
    return { ...runtime, dispose: createRelease() }
  } catch (error) {
    const detail = errorDetail(error)
    console.error(`${RUNTIME_LOG_PREFIX} assembly failed: ${detail.message}`)
    log(`${RUNTIME_LOG_PREFIX} assembly failed`, detail)
    return undefined
  }
}

/** Each setup call gets its own release, and releasing it twice never eats a second reference. */
function createRelease(): () => Promise<void> {
  let released = false
  return async (): Promise<void> => {
    if (released) return
    released = true
    await releaseReference()
  }
}

async function releaseReference(): Promise<void> {
  const current = state
  if (current === undefined) return
  current.references -= 1
  if (current.references > 0) {
    log(`${RUNTIME_LOG_PREFIX} reference released`, { references: current.references })
    return
  }
  state = undefined
  await current.runtime.dispose()
}

/** Test hook: drops the singleton without running dispose. */
export function _resetOpenCodeV2RuntimeForTesting(): void {
  state = undefined
}

export function getOpenCodeV2Runtime(): OpenCodeV2Runtime | undefined {
  return state?.runtime
}
