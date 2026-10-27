/**
 * OpenCode V2 hook bridge (S2b-1 mechanical keys, S2b-2 semantic keys).
 *
 * The V1 engine owns behaviour; this module only re-points V2 hook slots at the corresponding V1
 * handlers:
 *
 *   V1 key                                   V2 slot
 *   event                                    ctx.event.subscribe({ signal })  (async pump)
 *   tool.execute.before                      ctx.tool.hook("execute.before")
 *   tool.execute.after                       ctx.tool.hook("execute.after")
 *   tool.definition                          ctx.tool.transform(editor)       (per tool)
 *   command.execute.before                   — none in V2 2.1.4 (degraded, recorded)
 *   experimental.session.compacting          ctx.session.hook("compaction")
 *   experimental.compaction.autocontinue     ctx.session.hook("compaction")
 *   chat.message                             ctx.session.hook("prompt")           (S2b-2)
 *   experimental.chat.system.transform       ctx.session.hook("context")          (S2b-2)
 *   experimental.chat.messages.transform     ctx.session.hook("context")          (S2b-2)
 *   chat.params                              ctx.session.hook("context")          (S2b-2)
 *   chat.headers                             ctx.session.hook("http.request")     (S2b-2)
 *
 * The semantic adaptations live in `./hooks/semantic-hooks` (V1 `{info, parts}` <-> V2 provider
 * `Message[]`, `string[]` <-> `SystemPart[]`, and the options mapping).
 *
 * Payload contracts verified against the host packages, not guessed:
 *   - `ToolDomain.hook(name, cb)` passes ONE mutable event object per call
 *     (`{ tool, sessionID, agent, messageID, id, input }` for `execute.before`;
 *     `{ ...same, status: "completed" | "error", result | error }` for `execute.after`).
 *   - `ToolEditor` exposes `list()` / `get(id)` / `update(id, fn)` where the tool's schema field is
 *     `input` (V1 calls it `parameters`).
 *   - `SessionHooks` is a keyed map (`prompt`, `context`, `compaction`, `model.request`,
 *     `http.request`, ...) and each callback gets one mutable event object.
 *   - `EventDomain.subscribe({ signal })` returns an `AsyncIterable` of `{ id, type, data, ... }`
 *     events, i.e. a *different* envelope than the V1 SDK's `{ type, properties }`.
 *
 * Every bridge point counts calls and logs `[omo-v2] hook <key> fired` for the first few, so an e2e
 * can prove the bridge really fired instead of inferring it. setup never blocks and never throws:
 * a missing V2 method degrades to a recorded entry, not to a host that refuses to start.
 *
 * Two boundaries this file enforces:
 *   - the hook disable list (`./hooks/disabled-hooks`) is applied at *assembly*, so a hook that
 *     would read a shim value with no V2 source never exists to fire; the bridge logs
 *     `[omo-v2] hooks disabled: ...` and keeps the list in its snapshot;
 *   - `hooks.tool` (the whole V1 tool registry) is **not** registered here. Tools come from
 *     `./tools` (S1a); registering the registry would silently replace the bridged tools. The
 *     bridge reads `ctx.tool.list()` once and logs the boundary instead.
 */
import type { Hooks } from "@opencode-ai/plugin"

import { log } from "../shared/logger"
import { locationKeyOf, type OpenCodeV2Runtime } from "./adapter"
import { captureSessionTodos } from "./adapter/client-shim"
import { noteSessionEvent } from "./adapter/status-registry"
import { asRecord, readString } from "./adapter/types"
import {
  DISABLED_HOOKS_LOG_PREFIX,
  formatDisabledHooks,
} from "./hooks/disabled-hooks"
import {
  EMPTY_EVENT_PUMP_STATS,
  startEventPump,
  type EventPumpHandle,
  type EventPumpStats,
} from "./hooks/event-pump"
import {
  planSemanticBridge,
  logSemanticPlan,
  SEMANTIC_SLOT_OF,
  type SemanticHookKey,
} from "./hooks/semantic-hooks"

export const HOOK_LOG_PREFIX = "[omo-v2] hook"

/** Per-key log budget: enough evidence for a grep, never a flood in a long session. */
const FIRE_LOG_LIMIT = 3
const DROP_LOG_LIMIT = 3

export const HOOK_KEY = {
  event: "event",
  toolBefore: "tool.execute.before",
  toolAfter: "tool.execute.after",
  toolDefinition: "tool.definition",
  commandBefore: "command.execute.before",
  compacting: "experimental.session.compacting",
  autocontinue: "experimental.compaction.autocontinue",
  // S2b-2 semantic keys (see ./hooks/semantic-hooks for the payload adaptations).
  chatMessage: "chat.message",
  chatParams: "chat.params",
  chatHeaders: "chat.headers",
  systemTransform: "experimental.chat.system.transform",
  messagesTransform: "experimental.chat.messages.transform",
} as const

/** V1 key -> V2 session.hook slot, re-exported so the bridge snapshot can state the mapping. */
export { SEMANTIC_SLOT_OF }

// ---------------------------------------------------------------------------------------------
// V2 structural views (the host package's private type graph is not importable from here)
// ---------------------------------------------------------------------------------------------

type HookRegistration = { readonly dispose: () => Promise<void> | void }
type HookCallback = (input: unknown) => unknown
type HookRegisterFn = (name: string, callback: HookCallback) => Promise<HookRegistration>
type ToolTransformFn = (callback: (editor: unknown) => unknown) => Promise<HookRegistration>
type ToolListFn = () => Promise<unknown>
type SubscribeFn = (options: { readonly signal: AbortSignal }) => AsyncIterable<unknown>

