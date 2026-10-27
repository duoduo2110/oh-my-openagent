/**
 * V1 -> V2 client shim (S2a, semantically aligned in S4).
 *
 * The V1 engine talks to OpenCode through the 1.x SDK client that arrives as `PluginInput.client`.
 * V2 replaces that client with per-domain objects on the setup context, so the adapter hands the
 * engine a shim that translates the V1 call shapes (`{ path: { id } }` + `{ data }` envelope) onto
 * the V2 domains (`session.get({ sessionID })` + bare payload).
 *
 * Three rules keep the port honest:
 *
 *  1. Methods with a real V2 equivalent are mapped onto it, including the shape conversion
 *     (`session.messages` -> `session.context` flat messages rebuilt into `{info, parts}`,
 *     `session.status` -> `active()` + `list()`, `config.get` -> live domains + the config files
 *     the host reads).
 *  2. A method whose V2 source is missing keeps a *recorded* degraded fallback (one
 *     `[omo-v2] degraded <area>` line naming the reason), never a silent fabricated value.
 *  3. Anything with no V2 counterpart at all resolves to a proxy that logs
 *     `[omo-v2] client shim missing <method>` and throws.
 *
 * `readClientShimStats()` exposes the mapping counters (messages/parts/dropped, todo backend,
 * config sources) so an e2e can assert the semantic path instead of grepping a free-form log line.
 */
import { log } from "../../shared/logger"
import { createConfigCache } from "./config-source"
import { readSessionStatuses } from "./status-registry"
import { mapSessionMessages, type MessageMappingStats } from "./session-mapping"
import { getSessionTodoStore, TODO_STORAGE_PREFIX, type SessionTodoStore } from "./todo-store"
import {
  asRecord,
  callDomain,
  compactInput,
  readArray,
  readNumber,
  readRecord,
  readString,
  unwrapData,
  type UnknownRecord,
  type V2ContextLike,
} from "./types"

export const CLIENT_SHIM_LOG_PREFIX = "[omo-v2]"
export const DEGRADED_LOG_PREFIX = "[omo-v2] degraded"
export const MISSING_LOG_PREFIX = "[omo-v2] client shim missing"
export const MAPPED_LOG_PREFIX = "[omo-v2] mapped"

type Envelope = {
  readonly data?: unknown
  readonly error?: unknown
}

function ok(data: unknown): Envelope {
  return { data, error: undefined }
}

function fail(error: unknown): Envelope {
  return { data: undefined, error }
}

function degraded(area: string, detail: string): void {
  if (reportedDegradations.has(area)) return
  reportedDegradations.add(area)
  log(`${DEGRADED_LOG_PREFIX} ${area}`, { detail })
}

/** One line per degraded area: enough to grep, not enough to flood a long session log. */
const reportedDegradations = new Set<string>()

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Proxy for a V1 SDK surface with no V2 counterpart. Reading a property keeps the shim navigable
 * (`client.foo.bar()` inside feature detection does not explode on property access), while calling
 * it logs the exact method path and throws a named error.
 */
export function createMissingShim(path: readonly string[]): unknown {
  const name = path.join(".")
  const callable = (): never => {
    log(`${MISSING_LOG_PREFIX} ${name}`, {
      reason: "no OpenCode V2 equivalent is wired for this V1 SDK method",
    })
    throw new Error(
      `${MISSING_LOG_PREFIX} ${name}: no OpenCode V2 equivalent is wired for this V1 SDK method`,
    )
  }

  return new Proxy(callable, {
    get(target, property) {
      if (property === "then") return undefined
      if (typeof property !== "string") return Reflect.get(target, property)
      return createMissingShim([...path, property])
    },
  })
}

function readSessionID(input: unknown): string {
  const sessionID = readString(readRecord(input, "path"), "id")
    ?? readString(input, "sessionID")
    ?? readString(input, "id")
  if (sessionID === undefined || sessionID.length === 0) {
    throw new Error("[omo-v2] client shim: session id missing from V1 SDK call")
  }
  return sessionID
}

