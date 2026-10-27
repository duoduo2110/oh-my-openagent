/**
 * Semantic V1 hook bridge (S2b-2).
 *
 * The mechanical keys landed in S2b-1. These five V1 hooks describe *what the model receives*, so the
 * V1 payload has to be reconstructed and every write has to be mapped back onto a different V2
 * shape. Verified against `@opencode/plugin` 2.1.4 (`dist/promise/session.d.ts`, `registration.d.ts`):
 *
 *   V1 key                                V2 slot            V2 payload (mutable)
 *   chat.message                          session.hook("prompt")        { sessionID, messageID, prompt, metadata?, delivery }
 *   experimental.chat.system.transform    session.hook("context")       { sessionID, model, system: SystemPart[], messages, options, tools, agent }
 *   experimental.chat.messages.transform  session.hook("context")       (same event)
 *   chat.params                           session.hook("context")       (same event -> `options`)
 *   chat.headers                          session.hook("http.request")  { sessionID, agent, model, kind, request: Request }
 *
 * Two shape facts drive the code below:
 *
 *   - `prompt` is a *text* model (`{ text, files?, skills?, agents? }`), not V1's `{info, parts}`.
 *     Text parts therefore collapse into `prompt.text` on writeback; a V1 handler that only edits
 *     `message.variant`/`message.model` has nowhere to write (`chat.message dropped` is counted).
 *   - `context` carries provider-level `Message[]` (`{ id?, role, content: Part[] }`) plus
 *     `system: SystemPart[]`, while V1 transforms expect `{info, parts}[]` and `string[]`. Both
 *     directions are implemented here; a structural edit that cannot be expressed is counted.
 *
 * Why `chat.params` lives on `context` and not on `model.request`: 2.1.4's `SessionModelRequest` is
 * `{ sessionID, agent, model, kind, baseURL?, headers }` — it has no generation options at all, while
 * `SessionRequest.options` is exactly `GenerationOptionsFields & Record<string, unknown>`. Bridging
 * params onto `model.request` would accept every write and drop it. The deviation is recorded as a
 * degradation on `chat.params` so it stays visible.
 *
 * No handler may break the host request: every callback catches, counts, and returns.
 */
import { log } from "../../shared/logger"
import { asRecord, readArray, readNumber, readRecord, readString, type UnknownRecord } from "../adapter/types"

export const SEMANTIC_LOG_PREFIX = "[omo-v2] hook"

export type SemanticMeter = {
  readonly fire: (key: string, detail?: Readonly<Record<string, unknown>>) => void
  readonly fail: (key: string, error: unknown) => void
  readonly writeback: (key: string) => void
  readonly drop: (key: string, reason: string) => void
}

export type SemanticHookKey =
  | "chat.message"
  | "chat.params"
  | "chat.headers"
  | "experimental.chat.system.transform"
  | "experimental.chat.messages.transform"

type Handler = (input: unknown, output: unknown) => Promise<void>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function handlerOf(hooks: unknown, key: SemanticHookKey): Handler | undefined {
  const value = asRecord(hooks)?.[key]
  return typeof value === "function" ? (value as Handler) : undefined
}

function fingerprint(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "undefined"
  } catch {
    return "unserializable"
  }
}

// ---------------------------------------------------------------------------------------------
// chat.message  <->  session.hook("prompt")
// ---------------------------------------------------------------------------------------------

/**
 * V2 `PromptInput.Prompt` is `{ text, files?, skills?, agents? }`. V1 wants `message` (a
 * `UserMessage`) plus `parts`. The prompt text becomes the first text part, the attachments become
 * file parts, and the original message/session ids are preserved.
 */
function promptToV1(
  prompt: UnknownRecord,
  sessionID: string,
  messageID: string,
  metadata: UnknownRecord,
): { parts: UnknownRecord[]; message: UnknownRecord } {
  const now = Date.now()
  const parts: UnknownRecord[] = []
  const text = readString(prompt, "text")
  if (text !== undefined) {
    parts.push({ id: `${messageID}:p0`, sessionID, messageID, type: "text", text, time: { start: now, end: now } })
  }
  let index = 1
  for (const entry of readArray(prompt, "files") ?? []) {
    const file = asRecord(entry)
    const uri = file === undefined ? undefined : readString(file, "uri")
    if (uri === undefined) continue
    parts.push({
      id: `${messageID}:p${index}`,
      sessionID,
      messageID,
      type: "file",
      mime: readString(file, "mime") ?? "application/octet-stream",
      filename: readString(file, "name"),
      url: uri,
    })
    index += 1
  }

  const agent = readString(metadata, "agent")
  const model = readRecord(metadata, "model")
  const variant = readString(metadata, "variant")
  const message: UnknownRecord = {
    id: messageID,
    sessionID,
    role: "user",
    time: { created: now },
    ...(agent === undefined ? {} : { agent }),
    ...(model === undefined ? {} : { model }),
    ...(variant === undefined ? {} : { variant }),
  }
  return { parts, message }
}