export type V2HookContextLike = {
  readonly location?: { readonly directory?: string }
  readonly event?: { readonly subscribe?: SubscribeFn }
  readonly tool?: {
    readonly hook?: HookRegisterFn
    readonly transform?: ToolTransformFn
    /** Read-only; used to prove the hook bridge adds no tool of its own. */
    readonly list?: ToolListFn
  }
  readonly session?: { readonly hook?: HookRegisterFn }
  readonly command?: unknown
  /** Plugin-side per-session todo store backend (`StorageDomain` in V2 2.1.4). */
  readonly storage?: unknown
}

// ---------------------------------------------------------------------------------------------
// Counters and degradation records
// ---------------------------------------------------------------------------------------------

export type HookCounter = {
  readonly fired: number
  readonly errors: number
  readonly writebacks: number
  readonly dropped: number
}

export type HookBridgeCounters = Readonly<Record<string, HookCounter>>

export type HookBridgeDegradation = {
  readonly key: string
  readonly reason: string
}

export type HookBridgeSnapshot = {
  readonly bridged: readonly string[]
  readonly degraded: readonly HookBridgeDegradation[]
  readonly counters: HookBridgeCounters
  readonly pump: EventPumpStats
  /** Real V1 hook names switched off at assembly (see `hooks/disabled-hooks`). */
  readonly disabled: readonly string[]
  /** Tool-ownership probe: what the host lists, and what the V1 `hooks.tool` registry holds. */
  readonly tools: ToolBoundaryProbe
}

export type ToolBoundaryProbe = {
  readonly available: boolean
  readonly count?: number
  readonly toolNames?: readonly string[]
  readonly grepCount?: number
  readonly grepDescription?: string
  readonly hooksToolCount: number
  readonly hooksToolNames: readonly string[]
  /** Always false: the hook bridge registers no tool (S1a's `tools.ts` owns that). */
  readonly bridgeRegistersTools: false
}


type Meter = {
  readonly fire: (key: string, detail?: Readonly<Record<string, unknown>>) => void
  readonly fail: (key: string, error: unknown) => void
  readonly writeback: (key: string) => void
  readonly drop: (key: string, reason: string) => void
  readonly snapshot: () => HookBridgeCounters
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * V1 hooks patch `args`/`metadata` in place (`replaceToolArgs` merges into the same object), so an
 * identity check alone would miss the write. Structured payloads are small here; a JSON snapshot is
 * the cheapest reliable way to prove a change came back.
 */
function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined"
  } catch {
    return "unserializable"
  }
}

function createMeter(): Meter {
  const entries = new Map<string, HookCounter>()
  const ensure = (key: string): HookCounter => {
    const existing = entries.get(key)
    if (existing !== undefined) return existing
    const created = { fired: 0, errors: 0, writebacks: 0, dropped: 0 }
    entries.set(key, created)
    return created
  }
  // Mutating through the counter type keeps the meter small; `snapshot` hands out copies.
  const mutable = (key: string): { fired: number; errors: number; writebacks: number; dropped: number } =>
    ensure(key) as { fired: number; errors: number; writebacks: number; dropped: number }

  return {
    fire(key, detail) {
      const counter = mutable(key)
      counter.fired += 1
      if (counter.fired <= FIRE_LOG_LIMIT) {
        log(`${HOOK_LOG_PREFIX} ${key} fired`, { ...detail, count: counter.fired })
      }
    },
    fail(key, error) {
      const counter = mutable(key)
      counter.errors += 1
      log(`${HOOK_LOG_PREFIX} ${key} failed`, { error: errorMessage(error), count: counter.errors })
    },
    writeback(key) {
      mutable(key).writebacks += 1
    },
    drop(key, reason) {
      const counter = mutable(key)
      counter.dropped += 1
      if (counter.dropped <= DROP_LOG_LIMIT) {
        log(`${HOOK_LOG_PREFIX} ${key} dropped`, { reason, count: counter.dropped })
      }
    },
    snapshot() {
      const out: Record<string, HookCounter> = {}
      for (const [key, counter] of entries) out[key] = { ...counter }
      return out
    },
  }
}

// ---------------------------------------------------------------------------------------------
// tool.execute.before / tool.execute.after
// ---------------------------------------------------------------------------------------------

type V1ToolBeforeInput = { tool: string; sessionID: string; callID: string }
type V1ToolBeforeOutput = { args: Record<string, unknown> }
type V1ToolAfterInput = {
  tool: string
  sessionID: string
  callID: string
  args: Record<string, unknown>
}
type V1ToolAfterOutput = {
  title: string
  output: string
  metadata: Record<string, unknown>
}

type AfterBase = V1ToolAfterInput

function handleToolBefore(event: unknown, hooks: Hooks, meter: Meter): Promise<void> {
  return (async (): Promise<void> => {
    const record = asRecord(event)
    if (record === undefined) {
      meter.drop(HOOK_KEY.toolBefore, "V2 execute.before event is not an object")
      return
    }
    const handler = hooks["tool.execute.before"]
    if (handler === undefined) {
      meter.drop(HOOK_KEY.toolBefore, "V1 tool.execute.before handler disappeared after registration")
      return
    }

    const tool = readString(record, "tool") ?? ""
    const sessionID = readString(record, "sessionID") ?? ""
    const callID = readString(record, "id") ?? ""
    const originalArgs = asRecord(record["input"])
    const input: V1ToolBeforeInput = { tool, sessionID, callID }
    // V1 receives the arguments as a plain object; the V2 event may carry a non-object for tools
    // without arguments, in which case the V1 view starts empty and an untouched `{}` is not written
    // back (so a no-argument call keeps its original payload).
    const output: V1ToolBeforeOutput = { args: originalArgs ?? {} }
    const argsBefore = fingerprint(output.args)

    meter.fire(HOOK_KEY.toolBefore, { tool, hasArgs: originalArgs !== undefined })

    try {
      await handler(input, output)
    } catch (error) {
      // V1 uses this hook to *block* a tool call (BTW delegation, background sleep guard); a reject
      // here is meaningful, so it is counted and re-thrown instead of being swallowed.
      meter.fail(HOOK_KEY.toolBefore, error)
      throw error
    }

    const toolChanged = input.tool !== tool
    const argsChanged = output.args !== originalArgs || fingerprint(output.args) !== argsBefore
    if (toolChanged) record["tool"] = input.tool
    if (argsChanged) record["input"] = output.args
    if (toolChanged || argsChanged) meter.writeback(HOOK_KEY.toolBefore)
  })()
}