function toV1Session(info: unknown, directory: string): UnknownRecord {
  const record = asRecord(info) ?? {}
  const parentID = readString(record, "parentID")
  const title = readString(record, "title")
  return {
    id: readString(record, "id") ?? "",
    ...(parentID === undefined ? {} : { parentID }),
    projectID: readString(record, "projectID") ?? "",
    directory,
    ...(title === undefined ? {} : { title }),
    version: "1",
    time: readRecord(record, "time") ?? { created: Date.now(), updated: Date.now() },
  }
}

function toV1SessionList(value: unknown, directory: string): UnknownRecord[] {
  const payload = unwrapData(value)
  if (!Array.isArray(payload)) return []
  return payload.map((entry) => toV1Session(entry, directory))
}

function collectText(parts: unknown): string {
  const list = Array.isArray(parts) ? parts : []
  return list
    .map((part) => readString(part, "text") ?? "")
    .filter((text) => text.length > 0)
    .join("\n")
}

// ---------------------------------------------------------------------------------------------
// Mapping statistics (read by the S4 e2e, so "semantic path" is provable, not inferred)
// ---------------------------------------------------------------------------------------------

export type ClientShimStats = {
  readonly messages: {
    /** `session.context()` calls that produced a mapping. */
    readonly calls: number
    readonly mapped: number
    readonly parts: number
    readonly dropped: number
    readonly approximated: number
    readonly last?: MessageMappingStats
  }
  readonly todo: {
    readonly backend: "storage" | "memory" | "none"
    readonly reads: number
    readonly writes: number
    readonly captured: number
    readonly errors: number
  }
  readonly status: {
    readonly calls: number
    readonly busy: number
    readonly idle: number
  }
  readonly config: {
    readonly reads: number
    readonly sources: readonly string[]
    readonly keys: readonly string[]
  }
  readonly summarize: {
    readonly calls: number
    readonly mapped: number
    /** `providerState`/`native` windows the compaction receipt cannot carry. */
    readonly providerStateDropped: number
  }
  readonly skills: {
    readonly listed: number
    readonly degraded: boolean
  }
  readonly degraded: readonly string[]
  readonly notes: readonly string[]
}

type MutableStats = {
  messages: { calls: number; mapped: number; parts: number; dropped: number; approximated: number; last?: MessageMappingStats }
  todo: { backend: "storage" | "memory" | "none"; reads: number; writes: number; captured: number; errors: number }
  status: { calls: number; busy: number; idle: number }
  config: { reads: number; sources: string[]; keys: string[] }
  summarize: { calls: number; mapped: number; providerStateDropped: number }
  skills: { listed: number; degraded: boolean }
  degraded: string[]
  notes: string[]
}

let lastStats: ClientShimStats | undefined

/** The most recently created shim's counters; `undefined` before any shim exists. */
export function readClientShimStats(): ClientShimStats | undefined {
  return lastStats
}

function createStats(): MutableStats {
  return {
    messages: { calls: 0, mapped: 0, parts: 0, dropped: 0, approximated: 0 },
    todo: { backend: "none", reads: 0, writes: 0, captured: 0, errors: 0 },
    status: { calls: 0, busy: 0, idle: 0 },
    config: { reads: 0, sources: [], keys: [] },
    summarize: { calls: 0, mapped: 0, providerStateDropped: 0 },
    skills: { listed: 0, degraded: false },
    degraded: [],
    notes: [],
  }
}

/**
 * V1 messages are `{ info, parts }` pairs. V2 `session.context()` answers flat `SessionMessage.Info`
 * entries whose parts live in `content` (assistant) or `text`/`files` (user); `./session-mapping`
 * rebuilds the V1 view and reports what it had to drop.
 */
