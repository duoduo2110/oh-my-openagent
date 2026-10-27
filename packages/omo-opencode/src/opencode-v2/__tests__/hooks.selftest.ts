/**
 * S2b-1 selftest: the mechanical hook bridge, driven by a fake OpenCode V2 context.
 *
 * Run inside the v2 container (the repo has no host node_modules):
 *
 *   bun packages/omo-opencode/src/opencode-v2/__tests__/hooks.selftest.ts
 *
 * The V1 runtime is the real one (`assembleV1RuntimeOnV2`), so the evidence is "the V1 handler ran
 * and its mutation came back to the V2 event object", not "a stub was called":
 *
 *   event            fake AsyncIterable -> V1 `event` handler, counters, and a pump that stops
 *   tool.execute.before   real V1 handler: `mcp_` prefix strip + bash null-byte strip are written
 *                         back into `event.tool` / `event.input`
 *   tool.execute.after    V1 handler chain + a recording wrapper: result text/metadata write back,
 *                         and an error event never throws out of the bridge
 *   tool.definition       real V1 `todowrite` description override lands through `editor.update()`
 *   compaction            context strings land in `input.system`, an `enabled=false` decision is
 *                         counted as dropped (V2 has no such switch), and neither handler may throw
 *   command.execute.before V2 2.1.4 has no hook slot: asserted as a recorded degradation
 *
 * Everything runs under a throwaway HOME/XDG sandbox so the real plugin config is never touched.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { V2ContextLike } from "../adapter/types"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "omo-v2-hooks-selftest-"))
const projectDir = path.join(sandbox, "project")
const configDir = path.join(sandbox, "config")
fs.mkdirSync(projectDir, { recursive: true })
fs.mkdirSync(path.join(configDir, "opencode"), { recursive: true })

process.env["HOME"] = sandbox
process.env["XDG_CONFIG_HOME"] = configDir
process.env["XDG_DATA_HOME"] = path.join(sandbox, "data")
process.env["XDG_STATE_HOME"] = path.join(sandbox, "state")
process.env["XDG_CACHE_HOME"] = path.join(sandbox, "cache")
process.env["DO_NOT_TRACK"] = "1"

type Check = { readonly name: string; readonly ok: boolean; readonly detail: string }
const checks: Check[] = []
const pendingCleanups: Array<() => Promise<void>> = []

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(10)
  }
  return predicate()
}

function createBaseContext(directory: string): Record<string, unknown> {
  return {
    location: {
      directory,
      project: { id: "prj_selftest", directory, canonical: directory },
    },
    app: { name: "omo-v2-hooks-selftest", version: "0.0.0", channel: "local" },
    session: {
      list: async () => ({ data: [], cursor: {} }),
      get: async () => ({ id: "ses_selftest", projectID: "prj_selftest" }),
      create: async () => ({ id: "ses_selftest", projectID: "prj_selftest" }),
      context: async () => [],
      active: async () => ({}),
      interrupt: async () => undefined,
      prompt: async () => ({ id: "msg_selftest" }),
      compact: async () => ({ id: "msg_compact" }),
    },
    agent: { list: async () => ({ location: { directory }, data: [] }) },
    model: { list: async () => ({ location: { directory }, data: [] }) },
    provider: { list: async () => ({ location: { directory }, data: [] }) },
    skill: {},
  }
}

type Registration = { readonly name: string; readonly callback: (input: unknown) => unknown; disposed: boolean }

/**
 * Controllable AsyncIterable: the test pushes events and can prove the pump stops consuming after
 * cleanup (the queue is closed and the abort signal fires).
 */
