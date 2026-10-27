/**
 * V2 session message -> V1 `{ info, parts }` mapping (S4).
 *
 * Verified against OpenCode 2.1.4 (`@opencode/schema` 2.1.4 / `@opencode/client` 2.1.4):
 *
 *   `session.context({ sessionID })` answers `SessionMessage.Info[]`, a *flat* discriminated union
 *   keyed by `type` ("user" | "assistant" | "system" | "skill" | "shell" | "compaction" | "idle" |
 *   "agent-switched" | "model-switched" | "location-switched" | "synthetic"). There is no `parts`
 *   field, but the parts are not gone either:
 *
 *     user         text: string, files?: [{uri, name?, description?}], agents?, skills?
 *     assistant    content: [{type: "text" | "reasoning" | "tool-call" | "tool-result" | "media" | ...}]
 *     system       text, description?
 *     skill        skill, name, text
 *     shell        command, status, output?, shellID
 *     compaction   status + summary
 *
 * So the V1 view is reconstructible rather than empty: `content` is mapped 1:1 onto V1 parts, the
 * user `text`/`files` become the user turn's text/file parts, and the original message id, type and
 * timestamps are preserved. What cannot be expressed (agent/model switches, idle markers, provider
 * metadata on parts) is counted in `dropped`, so a loss is measurable instead of silent.
 */
import { asRecord, readArray, readNumber, readRecord, readString, type UnknownRecord } from "./types"

export type MessageMappingStats = {
  readonly messages: number
  readonly parts: number
  /** Fields/parts with no V1 equivalent, dropped on purpose. */
  readonly dropped: number
  /** The same information kept in an approximate V1 shape (e.g. a shell message as a text part). */
  readonly approximated: number
  readonly droppedReasons: Readonly<Record<string, number>>
}

export type MessageMappingResult = {
  readonly messages: UnknownRecord[]
  readonly stats: MessageMappingStats
}

const PART_TYPES = new Set(["text", "reasoning", "tool", "file", "compaction", "step-start", "step-finish"])

/** V2 decodes `time.created` to an ISO string; a raw host may still hand over epoch millis. */
function toMillis(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function readTime(record: UnknownRecord, fallback: number): { created: number; completed?: number } {
  const time = readRecord(record, "time")
  const created = toMillis(time?.["created"]) ?? fallback
  const completed = toMillis(time?.["completed"])
  return completed === undefined ? { created } : { created, completed }
}

function readModel(record: UnknownRecord): UnknownRecord | undefined {
  const model = readRecord(record, "model")
  const providerID = readString(model, "providerID") ?? readString(record, "providerID")
  const modelID = readString(model, "id") ?? readString(model, "modelID") ?? readString(record, "modelID")
  if (providerID === undefined && modelID === undefined) return undefined
  return { providerID: providerID ?? "", modelID: modelID ?? "" }
}

/** Counts losses without flooding: one bucket per reason, aggregated at the end. */
class Tally {
  private readonly reasons = new Map<string, number>()
  private approximated = 0

  drop(reason: string): void {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1)
  }

  approximate(): void {
    this.approximated += 1
  }

  get dropped(): number {
    let total = 0
    for (const count of this.reasons.values()) total += count
    return total
  }

  get approximatedCount(): number {
    return this.approximated
  }

  snapshot(): Readonly<Record<string, number>> {
    const out: Record<string, number> = {}
    for (const [reason, count] of this.reasons) out[reason] = count
    return out
  }
}

function partID(messageID: string, index: number): string {
  return `${messageID}:p${index}`
}

/** Media sources are bytes/base64/url/ref in V2; only url and base64 have a V1 `FilePart` shape. */
function mediaUrl(part: UnknownRecord): string | undefined {
  const source = readRecord(readRecord(part, "media"), "source")
  const type = readString(source, "type")
  if (type === "url") return readString(source, "url")
  if (type === "base64") {
    const data = readString(source, "data")
    const mediaType = readString(source, "mediaType") ?? "application/octet-stream"
    return data === undefined ? undefined : `data:${mediaType};base64,${data}`
  }
  return undefined
}