function toV1Messages(
  value: unknown,
  sessionID: string,
  directory: string,
  stats: MutableStats,
): UnknownRecord[] {
  const payload = unwrapData(value)
  const result = mapSessionMessages(payload, sessionID, directory)
  stats.messages.calls += 1
  stats.messages.mapped += result.stats.messages
  stats.messages.parts += result.stats.parts
  stats.messages.dropped += result.stats.dropped
  stats.messages.approximated += result.stats.approximated
  stats.messages.last = result.stats
  if (result.stats.messages > 0) {
    log(`${MAPPED_LOG_PREFIX} session.messages`, {
      sessionID,
      messages: result.stats.messages,
      parts: result.stats.parts,
      dropped: result.stats.dropped,
      approximated: result.stats.approximated,
    })
  }
  return result.messages
}

function buildSessionNamespace(
  context: V2ContextLike,
  directory: string,
  stats: MutableStats,
  todoStore: SessionTodoStore,
): UnknownRecord {
  return {
    list: async (input?: unknown): Promise<Envelope> => {
      try {
        const query = readRecord(input, "query")
        const v2Input = compactInput({
          limit: typeof query?.["limit"] === "number" ? query["limit"] : undefined,
          order: readString(query, "order"),
          parentID: readString(query, "parentID"),
        })
        const result = await callDomain(
          context.session,
          "list",
          Object.keys(v2Input).length === 0 ? undefined : v2Input,
        )
        return ok(toV1SessionList(result, directory))
      } catch (error) {
        return fail(error)
      }
    },
    create: async (input?: unknown): Promise<Envelope> => {
      try {
        const body = readRecord(input, "body")
        const v2Input = compactInput({
          parentID: readString(body, "parentID"),
          title: readString(body, "title"),
        })
        const result = await callDomain(
          context.session,
          "create",
          Object.keys(v2Input).length === 0 ? undefined : v2Input,
        )
        return ok(toV1Session(unwrapData(result), directory))
      } catch (error) {
        return fail(error)
      }
    },
    get: async (input?: unknown): Promise<Envelope> => {
      try {
        const result = await callDomain(context.session, "get", { sessionID: readSessionID(input) })
        return ok(toV1Session(unwrapData(result), directory))
      } catch (error) {
        return fail(error)
      }
    },
    messages: async (input?: unknown): Promise<Envelope> => {
      const sessionID = readSessionID(input)
      try {
        const result = await callDomain(context.session, "context", { sessionID })
        return ok(toV1Messages(result, sessionID, directory, stats))
      } catch (error) {
        // Fallback: the host has no `session.context`. An empty history is still wrong for hooks
        // that rewrite a transcript, so the reason is recorded instead of returned silently.
        degraded(
          "session.messages",
          `session.context() failed (${toErrorMessage(error)}); empty history returned`,
        )
        return ok([])
      }
    },
    abort: async (input?: unknown): Promise<Envelope> => {
      try {
        await callDomain(context.session, "interrupt", { sessionID: readSessionID(input) })
        return ok(true)
      } catch (error) {
        return fail(error)
      }
    },
    status: async (): Promise<Envelope> => {
      // V1 wants a map of *every* session to busy/idle/retry. Three real sources, in precedence
      // order: the event-stream registry (the only live signal a plugin can see), `session.active()`
      // when the host exposes it (2.1.4's plugin SessionDomain does not), and `session.list()` for
      // the idle half. Deriving all three is what makes this status instead of a constant.
      stats.status.calls += 1
      const data: UnknownRecord = {}
      for (const [sessionID, status] of readSessionStatuses()) data[sessionID] = status

      let activeOk = false
      let listOk = false
      let failure: string | undefined
      try {
        const active = unwrapData(await callDomain(context.session, "active"))
        const record = asRecord(active) ?? {}
        for (const sessionID of Object.keys(record)) data[sessionID] = { type: "busy" }
        activeOk = true
      } catch (error) {
        // Expected on a real 2.1.4 host: the plugin `SessionDomain` has no `active`.
        failure = `active(): ${toErrorMessage(error)}`
      }

      try {
        const listed = unwrapData(await callDomain(context.session, "list"))
        // `session.list` answers `{ data, cursor }`; `unwrapData` already peeled the envelope.
        const entries = Array.isArray(listed) ? listed : (readArray(listed, "data") ?? [])
        for (const entry of entries) {
          const sessionID = readString(entry, "id")
          if (sessionID === undefined || sessionID in data) continue
          data[sessionID] = { type: "idle" }
        }
        listOk = true
      } catch (error) {
        failure = failure === undefined ? `list(): ${toErrorMessage(error)}` : `${failure}; list(): ${toErrorMessage(error)}`
      }

      for (const status of Object.values(data)) {
        if ((status as { type?: string }).type === "idle") stats.status.idle += 1
        else stats.status.busy += 1
      }

      if (!listOk && !activeOk && Object.keys(data).length === 0) {
        degraded(
          "session.status",
          `neither list() nor active() answered (${failure ?? "unknown"}); an empty map is returned rather than a guessed idle`,
        )
      } else if (!listOk) {
        degraded(
          "session.status",
          `list() failed (${failure ?? "unknown"}); only the event registry and active() are reported`,
        )
      } else if (!activeOk && stats.status.calls <= 3) {
        // Honest, budgeted, and not a degradation: the registry + list() are the real sources here.
        log(`${MAPPED_LOG_PREFIX} session.status`, {
          active: "unavailable on this host",
          registry: readSessionStatuses().size,
          listed: Object.keys(data).length,
        })
      }
      return ok(data)
    },
    todo: async (input?: unknown): Promise<Envelope> => {
      const sessionID = readSessionIDSafe(input)
      if (sessionID.startsWith("<unknown")) {
        degraded("session.todo", `no session id in the V1 call (${sessionID}); empty list returned`)
        return ok([])
      }
      // A host that ever grows a todo domain wins; 2.1.4 has none, so the plugin-side store (fed by
      // the hook bridge, see `./todo-store`) is the source of truth.
      const domain = asRecord(context.session)
      if (typeof domain?.["todo"] === "function") {
        try {
          const payload = unwrapData(await callDomain(context.session, "todo", { sessionID }))
          const list = Array.isArray(payload) ? payload : []
          stats.todo.reads += 1
          return ok(list)
        } catch (error) {
          degraded("session.todo", `host todo() failed (${toErrorMessage(error)}); plugin store used`)
        }
      }
      const todos = await todoStore.read(sessionID)
      stats.todo.reads += 1
      return ok(todos)
    },
    children: async (input?: unknown): Promise<Envelope> => {
      try {
        const result = await callDomain(context.session, "list", { parentID: readSessionID(input) })
        return ok(toV1SessionList(result, directory))
      } catch (error) {
        return fail(error)
      }
    },
    promptAsync: async (input?: unknown): Promise<Envelope> => {
      try {
        const sessionID = readSessionID(input)
        const body = readRecord(input, "body")
        const promptInput = compactInput({
          sessionID,
          text: collectText(body?.["parts"]),
          agent: readString(body, "agent"),
          model: readRecord(body, "model"),
        })
        const result = await callDomain(context.session, "prompt", promptInput)
        return ok({ sessionID, result: unwrapData(result) })
      } catch (error) {
        return fail(error)
      }
    },
    summarize: async (input?: unknown): Promise<Envelope> => {
      const sessionID = readSessionID(input)
      const body = readRecord(input, "body") ?? {}
      try {
        const result = await callDomain(
          context.session,
          "compact",
          compactInput({
            sessionID,
            id: readString(body, "messageID"),
          }),
        )
        const payload = asRecord(unwrapData(result)) ?? {}
        stats.summarize.calls += 1
        stats.summarize.mapped += 1

        // 2.1.4 naming gap: V1 calls the provider replay window `providerState`, V2 calls it
        // `native` (`SessionCompactionResult.native`). `compact()` itself answers an inbox receipt
        // (`{type:"compaction", id, sessionID, delivery, time}`) with neither field, so the window is
        // only carried when a V1 caller handed one in; otherwise the loss is counted, not invented.
        const native = payload["native"] ?? payload["providerState"]
        const callerProviderState = body["providerState"]
        if (native === undefined && callerProviderState !== undefined) {
          stats.summarize.providerStateDropped += 1
          log(`${DEGRADED_LOG_PREFIX} session.summarize`, {
            reason: "compact() answers an inbox receipt; a V1 providerState window cannot be attached",
            sessionID,
          })
        }

        return ok({
          compacted: true,
          messageID: readString(payload, "id") ?? readString(payload, "messageID"),
          ...(readString(payload, "summary") === undefined ? {} : { summary: readString(payload, "summary") }),
          // V1 shape: `providerState` (renamed from V2's `native`).
          ...(native === undefined ? {} : { providerState: native }),
          delivery: readString(payload, "delivery"),
        })
      } catch (error) {
        degraded(
          "session.summarize",
          `compact() failed (${toErrorMessage(error)}); the caller is told the summary did not run`,
        )
        return fail(error)
      }
    },
    delete: async (input?: unknown): Promise<Envelope> => {
      try {
        await callDomain(context.session, "remove", { sessionID: readSessionID(input) })
        return ok(true)
      } catch (error) {
        return fail(error)
      }
    },
  }
}