type ResultSource = "output" | "content" | "content-array" | "none"

type ResultShape = { readonly source: ResultSource; readonly text: string }

function isTextPart(value: unknown): value is { readonly type: "text"; readonly text: string } {
  const record = asRecord(value)
  return record !== undefined && record["type"] === "text" && typeof record["text"] === "string"
}

/**
 * Reads the text a V1 hook expects to see. Only string payloads are bridged: converting a
 * structured `result.output` to JSON and writing the text back would corrupt the tool result, so
 * that case is counted as a drop instead.
 */
function readResultShape(result: Record<string, unknown>): ResultShape {
  const output = result["output"]
  if (typeof output === "string") return { source: "output", text: output }
  if (output !== undefined) return { source: "none", text: "" }

  const content = result["content"]
  if (typeof content === "string") return { source: "content", text: content }
  if (Array.isArray(content)) {
    const texts = content.filter(isTextPart).map((part) => part.text)
    if (texts.length > 0) return { source: "content-array", text: texts.join("\n") }
  }
  return { source: "none", text: "" }
}

function applyResultText(
  result: Record<string, unknown>,
  shape: ResultShape,
  text: string,
): boolean {
  switch (shape.source) {
    case "output":
      result["output"] = text
      return true
    case "content":
      result["content"] = text
      return true
    case "content-array": {
      const content = result["content"]
      if (!Array.isArray(content)) return false
      // Text parts collapse into the single bridged string; non-text parts (files) stay untouched.
      const kept = content.filter((part) => !isTextPart(part))
      result["content"] = [{ type: "text", text }, ...kept]
      return true
    }
    default:
      if (text.length === 0) return false
      result["output"] = text
      return true
  }
}

async function handleToolAfterResult(
  result: Record<string, unknown>,
  base: AfterBase,
  handler: NonNullable<Hooks["tool.execute.after"]>,
  meter: Meter,
): Promise<void> {
  const shape = readResultShape(result)
  if (shape.source === "none" && (result["output"] !== undefined || result["content"] !== undefined)) {
    meter.drop(HOOK_KEY.toolAfter, "V2 result text is not a bridged string; text bridging skipped")
  }
  const metadata = asRecord(result["metadata"])
  const metadataBefore = fingerprint(metadata ?? {})
  const originalTitle = metadata === undefined ? "" : readString(metadata, "title") ?? ""
  const v1Metadata: Record<string, unknown> = metadata === undefined ? {} : { ...metadata }
  const output: V1ToolAfterOutput = {
    title: originalTitle,
    output: shape.text,
    metadata: v1Metadata,
  }

  await handler(base, output)

  if (output.output !== shape.text) {
    if (applyResultText(result, shape, output.output)) meter.writeback(HOOK_KEY.toolAfter)
  }

  const titleChanged = output.title !== originalTitle
  const metadataChanged = output.metadata !== v1Metadata || fingerprint(output.metadata) !== metadataBefore
  if (metadataChanged || titleChanged) {
    // V2 `Tool.Result` has no title field, so a changed V1 title is mirrored into
    // `metadata.title` instead of being dropped.
    result["metadata"] = titleChanged ? { ...output.metadata, title: output.title } : output.metadata
    meter.writeback(HOOK_KEY.toolAfter)
  }
}

async function handleToolAfterError(
  errorRecord: Record<string, unknown>,
  base: AfterBase,
  handler: NonNullable<Hooks["tool.execute.after"]>,
  meter: Meter,
): Promise<void> {
  const message = readString(errorRecord, "message") ?? ""
  const metadata = asRecord(errorRecord["metadata"])
  const metadataBefore = fingerprint(metadata ?? {})
  const v1Metadata: Record<string, unknown> = metadata === undefined ? {} : { ...metadata }
  const output: V1ToolAfterOutput = {
    title: "",
    output: message,
    metadata: v1Metadata,
  }

  await handler(base, output)

  if (output.output !== message) {
    errorRecord["message"] = output.output
    meter.writeback(HOOK_KEY.toolAfter)
  }
  if (output.metadata !== v1Metadata || fingerprint(output.metadata) !== metadataBefore) {
    errorRecord["metadata"] = output.metadata
    meter.writeback(HOOK_KEY.toolAfter)
  }
}