function toolResultText(part: UnknownRecord): string | undefined {
  const result = readRecord(part, "result")
  const type = readString(result, "type")
  if (type === "text" || type === "json") {
    const value = result?.["value"]
    return typeof value === "string" ? value : JSON.stringify(value)
  }
  if (type === "error") return String(result?.["value"])
  const content = readArray(result, "value")
  if (Array.isArray(content)) {
    const texts = content
      .map((entry) => readString(entry, "text"))
      .filter((text): text is string => text !== undefined)
    if (texts.length > 0) return texts.join("\n")
  }
  return undefined
}

type PartDraft = { readonly index: number; readonly record: UnknownRecord }

/**
 * Assistant `content` -> V1 parts. A tool call and its result share an `id` in V2, so they collapse
 * into ONE V1 tool part (running -> completed), which is what V1 hooks (`tool-pair-validator`,
 * `claude-code-hooks` transcripts) expect to see.
 */
function mapAssistantContent(
  messageID: string,
  sessionID: string,
  content: readonly unknown[],
  tally: Tally,
  now: number,
): UnknownRecord[] {
  const parts: UnknownRecord[] = []
  const toolIndex = new Map<string, number>()

  for (const entry of content) {
    const record = asRecord(entry)
    const type = record === undefined ? undefined : readString(record, "type")
    if (record === undefined || type === undefined) {
      tally.drop("assistant-content:not-an-object")
      continue
    }

    if (type === "text") {
      const text = readString(record, "text") ?? ""
      parts.push({
        id: partID(messageID, parts.length),
        sessionID,
        messageID,
        type: "text",
        text,
        time: { start: now, end: now },
      })
      continue
    }

    if (type === "reasoning") {
      parts.push({
        id: partID(messageID, parts.length),
        sessionID,
        messageID,
        type: "reasoning",
        text: readString(record, "text") ?? "",
        time: { start: now, end: now },
      })
      continue
    }

    if (type === "tool-call") {
      const callID = readString(record, "id") ?? partID(messageID, parts.length)
      const tool = readString(record, "name") ?? ""
      toolIndex.set(callID, parts.length)
      parts.push({
        id: partID(messageID, parts.length),
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool,
        state: { status: "running", input: readRecord(record, "input") ?? {}, time: { start: now } },
      })
      continue
    }

    if (type === "tool-result") {
      const callID = readString(record, "id") ?? ""
      const existing = toolIndex.get(callID)
      const output = toolResultText(record) ?? ""
      if (existing !== undefined) {
        const part = parts[existing] as UnknownRecord
        part["state"] = {
          status: "completed",
          input: readRecord(part["state"], "input") ?? {},
          output,
          title: readString(record, "name") ?? "",
          metadata: {},
          time: { start: now, end: now },
        }
        continue
      }
      // A result whose call is not in this message: keep it observable as a completed tool part
      // rather than dropping the only record of what the tool returned.
      tally.approximate()
      toolIndex.set(callID, parts.length)
      parts.push({
        id: partID(messageID, parts.length),
        sessionID,
        messageID,
        type: "tool",
        callID,
        tool: readString(record, "name") ?? "",
        state: {
          status: "completed",
          input: {},
          output,
          title: readString(record, "name") ?? "",
          metadata: {},
          time: { start: now, end: now },
        },
      })
      continue
    }

    if (type === "media") {
      const url = mediaUrl(record)
      if (url === undefined) {
        tally.drop("assistant-content:media-source-unmappable")
        continue
      }
      parts.push({
        id: partID(messageID, parts.length),
        sessionID,
        messageID,
        type: "file",
        mime: readString(record, "mime") ?? "application/octet-stream",
        filename: readString(record, "filename") ?? readString(record, "name"),
        url,
      })
      continue
    }

    tally.drop(`assistant-content:${type}`)
  }

  return parts
}