function readSessionIDSafe(input: unknown): string {
  try {
    return readSessionID(input)
  } catch (error) {
    return `<unknown: ${toErrorMessage(error)}>`
  }
}

function buildAppNamespace(context: V2ContextLike, stats: MutableStats): UnknownRecord {
  return {
    agents: async (): Promise<Envelope> => {
      try {
        const payload = unwrapData(await callDomain(context.agent, "list"))
        const list = Array.isArray(payload) ? payload : []
        return ok(list.map((entry) => ({
          name: readString(entry, "name") ?? readString(entry, "id") ?? "",
          description: readString(entry, "description") ?? "",
          mode: readString(entry, "mode") ?? "all",
        })))
      } catch (error) {
        return fail(error)
      }
    },
    skills: async (): Promise<Envelope> => {
      // `ctx.skill.list()` answers `{ location, data: Skill.Info[] }`; V1 only reads name/description.
      try {
        const payload = unwrapData(await callDomain(context.skill, "list"))
        const list = Array.isArray(payload) ? payload : []
        stats.skills.listed += list.length
        return ok(list.map((entry) => ({
          name: readString(entry, "name") ?? readString(entry, "id") ?? "",
          description: readString(entry, "description") ?? "",
          ...(readString(entry, "path") === undefined ? {} : { location: readString(entry, "path") }),
        })))
      } catch (error) {
        stats.skills.degraded = true
        degraded(
          "app.skills",
          `skill.list() failed (${toErrorMessage(error)}); empty list returned, V1 falls back to its own skill sources`,
        )
        return ok([])
      }
    },
  }
}