function createEventStream(settings: { readonly closeOnAbort?: boolean } = {}): {
  readonly aborted: () => boolean
  readonly push: (event: unknown) => void
  readonly subscribe: (options: { readonly signal: AbortSignal }) => AsyncIterable<unknown>
} {
  const queue: unknown[] = []
  let waiter: ((result: IteratorResult<unknown>) => void) | undefined
  let closed = false
  let aborted = false

  const finish = (): void => {
    closed = true
    const pending = waiter
    waiter = undefined
    pending?.({ value: undefined, done: true })
  }

  const iterator = {
    next: (): Promise<IteratorResult<unknown>> => {
      if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
      if (closed) return Promise.resolve({ value: undefined, done: true })
      return new Promise<IteratorResult<unknown>>((resolve) => {
        waiter = resolve
      })
    },
  }

  return {
    aborted: () => aborted,
    push: (event) => {
      if (closed) return
      const pending = waiter
      if (pending !== undefined) {
        waiter = undefined
        pending({ value: event, done: false })
        return
      }
      queue.push(event)
    },
    subscribe: (options) => {
      options.signal.addEventListener("abort", () => {
        aborted = true
        if (settings.closeOnAbort !== false) finish()
      })
      if (options.signal.aborted) finish()
      return { [Symbol.asyncIterator]: () => iterator }
    },
  }
}

function createFakeEditor(tools: Record<string, unknown>[]): Record<string, unknown> {
  return {
    list: () => tools,
    get: (id: unknown) => tools.find((tool) => tool["id"] === id),
    add: () => undefined,
    remove: () => undefined,
    update: (id: unknown, update: (tool: unknown) => void) => {
      const tool = tools.find((entry) => entry["id"] === id)
      if (tool !== undefined) update(tool)
    },
  }
}

