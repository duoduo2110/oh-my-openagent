/**
 * S1a bridge self-test. Run inside the Docker dev container:
 *
 *   scripts/v2/docker.sh run bun packages/omo-opencode/src/opencode-v2/__tests__/tool-bridge.selftest.ts
 *
 * It is a script, not a `bun test` file, because it needs to drive the real A-group factories against
 * a temp project directory. Every assertion mirrors a fact that killed earlier drafts of the port:
 *
 *   R1  `execute` must resolve an object (`{ content: string }`), never a bare string.
 *   zod v4 schemas must be accepted as the V2 `input` without a JSON Schema round trip.
 *
 * Exits non-zero on the first failing stage, printing what failed.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { OhMyOpenCodeConfig } from "../../config"
import { createTaskCreateTool } from "../../tools/task"
import {
  COLLISION_POLICY,
  bridgeTool,
  jsonSchemaInput,
  normalizeResult,
  registerBridgedTool,
  setToolBridgeDirectory,
  _resetToolBridgeStateForTesting,
  type BridgeRegistrationResult,
  type V2ToolEditorLike,
  type V2ToolInfoLike,
  type V2ToolRegistration,
  type V2ToolResult,
} from "../tool-bridge"
import { V2_GROUP_A_TOOL_NAMES, createV2ToolsRecord } from "../tools"

const failures: string[] = []
let checks = 0

function check(condition: boolean, message: string): void {
  checks += 1
  if (!condition) failures.push(message)
}

function checkEqual<T>(actual: T, expected: T, message: string): void {
  check(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`)
}

const output: string[] = []
function note(line: string): void {
  output.push(line)
  console.log(line)
}

// ---------------------------------------------------------------------------------------------
// Fake editor: enough of the V2 ToolEditor to exercise registration and execution.
// ---------------------------------------------------------------------------------------------

class FakeEditor implements V2ToolEditorLike {
  private readonly tools = new Map<string, V2ToolInfoLike & { execute: V2ToolRegistration["execute"] }>()
  rejectZod = false

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
    // zod objects expose a `type` field too ("object"); only a plain schema lacks `_zod`.
    const looksLikeJsonSchema = isRecord(tool.input) && !("_zod" in tool.input)
    if (this.rejectZod && !looksLikeJsonSchema) {
      throw new Error("Schema vendor: unsupported standard schema")
    }
    this.tools.set(tool.name, { name: tool.name, id: tool.name, description: tool.description, execute: tool.execute })
  }

  async execute(name: string, input: unknown): Promise<V2ToolResult> {
    const entry = this.tools.get(name)
    if (entry === undefined) throw new Error(`tool ${name} is not registered`)
    return entry.execute(input, {
      sessionID: "ses_selftest",
      agent: "build",
      messageID: "msg_selftest",
      id: "call_selftest",
      signal: new AbortController().signal,
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** R1: the V2 host throws a TypeError on a bare string, so every result must be an object. */
function assertResultShape(toolName: string, result: unknown): string {
  if (!isRecord(result)) {
    failures.push(`${toolName}: execute returned ${typeof result}, expected an object (R1)`)
    return ""
  }
  const content = result["content"]
  if (typeof content !== "string") {
    failures.push(`${toolName}: result.content is ${typeof content}, expected string (R1)`)
    return ""
  }
  if (typeof result["output"] === "string" && content.length === 0) {
    failures.push(`${toolName}: result carries output but an empty content`)
  }
  return content
}

