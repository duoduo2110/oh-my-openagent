/**
 * V1 -> V2 tool bridge (S1a).
 *
 * The V1 runtime ships dozens of `tool({ description, args, execute })` definitions whose `execute`
 * receives a `ToolContext` (session/directory/abort/metadata/ask) and returns a string or
 * `{ title, output, metadata }`. The V2 runtime expects a completely different shape:
 *
 *   - `input` is a *single* schema (zod v4 / StandardSchemaV1, or a plain JSON Schema),
 *   - `execute` receives a V2 `ToolContext` and must resolve an *object* `{ output | content | metadata }`
 *     (a bare string throws a TypeError inside the host),
 *   - `default` values are not filled by the host, so the plugin must parse its own arguments.
 *
 * This module is the only place that knows about that impedance mismatch. Every V1 tool that the V2
 * port exposes goes through `bridgeTool()` / `registerBridgedTool()`.
 *
 * zod first, JSON Schema second: the repo pins zod v4, whose schemas satisfy StandardSchemaV1 *and*
 * can export JSON Schema (`z.toJSONSchema`). Passing `z.object(v1.args)` straight through keeps
 * unions/enums/defaults intact, so that is the primary path. If a host revision rejects it (schema
 * vendor mismatch, tool missing from `editor.get()` after `add`), `registerBridgedTool` retries with an
 * explicit JSON Schema built from the same zod object, and reports which path it took.
 */
import { tool, type ToolContext as V1ToolContext, type ToolDefinition } from "@opencode-ai/plugin/tool"

import { sanitizeJsonSchema } from "../plugin/normalize-tool-arg-schemas"
import { log } from "../shared/logger"

export const BRIDGE_LOG_PREFIX = "[omo-v2]"

/** How to treat a V2 built-in that already owns the name we want to register. */
export type CollisionPolicy = "override" | "skip"

/**
 * `grep`/`glob` are ours: the V1 implementations carry the limits, formatters and include semantics
 * the port depends on, so they replace the host built-ins. `edit` and `task` stay the host's until a
 * later stage validates the V1 equivalents, so we skip them instead of fighting the host.
 *
 * The B group (S1b: `session_*`, `skill`, `skill_mcp`, `look_at`, the task write pair and
 * `interactive_bash`) owns its names outright — no V2 built-in carries them — and `override` says
 * exactly that: if a future host revision claims one of them, the OMO surface wins, because these
 * are the definitions the V1 engine and its prompts are written against.
 */
export const COLLISION_POLICY: Readonly<Record<string, CollisionPolicy>> = {
  grep: "override",
  glob: "override",
  edit: "skip",
  // The host's delegating tool is `subagent`; the V1 name is `task`. Same job, different name, so
  // "skip" alone is not enough — `BridgeMeta.skipUnlessEnabled` makes the default "register nothing"
  // even though no host tool owns the name. `OMO_V2_TASK_TOOL=override` is the opt-in.
  task: "skip",
  session_list: "override",
  session_read: "override",
  session_search: "override",
  session_info: "override",
  skill: "override",
  skill_mcp: "override",
  look_at: "override",
  task_create: "override",
  task_update: "override",
  interactive_bash: "override",
  // C group (S1c). None of these names is a V2 built-in, so the OMO surface owns them outright —
  // the same reasoning as the B group: the V1 prompts and the team/monitor protocols are written
  // against exactly these names.
  call_omo_agent: "override",
  background_output: "override",
  background_cancel: "override",
  monitor_start: "override",
  monitor_stop: "override",
  monitor_list: "override",
  monitor_output: "override",
  team_create: "override",
  team_delete: "override",
  team_shutdown_request: "override",
  team_approve_shutdown: "override",
  team_reject_shutdown: "override",
  team_send_message: "override",
  team_task_create: "override",
  team_task_list: "override",
  team_task_update: "override",
  team_task_get: "override",
  team_status: "override",
  team_list: "override",
}

// ---------------------------------------------------------------------------------------------
// V2 shapes (structural, so this file never depends on the host package's private type graph)
// ---------------------------------------------------------------------------------------------

