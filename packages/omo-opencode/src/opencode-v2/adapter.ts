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
 * plugin logger and `console.error` with the stage it failed at and a summary of what was already
 * built; everything already built is disposed first (managers, hooks, the runtime skill-source
 * port), then `createOpenCodeV2Runtime` resolves `undefined`.
 *
 * Lifetime: one runtime per host *location* (`ctx.location.directory`), each with its own
 * reference count. V2 calls `setup` once per location, and the V1 client shim bakes the location
 * directory into every session it translates, so two locations must never share a runtime. Within
 * one location a second `setup` reuses the instance, and concurrent setups await the single
 * in-flight assembly instead of racing a second one into existence. The V1 `dispose` runs once,
 * when the last reference of that location is released.
 */
import type { Hooks } from "@opencode-ai/plugin"

import { BuiltinAgentNameSchema } from "../config/schema/agent-names"
import { validatePluginConfig, type PluginConfigValidation } from "../config/validate"
import { createHooks as createV1Hooks, type CreatedHooks } from "../create-hooks"
import { createManagers as createV1Managers, type Managers } from "../create-managers"
import { createPluginInterface as createV1PluginInterface } from "../plugin-interface"
import { createTools as createV1Tools } from "../create-tools"
import { createRuntimeSkillSourceServer } from "../features/opencode-runtime-skills"
import { createPluginModule } from "../testing/create-plugin-module"
import { log } from "../shared/logger"
import { createV1PluginInput, type PluginInputReport } from "./adapter/plugin-input"
import type { V2ContextLike } from "./adapter/types"
import {
  DISABLED_HOOKS_LOG_PREFIX,
  applyDisabledHooks,
  formatDisabledHooks,
  resolveDisabledHooks,
  type DisabledHookState,
} from "./hooks/disabled-hooks"

export const RUNTIME_LOG_PREFIX = "[omo-v2] runtime"
export const ASSEMBLY_LOG_PREFIX = "[omo-v2] assembly"

/**
 * Hook factories whose absence/presence is asserted: the ones the V2 defaults switch off, plus two
 * controls that must stay on. Reporting booleans (not the hook objects) keeps the report loggable.
 */
const REPORTED_HOOK_FACTORIES = [
  "claudeCodeHooks",
  "compactionContextInjector",
  "compactionTodoPreserver",
  "preemptiveCompaction",
  "todoContinuationEnforcer",
  "sessionNotification",
  "keywordDetector",
  "commentChecker",
] as const

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
  /** Real V1 hook names the V2 defaults (or the env/config override) switched off. */
  readonly disabledHooks: readonly string[]
  /** False when the hook factory was never called, i.e. the hook cannot fire at all. */
  readonly hookFactories: Readonly<Record<string, boolean>>
}

export type OpenCodeV2Runtime = {
  readonly hooks: Hooks
  readonly tools: Readonly<Record<string, unknown>>
  readonly managers: Managers
  readonly report: OpenCodeV2RuntimeReport
  /** Releases this reference; the V1 `dispose` runs when the last one of this location goes. */
  readonly dispose: () => Promise<void>
}

type RuntimeSkillSource = Awaited<ReturnType<typeof createRuntimeSkillSourceServer>>

/** What a half-built assembly managed to create; the failure path disposes exactly this. */
type AssemblyCapture = {
  stage: string
  managers?: Managers
  createdHooks?: CreatedHooks
  pluginInterface?: unknown
  runtimeSkillSource?: RuntimeSkillSource
  toolCount?: number
  skillCount?: number
  disabledHooks?: DisabledHookState
}

type RuntimeState = {
  readonly runtime: OpenCodeV2Runtime
  references: number
}

/** One runtime per host location; `""` is the key for a context without a usable directory. */
const runtimes = new Map<string, RuntimeState>()
/** One assembly per location: concurrent setups of the same location share this promise. */
const inFlight = new Map<string, Promise<OpenCodeV2Runtime | undefined>>()

/** Hook keys the port counts as hooks; `tool` and `dispose` are lifecycle, not hook entries. */
const NON_HOOK_KEYS = new Set(["tool", "dispose"])

/** Assembly stages in the order they run; a failure is tagged with the stage it happened at. */
export type AssemblyStage =
  | "runtime-skills"
  | "managers"
  | "tools"
  | "hooks"
  | "plugin-interface"

export type AssembleV1RuntimeOptions = {
  /** Extra names on top of the V2 defaults; the selftest uses this to prove the list is the gate. */
  readonly additionalDisabledHooks?: readonly string[]
  /**
   * Test-only fault injection: after the named stage has built its part, the assembly throws where a
   * real failure would surface. The selftest uses it to prove the stage tag, the release order of
   * whatever was already built, and that a failed assembly publishes no runtime — without having to
   * break a real dependency. Production callers never set it.
   */
  readonly failAtStage?: AssemblyStage
}

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

function hookFactoriesOf(hooks: CreatedHooks | undefined): Record<string, boolean> {
  const out: Record<string, boolean> = {}
  for (const name of REPORTED_HOOK_FACTORIES) {
    const value = (hooks as unknown as Record<string, unknown> | undefined)?.[name]
    out[name] = value !== undefined && value !== null
  }
  return out
}