function buildConfigNamespace(
  context: V2ContextLike,
  directory: string,
  stats: MutableStats,
): UnknownRecord {
  const cache = createConfigCache()
  return {
    get: async (): Promise<Envelope> => {
      const snapshot = await cache.get({
        directory,
        model: context.model,
        provider: context.provider,
        agent: context.agent,
      })
      stats.config.reads += 1
      stats.config.sources = [...snapshot.sources]
      stats.config.keys = Object.keys(snapshot.config).sort()
      for (const note of snapshot.notes) {
        if (!stats.notes.includes(note)) stats.notes.push(note)
        if (!stats.degraded.includes(note)) stats.degraded.push(note)
      }
      return ok(snapshot.config)
    },
  }
}

function buildModelNamespace(context: V2ContextLike): UnknownRecord {
  return {
    list: async (): Promise<Envelope> => {
      try {
        const payload = unwrapData(await callDomain(context.model, "list"))
        const list = Array.isArray(payload) ? payload : []
        return ok(list.map((entry) => ({
          provider: readString(entry, "providerID") ?? "",
          id: readString(entry, "modelID") ?? readString(entry, "id") ?? "",
          modelID: readString(entry, "modelID") ?? readString(entry, "id") ?? "",
          name: readString(entry, "name") ?? "",
        })))
      } catch (error) {
        return fail(error)
      }
    },
  }
}