function mapUserParts(
  messageID: string,
  sessionID: string,
  record: UnknownRecord,
  tally: Tally,
  now: number,
): UnknownRecord[] {
  const parts: UnknownRecord[] = []
  const text = readString(record, "text")
  if (text !== undefined) {
    parts.push({
      id: partID(messageID, parts.length),
      sessionID,
      messageID,
      type: "text",
      text,
      time: { start: now, end: now },
    })
  }

  for (const entry of readArray(record, "files") ?? []) {
    const file = asRecord(entry)
    const uri = file === undefined ? undefined : readString(file, "uri")
    if (uri === undefined) {
      tally.drop("user-file:no-uri")
      continue
    }
    parts.push({
      id: partID(messageID, parts.length),
      sessionID,
      messageID,
      type: "file",
      mime: readString(file, "mime") ?? "application/octet-stream",
      filename: readString(file, "name"),
      url: uri,
    })
  }

  if (readArray(record, "agents") !== undefined) tally.drop("user:agents-selection")
  if (readArray(record, "skills") !== undefined) tally.drop("user:skills-selection")
  return parts
}

function textPart(
  messageID: string,
  sessionID: string,
  text: string,
  now: number,
  synthetic = false,
): UnknownRecord {
  return {
    id: partID(messageID, 0),
    sessionID,
    messageID,
    type: "text",
    text,
    ...(synthetic ? { synthetic: true } : {}),
    time: { start: now, end: now },
  }
}

/** V1 `Message` requires a role of user/assistant; everything else is presented as a system turn. */
function v1Role(type: string): "user" | "assistant" {
  return type === "assistant" ? "assistant" : "user"
}

function baseInfo(
  id: string,
  sessionID: string,
  role: "user" | "assistant",
  record: UnknownRecord,
  now: number,
): UnknownRecord {
  return { id, sessionID, role, time: readTime(record, now) }
}

/**
 * Maps one V2 message. Returns `undefined` only for entries that have no V1 counterpart at all
 * (`idle`, `agent-switched`, ...); those are counted, not silently skipped.
 */