async function main(): Promise<void> {
  const adapter = await import("../adapter")
  const hooksModule = await import("../hooks")
  const { TODOWRITE_DESCRIPTION } = await import("../../hooks/todo-description-override/description")

  const runtime = await adapter.assembleV1RuntimeOnV2(
    createBaseContext(projectDir) as unknown as V2ContextLike,
  )
  record("V1 runtime assembled", runtime.report.hookCount > 0, `${runtime.report.hookCount} hooks`)

  // Recording wrappers around the real V1 handlers: the bridge must call these, and the assertions
  // are about what the *real* handler then did to the V2 event object.
  const calls = { event: 0, after: 0, compacting: 0, autocontinue: 0 }

  const realEvent = runtime.hooks.event
  runtime.hooks.event = async (input) => {
    calls.event += 1
    await realEvent?.(input)
  }
  const realAfter = runtime.hooks["tool.execute.after"]
  runtime.hooks["tool.execute.after"] = async (input, output) => {
    calls.after += 1
    await realAfter?.(input, output)
    output.output = `${output.output}|bridged`
    output.metadata["bridged"] = true
  }
  const realCompacting = runtime.hooks["experimental.session.compacting"]
  runtime.hooks["experimental.session.compacting"] = async (input, output) => {
    calls.compacting += 1
    await realCompacting?.(input, output)
    output.context.push("SELFTEST_CONTEXT")
  }
  const realAutocontinue = runtime.hooks["experimental.compaction.autocontinue"]
  runtime.hooks["experimental.compaction.autocontinue"] = async (input, output) => {
    calls.autocontinue += 1
    await realAutocontinue?.(input, output)
    output.enabled = false
  }

  const stream = createEventStream()
  const registrations: Registration[] = []
  let transformDisposed = 0

  // The host's tool list, as `tools.ts` (S1a) left it, plus an `add()` recorder: the hook bridge
  // must read this list and never add to it.
  const hostTools: Record<string, unknown>[] = [
    { name: "grep", description: "Fast content search tool with safety limits (bridged from V1)." },
    { name: "glob", description: "Fast file pattern matching tool with safety limits (bridged from V1)." },
    { name: "task", description: "host builtin task" },
  ]
  const hostToolNamesBefore = hostTools.map((tool) => tool["name"]).join(",")
  const addedTools: string[] = []

  const definitionTools: Record<string, unknown>[] = [
    { id: "todowrite", name: "todowrite", description: "original description", input: { type: "object" } },
    { id: "grep", name: "grep", description: "grep description", input: { type: "object" } },
  ]

  const baseContext = createBaseContext(projectDir)
  const context = {
    ...baseContext,
    event: { subscribe: stream.subscribe },
    tool: {
      list: async () => [...hostTools],
      add: async (tool: unknown) => {
        addedTools.push(String((tool as { name?: unknown }).name))
        return { dispose: async () => undefined }
      },
      hook: async (name: string, callback: (input: unknown) => unknown) => {
        const registration: Registration = { name, callback, disposed: false }
        registrations.push(registration)
        return {
          dispose: async () => {
            registration.disposed = true
          },
        }
      },
      transform: async (callback: (editor: unknown) => unknown) => {
        await callback(createFakeEditor(definitionTools))
        return {
          dispose: async () => {
            transformDisposed += 1
          },
        }
      },
    },
    session: {
      ...(baseContext["session"] as Record<string, unknown>),
      hook: async (name: string, callback: (input: unknown) => unknown) => {
        const registration: Registration = { name, callback, disposed: false }
        registrations.push(registration)
        return {
          dispose: async () => {
            registration.disposed = true
          },
        }
      },
    },
    command: { list: async () => [], transform: async () => ({ dispose: async () => undefined }), reload: async () => undefined },
  }

  const cleanup = await hooksModule.registerOpenCodeV2Hooks(context, runtime)
  pendingCleanups.push(cleanup)

  const snapshot = hooksModule.readOpenCodeV2HookBridge()
  const bridged = snapshot?.bridged ?? []
  const expectedBridged = [
    "tool.execute.before",
    "tool.execute.after",
    "tool.definition",
    "experimental.session.compacting",
    "experimental.compaction.autocontinue",
    "event",
  ]
  record(
    "bridged keys",
    expectedBridged.every((key) => bridged.includes(key)) && bridged.length === expectedBridged.length,
    bridged.join(","),
  )
  record(
    "registered V2 slots",
    registrations.map((entry) => entry.name).sort().join(",") === "compaction,execute.after,execute.before",
    registrations.map((entry) => entry.name).join(","),
  )

  // ---- hook disable list + tool ownership --------------------------------------------------
  const disabledNames = snapshot?.disabled ?? []
  const expectedDisabled = [
    "claude-code-hooks",
    "compaction-context-injector",
    "compaction-todo-preserver",
    "preemptive-compaction",
    "session-notification",
    "todo-continuation-enforcer",
  ]
  const missingDisabled = expectedDisabled.filter((name) => !disabledNames.includes(name))
  record(
    "disabled hook list reaches the bridge",
    missingDisabled.length === 0,
    missingDisabled.length === 0 ? disabledNames.join(",") : `missing ${missingDisabled.join(",")}`,
  )
  const factoriesToCheck: ReadonlyArray<readonly [string, string]> = [
    ["claude-code-hooks", "claudeCodeHooks"],
    ["compaction-context-injector", "compactionContextInjector"],
    ["compaction-todo-preserver", "compactionTodoPreserver"],
    ["preemptive-compaction", "preemptiveCompaction"],
    ["session-notification", "sessionNotification"],
    ["todo-continuation-enforcer", "todoContinuationEnforcer"],
  ]
  const disabledFactories = factoriesToCheck
    .filter(([, factory]) => runtime.report.hookFactories[factory] !== false)
    .map(([hook]) => hook)
  record(
    "disabled hooks are never assembled (cannot fire)",
    disabledFactories.length === 0,
    disabledFactories.length === 0 ? "all six factories absent" : `still assembled: ${disabledFactories.join(",")}`,
  )
  record(
    "unrelated hooks are still assembled (still fire)",
    runtime.report.hookFactories["keywordDetector"] === true
      && runtime.report.hookFactories["commentChecker"] === true,
    `keywordDetector=${String(runtime.report.hookFactories["keywordDetector"])} commentChecker=${String(runtime.report.hookFactories["commentChecker"])}`,
  )

  const toolProbe = snapshot?.tools
  record(
    "hook bridge registers no tool",
    addedTools.length === 0
      && hostTools.map((tool) => tool["name"]).join(",") === hostToolNamesBefore,
    `added=${addedTools.length} listed=${hostTools.map((tool) => tool["name"]).join(",")}`,
  )
  record(
    "tool ownership: grep listed once with the V1 description",
    toolProbe !== undefined
      && toolProbe.available
      && toolProbe.grepCount === 1
      && (toolProbe.grepDescription ?? "").startsWith("Fast content search tool with safety limits")
      && toolProbe.hooksToolCount > 0
      && toolProbe.bridgeRegistersTools === false,
    `count=${String(toolProbe?.count)} grepCount=${String(toolProbe?.grepCount)} hooksToolCount=${String(toolProbe?.hooksToolCount)}`,
  )

  const degradedKeys = (snapshot?.degraded ?? []).map((entry) => entry.key)
  const commandDegradation = (snapshot?.degraded ?? []).find(
    (entry) => entry.key === "command.execute.before",
  )
  record(
    "command.execute.before degraded with reason",
    commandDegradation !== undefined && commandDegradation.reason.includes("no hook()"),
    commandDegradation?.reason ?? "missing degradation entry",
  )
  record(
    "compaction field gaps recorded",
    degradedKeys.filter((key) => key === "experimental.compaction.autocontinue").length >= 2,
    degradedKeys.join(","),
  )

  const pumpStarted = await waitFor(() => hooksModule.readOpenCodeV2HookBridge()?.pump.started === true)
  record("event pump started", pumpStarted, pumpStarted ? "subscribed" : "never subscribed")

  // ---- pump lifecycle in isolation: an event after stop() must not be counted ---------------
  {
    const pumpModule = await import("../hooks/event-pump")
    const lateStream = createEventStream()
    let consumed = 0
    const pump = pumpModule.startEventPump({
      subscribe: lateStream.subscribe,
      onEvent: () => {
        consumed += 1
      },
      onError: () => undefined,
      stopTimeoutMs: 100,
    })
    await waitFor(() => pump.stats().started)
    lateStream.push({ type: "ping" })
    await waitFor(() => pump.stats().processed >= 1)
    const stopped = await pump.stop()
    const processedAtStop = stopped.processed
    record(
      "pump stops within its timeout budget",
      stopped.stopped === true && processedAtStop >= 1,
      JSON.stringify(stopped),
    )
    record("pump aborts the subscription", lateStream.aborted(), "signal fired")

    // A stream that ignores the abort must not keep the counters moving after stop().
    const stubbornStream = createEventStream({ closeOnAbort: false })
    const stubborn = pumpModule.startEventPump({
      subscribe: stubbornStream.subscribe,
      onEvent: () => {
        consumed += 1
      },
      onError: () => undefined,
      stopTimeoutMs: 100,
    })
    await waitFor(() => stubborn.stats().started)
    stubbornStream.push({ type: "ping" })
    await waitFor(() => stubborn.stats().processed >= 1)
    const stubbornAtStop = (await stubborn.stop()).processed
    stubbornStream.push({ type: "late" })
    await sleep(50)
    record(
      "counters freeze after stop (stubborn stream)",
      stubborn.stats().processed === stubbornAtStop && stubbornAtStop >= 1,
      `processed=${stubborn.stats().processed} stopped=${String(stubborn.stats().stopped)}`,
    )
  }

  // ---- tool.execute.before ----------------------------------------------------------------
  const beforeRegistration = registrations.find((entry) => entry.name === "execute.before")
  if (beforeRegistration === undefined) {
    record("execute.before registered", false, "missing registration")
  } else {
    const prefixed = {
      tool: "mcp_background_output",
      sessionID: "ses_selftest",
      agent: "sisyphus",
      messageID: "msg_1",
      id: "call_prefixed",
      input: { task_id: "bg_1" },
    }
    await beforeRegistration.callback(prefixed)
    record(
      "before rewrite: mcp_ prefix strip written back",
      prefixed.tool === "background_output",
      `event.tool=${prefixed.tool}`,
    )

    const nullBytes = {
      tool: "bash",
      sessionID: "ses_selftest",
      agent: "sisyphus",
      messageID: "msg_2",
      id: "call_null",
      input: { command: "echo\u0000 hi", description: "selftest" },
    }
    await beforeRegistration.callback(nullBytes)
    const command = (nullBytes.input as { command?: string }).command ?? ""
    record(
      "before rewrite: bash null bytes written back",
      command === "echo hi",
      JSON.stringify(command),
    )
    const beforeCounter = hooksModule.readOpenCodeV2HookBridge()?.counters["tool.execute.before"]
    record(
      "before counters",
      beforeCounter !== undefined && beforeCounter.fired === 2 && beforeCounter.writebacks === 2,
      JSON.stringify(beforeCounter),
    )
  }

  // ---- tool.execute.after -----------------------------------------------------------------
  const afterRegistration = registrations.find((entry) => entry.name === "execute.after")
  if (afterRegistration === undefined) {
    record("execute.after registered", false, "missing registration")
  } else {
    const completed = {
      // A tool name no V1 after-hook rewrites, so the assertion measures the bridge writeback only.
      tool: "omo_selftest_tool",
      sessionID: "ses_selftest",
      agent: "sisyphus",
      messageID: "msg_3",
      id: "call_ok",
      input: { pattern: "x" },
      status: "completed",
      result: { output: "line1\nline2", metadata: { lines: 2 } },
    }
    await afterRegistration.callback(completed)
    const result = completed.result as { output?: string; metadata?: Record<string, unknown> }
    record(
      "after writeback: result text",
      result.output === "line1\nline2|bridged",
      JSON.stringify(result.output),
    )
    record(
      "after writeback: result metadata",
      result.metadata?.["bridged"] === true && result.metadata?.["lines"] === 2,
      JSON.stringify(result.metadata),
    )
    record("after ran real V1 handler", calls.after === 1, `calls=${calls.after}`)

    let threw = false
    try {
      await afterRegistration.callback({
        tool: "fail_tool",
        sessionID: "ses_selftest",
        agent: "sisyphus",
        messageID: "msg_4",
        id: "call_err",
        input: {},
        status: "error",
        error: { message: "boom", metadata: {} },
      })
      await afterRegistration.callback({ not: "an event" })
    } catch (error) {
      threw = true
      record("after never throws", false, String(error))
    }
    if (!threw) record("after never throws", true, "error status + malformed event contained")
  }

  // ---- tool.definition --------------------------------------------------------------------
  const todo = definitionTools.find((tool) => tool["id"] === "todowrite") as
    | { description?: string }
    | undefined
  const grep = definitionTools.find((tool) => tool["id"] === "grep") as
    | { description?: string }
    | undefined
  record(
    "tool.definition writeback: todowrite description",
    todo?.description === TODOWRITE_DESCRIPTION,
    `${String(todo?.description).slice(0, 40)}…`,
  )
  record(
    "tool.definition leaves other tools alone",
    grep?.description === "grep description",
    String(grep?.description),
  )

  // ---- compaction -------------------------------------------------------------------------
  const compactionRegistration = registrations.find((entry) => entry.name === "compaction")
  if (compactionRegistration === undefined) {
    record("compaction registered", false, "missing registration")
  } else {
    const compactionEvent: Record<string, unknown> = {
      sessionID: "ses_selftest",
      agent: "sisyphus",
      model: { providerID: "provider", modelID: "model" },
      system: [],
      messages: [],
      tools: {},
      options: {},
    }
    let compactionThrew = false
    try {
      await compactionRegistration.callback(compactionEvent)
    } catch (error) {
      compactionThrew = true
      record("compaction never throws", false, String(error))
    }
    const system = compactionEvent["system"] as Array<{ type?: string; text?: string }>
    record(
      "compaction writeback: V1 context in system",
      system.some((part) => part.type === "text" && part.text === "SELFTEST_CONTEXT"),
      `systemParts=${system.length}`,
    )
    record("compaction ran real V1 handler", calls.compacting === 1, `calls=${calls.compacting}`)
    record("autocontinue ran real V1 handler", calls.autocontinue === 1, `calls=${calls.autocontinue}`)
    const autocontinueCounter = hooksModule.readOpenCodeV2HookBridge()?.counters[
      "experimental.compaction.autocontinue"
    ]
    record(
      "autocontinue enabled=false recorded as dropped",
      autocontinueCounter !== undefined && autocontinueCounter.dropped >= 1,
      JSON.stringify(autocontinueCounter),
    )
    if (!compactionThrew) record("compaction never throws", true, "handler contained")
  }

  // ---- event pump processing --------------------------------------------------------------
  stream.push({ id: "evt_1", type: "session.idle", data: { sessionID: "ses_selftest" } })
  const delivered = await waitFor(
    () => (hooksModule.readOpenCodeV2HookBridge()?.counters["event"]?.fired ?? 0) >= 1,
  )
  record("event delivered to V1 handler", delivered && calls.event >= 1, `calls=${calls.event}`)

  // ---- idempotency ------------------------------------------------------------------------
  const registrationsBefore = registrations.length
  const secondCleanup = await hooksModule.registerOpenCodeV2Hooks(context, runtime)
  pendingCleanups.push(secondCleanup)
  record(
    "second registration reuses the install",
    registrations.length === registrationsBefore,
    `slots=${registrations.length} (before ${registrationsBefore})`,
  )
  const countersAfterSecond = hooksModule.readOpenCodeV2HookBridge()?.counters["event"]?.fired ?? 0
  record(
    "reuse keeps counters",
    countersAfterSecond >= 1,
    `event.fired=${countersAfterSecond}`,
  )

  // ---- cleanup ----------------------------------------------------------------------------
  // Two registrations took two references, so the first release must NOT tear the bridge down.
  await secondCleanup()
  record(
    "reference count keeps the bridge alive",
    hooksModule.readOpenCodeV2HookBridge()?.pump.stopped === false && stream.aborted() === false,
    "one reference left",
  )

  stream.push({ id: "evt_2", type: "session.idle", data: { sessionID: "ses_selftest" } })
  const stillLive = await waitFor(() => (hooksModule.readOpenCodeV2HookBridge()?.pump.processed ?? 0) >= 2)
  record("bridge still consumes events", stillLive, `processed=${hooksModule.readOpenCodeV2HookBridge()?.pump.processed}`)

  const processedBeforeStop = hooksModule.readOpenCodeV2HookBridge()?.pump.processed ?? 0
  await cleanup()

  const snapshotAfterCleanup = hooksModule.readOpenCodeV2HookBridge()
  record("pump aborted on full release", stream.aborted(), stream.aborted() ? "signal fired" : "no abort")
  record(
    "pump stopped on full release",
    snapshotAfterCleanup?.pump.stopped === true,
    JSON.stringify(snapshotAfterCleanup?.pump),
  )
  record(
    "registrations disposed",
    registrations.every((entry) => entry.disposed) && transformDisposed === 1,
    `disposed=${registrations.filter((entry) => entry.disposed).length}/${registrations.length} transform=${transformDisposed}`,
  )

  stream.push({ id: "evt_3", type: "session.idle", data: { sessionID: "ses_selftest" } })
  await sleep(50)
  const processedAfterStop = hooksModule.readOpenCodeV2HookBridge()?.pump.processed ?? 0
  record(
    "counters frozen after cleanup",
    processedAfterStop === processedBeforeStop,
    `processed=${processedAfterStop} (before ${processedBeforeStop})`,
  )

  await cleanup()
  const finalSnapshot = hooksModule.readOpenCodeV2HookBridge()
  record(
    "double cleanup is safe",
    finalSnapshot?.pump.stopped === true && finalSnapshot.bridged.length > 0,
    `bridged=${finalSnapshot?.bridged.length ?? 0} stopped=${finalSnapshot?.pump.stopped}`,
  )

  await runtime.dispose()
  hooksModule._resetOpenCodeV2HooksForTesting()
}

try {
  await main()
} catch (error) {
  console.error("selftest crashed:", error)
  process.exitCode = 1
} finally {
  for (const cleanup of pendingCleanups) {
    try {
      await cleanup()
    } catch (error) {
      console.error("cleanup failed:", error)
    }
  }
  fs.rmSync(sandbox, { recursive: true, force: true })
}

const failed = checks.filter((check) => !check.ok)
console.log(`\nS2b-1 hooks selftest: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map((check) => check.name).join(", ")}`)
  process.exitCode = 1
}