export type V2TextContent = { readonly type: "text"; readonly text: string }
export type V2FileContent = { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
export type V2Content = V2TextContent | V2FileContent

export type V2ToolResult = {
  readonly output?: unknown
  readonly content?: string | ReadonlyArray<V2Content>
  readonly metadata?: Readonly<Record<string, unknown>>
}

export type V2ToolContextLike = {
  readonly sessionID?: string
  readonly agent?: string
  readonly messageID?: string
  readonly id?: string
  readonly signal?: AbortSignal
  readonly directory?: string
}

export type V2ToolInfoLike = {
  readonly name: string
  readonly id?: string
  readonly description?: string
}

/**
 * The slice of `ctx.permission` the bridge needs. `PermissionDomain.assert` (2.1.4) evaluates the
 * session's rules and, when approval is needed, prompts and waits; a deny rejects. That is the
 * direct V2 counterpart of the V1 `ctx.ask()`, so the bridge maps one onto the other instead of
 * allowing everything.
 */
export type V2PermissionLike = {
  readonly assert?: (input: {
    readonly sessionID: string
    readonly agent?: string
    readonly action: string
    readonly resources: readonly string[]
    readonly save?: readonly string[]
    readonly metadata?: Record<string, unknown>
  }) => Promise<void>
}


export type V2ToolRegistration = {
  readonly name: string
  readonly description: string
  readonly input: unknown
  readonly execute: (input: unknown, context: V2ToolContextLike) => Promise<V2ToolResult>
}

export type V2ToolEditorLike = {
  list(): readonly V2ToolInfoLike[]
  get(id: string): V2ToolInfoLike | undefined
  add(tool: V2ToolRegistration): void
}

/** A V1 tool definition plus the name the host would have registered it under. */
export type BridgeableTool = ToolDefinition & { readonly name?: string }

/**
 * How a rejected `execute` reaches the model.
 *
 *   "throw"   (default) the V1 contract: the host turns the rejection into a tool error.
 *   "content" the C group's contract: the tools there depend on optional subsystems (tmux, a model
 *             provider, a team run, a background manager) and V1 already answers most of those
 *             paths with text. A readable `Error: <tool>: <reason>` keeps the call's result shape
 *             `{ content }` and never leaves the model with an empty answer.
 */
export type BridgeErrorMode = "throw" | "content"

export type BridgeMeta = {
  /** Tool name in the V2 tool list (`grep`, `task_get`, ...). */
  readonly name: string
  /**
   * Normalises the raw arguments *before* the zod parse. Used where a V1 argument is a
   * `object | string` union (`team_create.inline_spec`): the host validates either branch, and the
   * preprocessor turns the JSON-string branch into the object branch so one shape reaches the tool.
   */
  readonly preprocess?: (rawArgs: unknown) => unknown
  /** Defaults to `COLLISION_POLICY[name]` (and to `"skip"` for names it does not list). */
  readonly collisionPolicy?: CollisionPolicy
  /**
   * Do not register at all unless a config switch turned this tool on — even when *no* host tool
   * owns the name. `task` needs this: the V2 host calls its delegator `subagent`, so a
   * collision-only skip would add a second spawner next to the host's instead of leaving
   * delegation alone. The skip is logged with the policy on every setup.
   */
  readonly skipUnlessEnabled?: boolean
  /** Defaults to `"throw"`, the V1 behaviour. */
  readonly errorMode?: BridgeErrorMode
}

export type BridgeMode = "zod" | "json-schema"

export type BridgeRegistrationResult = {
  readonly name: string
  readonly mode: BridgeMode | "skip"
  readonly replacedBuiltin: boolean
}

// ---------------------------------------------------------------------------------------------
// Setup-scoped state: `directory` reaches every V1 execute through the cached host location.
// ---------------------------------------------------------------------------------------------

let bridgeDirectory: string | undefined
let bridgeSessionID: string | undefined
let bridgePermission: V2PermissionLike | undefined

export function setToolBridgeDirectory(directory: string | undefined): void {
  bridgeDirectory = directory
}

export function getToolBridgeDirectory(): string | undefined {
  return bridgeDirectory
}

/**
 * Installs the host's permission domain so a V1 `ctx.ask()` can become
 * `ctx.permission.assert()`. Setup owns the context, tools only receive a `ToolContext`, so the
 * domain has to travel through this module the same way the directory does.
 */
export function setToolBridgePermission(permission: unknown): void {
  const candidate = permission as V2PermissionLike | undefined
  bridgePermission = candidate !== null && typeof candidate === "object" ? candidate : undefined
}

export function getToolBridgePermission(): V2PermissionLike | undefined {
  return bridgePermission
}

/**
 * Last session seen by the bridge. V1 helpers that take a `getSessionID` accessor (the goal tools)
 * call this instead of the V1 main-session registry, which does not exist under V2.
 */
export function getToolBridgeSessionID(): string | undefined {
  return bridgeSessionID
}

export function _resetToolBridgeStateForTesting(): void {
  bridgeDirectory = undefined
  bridgeSessionID = undefined
  bridgePermission = undefined
  warnedFeatures.clear()
}

const warnedFeatures = new Set<string>()

function warnOnce(toolName: string, feature: string, message: string): void {
  const key = `${toolName}:${feature}`
  if (warnedFeatures.has(key)) return
  warnedFeatures.add(key)
  log(`${BRIDGE_LOG_PREFIX} degraded ${feature} on tool ${toolName}: ${message}`)
}

// ---------------------------------------------------------------------------------------------
// Context adaptation
// ---------------------------------------------------------------------------------------------

function resolveDirectory(v2ctx: V2ToolContextLike): string {
  if (bridgeDirectory !== undefined && bridgeDirectory.length > 0) return bridgeDirectory
  if (typeof v2ctx.directory === "string" && v2ctx.directory.length > 0) return v2ctx.directory
  return process.cwd()
}

/**
 * V2 `ToolContext` -> V1 `ToolContext`.
 *
 * Mapped directly: `sessionID`, `agent`, `messageID`, `id` (as both `callID` and `callId`), `abort`
 * (V1 expects an `AbortSignal`, which V2 exposes as `signal`), `directory`/`worktree` (from the setup
 * location).
 *
 * `ask()` maps onto `ctx.permission.assert()` (installed by the setup through
 * `setToolBridgePermission`): V1 `permission` -> `action`, `patterns` -> `resources`,
 * `always` -> `save`, `metadata` -> `metadata`. A denial is rethrown — V1 semantics — because a
 * permission gate that answers "allow" to a denial is worse than no gate. Only when the host has no
 * permission domain, or the call carries no session, is the request allowed, and that is logged once
 * per tool so it cannot pass unnoticed.
 *
 * Degraded, warned once per tool:
 *   - `metadata()` — V2 has no equivalent sink here, so it stays a no-op returning nothing.
 */
export function adaptContext(toolName: string, v2ctx: V2ToolContextLike): V1ToolContext {
  const directory = resolveDirectory(v2ctx)
  if (typeof v2ctx.sessionID === "string" && v2ctx.sessionID.length > 0) {
    bridgeSessionID = v2ctx.sessionID
  }

  const adapted = {
    sessionID: v2ctx.sessionID ?? "",
    messageID: v2ctx.messageID ?? "",
    agent: v2ctx.agent ?? "",
    directory,
    worktree: directory,
    abort: v2ctx.signal ?? new AbortController().signal,
    metadata: (input: { title?: string; metadata?: { [key: string]: unknown } }): void => {
      void input
      warnOnce(toolName, "metadata", "metadata() has no V2 sink in S1; the update was dropped")
    },
    ask: async (input: unknown): Promise<void> => {
      const request = toAskRequest(input)
      if (request === undefined) return

      const assert = bridgePermission?.assert
      if (typeof assert !== "function") {
        warnOnce(toolName, "ask", "no ctx.permission domain on this host; the request was allowed")
        return
      }
      const sessionID = v2ctx.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) {
        warnOnce(toolName, "ask", "the call carried no session; the permission request was allowed")
        return
      }

      // A denial rejects with the host's own reason; let it reach the tool caller unchanged.
      await assert({
        sessionID,
        ...(typeof v2ctx.agent === "string" && v2ctx.agent.length > 0 ? { agent: v2ctx.agent } : {}),
        action: request.permission,
        resources: request.patterns,
        ...(request.always.length > 0 ? { save: request.always } : {}),
        ...(request.metadata === undefined ? {} : { metadata: request.metadata }),
      })
    },
  }

  if (typeof v2ctx.id === "string") {
    return Object.assign(adapted, { callID: v2ctx.id, callId: v2ctx.id }) as V1ToolContext
  }
  return adapted as V1ToolContext
}