function errorDetail(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack === undefined
      ? { message: error.message }
      : { message: error.message, stack: error.stack }
  }
  return { message: String(error) }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Best-effort teardown of a failed assembly. Every step is independent: a manager that never
 * started is skipped, and one that throws is reported without stopping the rest, because leaking
 * one timer is still better than leaking the port as well.
 */
async function disposePartialAssembly(capture: AssemblyCapture): Promise<{
  released: string[]
  failures: { step: string; error: string }[]
}> {
  const released: string[] = []
  const failures: { step: string; error: string }[] = []

  const attempt = async (step: string, action: () => void | Promise<void>): Promise<void> => {
    try {
      await action()
      released.push(step)
    } catch (error) {
      failures.push({ step, error: errorMessage(error) })
    }
  }

  const runtimeSkillSource = capture.runtimeSkillSource
  if (runtimeSkillSource !== undefined) {
    await attempt("runtimeSkillSource.stop", () => runtimeSkillSource.stop())
  }
  const createdHooks = capture.createdHooks
  if (createdHooks !== undefined) {
    await attempt("disposeHooks", () => createdHooks.disposeHooks())
  }
  const managers = capture.managers
  if (managers !== undefined) {
    const tuiStateMirror = managers.tuiStateMirror
    if (tuiStateMirror !== undefined) {
      await attempt("tuiStateMirror.stop", () => tuiStateMirror.stop())
    }
    await attempt("backgroundManager.shutdown", () => managers.backgroundManager.shutdown())
    await attempt("skillMcpManager.disconnectAll", () => managers.skillMcpManager.disconnectAll())
  }

  return { released, failures }
}

/**
 * Runs the V1 assembly. Exported for the selftest and for a future stage that needs a second,
 * isolated instance; production code goes through `createOpenCodeV2Runtime`.
 */
export async function assembleV1RuntimeOnV2(
  context: V2ContextLike,
  options: AssembleV1RuntimeOptions = {},
): Promise<OpenCodeV2Runtime> {
  const startedAt = Date.now()
  const { input, report } = createV1PluginInput(context)
  const capture: AssemblyCapture = { stage: "config" }
  // Injected only by the selftest: the throw is raised from inside the same override the real code
  // runs in, so the catch block below sees a genuine stage-tagged failure.
  const failIfInjected = (stage: AssemblyStage): void => {
    if (options.failAtStage === stage) {
      throw new Error(`[omo-v2] injected assembly failure at ${stage} (failAtStage, test-only)`)
    }
  }

  const pluginModule = createPluginModule({
    loadConfigChain: (directory: string): PluginConfigValidation => {
      const validation = validatePluginConfig(directory)
      const disabled = resolveDisabledHooks({
        env: process.env,
        configDisabledHooks: [
          ...(validation.config.disabled_hooks ?? []),
          ...(options.additionalDisabledHooks ?? []),
        ],
      })
      capture.disabledHooks = disabled
      return { ...validation, config: applyDisabledHooks(validation.config, disabled) }
    },
    createRuntimeSkillSourceServer: async (args) => {
      capture.stage = "runtime-skills"
      const server = await createRuntimeSkillSourceServer(args)
      capture.runtimeSkillSource = server
      failIfInjected("runtime-skills")
      return server
    },
    createManagers: (args) => {
      capture.stage = "managers"
      const managers = createV1Managers(args)
      capture.managers = managers
      failIfInjected("managers")
      return managers
    },
    createTools: async (args) => {
      capture.stage = "tools"
      const result = await createV1Tools(args)
      capture.toolCount = Object.keys(result.filteredTools).length
      capture.skillCount = result.mergedSkills.length
      failIfInjected("tools")
      return result
    },
    createHooks: (args) => {
      capture.stage = "hooks"
      const created = createV1Hooks(args)
      capture.createdHooks = created
      failIfInjected("hooks")
      return created
    },
    createPluginInterface: (args) => {
      capture.stage = "plugin-interface"
      const created = createV1PluginInterface(args)
      capture.pluginInterface = created
      failIfInjected("plugin-interface")
      return created
    },
  })

  try {
    const hooks = await pluginModule.server(input, {})
    capture.stage = "assembled"

    const managers = capture.managers
    if (managers === undefined) {
      throw new Error("[omo-v2] V1 assembly did not build managers; runtime is unusable")
    }

    const tools = toolsOf(hooks)
    const hookKeys = hookKeysOf(hooks)
    const managerNames = managerNamesOf(managers)
    const agentCount = BuiltinAgentNameSchema.options.length
    const durationMs = Date.now() - startedAt
    const disabledHooks = capture.disabledHooks ?? resolveDisabledHooks({ env: process.env })

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
      disabledHooks: disabledHooks.hooks,
      hookFactories: hookFactoriesOf(capture.createdHooks),
    }

    return {
      hooks,
      tools,
      managers,
      report: runtimeReport,
      dispose,
    }
  } catch (error) {
    const detail = errorDetail(error)
    const cleaned = await disposePartialAssembly(capture)
    const summary = {
      stage: capture.stage,
      managers: capture.managers === undefined ? [] : managerNamesOf(capture.managers),
      tools: capture.toolCount ?? 0,
      skills: capture.skillCount ?? 0,
      released: cleaned.released,
      releaseFailures: cleaned.failures,
      disabledHooks: capture.disabledHooks?.hooks ?? [],
    }
    // Structured, greppable and stage-tagged: "assembly failed at tools" tells an operator where to
    // look before reading the capture summary that follows on the same line.
    const line = `${ASSEMBLY_LOG_PREFIX} failed at ${capture.stage}: ${detail.message}`
    console.error(line)
    log(line, summary)
    throw error
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
  log(`${DISABLED_HOOKS_LOG_PREFIX}: ${formatDisabledHooks({ hooks: report.disabledHooks })}`, {
    hooks: report.disabledHooks,
    hookFactories: report.hookFactories,
    directory: report.directory,
  })
}

