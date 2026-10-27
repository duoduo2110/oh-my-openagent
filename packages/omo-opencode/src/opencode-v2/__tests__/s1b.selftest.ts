/**
 * S1b self-test: the ten B-group tools, driven for real.
 *
 * Run inside the v2 container:
 *
 *   scripts/v2/docker.sh run bun packages/omo-opencode/src/opencode-v2/__tests__/s1b.selftest.ts
 *
 * A script rather than a `bun test` file, like the other V2 selftests: it needs a temp project, a
 * fake V2 host and real V1 factories, and it asserts on what the tools actually answer.
 *
 * What it proves, tool by tool:
 *
 *   registration   all ten names register through the bridge, `skill` overrides a seeded builtin
 *   session_list   both fake sessions are listed, with message counts (SDK path via the S4 shim)
 *   session_read   messages come back from `session.context`, and todos from the plugin store
 *   session_search a token found in one session only, scoped search honoured
 *   session_info   message count + agents used, read through the paged SDK path
 *   skill          a real skill body (`## Skill: <name>`) and `ctx.ask` mapped onto
 *                  `ctx.permission.assert` (allow, then deny -> the call throws)
 *   skill_mcp      the not-found path names the servers it does know about
 *   look_at        the missing-file path answers with a readable error string, not a throw
 *   task_create     the task file is written *and* the todo reaches the session store
 *   task_update     status change is reflected on read-back; a second session stays empty
 *   interactive_bash no tmux here -> the documented "requires tmux" error string
 *
 * The session todo assertions are the point of the task pair: V1's `todo-sync` writes through an
 * `opencode/session/todo` module V2 does not ship, so the plugin store is the only channel that can
 * make `task_create` and `session_read(include_todos)` agree.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { OhMyOpenCodeConfig } from "../../config"
import { loadPluginConfig } from "../../plugin-config"
import type { V2ContextLike } from "../adapter/types"
import {
  _resetToolBridgeStateForTesting,
  registerBridgedTool,
  setToolBridgeDirectory,
  setToolBridgePermission,
  type BridgeRegistrationResult,
  type V2ToolEditorLike,
  type V2ToolInfoLike,
  type V2ToolRegistration,
  type V2ToolResult,
} from "../tool-bridge"
import { TMUX_MISSING_MESSAGE } from "../tools/interactive-bash"
import { V2_GROUP_B_TOOL_NAMES, createV2GroupBToolsRecord } from "../tools/index"

const failures: string[] = []
let checks = 0

function check(condition: boolean, message: string): void {
  checks += 1
  if (!condition) failures.push(message)
}

function checkEqual<T>(actual: T, expected: T, message: string): void {
  check(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

function note(line: string): void {
  console.log(line)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** R1 again: the host throws on a bare string, so every execute must answer an object. */
function contentOf(toolName: string, result: unknown): string {
  if (!isRecord(result)) {
    failures.push(`${toolName}: execute returned ${typeof result}, expected an object (R1)`)
    return ""
  }
  const content = result["content"]
  if (typeof content !== "string") {
    failures.push(`${toolName}: result.content is ${typeof content}, expected a string (R1)`)
    return ""
  }
  if (content.length === 0) failures.push(`${toolName}: result.content is empty`)
  return content
}

// ---------------------------------------------------------------------------------------------
// Temp project + config
// ---------------------------------------------------------------------------------------------

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-v2-s1b-"))
const taskStorage = path.join(projectDir, "tasks")
setToolBridgeDirectory(projectDir)

const pluginConfig: OhMyOpenCodeConfig = loadPluginConfig(projectDir, process.env)
pluginConfig.sisyphus = {
  ...pluginConfig.sisyphus,
  tasks: { storage_path: taskStorage, claude_code_compat: false },
}

// ---------------------------------------------------------------------------------------------
// Fake V2 host: two sessions, `session.context` in the 2.1.4 shape, a real key/value storage
// ---------------------------------------------------------------------------------------------