type AskRequest = {
  readonly permission: string
  readonly patterns: readonly string[]
  readonly always: readonly string[]
  readonly metadata?: Record<string, unknown>
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

/** V1 `AskInput` -> the four fields `ctx.permission.assert()` needs. Unknown shapes are ignored. */
function toAskRequest(input: unknown): AskRequest | undefined {
  if (typeof input !== "object" || input === null) return undefined
  const record = input as Record<string, unknown>
  const permission = record["permission"]
  if (typeof permission !== "string" || permission.length === 0) return undefined
  const metadata = record["metadata"]
  return {
    permission,
    patterns: stringList(record["patterns"]),
    always: stringList(record["always"]),
    ...(typeof metadata === "object" && metadata !== null && !Array.isArray(metadata)
      ? { metadata: metadata as Record<string, unknown> }
      : {}),
  }
}

// ---------------------------------------------------------------------------------------------
// Result normalisation: the V2 contract is an object, never a bare string.
// ---------------------------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toFileContent(attachment: unknown): V2FileContent | undefined {
  if (!isRecord(attachment)) return undefined
  if (attachment["type"] !== "file") return undefined
  const uri = attachment["url"]
  const mime = attachment["mime"]
  if (typeof uri !== "string" || typeof mime !== "string") return undefined
  const name = attachment["filename"]
  return typeof name === "string"
    ? { type: "file", uri, mime, name }
    : { type: "file", uri, mime }
}