async function handlePrompt(
  event: unknown,
  hooks: unknown,
  meter: SemanticMeter,
): Promise<void> {
  const record = asRecord(event)
  if (record === undefined) {
    meter.drop("chat.message", "V2 prompt event is not an object")
    return
  }
  const handler = handlerOf(hooks, "chat.message")
  if (handler === undefined) return

  const prompt = readRecord(record, "prompt")
  if (prompt === undefined) {
    meter.drop("chat.message", "V2 prompt event carries no prompt object")
    return
  }

  const sessionID = readString(record, "sessionID") ?? ""
  const messageID = readString(record, "messageID") ?? ""
  const metadata = readRecord(record, "metadata") ?? {}
  const built = promptToV1(prompt, sessionID, messageID, metadata)
  const originalText = readString(prompt, "text") ?? ""
  const originalParts = fingerprint(built.parts)

  meter.fire("chat.message", { sessionID, messageID, parts: built.parts.length })

  const output: UnknownRecord = { message: built.message, parts: built.parts }
  const input: UnknownRecord = {
    sessionID,
    messageID,
    ...(readString(built.message, "agent") === undefined ? {} : { agent: built.message["agent"] }),
    ...(readRecord(built.message, "model") === undefined ? {} : { model: built.message["model"] }),
    ...(readString(built.message, "variant") === undefined ? {} : { variant: built.message["variant"] }),
  }

  try {
    await handler(input, output)
  } catch (error) {
    // A broken V1 hook must not cancel the user's prompt.
    meter.fail("chat.message", error)
    return
  }

  // Writeback: every text part collapses into `prompt.text` (V2's prompt is text-based), file parts
  // rebuild the attachment list, and everything else is recorded as dropped.
  const parts = readArray(output, "parts") ?? []
  const texts: string[] = []
  const files: UnknownRecord[] = []
  let droppedParts = 0
  for (const entry of parts) {
    const part = asRecord(entry)
    const type = part === undefined ? undefined : readString(part, "type")
    if (type === "text") {
      const text = readString(part, "text")
      if (text !== undefined && text.length > 0) texts.push(text)
      continue
    }
    if (type === "file") {
      const url = readString(part, "url")
      if (url === undefined) {
        droppedParts += 1
        continue
      }
      files.push({
        uri: url,
        ...(readString(part, "filename") === undefined ? {} : { name: readString(part, "filename") }),
      })
      continue
    }
    droppedParts += 1
  }
  if (droppedParts > 0) {
    meter.drop("chat.message", `${droppedParts} V1 part type(s) have no PromptInput equivalent`)
  }

  const nextText = texts.join("\n\n")
  if (nextText !== originalText) {
    prompt["text"] = nextText
    meter.writeback("chat.message")
  }
  const originalFiles = readArray(prompt, "files") ?? []
  if (fingerprint(files) !== fingerprint(originalFiles.map((file) => {
    const entry = asRecord(file) ?? {}
    return {
      uri: readString(entry, "uri"),
      ...(readString(entry, "name") === undefined ? {} : { name: readString(entry, "name") }),
    }
  }))) {
    if (files.length === 0) delete prompt["files"]
    else prompt["files"] = files
    meter.writeback("chat.message")
  }

  // `message` is V1-only: V2's prompt event has no model/variant slot to write into.
  const modelAfter = readRecord(output["message"], "model")
  if (
    fingerprint(modelAfter) !== fingerprint(readRecord(built.message, "model"))
    || readString(output["message"], "variant") !== readString(built.message, "variant")
  ) {
    meter.drop("chat.message", "V2 prompt event has no model/variant field; the V1 message edit was dropped")
  }
  if (fingerprint(readArray(output, "parts") ?? []) !== originalParts && parts.length === 0) {
    meter.drop("chat.message", "V1 handler removed every part; V2 cannot express an empty prompt")
  }
}