const SESSION_A = "ses_s1b_a"
const SESSION_B = "ses_s1b_b"
const SEARCH_TOKEN = "needle-token-s1b"

function createdMessages(): unknown[] {
  const created = "2026-10-27T10:00:00.000Z"
  return [
    { id: "msg_a_user", type: "user", time: { created }, text: `please look at ${SEARCH_TOKEN}`, files: [], agents: [{ name: "sisyphus" }] },
    {
      id: "msg_a_assistant",
      type: "assistant",
      time: { created },
      agent: "sisyphus",
      model: { id: "claude-sonnet-4-5", providerID: "anthropic" },
      parentID: "msg_a_user",
      cost: 0.01,
      tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } },
      content: [{ type: "text", text: "reading the build log" }],
    },
  ]
}

function otherMessages(): unknown[] {
  const created = "2026-10-27T11:00:00.000Z"
  return [
    { id: "msg_b_user", type: "user", time: { created }, text: "unrelated request", files: [], agents: [] },
    { id: "msg_b_idle", type: "idle", time: { created }, outcome: "succeeded" },
  ]
}

type FakeHost = {
  readonly context: V2ContextLike
  readonly storage: Map<string, unknown>
  readonly permission: { readonly assert: (input: Record<string, unknown>) => Promise<void> }
  readonly permissionCalls: Array<Record<string, unknown>>
}