function handleToolAfter(event: unknown, hooks: Hooks, meter: Meter): Promise<void> {
  return (async (): Promise<void> => {
    try {
      const record = asRecord(event)
      if (record === undefined) {
        meter.drop(HOOK_KEY.toolAfter, "V2 execute.after event is not an object")
        return
      }
      const handler = hooks["tool.execute.after"]
      if (handler === undefined) {
        meter.drop(HOOK_KEY.toolAfter, "V1 tool.execute.after handler disappeared after registration")
        return
      }

      const tool = readString(record, "tool") ?? ""
      const sessionID = readString(record, "sessionID") ?? ""
      const callID = readString(record, "id") ?? ""
      // The V1 handler type requires `args`; V2 always carries the tool input on the event.
      const base: AfterBase = { tool, sessionID, callID, args: asRecord(record["input"]) ?? {} }
      const status = readString(record, "status") ?? "unknown"

      meter.fire(HOOK_KEY.toolAfter, { tool, status })

      if (status === "error") {
        const errorRecord = asRecord(record["error"])
        if (errorRecord === undefined) {
          meter.drop(HOOK_KEY.toolAfter, "error status without an error payload")
          return
        }
        await handleToolAfterError(errorRecord, base, handler, meter)
        return
      }

      const result = asRecord(record["result"])
      if (result === undefined) {
        meter.drop(HOOK_KEY.toolAfter, `status ${status} without a result payload`)
        return
      }
      await handleToolAfterResult(result, base, handler, meter)
    } catch (error) {
      // An after-hook must never break the tool call it observes (V1 wraps its own hooks the same way).
      meter.fail(HOOK_KEY.toolAfter, error)
    }
  })()
}

// ---------------------------------------------------------------------------------------------
// tool.definition (V2 has no hook slot; it is a tool-transform concern)
// ---------------------------------------------------------------------------------------------

type DefinitionOutput = { description: string; parameters: unknown }

async function applyToolDefinition(
  editor: Record<string, unknown>,
  id: string,
  entry: Record<string, unknown>,
  handler: NonNullable<Hooks["tool.definition"]>,
  meter: Meter,
): Promise<void> {
  const description = readString(entry, "description") ?? ""
  const parameters = entry["input"]
  const output: DefinitionOutput = { description, parameters }

  meter.fire(HOOK_KEY.toolDefinition, { toolID: id })

  try {
    // V2 `ToolEditor.update()` applies inside the transform callback scope, so the V1 handler is
    // awaited here and the write happens before the callback resolves.
    await handler({ toolID: id }, output)
  } catch (error) {
    meter.fail(HOOK_KEY.toolDefinition, error)
    return
  }

  const descriptionChanged = output.description !== description
  const parametersChanged = output.parameters !== parameters
  if (!descriptionChanged && !parametersChanged) return

  const update = editor["update"]
  if (typeof update !== "function") {
    meter.drop(HOOK_KEY.toolDefinition, "tool editor has no update(); definition override dropped")
    return
  }
  Reflect.apply(update, editor, [
    id,
    (target: unknown) => {
      const record = asRecord(target)
      if (record === undefined) return
      if (descriptionChanged) record["description"] = output.description
      // V2 names the schema field `input`; the V1 handler knows it as `parameters`.
      if (parametersChanged) record["input"] = output.parameters
    },
  ])
  meter.writeback(HOOK_KEY.toolDefinition)
}

async function handleToolDefinitions(event: unknown, hooks: Hooks, meter: Meter): Promise<void> {
  const editor = asRecord(event)
  if (editor === undefined) {
    meter.drop(HOOK_KEY.toolDefinition, "tool transform editor is not an object")
    return
  }
  const handler = hooks["tool.definition"]
  if (handler === undefined) {
    meter.drop(HOOK_KEY.toolDefinition, "V1 tool.definition handler disappeared after registration")
    return
  }
  const list = editor["list"]
  if (typeof list !== "function") {
    meter.drop(HOOK_KEY.toolDefinition, "tool transform editor has no list()")
    return
  }
  const entries = Reflect.apply(list, editor, []) as unknown
  if (!Array.isArray(entries)) return

  for (const entry of entries) {
    const record = asRecord(entry)
    const id = record === undefined ? undefined : readString(record, "id")
    if (record === undefined || id === undefined) continue
    await applyToolDefinition(editor, id, record, handler, meter)
  }
}

// ---------------------------------------------------------------------------------------------
// experimental.session.compacting + experimental.compaction.autocontinue
// ---------------------------------------------------------------------------------------------

type CompactionCompactingInput = { sessionID: string }
type CompactionCompactingOutput = { context: string[]; prompt?: string }
type CompactionAutocontinueInput = {
  sessionID: string
  agent: string
  model: unknown
  provider: unknown
  message: unknown
  overflow: boolean
}
type CompactionAutocontinueOutput = { enabled: boolean }
type CompactionAutocontinueFn = (
  input: CompactionAutocontinueInput,
  output: CompactionAutocontinueOutput,
) => Promise<void>

async function runCompacting(
  record: Record<string, unknown>,
  hooks: Hooks,
  meter: Meter,
): Promise<void> {
  const handler = hooks["experimental.session.compacting"]
  if (handler === undefined) return

  const sessionID = readString(record, "sessionID") ?? ""
  const input: CompactionCompactingInput = { sessionID }
  const output: CompactionCompactingOutput = { context: [] }
  meter.fire(HOOK_KEY.compacting, { sessionID })

  try {
    await handler(input, output)
  } catch (error) {
    meter.fail(HOOK_KEY.compacting, error)
  }

  if (output.context.length > 0) {
    const system = record["system"]
    if (Array.isArray(system)) {
      for (const text of output.context) system.push({ type: "text", text })
      meter.writeback(HOOK_KEY.compacting)
    } else {
      meter.drop(HOOK_KEY.compacting, "V2 compaction input has no system array; V1 context dropped")
    }
  }

  if (output.prompt !== undefined) {
    meter.drop(HOOK_KEY.compacting, "V2 compaction has no prompt-replacement field; V1 prompt dropped")
  }
}