// ---------------------------------------------------------------------------------------------
// provider-level Message[]  <->  V1 {info, parts}[]
// ---------------------------------------------------------------------------------------------

type Slot =
  | { readonly kind: "text"; readonly index: number; readonly ref: UnknownRecord }
  | { readonly kind: "tool"; readonly index: number; readonly ref: UnknownRecord }
  | { readonly kind: "media"; readonly index: number; readonly ref: UnknownRecord }

type MessageBinding = {
  readonly id: string
  readonly content: unknown[]
  readonly record: UnknownRecord
  readonly slots: Slot[]
}

type ProviderMessageView = {
  readonly messages: UnknownRecord[]
  readonly bindings: MessageBinding[]
  readonly dropped: number
}

function mediaUrlOf(part: UnknownRecord): string | undefined {
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

/**
 * Provider `Message` = `{ id?, role, content: Part[] }`; V1 wants `{info, parts}`. The binding keeps
 * a pointer to the exact V2 object each V1 part came from, which is what makes a parts-level edit
 * writable (the alternative — matching by index after the fact — breaks as soon as a hook splices).
 */
function providerMessagesToV1(messages: readonly unknown[], directory: string): ProviderMessageView {
  const now = Date.now()
  const out: UnknownRecord[] = []
  const bindings: MessageBinding[] = []
  let dropped = 0

  for (const [messageIndex, entry] of messages.entries()) {
    const record = asRecord(entry)
    const role = record === undefined ? undefined : readString(record, "role")
    if (record === undefined || role === undefined) {
      dropped += 1
      continue
    }
    const id = readString(record, "id") ?? `msg_${messageIndex}`
    const content = Array.isArray(record["content"]) ? (record["content"] as unknown[]) : []
    const slots: Slot[] = []
    const parts: UnknownRecord[] = []
    const v1Role = role === "assistant" ? "assistant" : "user"

    const info: UnknownRecord = {
      id,
      sessionID: "",
      role: v1Role,
      time: { created: now },
      path: { cwd: directory, root: directory },
      // The provider view carries no ids of its own; the V1 shapes that need them get placeholders
      // so a handler reading `info.agent` does not crash on `undefined.length`.
      ...(v1Role === "assistant"
        ? { agent: "", mode: "", parentID: "", modelID: "", providerID: "", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
        : { agent: "" }),
    }

    for (const [index, contentEntry] of content.entries()) {
      const part = asRecord(contentEntry)
      const type = part === undefined ? undefined : readString(part, "type")
      if (part === undefined || type === undefined) {
        dropped += 1
        continue
      }
      const partID = `${id}:p${index}`
      if (type === "text") {
        parts.push({
          id: partID,
          sessionID: "",
          messageID: id,
          type: "text",
          text: readString(part, "text") ?? "",
          time: { start: now, end: now },
        })
        slots.push({ kind: "text", index, ref: part })
        continue
      }
      if (type === "tool-call") {
        parts.push({
          id: partID,
          sessionID: "",
          messageID: id,
          type: "tool",
          callID: readString(part, "id") ?? partID,
          tool: readString(part, "name") ?? "",
          state: { status: "running", input: readRecord(part, "input") ?? {}, time: { start: now } },
        })
        slots.push({ kind: "tool", index, ref: part })
        continue
      }
      if (type === "tool-result") {
        // V2 keeps the result as its own provider part; V1 keeps one tool part with a state. The V1
        // view shows it, but there is no single V2 object to write a merged state back into.
        parts.push({
          id: partID,
          sessionID: "",
          messageID: id,
          type: "tool",
          callID: readString(part, "id") ?? partID,
          tool: readString(part, "name") ?? "",
          state: {
            status: "completed",
            input: {},
            output: "",
            title: "",
            metadata: {},
            time: { start: now, end: now },
          },
        })
        slots.push({ kind: "tool", index, ref: part })
        continue
      }
      if (type === "media") {
        const url = mediaUrlOf(part)
        if (url === undefined) {
          dropped += 1
          continue
        }
        parts.push({
          id: partID,
          sessionID: "",
          messageID: id,
          type: "file",
          mime: readString(part, "mime") ?? "application/octet-stream",
          filename: readString(part, "filename") ?? readString(part, "name"),
          url,
        })
        slots.push({ kind: "media", index, ref: part })
        continue
      }
      // reasoning / cache / provider-metadata parts exist on both sides in spirit but not in shape.
      dropped += 1
    }

    out.push({ info, parts })
    bindings.push({ id, content, record, slots })
  }

  return { messages: out, bindings, dropped }
}

/** Writes one V1 part back into the V2 content array it came from; returns whether it wrote. */
function writeBackPart(
  slot: Slot | undefined,
  v1Part: UnknownRecord,
  content: unknown[],
  meter: SemanticMeter,
  key: SemanticHookKey,
  id: string,
  index: number,
): boolean {
  const type = readString(v1Part, "type")
  if (slot === undefined) {
    // A V1 hook appended a part: text and file parts have an expressible V2 form.
    if (type === "text") {
      const text = readString(v1Part, "text") ?? ""
      content.push({ type: "text", text })
      return true
    }
    if (type === "file") {
      const url = readString(v1Part, "url")
      if (url !== undefined) {
        content.push({
          type: "media",
          media: { source: { type: "url", url }, mediaType: readString(v1Part, "mime") ?? "application/octet-stream" },
          ...(readString(v1Part, "filename") === undefined ? {} : { filename: readString(v1Part, "filename") }),
        })
        return true
      }
    }
    meter.drop(key, `appended V1 part type "${type ?? "unknown"}" has no provider-part equivalent`)
    return false
  }

  if (slot.kind === "text") {
    if (type !== "text") {
      meter.drop(key, `part ${index} of ${id} changed type (${String(type)}); V2 cannot re-tag a part`)
      return false
    }
    const text = readString(v1Part, "text") ?? ""
    if (text !== (readString(slot.ref, "text") ?? "")) {
      slot.ref["text"] = text
      return true
    }
    return false
  }

  if (slot.kind === "tool") {
    const state = readRecord(v1Part, "state")
    if (state === undefined) return false
    const input = readRecord(state, "input")
    let wrote = false
    if (input !== undefined && fingerprint(input) !== fingerprint(readRecord(slot.ref, "input"))) {
      slot.ref["input"] = input
      wrote = true
    }
    const status = readString(state, "status")
    const providerType = readString(slot.ref, "type")
    if (providerType === "tool-result") {
      meter.drop(key, "V1 tool output edits are not mapped back onto a V2 tool-result part")
    } else if (status === "completed" || status === "error") {
      // The V2 tool-call part has no lifecycle fields; only `input` is writable there.
      meter.drop(key, `V1 tool state "${String(status)}" has no V2 tool-call field`)
    }
    return wrote
  }

  if (type !== "file") {
    meter.drop(key, `part ${index} of ${id} changed type (${String(type)}); V2 media parts cannot be re-tagged`)
    return false
  }
  const url = readString(v1Part, "url")
  if (url === undefined) return false
  if (url !== mediaUrlOf(slot.ref)) {
    slot.ref["media"] = { source: { type: "url", url }, mediaType: readString(v1Part, "mime") ?? "application/octet-stream" }
    return true
  }
  return false
}

function writeBackProviderMessages(
  view: ProviderMessageView,
  v1Messages: readonly unknown[],
  meter: SemanticMeter,
  key: SemanticHookKey = "experimental.chat.messages.transform",
): void {
  if (v1Messages.length !== view.bindings.length) {
    meter.drop(
      key,
      `V1 handed back ${v1Messages.length} messages for ${view.bindings.length} provider messages; only matching positions are written`,
    )
  }
  const limit = Math.min(v1Messages.length, view.bindings.length)
  for (let index = 0; index < limit; index += 1) {
    const binding = view.bindings[index] as MessageBinding
    const v1Message = asRecord(v1Messages[index])
    if (v1Message === undefined) {
      meter.drop(key, `message ${index} is not an object; skipped`)
      continue
    }
    const v1ID = readString(readRecord(v1Message, "info"), "id") ?? readString(v1Message, "id")
    if (v1ID !== undefined && v1ID !== binding.id) {
      meter.drop(key, `message ${index} identity changed (${v1ID} != ${binding.id}); V2 ids are not editable`)
      continue
    }
    const parts = readArray(v1Message, "parts") ?? []
    for (const [partIndex, entry] of parts.entries()) {
      const v1Part = asRecord(entry)
      if (v1Part === undefined) {
        meter.drop(key, `part ${partIndex} of message ${index} is not an object`)
        continue
      }
      if (writeBackPart(binding.slots[partIndex], v1Part, binding.content, meter, key, binding.id, partIndex)) {
        meter.writeback(key)
      }
    }
    if (parts.length > binding.slots.length) {
      // Appended parts were already pushed by `writeBackPart` (slot === undefined).
      continue
    }
    if (parts.length < binding.slots.length) {
      meter.drop(key, `message ${index} lost ${binding.slots.length - parts.length} part(s); V2 removal is not mapped`)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// session.hook("context"): system.transform + messages.transform + chat.params
// ---------------------------------------------------------------------------------------------

/**
 * V2 `system` is `SystemPart[]` (`{ type: "text", text, cache?, metadata? }`); V1 is `string[]`.
 * Text is replaced in place so `cache`/`metadata` survive an unchanged part, and new strings are
 * appended as plain text parts.
 */
function writeBackSystem(
  system: unknown[],
  next: readonly string[],
  meter: SemanticMeter,
): void {
  const current = system.map((part) => readString(part, "text") ?? "")
  if (current.length === next.length && current.every((text, index) => text === next[index])) return

  const limit = Math.min(system.length, next.length)
  for (let index = 0; index < limit; index += 1) {
    const part = asRecord(system[index])
    if (part === undefined) continue
    if (readString(part, "text") !== next[index]) part["text"] = next[index]
  }
  if (next.length > system.length) {
    for (const text of next.slice(system.length)) system.push({ type: "text", text })
  } else if (next.length < system.length) {
    meter.drop(
      "experimental.chat.system.transform",
      `V1 returned ${next.length} system strings for ${system.length} parts; removals are not mapped`,
    )
    system.splice(next.length)
  }
  meter.writeback("experimental.chat.system.transform")
}

function modelRefOf(record: UnknownRecord): UnknownRecord {
  const model = readRecord(record, "model") ?? {}
  return {
    providerID: readString(model, "providerID") ?? "",
    modelID: readString(model, "id") ?? readString(model, "modelID") ?? "",
    ...(readString(model, "variant") === undefined ? {} : { variant: readString(model, "variant") }),
  }
}

async function runSystemTransform(
  record: UnknownRecord,
  hooks: unknown,
  meter: SemanticMeter,
  sessionID: string,
): Promise<void> {
  const handler = handlerOf(hooks, "experimental.chat.system.transform")
  if (handler === undefined) return
  const system = readArray(record, "system")
  if (system === undefined) {
    meter.drop("experimental.chat.system.transform", "V2 context event has no system array")
    return
  }
  const mutable = system as unknown[]
  const output = { system: mutable.map((part) => readString(part, "text") ?? "") }

  meter.fire("experimental.chat.system.transform", { sessionID, parts: mutable.length })
  try {
    await handler({ sessionID, model: modelRefOf(record) }, output)
  } catch (error) {
    meter.fail("experimental.chat.system.transform", error)
    return
  }
  if (!Array.isArray(output.system)) {
    meter.drop("experimental.chat.system.transform", "V1 output.system is not an array; nothing written")
    return
  }
  writeBackSystem(mutable, output.system.map((text) => String(text)), meter)
}

async function runMessagesTransform(
  record: UnknownRecord,
  hooks: unknown,
  meter: SemanticMeter,
  sessionID: string,
  directory: string,
): Promise<void> {
  const handler = handlerOf(hooks, "experimental.chat.messages.transform")
  if (handler === undefined) return
  const messages = readArray(record, "messages")
  if (messages === undefined) {
    meter.drop("experimental.chat.messages.transform", "V2 context event has no messages array")
    return
  }
  const mutable = messages as unknown[]
  const view = providerMessagesToV1(mutable, directory)
  const output = { messages: view.messages }

  meter.fire("experimental.chat.messages.transform", {
    sessionID,
    messages: view.messages.length,
    dropped: view.dropped,
  })
  if (view.dropped > 0) {
    meter.drop("experimental.chat.messages.transform", `${view.dropped} provider part(s) have no V1 shape`)
  }

  try {
    await handler({}, output)
  } catch (error) {
    meter.fail("experimental.chat.messages.transform", error)
    return
  }
  if (!Array.isArray(output.messages)) {
    meter.drop("experimental.chat.messages.transform", "V1 output.messages is not an array; nothing written")
    return
  }
  writeBackProviderMessages(view, output.messages, meter)
}

/**
 * V1 `chat.params` output is `{ temperature, topP, topK, maxOutputTokens, options }`; the V2 request
 * options are `{ temperature?, topP?, topK?, maxTokens?, ...providerOptions }`. The rename
 * `maxOutputTokens -> maxTokens` is the one name change; `options` merges as top-level provider keys.
 */
async function runChatParams(
  record: UnknownRecord,
  hooks: unknown,
  meter: SemanticMeter,
  sessionID: string,
): Promise<void> {
  const handler = handlerOf(hooks, "chat.params")
  if (handler === undefined) return
  const options = asRecord(record["options"])
  if (options === undefined) {
    meter.drop("chat.params", "V2 context event has no options object")
    return
  }

  const output: UnknownRecord = {
    temperature: readNumber(options, "temperature") ?? 0,
    topP: readNumber(options, "topP") ?? 0,
    topK: readNumber(options, "topK") ?? 0,
    maxOutputTokens: readNumber(options, "maxTokens"),
    options: {},
  }
  const before = fingerprint(options)

  meter.fire("chat.params", { sessionID })
  try {
    await handler(
      {
        sessionID,
        agent: readString(record, "agent") ?? "",
        model: modelRefOf(record),
        provider: {},
        message: undefined,
      },
      output,
    )
  } catch (error) {
    meter.fail("chat.params", error)
    return
  }

  const numericKeys: ReadonlyArray<readonly [string, string]> = [
    ["temperature", "temperature"],
    ["topP", "topP"],
    ["topK", "topK"],
    ["maxOutputTokens", "maxTokens"],
  ]
  for (const [v1Key, v2Key] of numericKeys) {
    const value = output[v1Key]
    if (typeof value !== "number" || value === options[v2Key]) continue
    if (v1Key !== "maxOutputTokens" && value === 0 && options[v2Key] === undefined) continue
    options[v2Key] = value
  }
  const extra = asRecord(output["options"])
  if (extra !== undefined) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || fingerprint(value) === fingerprint(options[key])) continue
      options[key] = value
    }
  }
  if (fingerprint(options) !== before) meter.writeback("chat.params")
}

async function handleContext(
  event: unknown,
  hooks: unknown,
  meter: SemanticMeter,
  directory: string,
): Promise<void> {
  const record = asRecord(event)
  if (record === undefined) {
    meter.drop("experimental.chat.system.transform", "V2 context event is not an object")
    meter.drop("chat.params", "V2 context event is not an object")
    return
  }
  const sessionID = readString(record, "sessionID") ?? ""

  // Order matches V1: system/messages are finalised first, params are the last word before the call.
  await runSystemTransform(record, hooks, meter, sessionID)
  await runMessagesTransform(record, hooks, meter, sessionID, directory)
  await runChatParams(record, hooks, meter, sessionID)
}

// ---------------------------------------------------------------------------------------------
// chat.headers  <->  session.hook("http.request")
// ---------------------------------------------------------------------------------------------

function readHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers === undefined || headers === null) return out
  const entries = (headers as { entries?: () => Iterable<[string, string]> }).entries
  if (typeof entries === "function") {
    for (const [key, value] of entries.call(headers)) out[key] = value
    return out
  }
  const record = asRecord(headers)
  if (record === undefined) return out
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") out[key] = value
  }
  return out
}