/**
 * V1 result -> V2 `Tool.Result`.
 *
 *   string                     -> { content: string }
 *   { title, output, metadata }-> { content: output, metadata }
 *   undefined / null           -> { content: "" }
 *   already { content | output }-> untouched
 *   attachments                -> file content parts next to the text
 */
export function normalizeResult(result: unknown): V2ToolResult {
  if (result === undefined || result === null) return { content: "" }
  if (typeof result === "string") return { content: result }
  if (!isRecord(result)) return { content: String(result) }

  const attachments = Array.isArray(result["attachments"])
    ? result["attachments"].map(toFileContent).filter((entry): entry is V2FileContent => entry !== undefined)
    : []

  if ("content" in result) {
    const content = result["content"]
    const normalized: V2ToolResult = typeof content === "string"
      ? { content: content.length > 0 || attachments.length === 0 ? content : attachments }
      : { content: attachments }
    const metadata = isRecord(result["metadata"]) ? result["metadata"] : undefined
    return metadata === undefined ? normalized : { ...normalized, metadata }
  }

  if ("output" in result) {
    const output = result["output"]
    const content = typeof output === "string" ? output : String(output)
    const metadata = isRecord(result["metadata"]) ? result["metadata"] : undefined
    const base: V2ToolResult = attachments.length === 0
      ? { content }
      : { content: [{ type: "text", text: content }, ...attachments] }
    return metadata === undefined ? base : { ...base, metadata }
  }

  // A `{ title }`-only object still has to become a string content part.
  if (attachments.length > 0) return { content: attachments }
  const title = result["title"]
  return { content: typeof title === "string" ? title : "" }
}

// ---------------------------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------------------------

/** The single object schema V2 wants, built from the V1 raw-shape record. */
export function zodInputSchema(v1: ToolDefinition): ReturnType<typeof tool.schema.object> {
  return tool.schema.object(v1.args)
}

/**
 * JSON Schema fallback. zod v4 already renders unions as `anyOf`, enums as `enum` and nullable as
 * `type: [..., "null"]`, so the only cleanup left is `sanitizeJsonSchema` (drop `$schema`, normalise
 * `$ref`, drop keywords some hosts reject).
 */