async function runAutocontinue(
  record: Record<string, unknown>,
  hooks: Hooks,
  meter: Meter,
): Promise<void> {
  const handler = hooks["experimental.compaction.autocontinue"] as unknown as
    | CompactionAutocontinueFn
    | undefined
  if (handler === undefined) return

  const sessionID = readString(record, "sessionID") ?? ""
  const input: CompactionAutocontinueInput = {
    sessionID,
    agent: readString(record, "agent") ?? "",
    model: record["model"],
    // V2's compaction event carries neither a provider context, a user message nor an overflow
    // flag; the V1 shape is filled with explicit placeholders and the gap is recorded.
    provider: undefined,
    message: undefined,
    overflow: false,
  }
  const output: CompactionAutocontinueOutput = { enabled: true }
  meter.fire(HOOK_KEY.autocontinue, { sessionID })

  try {
    await handler(input, output)
  } catch (error) {
    meter.fail(HOOK_KEY.autocontinue, error)
  }

  if (!output.enabled) {
    meter.drop(
      HOOK_KEY.autocontinue,
      "V2 compaction has no autocontinue switch; enabled=false cannot be expressed",
    )
  }
}

async function handleCompaction(event: unknown, hooks: Hooks, meter: Meter): Promise<void> {
  const record = asRecord(event)
  if (record === undefined) {
    meter.drop(HOOK_KEY.compacting, "V2 compaction event is not an object")
    return
  }
  // Neither V1 handler may fail the host's compaction: each error is counted and contained.
  await runCompacting(record, hooks, meter)
  await runAutocontinue(record, hooks, meter)
}

// ---------------------------------------------------------------------------------------------
// event (V2 event envelope -> V1 { type, properties })
// ---------------------------------------------------------------------------------------------

/**
 * V1 event handlers switch on `event.type` and read `event.properties`. V2 events use the same
 * dotted type strings for the overlapping cases but carry their payload in `event.data`, so the
 * bridge adds the V1 envelope and leaves the raw fields in place.
 */
function toV1Event(event: unknown): { type: string; properties: Readonly<Record<string, unknown>> } {
  const record = asRecord(event)
  const type = record === undefined ? "unknown" : readString(record, "type") ?? "unknown"
  const properties = (record === undefined ? undefined : asRecord(record["properties"]))
    ?? (record === undefined ? undefined : asRecord(record["data"]))
    ?? {}
  return { type, properties }
}

function typeOfEvent(event: unknown): string {
  const record = asRecord(event)
  return record === undefined ? "non-object" : readString(record, "type") ?? "untyped"
}

// ---------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------

type HookBridge = {
  readonly snapshot: () => HookBridgeSnapshot
  readonly dispose: () => Promise<void>
}

type InstalledBridge = {
  /** `ctx.location.directory` of the location this bridge belongs to (`""` when it has none). */
  readonly key: string
  readonly hooks: Hooks
  readonly bridge: HookBridge
  references: number
}

/**
 * One bridge per host *location*, keyed exactly like the adapter (`locationKeyOf`: the
 * `ctx.location.directory` string, `""` for a context that carries none).
 *
 * A single global install was wrong on two counts: two locations alive at once let the second
 * `setup` take over the first location's bridge (the first location's event stream then had no
 * pump, and the second had the first's handlers), and re-running `setup` for a location it had
 * already installed added a *second* event pump plus duplicate `execute.before`/`execute.after`/
 * `compaction` registrations. Keyed, A and B coexist and a repeat install of one key is only a
 * reference bump.
 */
const installed = new Map<string, InstalledBridge>()
/** Snapshot taken at dispose time: the hook counters an e2e needs after `setup` has been torn down. */
let lastSnapshot: HookBridgeSnapshot | undefined
/** Key of the most recently installed live bridge and of the last disposed one (see the reader). */
let lastInstalledKey: string | undefined
let lastSnapshotKey: string | undefined

function degradedEntry(key: string, reason: string): HookBridgeDegradation {
  return { key, reason }
}

type TodoCapture = (tool: string, sessionID: string, input: unknown) => Promise<void>

async function registerToolHooks(
  context: V2HookContextLike,
  hooks: Hooks,
  meter: Meter,
  degraded: HookBridgeDegradation[],
  registrations: HookRegistration[],
  bridged: string[],
  captureTodos: TodoCapture,
): Promise<void> {
  const toolDomain = context.tool
  const register = toolDomain?.hook

  if (typeof register !== "function") {
    degraded.push(degradedEntry(HOOK_KEY.toolBefore, "V2 ctx.tool.hook is not available on this host"))
    degraded.push(degradedEntry(HOOK_KEY.toolAfter, "V2 ctx.tool.hook is not available on this host"))
    return
  }

  const slots: ReadonlyArray<{
    readonly key: string
    readonly v1: "tool.execute.before" | "tool.execute.after"
    readonly v2: "execute.before" | "execute.after"
    readonly handle: (event: unknown) => Promise<void>
  }> = [
    {
      key: HOOK_KEY.toolBefore,
      v1: "tool.execute.before",
      v2: "execute.before",
      handle: async (event) => {
        // The only point where a tool's *input* is visible before it runs: a todo-carrying call
        // (todowrite/task_*) is folded into the plugin-side store so `session.todo()` and the tool
        // that produced the todos cannot disagree. Failure here never blocks the tool call.
        const record = asRecord(event)
        const tool = readString(record, "tool") ?? ""
        const sessionID = readString(record, "sessionID") ?? ""
        if (tool.length > 0 && sessionID.length > 0) {
          try {
            await captureTodos(tool, sessionID, record?.["input"])
          } catch (error) {
            log(`${HOOK_LOG_PREFIX} session todo capture failed`, { tool, error: errorMessage(error) })
          }
        }
        await handleToolBefore(event, hooks, meter)
      },
    },
    {
      key: HOOK_KEY.toolAfter,
      v1: "tool.execute.after",
      v2: "execute.after",
      handle: (event) => handleToolAfter(event, hooks, meter),
    },
  ]

  for (const slot of slots) {
    if (hooks[slot.v1] === undefined) {
      degraded.push(degradedEntry(slot.key, "V1 runtime exposes no handler for this key"))
      continue
    }
    try {
      registrations.push(await register.call(toolDomain, slot.v2, (event: unknown) => slot.handle(event)))
      bridged.push(slot.key)
    } catch (error) {
      degraded.push(degradedEntry(slot.key, `ctx.tool.hook("${slot.v2}") threw: ${errorMessage(error)}`))
    }
  }

  if (toolDomain?.transform === undefined) {
    degraded.push(degradedEntry(HOOK_KEY.toolDefinition, "V2 ctx.tool.transform is not available on this host"))
    return
  }
  if (hooks["tool.definition"] === undefined) {
    degraded.push(degradedEntry(HOOK_KEY.toolDefinition, "V1 runtime exposes no handler for this key"))
    return
  }
  try {
    registrations.push(
      await toolDomain.transform(async (editor: unknown) => {
        await handleToolDefinitions(editor, hooks, meter)
      }),
    )
    bridged.push(HOOK_KEY.toolDefinition)
  } catch (error) {
    degraded.push(degradedEntry(HOOK_KEY.toolDefinition, `ctx.tool.transform threw: ${errorMessage(error)}`))
  }
}

