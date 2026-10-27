/**
 * V1 -> V2 client shim (S2a).
 *
 * The V1 engine talks to OpenCode through the 1.x SDK client that arrives as `PluginInput.client`.
 * V2 replaces that client with per-domain objects on the setup context, so the adapter hands the
 * engine a shim that translates the V1 call shapes (`{ path: { id } }` + `{ data }` envelope) onto
 * the V2 domains (`session.get({ sessionID })` + bare payload).
 *
 * Two rules keep the port honest:
 *
 *  1. Methods that have a real V2 equivalent are mapped. No fabricated payloads.
 *  2. Everything else either degrades with a `[omo-v2] degraded <area>` log line (only where the
 *     orchestrator accepted the loss) or resolves to a proxy that logs
 *     `[omo-v2] client shim missing <method>` and throws. A silent fake is never returned.
 */
import { log } from "../../shared/logger"
import {
  asRecord,
  callDomain,
  compactInput,
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

/**
 * V1 messages are `{ info, parts }` pairs; V2 `session.context()` returns one flat message per
 * entry (`SessionMessageInfo`). The info half survives the translation, the parts half does not,
 * which is logged as a degradation because hooks that read `parts` will see nothing.
 */
function toV1Messages(value: unknown): UnknownRecord[] {
  const payload = unwrapData(value)
  if (!Array.isArray(payload)) return []
  return payload.map((entry) => {
    const record = asRecord(entry) ?? {}
    const role = readString(record, "role") ?? readString(record, "type") ?? "assistant"
    return {
      info: {
        ...record,
        role,
        sessionID: readString(record, "sessionID") ?? "",
      },
      parts: [],
    }
  })
}

function buildSessionNamespace(context: V2ContextLike, directory: string): UnknownRecord {
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
      degraded("session.messages", "V2 session.context() is flat; V1 parts are returned empty")
      try {
        const result = await callDomain(context.session, "context", { sessionID: readSessionID(input) })
        return ok(toV1Messages(result))
      } catch (error) {
        return fail(error)
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
      degraded("session.status", "derived from session.active(); only running sessions are visible")
      try {
        const active = asRecord(unwrapData(await callDomain(context.session, "active")))
        const data: UnknownRecord = {}
        for (const sessionID of Object.keys(active ?? {})) data[sessionID] = { type: "busy" }
        return ok(data)
      } catch (error) {
        return fail(error)
      }
    },
    todo: async (input?: unknown): Promise<Envelope> => {
      degraded("session.todo", "V2 has no todo endpoint; empty list returned for session " + readSessionIDSafe(input))
      return ok([])
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
      degraded("session.summarize", "mapped to session.compact")
      try {
        await callDomain(context.session, "compact", { sessionID: readSessionID(input) })
        return ok(true)
      } catch (error) {
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

function buildAppNamespace(context: V2ContextLike): UnknownRecord {
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
      degraded("app.skills", "V2 exposes skills through context.skill; no V1 list payload is mapped")
      return ok([])
    },
  }
}

function buildConfigNamespace(): UnknownRecord {
  return {
    get: async (): Promise<Envelope> => {
      degraded("config.get", "V2 setup context has no config domain; empty config returned")
      return ok({})
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
  const namespaces: UnknownRecord = {
    session: buildSessionNamespace(context, directory),
    app: buildAppNamespace(context),
    config: buildConfigNamespace(),
    model: buildModelNamespace(context),
    provider: buildProviderNamespace(context),
    tui: buildTuiNamespace(),
    experimental: buildExperimentalNamespace(context, directory),
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