function mapMessage(
  entry: unknown,
  index: number,
  sessionID: string,
  directory: string,
  tally: Tally,
  now: number,
): UnknownRecord | undefined {
  const record = asRecord(entry)
  const type = record === undefined ? undefined : readString(record, "type")
  if (record === undefined || type === undefined) {
    tally.drop("message:untyped")
    return undefined
  }

  const messageID = readString(record, "id") ?? `msg_${index}`
  const role = v1Role(type)

  if (type === "idle") {
    tally.drop("message:idle")
    return undefined
  }
  if (type === "agent-switched" || type === "model-switched" || type === "location-switched") {
    tally.drop(`message:${type}`)
    return undefined
  }

  if (type === "assistant") {
    const tokens = readRecord(record, "tokens")
    const cache = readRecord(tokens, "cache")
    const info = {
      ...baseInfo(messageID, sessionID, "assistant", record, now),
      agent: readString(record, "agent") ?? "",
      ...(readModel(record) === undefined ? {} : { model: readModel(record) }),
      mode: readString(record, "agent") ?? "",
      parentID: readString(record, "parentID") ?? "",
      path: { cwd: directory, root: directory },
      cost: readNumber(record, "cost") ?? 0,
      tokens: {
        input: readNumber(tokens, "input") ?? 0,
        output: readNumber(tokens, "output") ?? 0,
        reasoning: readNumber(tokens, "reasoning") ?? 0,
        cache: { read: readNumber(cache, "read") ?? 0, write: readNumber(cache, "write") ?? 0 },
      },
      ...(readString(record, "finish") === undefined ? {} : { finish: readString(record, "finish") }),
    }
    const content = readArray(record, "content") ?? []
    const parts = mapAssistantContent(messageID, sessionID, content, tally, now)
    if (readRecord(record, "error") !== undefined) tally.drop("assistant:error")
    return { info, parts }
  }

  if (type === "user" || type === "synthetic") {
    const info = baseInfo(messageID, sessionID, "user", record, now)
    const agents = readArray(record, "agents")
    const firstAgent = asRecord(agents?.[0])
    const agentName = readString(firstAgent, "name") ?? (typeof agents?.[0] === "string" ? agents[0] : undefined)
    if (agentName !== undefined) info["agent"] = agentName
    const parts = mapUserParts(messageID, sessionID, record, tally, now)
    if (type === "synthetic" && parts.length === 0) {
      tally.drop("message:synthetic-without-text")
      return undefined
    }
    return { info, parts }
  }

  if (type === "compaction") {
    // `isCompactionMessage()` in the V1 engine keys off `info.agent === "compaction"` or a part of
    // type "compaction"; both are set so compaction detection keeps working on V2 history.
    const info = { ...baseInfo(messageID, sessionID, "assistant", record, now), agent: "compaction" }
    const parts: UnknownRecord[] = [{ id: partID(messageID, 0), sessionID, messageID, type: "compaction" }]
    const summary = readString(record, "summary")
    if (summary !== undefined) {
      parts.push(textPart(messageID, sessionID, summary, now))
    } else {
      tally.drop("compaction:no-summary")
    }
    return { info, parts }
  }

  if (type === "system") {
    const text = readString(record, "text") ?? ""
    return {
      info: { ...baseInfo(messageID, sessionID, "user", record, now), ...{ synthetic: true } },
      parts: [textPart(messageID, sessionID, text, now, true)],
    }
  }

  if (type === "skill") {
    const text = readString(record, "text") ?? ""
    const name = readString(record, "name")
    tally.approximate()
    return {
      info: baseInfo(messageID, sessionID, "user", record, now),
      parts: [textPart(messageID, sessionID, name === undefined ? text : `[skill:${name}]\n${text}`, now, true)],
    }
  }

  if (type === "shell") {
    const command = readString(record, "command") ?? ""
    const output = readString(readRecord(record, "output"), "text") ?? ""
    tally.approximate()
    return {
      info: baseInfo(messageID, sessionID, "user", record, now),
      parts: [textPart(messageID, sessionID, `$ ${command}\n${output}`.trimEnd(), now, true)],
    }
  }

  tally.drop(`message:${type}`)
  return undefined
}

/** The one entry point the client shim uses: V2 `SessionMessage.Info[]` -> V1 `{info, parts}[]`. */
export function mapSessionMessages(
  payload: unknown,
  sessionID: string,
  directory: string,
): MessageMappingResult {
  const list = Array.isArray(payload) ? payload : []
  const tally = new Tally()
  const now = Date.now()
  const messages: UnknownRecord[] = []
  let parts = 0

  for (const [index, entry] of list.entries()) {
    const mapped = mapMessage(entry, index, sessionID, directory, tally, now)
    if (mapped === undefined) continue
    messages.push(mapped)
    parts += (mapped["parts"] as unknown[]).length
  }

  return {
    messages,
    stats: {
      messages: messages.length,
      parts,
      dropped: tally.dropped,
      approximated: tally.approximatedCount,
      droppedReasons: tally.snapshot(),
    },
  }
}

/** Exported for the selftest: a part is legal when it carries the V1 identity envelope and a type. */
export function isLegalV1Part(part: unknown): boolean {
  const record = asRecord(part)
  if (record === undefined) return false
  const type = readString(record, "type")
  if (type === undefined || !PART_TYPES.has(type)) return false
  if (typeof record["id"] !== "string" || record["id"].length === 0) return false
  if (typeof record["sessionID"] !== "string") return false
  if (typeof record["messageID"] !== "string") return false
  if (type === "text" || type === "reasoning") return typeof record["text"] === "string"
  if (type === "tool") return typeof record["callID"] === "string" && typeof record["tool"] === "string"
  if (type === "file") return typeof record["url"] === "string"
  return true
}