async function registerCompactionHooks(
  context: V2HookContextLike,
  hooks: Hooks,
  meter: Meter,
  degraded: HookBridgeDegradation[],
  registrations: HookRegistration[],
  bridged: string[],
): Promise<void> {
  const hasCompacting = hooks["experimental.session.compacting"] !== undefined
  const hasAutocontinue = hooks["experimental.compaction.autocontinue"] !== undefined
  if (!hasCompacting && !hasAutocontinue) {
    degraded.push(degradedEntry(HOOK_KEY.compacting, "V1 runtime exposes no compaction handler"))
    return
  }

  // V2 field gaps: recorded once at install so the loss is visible even if compaction never runs.
  if (hasCompacting) {
    degraded.push(
      degradedEntry(
        HOOK_KEY.compacting,
        "V2 compaction has no prompt-replacement field; a V1 prompt override is dropped",
      ),
    )
  }
  if (hasAutocontinue) {
    degraded.push(
      degradedEntry(
        HOOK_KEY.autocontinue,
        "V2 compaction event has no provider/message/overflow fields; V1 payload uses placeholders",
      ),
    )
    degraded.push(
      degradedEntry(
        HOOK_KEY.autocontinue,
        "V2 compaction runs before the request and has no autocontinue switch; the V1 hook runs at compaction time",
      ),
    )
  }

  const register = context.session?.hook
  if (typeof register !== "function") {
    degraded.push(degradedEntry(HOOK_KEY.compacting, "V2 ctx.session.hook is not available on this host"))
    return
  }
  try {
    registrations.push(await register.call(context.session, "compaction", (event: unknown) => handleCompaction(event, hooks, meter)))
    if (hasCompacting) bridged.push(HOOK_KEY.compacting)
    if (hasAutocontinue) bridged.push(HOOK_KEY.autocontinue)
  } catch (error) {
    degraded.push(degradedEntry(HOOK_KEY.compacting, `ctx.session.hook("compaction") threw: ${errorMessage(error)}`))
  }
}

async function registerSemanticHooks(
  context: V2HookContextLike,
  hooks: Hooks,
  meter: Meter,
  degraded: HookBridgeDegradation[],
  registrations: HookRegistration[],
  bridged: string[],
  directory: string,
): Promise<void> {
  const register = context.session?.hook
  const plan = planSemanticBridge({ hooks, meter, directory })
  degraded.push(...plan.degraded)
  logSemanticPlan(plan)

  if (typeof register !== "function") {
    for (const registration of plan.registrations) {
      degraded.push(
        degradedEntry(registration.name, "V2 ctx.session.hook is not available on this host"),
      )
    }
    return
  }
  if (plan.registrations.length === 0) return

  for (const registration of plan.registrations) {
    try {
      registrations.push(await register.call(context.session, registration.name, registration.callback))
      log(`${HOOK_LOG_PREFIX} ${registration.name} slot bridged`, {
        v1Keys: plan.bridged.filter((key: SemanticHookKey) => SEMANTIC_SLOT_OF[key] === registration.name),
      })
    } catch (error) {
      degraded.push(
        degradedEntry(registration.name, `ctx.session.hook("${registration.name}") threw: ${errorMessage(error)}`),
      )
    }
  }
  for (const key of plan.bridged) {
    if (!bridged.includes(key)) bridged.push(key)
  }
}

function registerCommandHook(
  context: V2HookContextLike,
  degraded: HookBridgeDegradation[],
): void {
  const domain = asRecord(context.command)
  const available = domain === undefined ? [] : Object.keys(domain).sort()
  // Verified against @opencode/plugin 2.1.4: `CommandDomain` is
  //   Pick<CommandApi, "list"> & { transform, reload }
  // with `CommandEditor = { add(definition) }`. There is no hook slot, so V1's
  // `command.execute.before` (which rewrites the command's parts) has nowhere to run.
  if (typeof domain?.["hook"] !== "function") {
    degraded.push({
      key: HOOK_KEY.commandBefore,
      reason:
        "V2 CommandDomain has no hook(); exposes " +
        `[${available.join(",")}] so a command cannot be intercepted before execution`,
    })
    log(`${HOOK_LOG_PREFIX} ${HOOK_KEY.commandBefore} degraded`, { domainKeys: available })
    return
  }
  degraded.push({
    key: HOOK_KEY.commandBefore,
    reason: "host exposes command.hook but its event shape is unverified; not bridged in S2b-1",
  })
}