function parseJson(toolName: string, content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    failures.push(`${toolName}: content is not JSON: ${content.slice(0, 120)}`)
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------

function checkNormalizeResult(): void {
  const fromString = normalizeResult("hello")
  check(isRecord(fromString) && fromString["content"] === "hello", "normalizeResult(string) -> { content }")

  const fromV1 = normalizeResult({ title: "t", output: "body", metadata: { a: 1 } })
  check(isRecord(fromV1) && fromV1["content"] === "body", "normalizeResult({title,output}) -> content=output")
  check(isRecord(fromV1) && isRecord(fromV1["metadata"]), "normalizeResult keeps metadata")

  const fromNothing = normalizeResult(undefined)
  check(isRecord(fromNothing) && fromNothing["content"] === "", "normalizeResult(undefined) -> { content: \"\" }")
  const fromNull = normalizeResult(null)
  check(isRecord(fromNull) && fromNull["content"] === "", "normalizeResult(null) -> { content: \"\" }")

  const already = normalizeResult({ content: "kept", metadata: { k: "v" } })
  check(isRecord(already) && already["content"] === "kept", "normalizeResult({content}) passes through")

  const attachment = normalizeResult({
    output: "see file",
    attachments: [{ type: "file", mime: "image/png", url: "file:///tmp/x.png", filename: "x.png" }],
  })
  check(
    isRecord(attachment) && Array.isArray(attachment["content"]) && (attachment["content"] as unknown[]).length === 2,
    "normalizeResult maps V1 attachments to file content parts",
  )
  note("normalizeResult: string/object/undefined/null/content/attachments all produce objects")
}

function checkSchemaPaths(): void {
  const record = createV2ToolsRecord({ directory: process.cwd(), pluginConfig: {} })
  const grep = record["grep"]
  check(grep !== undefined, "grep factory produces a tool definition")
  if (grep === undefined) return

  const zod = bridgeTool(grep, { name: "grep" })
  check(isRecord(zod.input) || typeof zod.input === "object", "bridgeTool(zod) input is a schema object")

  const json = bridgeTool(grep, { name: "grep" }, "json-schema")
  const schema = json.input as Record<string, unknown>
  check(schema["type"] === "object", "json-schema fallback declares type: object")
  const properties = schema["properties"] as Record<string, unknown> | undefined
  check(properties !== undefined && "pattern" in properties, "json-schema fallback keeps the pattern property")
  check(schema["$schema"] === undefined, "json-schema fallback drops $schema")
  check(jsonSchemaInput(grep)["type"] === "object", "jsonSchemaInput() is reusable")

  // A host that rejects non-JSON-Schema input must make the bridge fall back, not give up.
  const rejecting = new FakeEditor()
  rejecting.rejectZod = true
  const result = registerBridgedTool(rejecting, grep, { name: "grep" })
  checkEqual(result.mode, "json-schema", "registerBridgedTool falls back to JSON Schema when zod is rejected")
  check(rejecting.get("grep") !== undefined, "fallback registration is visible in the editor")
  note(`schemas: zod passthrough + json-schema fallback ok (fallback mode=${result.mode})`)
}

function makeTempProject(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-v2-s1a-"))
}

async function checkGroupA(): Promise<void> {
  const projectDir = makeTempProject()
  setToolBridgeDirectory(projectDir)
  const taskStorage = path.join(projectDir, "tasks")
  const pluginConfig: Partial<OhMyOpenCodeConfig> = {
    sisyphus: { tasks: { storage_path: taskStorage, claude_code_compat: false } },
  }

  const record = createV2ToolsRecord({ directory: projectDir, pluginConfig })
  const names = Object.keys(record).sort()
  checkEqual(names.length, V2_GROUP_A_TOOL_NAMES.length, "A group has exactly the seven always-on tools")
  for (const name of V2_GROUP_A_TOOL_NAMES) {
    check(names.includes(name), `A group contains ${name}`)
  }

  // Built-ins exist first so grep/glob exercise the override policy while the others register fresh.
  const editor = new FakeEditor([
    { name: "grep", id: "grep", description: "builtin grep" },
    { name: "glob", id: "glob", description: "builtin glob" },
    { name: "task", id: "task", description: "builtin task" },
  ])
  const registrations: BridgeRegistrationResult[] = []
  for (const [name, definition] of Object.entries(record)) {
    registrations.push(registerBridgedTool(editor, definition, { name }))
  }

  const modes = registrations.map((entry) => `${entry.name}:${entry.mode}`).join(" ")
  note(`registration: ${modes}`)
  for (const entry of registrations) {
    checkEqual(entry.mode, "zod", `${entry.name}: zod input accepted by a V2-shaped editor`)
    check(editor.get(entry.name) !== undefined, `${entry.name}: present in editor.get()`)
  }
  checkEqual(COLLISION_POLICY["grep"], "override", "grep collision policy is override")
  checkEqual(COLLISION_POLICY["glob"], "override", "glob collision policy is override")
  checkEqual(COLLISION_POLICY["edit"], "skip", "edit collision policy is skip")
  checkEqual(COLLISION_POLICY["task"], "skip", "task collision policy is skip")

  const builtinTask = record["task"]
  check(builtinTask === undefined, "A group does not claim the builtin task tool")

  // ---- grep / glob against a real temp tree -------------------------------------------------
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true })
  fs.writeFileSync(path.join(projectDir, "src", "alpha.ts"), "export const needle = 1\n", "utf8")
  fs.writeFileSync(path.join(projectDir, "src", "beta.ts"), "export const other = 2\n", "utf8")
  fs.writeFileSync(path.join(projectDir, "notes.md"), "# needle in markdown\n", "utf8")

  const grepResult = await editor.execute("grep", {
    pattern: "needle",
    path: path.join(projectDir, "src"),
    output_mode: "content",
  })
  const grepContent = assertResultShape("grep", grepResult)
  check(grepContent.includes("needle"), `grep finds the needle (got ${JSON.stringify(grepContent.slice(0, 160))})`)
  note(`grep: ${JSON.stringify(grepContent.split("\n").slice(0, 2))}`)

  const globResult = await editor.execute("glob", {
    pattern: "**/*.ts",
    path: projectDir,
  })
  const globContent = assertResultShape("glob", globResult)
  check(globContent.includes("alpha.ts"), `glob finds alpha.ts (got ${JSON.stringify(globContent.slice(0, 160))})`)
  check(!globContent.includes("notes.md"), "glob respects the pattern")
  note(`glob: ${JSON.stringify(globContent.split("\n").slice(0, 2))}`)

  // ---- task_get / task_list -----------------------------------------------------------------
  const createTask = createTaskCreateTool(pluginConfig)
  const createdRaw = await createTask.execute({ subject: "S1a selftest task" } as never, {
    sessionID: "ses_selftest",
  } as never)
  const created = parseJson("task_create", String(createdRaw))
  const createdTask = isRecord(created) && isRecord(created["task"]) ? created["task"] : {}
  const taskID = typeof createdTask["id"] === "string" ? createdTask["id"] : ""
  check(taskID.startsWith("T-"), `task_create produced a task id (got ${JSON.stringify(created)})`)

  const taskGetResult = await editor.execute("task_get", { id: taskID })
  const taskGetContent = assertResultShape("task_get", taskGetResult)
  const taskGet = parseJson("task_get", taskGetContent)
  check(isRecord(taskGet) && isRecord(taskGet["task"]), "task_get returns { task }")
  const taskObject = isRecord(taskGet) && isRecord(taskGet["task"]) ? taskGet["task"] : {}
  checkEqual(taskObject["id"], taskID, "task_get returns the created task")
  note(`task_get: ${JSON.stringify(taskGetContent.slice(0, 100))}`)

  const taskListResult = await editor.execute("task_list", {})
  const taskListContent = assertResultShape("task_list", taskListResult)
  const taskList = parseJson("task_list", taskListContent)
  check(isRecord(taskList) && Array.isArray(taskList["tasks"]), "task_list returns { tasks: [] }")
  const listedTasks = isRecord(taskList) && Array.isArray(taskList["tasks"]) ? taskList["tasks"] : []
  check(
    listedTasks.some((entry) => isRecord(entry) && entry["id"] === taskID),
    "task_list includes the created task",
  )
  note(`task_list: ${listedTasks.length} task(s)`)

  // ---- goal trio ----------------------------------------------------------------------------
  const createGoalResult = await editor.execute("create_goal", { objective: "ship S1a", session_id: "ses_selftest" })
  const createGoalContent = assertResultShape("create_goal", createGoalResult)
  const createdGoal = parseJson("create_goal", createGoalContent)
  check(isRecord(createdGoal) && isRecord(createdGoal["goal"]), "create_goal returns { goal }")
  const goal = isRecord(createdGoal) && isRecord(createdGoal["goal"]) ? createdGoal["goal"] : {}
  checkEqual(goal["objective"], "ship S1a", "create_goal stores the objective")
  checkEqual(goal["status"], "active", "create_goal starts active")
  note(`create_goal: ${JSON.stringify({ id: goal["id"], status: goal["status"] })}`)

  const updateGoalResult = await editor.execute("update_goal", { status: "complete", session_id: "ses_selftest" })
  const updateGoalContent = assertResultShape("update_goal", updateGoalResult)
  const updatedGoal = parseJson("update_goal", updateGoalContent)
  const updated = isRecord(updatedGoal) && isRecord(updatedGoal["goal"]) ? updatedGoal["goal"] : {}
  checkEqual(updated["status"], "complete", "update_goal marks the goal complete")
  note(`update_goal: ${JSON.stringify({ status: updated["status"] })}`)

  const getGoalResult = await editor.execute("get_goal", { session_id: "ses_selftest" })
  const getGoalContent = assertResultShape("get_goal", getGoalResult)
  const readGoal = parseJson("get_goal", getGoalContent)
  const read = isRecord(readGoal) && isRecord(readGoal["goal"]) ? readGoal["goal"] : {}
  checkEqual(read["objective"], "ship S1a", "get_goal reads the stored objective")
  checkEqual(read["status"], "complete", "get_goal reads the updated status")
  note(`get_goal: ${JSON.stringify({ objective: read["objective"], status: read["status"] })}`)

  // ---- edit stays opt-in --------------------------------------------------------------------
  const withEdit = createV2ToolsRecord({ directory: projectDir, pluginConfig, enableEdit: true })
  check(withEdit["edit"] !== undefined, "edit is available behind the enableEdit switch")
  check(record["edit"] === undefined, "edit is absent by default")
}

async function main(): Promise<void> {
  const started = Date.now()
  _resetToolBridgeStateForTesting()
  note(`[s1a-selftest] bun=${process.versions.bun ?? "?"} node=${process.version}`)

  checkNormalizeResult()
  checkSchemaPaths()
  await checkGroupA()

  const elapsed = Date.now() - started
  note(`[s1a-selftest] ${checks} checks, ${failures.length} failure(s), ${elapsed}ms`)

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`)
    process.exit(1)
  }
  note("[s1a-selftest] PASS")
}

main().catch((error: unknown) => {
  console.error(`[s1a-selftest] crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