function buildProviderNamespace(context: V2ContextLike): UnknownRecord {
  return {
    list: async (): Promise<Envelope> => {
      try {
        const payload = unwrapData(await callDomain(context.provider, "list"))
        const list = Array.isArray(payload) ? payload : []
        const connected = list
          .filter((entry) => readString(entry, "activation") !== "disabled")
          .map((entry) => readString(entry, "id") ?? "")
          .filter((id) => id.length > 0)
        return ok({ connected, all: list })
      } catch (error) {
        return fail(error)
      }
    },
  }
}

function buildTuiNamespace(): UnknownRecord {
  return {
    showToast: async (input?: unknown): Promise<Envelope> => {
      const body = readRecord(input, "body") ?? {}
      degraded("tui.showToast", `V2 serve has no toast surface; logged only: ${JSON.stringify(body)}`)
      return ok(true)
    },
  }
}

function buildExperimentalNamespace(context: V2ContextLike, directory: string): UnknownRecord {
  return {
    session: {
      list: async (input?: unknown): Promise<Envelope> => {
        degraded("experimental.session.list", "location scoped: V2 session.list only sees this location")
        try {
          const limit = readNumber(input, "limit")
          const result = await callDomain(
            context.session,
            "list",
            limit === undefined ? undefined : { limit },
          )
          return ok(toV1SessionList(result, directory))
        } catch (error) {
          return fail(error)
        }
      },
    },
  }
}

export function createV1ClientShim(args: {
  readonly context: V2ContextLike
  readonly directory: string
}): unknown {
  const { context, directory } = args
  const stats = createStats()
  const todoStore = getSessionTodoStore(context.storage)
  stats.todo.backend = todoStore.stats().backend

  const namespaces: UnknownRecord = {
    session: buildSessionNamespace(context, directory, stats, todoStore),
    app: buildAppNamespace(context, stats),
    config: buildConfigNamespace(context, directory, stats),
    model: buildModelNamespace(context),
    provider: buildProviderNamespace(context),
    tui: buildTuiNamespace(),
    experimental: buildExperimentalNamespace(context, directory),
  }

  lastStats = {
    get messages() {
      return { ...stats.messages }
    },
    get todo() {
      const live = todoStore.stats()
      return { ...live }
    },
    get status() {
      return { ...stats.status }
    },
    get config() {
      return { ...stats.config, sources: [...stats.config.sources], keys: [...stats.config.keys] }
    },
    get summarize() {
      return { ...stats.summarize }
    },
    get skills() {
      return { ...stats.skills }
    },
    get degraded() {
      return [...reportedDegradations]
    },
    get notes() {
      return [...stats.notes, ...todoStore.notes()]
    },
  }

  return new Proxy(namespaces, {
    get(target, property) {
      if (property === "then") return undefined
      if (typeof property !== "string") return Reflect.get(target, property)
      const value = target[property]
      return value === undefined ? createMissingShim([property]) : value
    },
  })
}

/**
 * Folds a tool call that carries todos into the plugin-side store. The hook bridge calls this so
 * `session.todo()` and whatever produced the todos never disagree. Exported (not inlined) because
 * `hooks.ts` owns the tool event and the store lives here.
 */
export function captureSessionTodos(args: {
  readonly storage: unknown
  readonly sessionID: string
  readonly tool: string
  readonly input: unknown
}): Promise<boolean> {
  const store = getSessionTodoStore(args.storage)
  return store.captureToolInput(args.sessionID, args.tool, args.input)
}

export const TODO_STORE_STORAGE_PREFIX = TODO_STORAGE_PREFIX