function installEventPump(
  context: V2HookContextLike,
  hooks: Hooks,
  meter: Meter,
  degraded: HookBridgeDegradation[],
  bridged: string[],
): EventPumpHandle | undefined {
  const handler = hooks.event
  if (handler === undefined) {
    degraded.push(degradedEntry(HOOK_KEY.event, "V1 runtime exposes no event handler"))
    return undefined
  }
  const eventDomain = asRecord(context.event)
  const subscribe = eventDomain?.["subscribe"]
  if (typeof subscribe !== "function") {
    degraded.push(degradedEntry(HOOK_KEY.event, "V2 ctx.event.subscribe is not available on this host"))
    return undefined
  }

  const pump = startEventPump({
    subscribe: (options) => Reflect.apply(subscribe, eventDomain, [options]) as AsyncIterable<unknown>,
    onEvent: async (event) => {
      // The shim's `session.status()` has no live source on a real 2.1.4 host (no `active` on the
      // plugin SessionDomain), so the stream is the source: record it before V1 sees the event.
      noteSessionEvent(event)
      meter.fire(HOOK_KEY.event, { type: typeOfEvent(event) })
      await handler({ event: toV1Event(event) as unknown as Parameters<typeof handler>[0]["event"] })
    },
    onError: (error) => meter.fail(HOOK_KEY.event, error),
  })
  bridged.push(HOOK_KEY.event)
  return pump
}

/**
 * Reads what the host lists and what the V1 `hooks.tool` registry holds, and logs it once. The
 * bridge must never add a tool: `tools.ts` (S1a) owns registration, and registering the whole V1
 * registry here would silently replace the seven bridged ones with host-incompatible copies.
 */
async function probeToolBoundary(
  context: V2HookContextLike,
  hooks: Hooks,
): Promise<ToolBoundaryProbe> {
  const hooksTool = asRecord(hooks.tool) ?? {}
  const base = {
    hooksToolCount: Object.keys(hooksTool).length,
    hooksToolNames: Object.keys(hooksTool).sort(),
    bridgeRegistersTools: false as const,
  }

  const list = context.tool?.list
  if (typeof list !== "function") {
    log(`${HOOK_LOG_PREFIX} tools`, { available: false, ...base })
    return { available: false, ...base }
  }

  try {
    const entries = await Reflect.apply(list, context.tool, []) as unknown
    const records = Array.isArray(entries) ? entries.map((entry) => asRecord(entry)) : []
    const toolNames = records
      .map((record) => (record === undefined ? undefined : readString(record, "name")))
      .filter((name): name is string => name !== undefined)
      .sort()
    const grepEntries = records.filter((record) => record !== undefined && readString(record, "name") === "grep")
    const grepDescription = grepEntries.length === 0
      ? undefined
      : readString(grepEntries[0], "description") ?? ""
    const probe: ToolBoundaryProbe = {
      available: true,
      count: toolNames.length,
      toolNames,
      grepCount: grepEntries.length,
      ...(grepDescription === undefined ? {} : { grepDescription }),
      ...base,
    }
    log(`${HOOK_LOG_PREFIX} tools`, probe)
    return probe
  } catch (error) {
    log(`${HOOK_LOG_PREFIX} tools`, { available: false, error: errorMessage(error), ...base })
    return { available: false, ...base }
  }
}

async function install(
  context: V2HookContextLike,
  hooks: Hooks,
  disabled: readonly string[],
  location: string,
): Promise<HookBridge> {
  const meter = createMeter()
  const degraded: HookBridgeDegradation[] = []
  const registrations: HookRegistration[] = []
  const bridged: string[] = []

  // Bridge-layer evidence, independent of the assembly log: this is the list that made the V1 hook
  // factories return null, so an operator reading the bridge sees the same names.
  log(`${DISABLED_HOOKS_LOG_PREFIX}: ${formatDisabledHooks({ hooks: disabled })}`, {
    at: "bridge",
    hooks: disabled,
  })

  const tools = await probeToolBoundary(context, hooks)
  // Same string as the adapter keys runtimes on; passed in so a log line and a map entry can never
  // disagree about which location they describe.
  const directory = location
  const storage = context.storage

  await registerToolHooks(
    context,
    hooks,
    meter,
    degraded,
    registrations,
    bridged,
    async (tool, sessionID, input) => {
      await captureSessionTodos({ storage, sessionID, tool, input })
    },
  )
  await registerCompactionHooks(context, hooks, meter, degraded, registrations, bridged)
  await registerSemanticHooks(context, hooks, meter, degraded, registrations, bridged, directory)
  registerCommandHook(context, degraded)
  let pump = installEventPump(context, hooks, meter, degraded, bridged)

  let disposed = false
  const snapshotCache = (pumpStats: EventPumpStats): HookBridgeSnapshot => ({
    bridged: [...bridged],
    degraded: [...degraded],
    counters: meter.snapshot(),
    pump: pumpStats,
    disabled: [...disabled],
    tools,
  })

  const dispose = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    // Stop producing before tearing down: a late event must not run into a disposed registration.
    const pumpStats = pump === undefined ? EMPTY_EVENT_PUMP_STATS : await pump.stop()
    for (const registration of [...registrations].reverse()) {
      try {
        await registration.dispose()
      } catch (error) {
        log(`${HOOK_LOG_PREFIX} registration dispose failed`, { error: errorMessage(error) })
      }
    }
    const finalSnapshot = snapshotCache(pumpStats)
    log(`${HOOK_LOG_PREFIX} bridge disposed`, {
      location,
      bridged: finalSnapshot.bridged,
      degraded: finalSnapshot.degraded,
      counters: finalSnapshot.counters,
      disabled: finalSnapshot.disabled,
      tools: { count: tools.count, grepCount: tools.grepCount, hooksToolCount: tools.hooksToolCount },
      pump: pumpStats,
    })
    lastSnapshot = finalSnapshot
    lastSnapshotKey = location
    pump = undefined
  }

  log(`${HOOK_LOG_PREFIX} bridge installed`, {
    location,
    bridged,
    degraded,
    counters: meter.snapshot(),
    disabled,
    tools: { count: tools.count, grepCount: tools.grepCount, hooksToolCount: tools.hooksToolCount },
  })

  return {
    snapshot: () => snapshotCache(pump === undefined ? EMPTY_EVENT_PUMP_STATS : pump.stats()),
    dispose,
  }
}