export function jsonSchemaInput(v1: ToolDefinition): Record<string, unknown> {
  const schema = tool.schema.toJSONSchema(zodInputSchema(v1), {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>
  return sanitizeJsonSchema(schema) as Record<string, unknown>
}

// ---------------------------------------------------------------------------------------------
// Bridge construction
// ---------------------------------------------------------------------------------------------

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseArgs(v1: ToolDefinition, toolName: string, mode: BridgeMode, rawArgs: unknown): unknown {
  const input = rawArgs ?? {}
  try {
    // zod fills `default` values the V2 host never applies, which keeps V1 behaviour.
    return zodInputSchema(v1).parse(input)
  } catch (error) {
    if (mode === "json-schema") {
      // The host validated against JSON Schema; keep whatever it produced rather than failing twice.
      log(`${BRIDGE_LOG_PREFIX} arg re-parse failed for ${toolName} (json-schema mode)`, {
        error: describeError(error),
      })
      return input
    }
    throw new Error(`${BRIDGE_LOG_PREFIX} ${toolName}: invalid arguments (${describeError(error)})`)
  }
}

/** The same parse, after the tool's own argument preprocessor has run. */
function parsePreprocessedArgs(
  v1: ToolDefinition,
  toolName: string,
  mode: BridgeMode,
  rawArgs: unknown,
  preprocess: ((rawArgs: unknown) => unknown) | undefined,
): unknown {
  if (preprocess === undefined) return parseArgs(v1, toolName, mode, rawArgs)
  let input: unknown
  try {
    input = preprocess(rawArgs ?? {})
  } catch (error) {
    // A preprocessor that cannot read its input is reported, never fatal: the zod parse below gets
    // the untouched arguments and produces the schema error the model can act on.
    log(`${BRIDGE_LOG_PREFIX} argument preprocess failed for ${toolName}`, {
      error: describeError(error),
    })
    input = rawArgs ?? {}
  }
  return parseArgs(v1, toolName, mode, input)
}

function errorContent(toolName: string, error: unknown): V2ToolResult {
  const message = describeError(error)
  log(`${BRIDGE_LOG_PREFIX} tool failed ${toolName}`, { error: message })
  return { content: `Error: ${toolName} failed: ${message}` }
}

export function bridgeTool(v1: ToolDefinition, meta: BridgeMeta, mode: BridgeMode = "zod"): V2ToolRegistration {
  const toolName = meta.name
  if (typeof v1.description !== "string" || v1.description.length === 0) {
    throw new Error(`${BRIDGE_LOG_PREFIX} ${toolName}: refusing to bridge a tool without a description`)
  }

  return {
    name: toolName,
    description: v1.description,
    input: mode === "zod" ? zodInputSchema(v1) : jsonSchemaInput(v1),
    execute: async (rawArgs: unknown, v2ctx: V2ToolContextLike): Promise<V2ToolResult> => {
      const execute = v1.execute as unknown as (input: unknown, ctx: V1ToolContext) => Promise<unknown>
      try {
        const args = parsePreprocessedArgs(v1, toolName, mode, rawArgs, meta.preprocess)
        const context = adaptContext(toolName, v2ctx)
        const result = await execute(args, context)
        return normalizeResult(result)
      } catch (error) {
        if (meta.errorMode === "content") return errorContent(toolName, error)
        throw error
      }
    },
  }
}

function addAndVerify(editor: V2ToolEditorLike, registration: V2ToolRegistration): boolean {
  try {
    editor.add(registration)
  } catch (error) {
    log(`${BRIDGE_LOG_PREFIX} add failed for ${registration.name}`, { error: describeError(error) })
    return false
  }

  // `add` can be silently dropped. Compare descriptions so an untouched built-in cannot be mistaken
  // for a successful override.
  const current = editor.get(registration.name)
  return current !== undefined && current.description === registration.description
}

/**
 * Register one bridged tool, honouring the collision policy.
 *
 * Returns which input flavour the host accepted. Throws when neither zod nor JSON Schema registers:
 * a missing tool is a port defect, not something to swallow.
 */
export function registerBridgedTool(
  editor: V2ToolEditorLike,
  v1: ToolDefinition,
  meta: BridgeMeta,
): BridgeRegistrationResult {
  const toolName = meta.name
  const existing = editor.get(toolName)
  const policy = meta.collisionPolicy ?? COLLISION_POLICY[toolName] ?? "skip"

  if (meta.skipUnlessEnabled === true && existing === undefined) {
    // No name collision, but this tool is not ours to add by default (see `skipUnlessEnabled`).
    log(`${BRIDGE_LOG_PREFIX} tool not registered ${toolName} (skip unless enabled; no host tool owns the name)`)
    return { name: toolName, mode: "skip", replacedBuiltin: false }
  }

  if (existing !== undefined) {
    // A transform can run more than once per host lifetime; a name that already carries our own
    // description is our previous registration, not a built-in.
    const isOurOwn = existing.description === v1.description
    if (policy === "skip") {
      if (!isOurOwn) log(`${BRIDGE_LOG_PREFIX} keeping builtin tool ${toolName} (no override policy)`)
      return { name: toolName, mode: "skip", replacedBuiltin: false }
    }
    if (!isOurOwn) log(`${BRIDGE_LOG_PREFIX} overriding builtin tool ${toolName}`)
  }

  if (addAndVerify(editor, bridgeTool(v1, meta, "zod"))) {
    return { name: toolName, mode: "zod", replacedBuiltin: existing !== undefined }
  }

  log(`${BRIDGE_LOG_PREFIX} zod schema rejected for ${toolName}; retrying with JSON Schema`, {
    hint: "host may require a schema vendor we do not provide",
  })

  if (addAndVerify(editor, bridgeTool(v1, meta, "json-schema"))) {
    return { name: toolName, mode: "json-schema", replacedBuiltin: existing !== undefined }
  }

  throw new Error(`${BRIDGE_LOG_PREFIX} could not register tool ${toolName} (zod and JSON Schema both rejected)`)
}