async function handleHttpRequest(
  event: unknown,
  hooks: unknown,
  meter: SemanticMeter,
): Promise<void> {
  const record = asRecord(event)
  if (record === undefined) {
    meter.drop("chat.headers", "V2 http.request event is not an object")
    return
  }
  const handler = handlerOf(hooks, "chat.headers")
  if (handler === undefined) return

  const request = record["request"] as { headers?: unknown } | undefined
  const sessionID = readString(record, "sessionID") ?? ""
  const before = readHeaders(request?.headers)
  const output = { headers: { ...before } }

  meter.fire("chat.headers", { sessionID, kind: readString(record, "kind") ?? "" })
  try {
    await handler(
      {
        sessionID,
        agent: readString(record, "agent") ?? "",
        model: modelRefOf(record),
        provider: {},
        message: undefined,
      },
      output,
    )
  } catch (error) {
    meter.fail("chat.headers", error)
    return
  }

  const headers = request?.headers as (Headers & { set?: unknown; delete?: unknown }) | undefined
  if (headers === undefined || typeof headers.set !== "function") {
    meter.drop("chat.headers", "V2 http.request has no mutable headers object")
    return
  }

  let wrote = false
  for (const [key, value] of Object.entries(output.headers)) {
    if (before[key] === value) continue
    try {
      headers.set(key, String(value))
      wrote = true
    } catch (error) {
      meter.drop("chat.headers", `header "${key}" could not be set (${errorMessage(error)})`)
    }
  }
  for (const key of Object.keys(before)) {
    if (key in output.headers) continue
    try {
      headers.delete(key)
      wrote = true
    } catch (error) {
      meter.drop("chat.headers", `header "${key}" could not be deleted (${errorMessage(error)})`)
    }
  }
  if (wrote) meter.writeback("chat.headers")
}