/** `ctx.location.directory`, or `""` when the context carries none (a host that cannot build one). */
export function locationKeyOf(context: unknown): string {
  const candidate = context as { readonly location?: { readonly directory?: unknown } } | undefined
  const directory = candidate?.location?.directory
  return typeof directory === "string" ? directory : ""
}

/**
 * Assembles (or reuses) the V1 runtime for a V2 host location. Returns `undefined` when assembly
 * fails, after logging the stage and disposing what was already built: a broken port must degrade
 * to "plugin loaded, engine inactive", never to a host that refuses to start.
 */
export async function createOpenCodeV2Runtime(
  context: V2ContextLike,
): Promise<OpenCodeV2Runtime | undefined> {
  const key = locationKeyOf(context)

  const existing = runtimes.get(key)
  if (existing !== undefined) {
    existing.references += 1
    logReused(existing)
    return { ...existing.runtime, dispose: createRelease(key) }
  }

  let pending = inFlight.get(key)
  if (pending === undefined) {
    pending = assembleForLocation(key, context)
    inFlight.set(key, pending)
  }
  // Awaiting the shared promise is what makes concurrent setups converge: only one assembly runs
  // and every caller increments the same reference count once it resolves.
  const runtime = await pending
  if (runtime === undefined) return undefined

  const state = runtimes.get(key)
  if (state === undefined) {
    // Assembly succeeded but the location vanished in between (a dispose of a zero-reference
    // state); returning undefined is honest: this call installed nothing.
    log(`${RUNTIME_LOG_PREFIX} assembly discarded`, { directory: key })
    return undefined
  }
  state.references += 1
  // The first owner is the one whose `setup` produced the runtime (already logged as `assembled`);
  // only a second owner of the same location is logged as a reuse.
  if (state.references > 1) logReused(state)
  return { ...state.runtime, dispose: createRelease(key) }
}

function logReused(state: RuntimeState): void {
  log(`${RUNTIME_LOG_PREFIX} reused`, {
    references: state.references,
    directory: state.runtime.report.directory,
    hookCount: state.runtime.report.hookCount,
    toolCount: state.runtime.report.toolCount,
  })
}

/** Single assembly per location; never rejects, removes its in-flight entry when it settles. */
async function assembleForLocation(
  key: string,
  context: V2ContextLike,
): Promise<OpenCodeV2Runtime | undefined> {
  try {
    const runtime = await assembleV1RuntimeOnV2(context)
    runtimes.set(key, { runtime, references: 0 })
    logAssembly(runtime, 1)
    return runtime
  } catch {
    // `assembleV1RuntimeOnV2` already logged the stage, the capture summary and the cleanup.
    return undefined
  } finally {
    inFlight.delete(key)
  }
}

/** Each setup call gets its own release, and releasing it twice never eats a second reference. */
function createRelease(key: string): () => Promise<void> {
  let released = false
  return async (): Promise<void> => {
    if (released) return
    released = true
    await releaseReference(key)
  }
}

async function releaseReference(key: string): Promise<void> {
  const current = runtimes.get(key)
  if (current === undefined) return
  current.references -= 1
  if (current.references > 0) {
    log(`${RUNTIME_LOG_PREFIX} reference released`, { references: current.references })
    return
  }
  // Drop the entry before awaiting dispose: a setup that lands during teardown then assembles its
  // own runtime instead of reusing one that is closing.
  runtimes.delete(key)
  await current.runtime.dispose()
}

/**
 * Test-only accessors. Deliberately not a public runtime lookup with `dispose` attached: a caller
 * that could dispose the shared instance would bypass the reference count of every other setup.
 */
export function _getOpenCodeV2RuntimeForTesting(
  locationKey?: string,
): OpenCodeV2Runtime | undefined {
  if (locationKey === undefined) {
    return runtimes.values().next().value?.runtime
  }
  return runtimes.get(locationKey)?.runtime
}

export function _runtimeLocationKeysForTesting(): string[] {
  return [...runtimes.keys()].sort()
}

/** Test hook: drops every runtime without running dispose. */
export function _resetOpenCodeV2RuntimeForTesting(): void {
  runtimes.clear()
  inFlight.clear()
}