function createFakeHost(): FakeHost {
  const storage = new Map<string, unknown>()
  const permissionCalls: Array<Record<string, unknown>> = []
  const sessions = [
    { id: SESSION_A, projectID: "prj_s1b", title: "a", time: { created: 1, updated: 2 } },
    { id: SESSION_B, projectID: "prj_s1b", title: "b", time: { created: 1, updated: 1 } },
  ]

  const permission = {
    assert: async (input: Record<string, unknown>) => {
      permissionCalls.push(input)
    },
  }

  const context = {
    location: { directory: projectDir, project: { id: "prj_s1b", directory: projectDir } },
    app: { name: "omo-v2-s1b-selftest", version: "0.0.0", channel: "local" },
    storage: {
      get: async (key: string) => storage.get(key),
      set: async (key: string, value: unknown) => {
        storage.set(key, value)
      },
      remove: async (key: string) => {
        storage.delete(key)
      },
      scan: async (options: { prefix: string }) => ({
        entries: [...storage.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .map(([key, value]) => ({ key, value })),
      }),
    },
    session: {
      context: async (input: unknown) => {
        const sessionID = isRecord(input) ? input["sessionID"] : undefined
        if (sessionID === SESSION_A) return createdMessages()
        if (sessionID === SESSION_B) return otherMessages()
        // An unknown session has no history; `session_read` must say so instead of inventing one.
        return []
      },
      list: async () => ({ data: sessions, cursor: {} }),
      get: async (input: unknown) => ({
        id: isRecord(input) && typeof input["sessionID"] === "string" ? input["sessionID"] : SESSION_A,
        projectID: "prj_s1b",
      }),
      create: async () => ({ id: SESSION_A, projectID: "prj_s1b" }),
      prompt: async () => ({ id: "msg_prompt" }),
      interrupt: async () => undefined,
    },
    permission,
  }

  return {
    context: context as unknown as V2ContextLike,
    storage,
    permission,
    permissionCalls,
  }
}

// ---------------------------------------------------------------------------------------------
// Fake editor: the V2 tool surface the bridge writes into
// ---------------------------------------------------------------------------------------------

class FakeEditor implements V2ToolEditorLike {
  private readonly tools = new Map<string, V2ToolInfoLike & { execute: V2ToolRegistration["execute"] }>()

  constructor(seed: V2ToolInfoLike[] = []) {
    for (const entry of seed) {
      this.tools.set(entry.name, { ...entry, execute: async () => ({ content: "builtin" }) })
    }
  }

  list(): readonly V2ToolInfoLike[] {
    return [...this.tools.values()].map(({ name, id, description }) => ({ name, id, description }))
  }

  get(id: string): V2ToolInfoLike | undefined {
    const entry = this.tools.get(id)
    return entry === undefined ? undefined : { name: entry.name, id: entry.id, description: entry.description }
  }

  add(tool: V2ToolRegistration): void {
    this.tools.set(tool.name, { name: tool.name, id: tool.name, description: tool.description, execute: tool.execute })
  }

  descriptionOf(name: string): string {
    return this.tools.get(name)?.description ?? ""
  }

  async execute(name: string, input: unknown, sessionID = SESSION_A): Promise<V2ToolResult> {
    const entry = this.tools.get(name)
    if (entry === undefined) throw new Error(`tool ${name} is not registered`)
    return entry.execute(input, {
      sessionID,
      agent: "sisyphus",
      messageID: "msg_s1b",
      id: "call_s1b",
      signal: new AbortController().signal,
    })
  }
}

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

async function checkRegistration(host: FakeHost): Promise<{ editor: FakeEditor; groupB: Awaited<ReturnType<typeof createV2GroupBToolsRecord>> }> {
  const groupB = await createV2GroupBToolsRecord({
    context: host.context,
    directory: projectDir,
    pluginConfig,
  })

  const built = Object.keys(groupB.tools).sort()
  for (const name of V2_GROUP_B_TOOL_NAMES) {
    check(built.includes(name), `group B built ${name} (built: ${built.join(",")}, skipped: ${JSON.stringify(groupB.skipped)})`)
  }
  checkEqual(groupB.skipped.length, 0, "no B-group tool was skipped")
  check(groupB.deps.skills > 0, `the skill list is non-empty (${groupB.deps.skills})`)

  // `skill` is seeded as a builtin so the override policy is exercised; the rest register fresh.
  const editor = new FakeEditor([{ name: "skill", id: "skill", description: "builtin skill tool" }])
  const registrations: BridgeRegistrationResult[] = []
  for (const [name, definition] of Object.entries(groupB.tools)) {
    registrations.push(registerBridgedTool(editor, definition, { name }))
  }

  for (const entry of registrations) {
    checkEqual(entry.mode, "zod", `${entry.name}: zod input accepted by a V2-shaped editor`)
    check(editor.get(entry.name) !== undefined, `${entry.name}: present in editor.get()`)
  }
  const skillRegistration = registrations.find((entry) => entry.name === "skill")
  check(skillRegistration?.replacedBuiltin === true, "skill replaced the seeded builtin")
  check(
    editor.descriptionOf("skill").startsWith("Load a skill or execute a slash command"),
    `skill description came from the V1 factory (got ${JSON.stringify(editor.descriptionOf("skill").slice(0, 60))})`,
  )

  note(`b-group registration: ${registrations.map((entry) => `${entry.name}:${entry.mode}`).join(" ")}`)
  note(`b-group deps: skills=${groupB.deps.skills} commands=${groupB.deps.commands}`)
  return { editor, groupB }
}

async function checkSessionList(editor: FakeEditor): Promise<void> {
  const content = contentOf("session_list", await editor.execute("session_list", {}))
  check(content.includes(SESSION_A), `session_list lists ${SESSION_A} (got ${JSON.stringify(content.slice(0, 200))})`)
  check(content.includes(SESSION_B), `session_list lists ${SESSION_B}`)
  check(content.includes("Messages"), "session_list renders the metadata table header")
  note(`session_list: ${JSON.stringify(content.split("\n").slice(0, 3))}`)
}

async function checkSessionRead(editor: FakeEditor): Promise<void> {
  const content = contentOf("session_read", await editor.execute("session_read", { session_id: SESSION_A }))
  check(content.includes(SEARCH_TOKEN), "session_read shows the user text from session.context")
  check(content.includes("reading the build log"), "session_read shows the assistant text part")
  check(!content.includes("unrelated request"), "session_read stays inside the requested session")
  note(`session_read: ${JSON.stringify(content.slice(0, 160))}`)

  const missing = contentOf("session_read", await editor.execute("session_read", { session_id: "ses_does_not_exist" }))
  check(missing.startsWith("Session not found"), `session_read reports an unknown session (got ${JSON.stringify(missing.slice(0, 80))})`)
}

async function checkSessionSearch(editor: FakeEditor): Promise<void> {
  const content = contentOf("session_search", await editor.execute("session_search", { query: SEARCH_TOKEN }))
  check(content.includes("Found"), `session_search reports matches (got ${JSON.stringify(content.slice(0, 160))})`)
  check(content.includes(SESSION_A), "session_search attributes the match to session A")
  check(!content.includes(SESSION_B), "session_search found the token in one session only")
  note(`session_search: ${JSON.stringify(content.slice(0, 140))}`)

  const scoped = contentOf(
    "session_search",
    await editor.execute("session_search", { query: SEARCH_TOKEN, session_id: SESSION_B }),
  )
  check(scoped.includes("No matches found"), "session_search honours session_id scoping")
}

async function checkSessionInfo(editor: FakeEditor): Promise<void> {
  const content = contentOf("session_info", await editor.execute("session_info", { session_id: SESSION_A }))
  check(content.includes(`Session ID: ${SESSION_A}`), "session_info names the session")
  check(content.includes("Messages: 2"), `session_info counts the mapped messages (got ${JSON.stringify(content)})`)
  check(content.includes("sisyphus"), "session_info lists the agents used")
  note(`session_info: ${JSON.stringify(content.split("\n").slice(0, 3))}`)
}

async function checkSkill(editor: FakeEditor, host: FakeHost): Promise<void> {
  const description = editor.descriptionOf("skill")
  const names = [...description.matchAll(/<name>\/([^<]+)<\/name>/g)].map((match) => match[1])
  check(names.length > 0, `skill description advertises skills (got ${names.length})`)
  const skillName = names[0] ?? ""
  if (skillName.length === 0) return

  // ask() -> ctx.permission.assert: the domain is installed by setup, here by the test.
  setToolBridgePermission({
    assert: async (input: Record<string, unknown>) => {
      host.permissionCalls.push(input)
    },
  })

  const content = contentOf("skill", await editor.execute("skill", { name: skillName }))
  check(content.startsWith(`## Skill: ${skillName}`), `skill returns the body of ${skillName} (got ${JSON.stringify(content.slice(0, 80))})`)
  check(content.includes("**Base directory**"), "skill returns the base directory line")

  const ask = host.permissionCalls.at(-1)
  checkEqual(ask?.["action"], "skill", "ctx.ask mapped to ctx.permission.assert action")
  checkEqual(ask?.["sessionID"], SESSION_A, "ctx.ask carries the calling session")
  check(
    Array.isArray(ask?.["resources"]) && (ask["resources"] as unknown[]).includes(skillName),
    `ctx.ask patterns became permission resources (got ${JSON.stringify(ask?.["resources"])})`,
  )
  note(`skill: ${JSON.stringify(content.slice(0, 60))} ask=${JSON.stringify({ action: ask?.["action"], resources: ask?.["resources"], save: ask?.["save"] })}`)

  // A denial must reach the caller: a gate that swallows "deny" is worse than no gate.
  setToolBridgePermission({ assert: async () => { throw new Error("denied by policy: skill") } })
  let denied = ""
  try {
    await editor.execute("skill", { name: skillName })
  } catch (error) {
    denied = error instanceof Error ? error.message : String(error)
  }
  check(denied.includes("denied by policy"), `a permission denial propagates (got ${JSON.stringify(denied)})`)
  note(`skill denial: ${JSON.stringify(denied)}`)

  // No permission domain on the host: allowed, but only with a one-time warning (V1 behaviour kept).
  setToolBridgePermission(undefined)
  const allowed = contentOf("skill", await editor.execute("skill", { name: skillName }))
  check(allowed.startsWith(`## Skill: ${skillName}`), "without a permission domain the skill still loads (degraded allow)")
  setToolBridgePermission({
    assert: async (input: Record<string, unknown>) => {
      host.permissionCalls.push(input)
    },
  })
}

async function checkSkillMcp(editor: FakeEditor): Promise<void> {
  let message = ""
  try {
    await editor.execute("skill_mcp", { mcp_name: "s1b_no_such_mcp", tool_name: "anything" })
    failures.push("skill_mcp: an unknown server should not answer successfully")
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  check(message.includes("not found"), `skill_mcp reports an unknown server (got ${JSON.stringify(message.slice(0, 120))})`)
  check(
    message.includes("Available MCP servers in loaded skills"),
    "skill_mcp lists the servers it does know about",
  )

  let builtin = ""
  try {
    await editor.execute("skill_mcp", { mcp_name: "grep_app", tool_name: "searchGitHub" })
  } catch (error) {
    builtin = error instanceof Error ? error.message : String(error)
  }
  check(builtin.includes("builtin MCP"), `skill_mcp redirects a builtin MCP (got ${JSON.stringify(builtin.slice(0, 120))})`)
  note(`skill_mcp: ${JSON.stringify(message.split("\n")[0])}`)
}

async function checkLookAt(editor: FakeEditor): Promise<void> {
  // A missing JSON input stops before any session exists: the answer must be readable text.
  const missingPath = path.join(projectDir, "does-not-exist.json")
  const missing = contentOf("look_at", await editor.execute("look_at", { file_path: missingPath, goal: "describe it" }))
  check(missing.includes("File not found"), `look_at answers a readable error string (got ${JSON.stringify(missing.slice(0, 120))})`)
  check(missing.includes(missingPath), "look_at names the missing file")

  // A real image drives the whole child-session path (create -> prompt -> poll -> extract).
  const imagePath = path.join(projectDir, "dot.png")
  fs.writeFileSync(
    imagePath,
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/AF+7n0AAAAASUVORK5CYII=", "base64"),
  )
  const analysed = contentOf("look_at", await editor.execute("look_at", { file_path: imagePath, goal: "what is this" }))
  check(analysed.includes("reading the build log"), `look_at returns the child session answer through the shim (got ${JSON.stringify(analysed.slice(0, 120))})`)
  note(`look_at: ${JSON.stringify(missing.slice(0, 80))} | session: ${JSON.stringify(analysed.slice(0, 60))}`)
}

async function checkTaskTools(editor: FakeEditor, host: FakeHost): Promise<void> {
  const created = contentOf("task_create", await editor.execute("task_create", { subject: "S1b todo bridge" }))
  const createdPayload: unknown = JSON.parse(created)
  const taskID = isRecord(createdPayload) && isRecord(createdPayload["task"]) ? createdPayload["task"]["id"] : undefined
  check(typeof taskID === "string" && taskID.startsWith("T-"), `task_create produced a task id (got ${created.slice(0, 80)})`)
  check(
    typeof taskID === "string" && fs.existsSync(path.join(taskStorage, `${taskID}.json`)),
    "task_create wrote the task file into the configured storage",
  )

  const todoKey = `omo-v2/session-todo/${SESSION_A}`
  check(host.storage.has(todoKey), `task_create mirrored the todo into ctx.storage (${todoKey})`)
  const storedTodos = host.storage.get(todoKey)
  const todoList = isRecord(storedTodos) && Array.isArray(storedTodos["todos"]) ? storedTodos["todos"] : []
  check(
    todoList.some((entry) => isRecord(entry) && entry["content"] === "S1b todo bridge" && entry["status"] === "pending"),
    `the stored todo carries subject + pending (got ${JSON.stringify(todoList)})`,
  )

  // Read-back through the tool the model would use, not through the store: proves one channel.
  const readWithTodos = contentOf(
    "session_read",
    await editor.execute("session_read", { session_id: SESSION_A, include_todos: true }),
  )
  check(readWithTodos.includes("=== Todos ==="), "session_read(include_todos) renders the todo section")
  check(readWithTodos.includes("S1b todo bridge"), "session_read(include_todos) shows the created task")
  note(`task_create: ${created} todos=${JSON.stringify(todoList)}`)

  const updated = contentOf("task_update", await editor.execute("task_update", { id: String(taskID), status: "completed" }))
  check(updated.includes('"status":"completed"'), `task_update returns the completed task (got ${JSON.stringify(updated.slice(0, 120))})`)
  const afterUpdate = host.storage.get(todoKey)
  const updatedTodos = isRecord(afterUpdate) && Array.isArray(afterUpdate["todos"]) ? afterUpdate["todos"] : []
  check(
    updatedTodos.length === 1 && isRecord(updatedTodos[0]) && updatedTodos[0]["status"] === "completed",
    `task_update replaced the todo in place instead of duplicating it (got ${JSON.stringify(updatedTodos)})`,
  )
  note(`task_update: ${JSON.stringify(updated.slice(0, 120))}`)

  // Session partitioning: the other session must not see A's task.
  const otherSession = contentOf(
    "session_read",
    await editor.execute("session_read", { session_id: SESSION_B, include_todos: true }, SESSION_B),
  )
  check(!otherSession.includes("S1b todo bridge"), "todos stay partitioned per session")
  check(!host.storage.has(`omo-v2/session-todo/${SESSION_B}`), "the other session has no store entry")

  // `deleted` removes the entry, like syncTaskToTodo's null mapping.
  contentOf("task_update", await editor.execute("task_update", { id: String(taskID), status: "deleted" }))
  const afterDelete = host.storage.get(todoKey)
  const deletedTodos = isRecord(afterDelete) && Array.isArray(afterDelete["todos"]) ? afterDelete["todos"] : []
  checkEqual(deletedTodos.length, 0, "a deleted task leaves no todo behind")
}

async function checkInteractiveBash(editor: FakeEditor): Promise<void> {
  const content = contentOf("interactive_bash", await editor.execute("interactive_bash", { tmux_command: "ls" }))
  check(content.includes("requires tmux"), `interactive_bash names the tmux requirement (got ${JSON.stringify(content.slice(0, 120))})`)
  checkEqual(content, TMUX_MISSING_MESSAGE, "interactive_bash answers the documented missing-tmux string")
  note(`interactive_bash: ${JSON.stringify(content.split("\n")[0])}`)
}

async function main(): Promise<void> {
  const started = Date.now()
  _resetToolBridgeStateForTesting()
  setToolBridgeDirectory(projectDir)
  note(`[s1b-selftest] bun=${process.versions.bun ?? "?"} project=${projectDir}`)

  const host = createFakeHost()
  setToolBridgePermission(host.permission)

  const { editor } = await checkRegistration(host)
  await checkSessionList(editor)
  await checkSessionRead(editor)
  await checkSessionSearch(editor)
  await checkSessionInfo(editor)
  await checkSkill(editor, host)
  await checkSkillMcp(editor)
  await checkLookAt(editor)
  await checkTaskTools(editor, host)
  await checkInteractiveBash(editor)

  const elapsed = Date.now() - started
  note(`[s1b-selftest] ${checks} checks, ${failures.length} failure(s), ${elapsed}ms`)

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`)
    process.exit(1)
  }
  note("[s1b-selftest] PASS")
}

main().catch((error: unknown) => {
  console.error(`[s1b-selftest] crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
