/**
 * Live session status, fed by the V2 event stream (S4).
 *
 * `session.status()` cannot be "active() or nothing": 2.1.4's plugin `SessionDomain` is
 * `Pick<SessionApi, "list" | "create" | "get" | "remove" | ... | "context">` — it does **not** expose
 * `active` (a real serve logs `V2 domain method active is not available on this host`). The only
 * truthful running signal a plugin can see is the event stream:
 *
 *   session.status  { sessionID, status: { type: "busy" | "idle" | "retry", ... } }
 *   session.idle    { sessionID }
 *   session.deleted -> forget the session
 *
 * The event pump in `../hooks` feeds this registry; the client shim merges it with `session.list()`
 * (every listed session that never reported status is `idle`). A `retry` status keeps the V1 retry
 * shape, so a consumer that switches on `type` sees the same three cases it knows.
 */
import { asRecord, readNumber, readRecord, readString } from "./types"

export type V1SessionStatus =
  | { readonly type: "busy" }
  | { readonly type: "idle" }
  | { readonly type: "retry"; readonly attempt: number; readonly message: string; readonly next: number }

const statuses = new Map<string, V1SessionStatus>()

function statusOf(value: unknown): V1SessionStatus | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const type = readString(record, "type")
  if (type === "busy" || type === "idle") return { type }
  if (type === "retry") {
    return {
      type: "retry",
      attempt: readNumber(record, "attempt") ?? 0,
      message: readString(record, "message") ?? "",
      next: readNumber(record, "next") ?? 0,
    }
  }
  return undefined
}

/** V2 events carry their payload in `data`; a V1-shaped event would carry `properties`. */
function payloadOf(record: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(record["data"]) ?? asRecord(record["properties"])
}

/**
 * Records one V2 event. Returns true when it was a status-bearing event, so the caller can count it.
 * Unknown shapes are ignored on purpose: a broken event must not invent a status.
 */
export function noteSessionEvent(event: unknown): boolean {
  const record = asRecord(event)
  const type = record === undefined ? undefined : readString(record, "type")
  if (record === undefined || type === undefined) return false

  const payload = payloadOf(record)
  const sessionID = readString(payload, "sessionID")
  if (sessionID === undefined || sessionID.length === 0) return false

  if (type === "session.deleted") {
    statuses.delete(sessionID)
    return true
  }
  if (type === "session.idle") {
    statuses.set(sessionID, { type: "idle" })
    return true
  }
  if (type === "session.status") {
    const next = statusOf(payload?.["status"]) ?? statusOf(payload)
    if (next === undefined) return false
    statuses.set(sessionID, next)
    return true
  }
  return false
}

export function readSessionStatuses(): ReadonlyMap<string, V1SessionStatus> {
  return statuses
}

export function resetSessionStatuses(): void {
  statuses.clear()
}