// ---------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------

export type SemanticRegistration = {
  readonly name: string
  readonly callback: (input: unknown) => Promise<void>
}

export type SemanticBridgePlan = {
  readonly registrations: readonly SemanticRegistration[]
  readonly bridged: readonly SemanticHookKey[]
  readonly degraded: ReadonlyArray<{ readonly key: string; readonly reason: string }>
}

/** Which V2 slot owns which V1 key; exported so the selftest can assert the mapping itself. */
export const SEMANTIC_SLOT_OF: Readonly<Record<SemanticHookKey, string>> = {
  "chat.message": "prompt",
  "chat.params": "context",
  "chat.headers": "http.request",
  "experimental.chat.system.transform": "context",
  "experimental.chat.messages.transform": "context",
}

const SEMANTIC_KEYS = [
  "chat.message",
  "chat.params",
  "chat.headers",
  "experimental.chat.system.transform",
  "experimental.chat.messages.transform",
] as const satisfies readonly SemanticHookKey[]

/**
 * Builds the plan for the current V1 runtime. Only keys the runtime actually exposes are registered,
 * so the bridge never invents a handler; every skipped key gets a reason.
 */
export function planSemanticBridge(args: {
  readonly hooks: unknown
  readonly meter: SemanticMeter
  readonly directory: string
}): SemanticBridgePlan {
  const degraded: Array<{ key: string; reason: string }> = []
  const registrations: SemanticRegistration[] = []
  const bridged: SemanticHookKey[] = []
  const present = SEMANTIC_KEYS.filter((key) => handlerOf(args.hooks, key) !== undefined)

  for (const key of SEMANTIC_KEYS) {
    if (handlerOf(args.hooks, key) === undefined) {
      degraded.push({ key, reason: "V1 runtime exposes no handler for this key" })
    }
  }

  const slotKeys = new Set(present.map((key) => SEMANTIC_SLOT_OF[key]))

  if (slotKeys.has("prompt")) {
    registrations.push({
      name: "prompt",
      callback: (event) => handlePrompt(event, args.hooks, args.meter),
    })
    if (present.includes("chat.message")) bridged.push("chat.message")
  }

  if (slotKeys.has("context")) {
    registrations.push({
      name: "context",
      callback: (event) => handleContext(event, args.hooks, args.meter, args.directory),
    })
    for (const key of [
      "experimental.chat.system.transform",
      "experimental.chat.messages.transform",
      "chat.params",
    ] as const) {
      if (present.includes(key)) bridged.push(key)
    }
    if (present.includes("chat.params")) {
      degraded.push({
        key: "chat.params",
        reason:
          "bridged on the context hook's `options`: 2.1.4 model.request is {sessionID,agent,model,kind,baseURL?,headers} and has no generation options",
      })
    }
  }

  if (slotKeys.has("http.request")) {
    registrations.push({
      name: "http.request",
      callback: (event) => handleHttpRequest(event, args.hooks, args.meter),
    })
    if (present.includes("chat.headers")) bridged.push("chat.headers")
  }

  if (!slotKeys.has("prompt")) {
    degraded.push({
      key: "chat.message",
      reason: "V2 ctx.session.hook is not available on this host",
    })
  }

  return { registrations, bridged, degraded }
}

export function logSemanticPlan(plan: SemanticBridgePlan): void {
  for (const entry of plan.degraded) {
    log(`${SEMANTIC_LOG_PREFIX} ${entry.key} degraded`, { reason: entry.reason })
  }
}