/** Creates a release for one install of one location; releasing twice never eats a second reference. */
function createRelease(target: InstalledBridge): () => Promise<void> {
  let released = false
  return async (): Promise<void> => {
    if (released) return
    released = true
    target.references -= 1
    if (target.references > 0) {
      log(`${HOOK_LOG_PREFIX} bridge reference released`, {
        location: target.key,
        references: target.references,
      })
      return
    }
    // Drop the entry *before* awaiting dispose: a setup for the same location that lands during
    // teardown then installs its own bridge instead of reusing one that is already closing. Only
    // this object's own entry is removed, so a bridge a later install put under the same key (a
    // fresh runtime for the same location) is left alone.
    if (installed.get(target.key) === target) installed.delete(target.key)
    log(`${HOOK_LOG_PREFIX} bridge release`, { location: target.key, references: target.references })
    await target.bridge.dispose()
  }
}

/**
 * Bridges the mechanical V1 hooks onto the V2 host, one bridge per location
 * (`locationKeyOf(context)`: `ctx.location.directory`, `""` when the context has none — the same
 * key the adapter counts runtimes on).
 *
 * Resolves the `release` function for `setup`'s cleanup:
 *   - the first install for a location builds the bridge with one reference;
 *   - a second `setup` for a location that already has a live bridge for the *same* V1 runtime is
 *     a reference bump and registers nothing (no second event pump, no duplicate `execute.*`);
 *   - a second `setup` for a location whose runtime was replaced tears the stale bridge down
 *     first, because its handlers belong to a runtime the adapter has already released;
 *   - releasing is per location and idempotent: the last release disposes the bridge, and
 *     releasing twice never eats another location's reference.
 */
export async function registerOpenCodeV2Hooks(
  context: unknown,
  runtime: OpenCodeV2Runtime | undefined,
): Promise<() => Promise<void>> {
  if (runtime === undefined) {
    log(`${HOOK_LOG_PREFIX} bridge skipped`, {
      location: locationKeyOf(context),
      reason: "V1 runtime was not assembled",
    })
    return async (): Promise<void> => {}
  }

  const key = locationKeyOf(context)
  const existing = installed.get(key)

  if (existing !== undefined && existing.hooks === runtime.hooks) {
    existing.references += 1
    lastInstalledKey = key
    log(`${HOOK_LOG_PREFIX} bridge reused`, { location: key, references: existing.references })
    return createRelease(existing)
  }

  if (existing !== undefined) {
    // Same location, different V1 runtime: the old bridge points at handlers the adapter has
    // already released, so it is torn down before the new one installs a second set of slots.
    installed.delete(key)
    log(`${HOOK_LOG_PREFIX} bridge replaced`, {
      location: key,
      reason: "a different V1 runtime now owns this location",
    })
    await existing.bridge.dispose()
  }

  const bridge = await install(
    context as V2HookContextLike,
    runtime.hooks,
    runtime.report.disabledHooks,
    key,
  )
  const target: InstalledBridge = { key, hooks: runtime.hooks, bridge, references: 1 }
  installed.set(key, target)
  lastInstalledKey = key

  // The adapter's `runtime.dispose()` calls `hooks.dispose`; wrapping it here makes the real-serve
  // shutdown stop the pump even though `setup`'s returned cleanup is ignored by the current entry.
  // The map entry goes too: the bridge this location publishes must never be one that is closing.
  const originalDispose = runtime.hooks.dispose
  runtime.hooks.dispose = async (): Promise<void> => {
    if (installed.get(key) === target) installed.delete(key)
    await bridge.dispose()
    await originalDispose?.()
  }

  log(`${HOOK_LOG_PREFIX} bridge reference acquired`, { location: key, references: target.references })
  return createRelease(target)
}

/**
 * Bridge snapshot for the selftest / e2e layer.
 *
 * With `locationKey` (the `ctx.location.directory` the adapter keys on, `""` for a context with
 * none): that location's live bridge, or its last snapshot once that location was fully released.
 *
 * Without an argument it answers "the bridge that was installed most recently": the most recently
 * installed *live* bridge, falling back to the last disposed snapshot. With two locations alive at
 * once that is only one of them — pass the key, or use `_hookBridgeLocationKeysForTesting()`.
 */
export function readOpenCodeV2HookBridge(locationKey?: string): HookBridgeSnapshot | undefined {
  if (locationKey !== undefined) {
    const live = installed.get(locationKey)
    if (live !== undefined) return live.bridge.snapshot()
    return lastSnapshotKey === locationKey ? lastSnapshot : undefined
  }
  const recent = lastInstalledKey === undefined ? undefined : installed.get(lastInstalledKey)
  return recent?.bridge.snapshot() ?? lastSnapshot
}

/** Location keys with a live bridge, sorted; the count is the "one bridge per location" evidence. */
export function _hookBridgeLocationKeysForTesting(): string[] {
  return [...installed.keys()].sort()
}

/** Reference count of a location's bridge, or `undefined` when that location has no live bridge. */
export function _hookBridgeReferencesForTesting(locationKey: string): number | undefined {
  return installed.get(locationKey)?.references
}

export function _resetOpenCodeV2HooksForTesting(): void {
  installed.clear()
  lastSnapshot = undefined
  lastSnapshotKey = undefined
  lastInstalledKey = undefined
}
