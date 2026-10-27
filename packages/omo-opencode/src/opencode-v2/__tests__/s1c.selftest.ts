/**
 * S1c self-test: the twenty C-group tools (delegation / background / monitor / team), driven for real.
 *
 * Run inside the v2 container:
 *
 *   scripts/v2/docker.sh run bun packages/omo-opencode/src/opencode-v2/__tests__/s1c.selftest.ts
 *
 * A script rather than a `bun test` file, like the other V2 selftests: it needs a temp project, a
 * fake V2 host, real V1 factories and a real team-core file tree, and it asserts on what the tools
 * actually answer.
 *
 * What it proves:
 *
 *   registration     all twenty names build; nineteen register with the zod schema; `task` is
 *                    skipped (the host keeps its built-in) unless `OMO_V2_TASK_TOOL=override`
 *   background       unknown task id answers "Task not found"; `block: true` with a 1s budget and a
 *                    stuck poll is released by the guard in < 5s; an abort answers immediately
 *   monitor          list/output/stop answer JSON with no manager activity; start is denied with
 *                    the V1 "feature disabled" reason when `monitor.enabled` is false
 *   team (no tmux)   create is refused as `team_mode` disabled, then (enabled) reports the missing
 *                    team spec as content instead of throwing
 *   team tasks       create -> list -> update -> get closed loop on a temp `base_dir`
 *   team status/list status renders the fabricated run; list finds a project spec placed under the
 *                    *project* directory while `process.cwd()` is elsewhere
 *   task/call_omo    abort reaches the guard through `v2ctx.signal`; the union preprocessor turns a
 *                    JSON-string `inline_spec` into the object the V1 schema expects
 *
 * "Real call" is deliberate: this host has no tmux, no model provider and no team run, so most tools
 * exercise their error path. What matters is that each call answers `{ content }` with something a
 * model can act on — never a hang and never an empty result.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { OhMyOpenCodeConfig } from "../../config"
import { TeamModeConfigSchema } from "../../config/schema/team-mode"
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
import { v2ToolBridgeMeta } from "../tools"
import { guardToolCall } from "../tools/guards"
import {
  V2_GROUP_C_TOOL_NAMES,
  createV2GroupCToolsRecord,
  type V2GroupCToolsResult,
} from "../tools/index-c"
import {
  TEAM_DISABLED_MESSAGE,
  TEAM_TMUX_REQUIRED_MESSAGE,
  preprocessTeamCreateArgs,
} from "../tools/team"

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

/** Guard-level results are pre-bridge: a V1 string is a legal answer there. */
function textOf(toolName: string, result: unknown): string {
  if (typeof result === "string") {
    if (result.length === 0) failures.push(`${toolName}: guard answered an empty string`)
    return result
  }
  return contentOf(toolName, result)
}

function parseJson(toolName: string, content: string): unknown {
  try {
    return JSON.parse(content)
  } catch {
    failures.push(`${toolName}: content is not JSON (${JSON.stringify(content.slice(0, 120))})`)
    return undefined
  }
}

// ---------------------------------------------------------------------------------------------
// Temp project, team dirs and config
// ---------------------------------------------------------------------------------------------

const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "omo-v2-s1c-"))
const teamBaseDir = path.join(projectDir, "omo-base")
const SESSION_A = "ses_s1c_a"
const TEAM_RUN_ID = "3f1c9a52-6b0d-4f3e-9a1b-2c4d5e6f7a80"
const PROJECT_TEAM_NAME = "s1c-team"

setToolBridgeDirectory(projectDir)

function basePluginConfig(): OhMyOpenCodeConfig {
  return loadPluginConfig(projectDir, process.env)
}

/** The enabled variant: team tools read/write a throwaway `base_dir`. */
function enabledConfig(): OhMyOpenCodeConfig {
  const config = basePluginConfig()
  config.team_mode = TeamModeConfigSchema.parse({
    ...(config.team_mode ?? {}),
    enabled: true,
    tmux_visualization: false,
    base_dir: teamBaseDir,
  })
  return config
}

/** The factory default variant: `team_mode` off, which is what a fresh install looks like. */
function disabledConfig(): OhMyOpenCodeConfig {
  const config = basePluginConfig()
  config.team_mode = TeamModeConfigSchema.parse({
    ...(config.team_mode ?? {}),
    enabled: false,
    base_dir: teamBaseDir,
  })
  return config
}

function writeTeamFixtures(): void {
  // A project-scoped team spec. `team_list` must find it through `ctx.location.directory` — the
  // process cwd inside the container is /repo, which has no `.omo/teams`.
  const specDir = path.join(projectDir, ".omo", "teams", PROJECT_TEAM_NAME)
  fs.mkdirSync(specDir, { recursive: true })
  fs.writeFileSync(
    path.join(specDir, "config.json"),
    `${JSON.stringify({
      version: 1,
      name: PROJECT_TEAM_NAME,
      leadAgentId: "lead",
      members: [
        { name: "lead", kind: "subagent_type", subagent_type: "sisyphus", prompt: "lead the team" },
        { name: "worker", kind: "category", category: "quick", prompt: "do the work" },
      ],
    }, null, 2)}\n`,
  )

  // A fabricated runtime state: team tasks/status/shutdown tools all resolve the caller through it.
  const stateDir = path.join(teamBaseDir, "runtime", TEAM_RUN_ID)
  fs.mkdirSync(stateDir, { recursive: true })
  fs.writeFileSync(
    path.join(stateDir, "state.json"),
    `${JSON.stringify({
      version: 1,
      teamRunId: TEAM_RUN_ID,
      teamName: PROJECT_TEAM_NAME,
      specSource: "project",
      createdAt: 1_700_000_000_000,
      status: "active",
      leadSessionId: SESSION_A,
      members: [
        { name: "lead", sessionId: SESSION_A, agentType: "leader", status: "running" },
        { name: "worker", agentType: "general-purpose", category: "quick", status: "pending" },
      ],
      shutdownRequests: [],
      bounds: {
        maxMembers: 8,
        maxParallelMembers: 4,
        maxMessagesPerRun: 10000,
        maxWallClockMinutes: 120,
        maxMemberTurns: 500,
      },
    }, null, 2)}\n`,
  )
}

// ---------------------------------------------------------------------------------------------
// Fake V2 host + editor
// ---------------------------------------------------------------------------------------------

type FakeHost = {
  readonly context: V2ContextLike
  readonly permissionCalls: Array<Record<string, unknown>>
}

function createFakeHost(): FakeHost {
  const permissionCalls: Array<Record<string, unknown>> = []
  const permission = {
    assert: async (input: Record<string, unknown>) => {
      permissionCalls.push(input)
    },
  }
  const context = {
    location: { directory: projectDir, project: { id: "prj_s1c", directory: projectDir } },
    app: { name: "omo-v2-s1c-selftest", version: "0.0.0", channel: "local" },
    permission,
  }
  return { context: context as unknown as V2ContextLike, permissionCalls }
}

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

  async execute(
    name: string,
    input: unknown,
    options: { sessionID?: string; signal?: AbortSignal } = {},
  ): Promise<V2ToolResult> {
    const entry = this.tools.get(name)
    if (entry === undefined) throw new Error(`tool ${name} is not registered`)
    return entry.execute(input, {
      sessionID: options.sessionID ?? SESSION_A,
      agent: "sisyphus",
      messageID: "msg_s1c",
      id: "call_s1c",
      signal: options.signal ?? new AbortController().signal,
    })
  }
}

/** Registers through the production meta builder, so the `task` policy is the one that ships. */
function registerGroup(
  editor: FakeEditor,
  result: V2GroupCToolsResult,
  options: { taskOverride?: boolean } = {},
): BridgeRegistrationResult[] {
  const registrations: BridgeRegistrationResult[] = []
  for (const [name, definition] of Object.entries(result.tools)) {
    registrations.push(registerBridgedTool(editor, definition, v2ToolBridgeMeta(name, options.taskOverride === true)))
  }
  return registrations
}

// ---------------------------------------------------------------------------------------------
// Stages
// ---------------------------------------------------------------------------------------------

async function checkRegistration(host: FakeHost, config: OhMyOpenCodeConfig): Promise<{
  editor: FakeEditor
  result: V2GroupCToolsResult
}> {
  const result = await createV2GroupCToolsRecord({
    context: host.context,
    directory: projectDir,
    pluginConfig: config,
  })

  const built = Object.keys(result.tools).sort()
  for (const name of V2_GROUP_C_TOOL_NAMES) {
    check(built.includes(name), `group C built ${name} (built: ${built.join(",")}, skipped: ${JSON.stringify(result.skipped)})`)
  }
  checkEqual(result.skipped.length, 0, "no C-group tool was skipped")
  checkEqual(result.subsystems?.teamModeEnabled, true, "the C dependency set carries team_mode.enabled")

  // The host exposes its delegator as `subagent`, so `task` has *no* name collision here — and the
  // default policy must still refuse to add a second spawner next to the host's own.
  const editor = new FakeEditor()
  const registrations = registerGroup(editor, result)

  const byName = new Map(registrations.map((entry) => [entry.name, entry]))
  const taskRegistration = byName.get("task")
  checkEqual(taskRegistration?.mode, "skip", "task is skipped by default even without a same-named builtin")
  checkEqual(editor.get("task"), undefined, "the default policy did not add a second task tool")
  checkEqual(editor.list().length, 19, "exactly nineteen C tools were registered")
  const notZod = registrations
    .filter((entry) => entry.name !== "task" && entry.mode !== "zod")
    .map((entry) => `${entry.name}:${entry.mode}`)
  checkEqual(notZod.length, 0, `every other C tool registered with the zod schema (${notZod.join(",")})`)
  for (const entry of registrations) {
    if (entry.mode === "skip") continue
    check(editor.get(entry.name) !== undefined, `${entry.name}: present in editor.get()`)
  }
  note(`c-group registration: ${registrations.map((entry) => `${entry.name}:${entry.mode}`).join(" ")}`)
  note(`c-group subsystems: ${JSON.stringify(result.subsystems)}`)
  return { editor, result }
}

function checkTaskOverride(result: V2GroupCToolsResult): FakeEditor {
  const editor = new FakeEditor([{ name: "task", id: "task", description: "builtin task tool" }])
  const definition = result.tools["task"]
  check(definition !== undefined, "the task definition exists")
  if (definition === undefined) return editor
  const registration = registerBridgedTool(editor, definition, v2ToolBridgeMeta("task", true))
  checkEqual(registration.mode, "zod", "OMO_V2_TASK_TOOL=override registers the V1 task tool")
  checkEqual(registration.replacedBuiltin, true, "the override replaced the builtin task")
  check(
    editor.descriptionOf("task") !== "builtin task tool",
    "the override carries the V1 delegate description",
  )
  return editor
}

async function checkBackground(editor: FakeEditor): Promise<void> {
  const output = contentOf("background_output", await editor.execute("background_output", { task_id: "bg_s1c_missing" }))
  check(output.includes("Task not found"), `background_output explains an unknown id (got ${JSON.stringify(output.slice(0, 120))})`)

  const blocking = contentOf(
    "background_output",
    await editor.execute("background_output", { task_id: "bg_s1c_missing", block: true, timeout: 1000 }),
  )
  check(blocking.includes("Task not found"), "background_output with block:true still answers an unknown id at once")

  const cancelled = contentOf("background_cancel", await editor.execute("background_cancel", { all: true }))
  check(cancelled.includes("No running or pending background tasks"), `background_cancel answers with nothing to cancel (got ${JSON.stringify(cancelled.slice(0, 100))})`)
  note(`background_output: ${JSON.stringify(output.slice(0, 70))} | background_cancel: ${JSON.stringify(cancelled.slice(0, 70))}`)
}

/**
 * The guard contract on a poll that never returns: the wrapped call must answer inside 5s, and on
 * abort it must answer immediately. A stub tool is used because a *real* `background_output` only
 * blocks when the task exists, which no manager in this container can provide.
 */
async function checkLongWaitGuard(): Promise<void> {
  let settle: ((value: string) => void) | undefined
  const stuck = {
    description: "stuck poll (self-test stub)",
    args: { block: { type: "boolean" }, timeout: { type: "number" } },
    execute: async (): Promise<string> =>
      await new Promise<string>((resolve) => {
        settle = resolve
      }),
  } as unknown as Parameters<typeof guardToolCall>[0]

  const guarded = guardToolCall(stuck, {
    name: "background_output",
    deadline: { timeoutArg: "timeout", defaultTimeoutMs: 60_000, maxTimeoutMs: 600_000, applies: (args) => args["block"] === true },
  })
  const context = {
    sessionID: SESSION_A,
    messageID: "msg_s1c",
    agent: "sisyphus",
    directory: projectDir,
    abort: new AbortController().signal,
    metadata: () => undefined,
  }

  const started = Date.now()
  const deadlineResult = await (guarded.execute as unknown as (a: unknown, c: unknown) => Promise<unknown>)(
    { task_id: "bg_stub", block: true, timeout: 1000 },
    context,
  )
  const elapsed = Date.now() - started
  const deadlineText = textOf("background_output(guard)", deadlineResult)
  check(elapsed < 5000, `a blocked poll is released in <5s (took ${elapsed}ms)`)
  check(deadlineText.includes("did not answer within"), `the released call says why (got ${JSON.stringify(deadlineText.slice(0, 120))})`)
  note(`guard deadline: ${elapsed}ms ${JSON.stringify(deadlineText.slice(0, 80))}`)

  // Abort: the host cancels the call, so the answer must not wait for the poll.
  const controller = new AbortController()
  const abortedAt = Date.now()
  const aborted = (guarded.execute as unknown as (a: unknown, c: unknown) => Promise<unknown>)(
    { task_id: "bg_stub", block: true, timeout: 600_000 },
    { ...context, abort: controller.signal },
  )
  setTimeout(() => controller.abort(), 100)
  const abortText = textOf("background_output(guard)", await aborted)
  const abortElapsed = Date.now() - abortedAt
  check(abortElapsed < 2000, `an aborted wait answers at once (took ${abortElapsed}ms)`)
  check(abortText.includes("was aborted"), `the aborted call says so (got ${JSON.stringify(abortText.slice(0, 120))})`)
  note(`guard abort: ${abortElapsed}ms ${JSON.stringify(abortText.slice(0, 80))}`)

  // Release the stub so its promise does not outlive the test.
  settle?.("late")
}

async function checkMonitors(editor: FakeEditor): Promise<void> {
  const list = contentOf("monitor_list", await editor.execute("monitor_list", {}))
  const listPayload = parseJson("monitor_list", list)
  check(isRecord(listPayload) && Array.isArray(listPayload["monitors"]), `monitor_list returns { monitors: [] } (got ${JSON.stringify(list.slice(0, 80))})`)
  checkEqual(listPayload !== undefined && isRecord(listPayload) ? (listPayload["monitors"] as unknown[]).length : -1, 0, "monitor_list is empty for a fresh session")

  const started = contentOf("monitor_start", await editor.execute("monitor_start", { command: "echo s1c", label: "s1c" }))
  check(started.includes("[ERROR] monitor_start denied"), `monitor_start fails closed when the feature is off (got ${JSON.stringify(started.slice(0, 120))})`)
  check(started.includes("monitor feature disabled"), "monitor_start names the V1 reason")

  const output = contentOf("monitor_output", await editor.execute("monitor_output", { monitor_id: "mon_s1c_missing" }))
  const outputPayload = parseJson("monitor_output", output)
  check(isRecord(outputPayload) && outputPayload["error"] === "not_found", `monitor_output answers not_found (got ${JSON.stringify(output.slice(0, 80))})`)

  const stopped = contentOf("monitor_stop", await editor.execute("monitor_stop", { monitor_id: "mon_s1c_missing" }))
  const stoppedPayload = parseJson("monitor_stop", stopped)
  check(isRecord(stoppedPayload) && stoppedPayload["status"] === "already-stopped", `monitor_stop answers already-stopped (got ${JSON.stringify(stopped.slice(0, 80))})`)
  note(`monitor: ${JSON.stringify(started.slice(0, 60))} | ${JSON.stringify(output.slice(0, 60))}`)
}

async function checkTeamCreate(disabled: FakeEditor, editor: FakeEditor): Promise<void> {
  const off = contentOf("team_create", await disabled.execute("team_create", { teamName: "s1c-anything" }))
  checkEqual(off, TEAM_DISABLED_MESSAGE, "team_create refuses while team_mode is disabled")
  check(off.includes("team_mode is disabled"), "the refusal names the config switch")

  const missing = contentOf("team_create", await editor.execute("team_create", { teamName: "s1c-no-such-team" }))
  check(missing.startsWith("Error: team_create"), `team_create reports a missing spec as content (got ${JSON.stringify(missing.slice(0, 120))})`)
  check(missing.toLowerCase().includes("s1c-no-such-team"), "the missing-spec message names the team")

  // The union branch: a JSON *string* spec is parsed before the V1 validation runs.
  const inline = contentOf(
    "team_create",
    await editor.execute("team_create", { inline_spec: JSON.stringify({ name: "s1c-inline", members: [] }) }),
  )
  check(inline.length > 0, "team_create answers for a JSON-string inline_spec")
  check(inline.startsWith("Error: team_create"), `an invalid inline spec is reported as content (got ${JSON.stringify(inline.slice(0, 120))})`)
  note(`team_create: ${JSON.stringify(off.slice(0, 50))} | ${JSON.stringify(missing.slice(0, 80))}`)
}

function checkTeamPreprocess(): void {
  const parsed = preprocessTeamCreateArgs({ inline_spec: JSON.stringify({ name: "s1c-pre", members: [{ name: "a" }] }) })
  check(isRecord(parsed) && isRecord(parsed["inline_spec"]), "a JSON-string inline_spec becomes an object")
  check(isRecord(parsed) && isRecord(parsed["inline_spec"]) && parsed["inline_spec"]["name"] === "s1c-pre", "the parsed spec keeps its fields")

  const object = { name: "s1c-pre", members: [{ name: "a" }] }
  const passthrough = preprocessTeamCreateArgs({ inline_spec: object })
  check(isRecord(passthrough) && passthrough["inline_spec"] === object, "an object inline_spec passes straight through")

  const broken = preprocessTeamCreateArgs({ inline_spec: "{not json" })
  check(isRecord(broken) && broken["inline_spec"] === "{not json", "an unparseable string is left for V1 validation")
  note("team_create inline_spec: string parsed, object passed through, broken string preserved")
}

/**
 * `team_mode.tmux_visualization = true` with no tmux binary: the refusal must be a string, not a
 * throw and not a silently un-visualized team. Skipped when this host does have tmux.
 */
async function checkTeamTmuxRequirement(host: FakeHost): Promise<void> {
  const withVisualization = basePluginConfig()
  withVisualization.team_mode = TeamModeConfigSchema.parse({
    ...(withVisualization.team_mode ?? {}),
    enabled: true,
    tmux_visualization: true,
    base_dir: teamBaseDir,
  })
  const result = await createV2GroupCToolsRecord({
    context: host.context,
    directory: projectDir,
    pluginConfig: withVisualization,
  })
  if (result.subsystems?.tmuxAvailable === true) {
    note("team tmux: tmux is available on this host, the layout refusal was not exercised")
    return
  }
  const editor = new FakeEditor()
  registerGroup(editor, result)
  const content = contentOf("team_create", await editor.execute("team_create", { teamName: PROJECT_TEAM_NAME }))
  checkEqual(content, TEAM_TMUX_REQUIRED_MESSAGE, "team_create refuses tmux_visualization without tmux")
  note(`team tmux: ${JSON.stringify(content.slice(0, 70))}`)
}

async function checkTeamTasks(editor: FakeEditor): Promise<void> {
  const created = contentOf(
    "team_task_create",
    await editor.execute("team_task_create", {
      teamRunId: TEAM_RUN_ID,
      subject: "S1c task bridge",
      description: "prove the team task store works through the V2 bridge",
    }),
  )
  const createdPayload = parseJson("team_task_create", created)
  const taskId = isRecord(createdPayload) && isRecord(createdPayload["task"]) && typeof createdPayload["task"]["id"] === "string"
    ? createdPayload["task"]["id"]
    : undefined
  checkEqual(taskId, "1", "team_task_create allocated task id 1")

  const listed = contentOf("team_task_list", await editor.execute("team_task_list", { teamRunId: TEAM_RUN_ID }))
  const listedPayload = parseJson("team_task_list", listed)
  const listedTasks = listedPayload !== undefined && isRecord(listedPayload) && Array.isArray(listedPayload["tasks"])
    ? listedPayload["tasks"]
    : []
  checkEqual(listedTasks.length, 1, "team_task_list returns the created task")

  const updated = contentOf(
    "team_task_update",
    await editor.execute("team_task_update", { teamRunId: TEAM_RUN_ID, taskId: String(taskId), status: "in_progress" }),
  )
  const updatedPayload = parseJson("team_task_update", updated)
  checkEqual(
    isRecord(updatedPayload) && isRecord(updatedPayload["task"]) ? updatedPayload["task"]["status"] : undefined,
    "in_progress",
    "team_task_update moved the task to in_progress",
  )
  checkEqual(
    isRecord(updatedPayload) && isRecord(updatedPayload["task"]) ? updatedPayload["task"]["owner"] : undefined,
    "lead",
    "team_task_update attributed the change to the calling team member",
  )

  const read = contentOf("team_task_get", await editor.execute("team_task_get", { teamRunId: TEAM_RUN_ID, taskId: String(taskId) }))
  const readPayload = parseJson("team_task_get", read)
  checkEqual(
    isRecord(readPayload) && isRecord(readPayload["task"]) ? readPayload["task"]["status"] : undefined,
    "in_progress",
    "team_task_get reads the updated status back",
  )
  note(`team tasks: id=${String(taskId)} list=${listedTasks.length} status=in_progress owner=lead`)
}

async function checkTeamQueries(editor: FakeEditor): Promise<void> {
  const status = contentOf("team_status", await editor.execute("team_status", { teamRunId: TEAM_RUN_ID }))
  const statusPayload = parseJson("team_status", status)
  checkEqual(isRecord(statusPayload) ? statusPayload["teamRunId"] : undefined, TEAM_RUN_ID, "team_status reports the run id")
  checkEqual(isRecord(statusPayload) ? statusPayload["status"] : undefined, "active", "team_status reports the runtime status")
  check(
    isRecord(statusPayload) && Array.isArray(statusPayload["members"]) && statusPayload["members"].length === 2,
    "team_status lists both members",
  )

  const list = contentOf("team_list", await editor.execute("team_list", { scope: "all" }))
  const listPayload = parseJson("team_list", list)
  const entries = Array.isArray(listPayload) ? listPayload : []
  const projectEntry = entries.find((entry) => isRecord(entry) && entry["name"] === PROJECT_TEAM_NAME)
  check(projectEntry !== undefined, `team_list finds the project spec via ctx.location.directory (got ${JSON.stringify(list.slice(0, 160))})`)
  checkEqual(projectEntry !== undefined && isRecord(projectEntry) ? projectEntry["memberCount"] : undefined, 2, "team_list counts the spec's members")
  checkEqual(projectEntry !== undefined && isRecord(projectEntry) ? projectEntry["teamRunId"] : undefined, TEAM_RUN_ID, "team_list joins the active run")
  check(
    process.cwd() !== projectDir,
    `the cwd is not the project directory (cwd=${process.cwd()}), so the spec can only come from ctx.location.directory`,
  )
  note(`team_status: ${JSON.stringify(status.slice(0, 90))}`)
  note(`team_list: ${JSON.stringify(list.slice(0, 120))}`)
}

async function checkTeamLifecycleErrors(editor: FakeEditor): Promise<void> {
  const unknownRun = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f2a3b4c5d"
  const deleted = contentOf("team_delete", await editor.execute("team_delete", { teamRunId: unknownRun }))
  check(deleted.startsWith("Error: team_delete"), `team_delete reports an unknown run as content (got ${JSON.stringify(deleted.slice(0, 100))})`)

  const request = contentOf(
    "team_shutdown_request",
    await editor.execute("team_shutdown_request", { teamRunId: unknownRun, targetMemberName: "worker" }),
  )
  check(request.startsWith("Error: team_shutdown_request"), `team_shutdown_request reports an unknown run (got ${JSON.stringify(request.slice(0, 100))})`)

  const approve = contentOf(
    "team_approve_shutdown",
    await editor.execute("team_approve_shutdown", { teamRunId: unknownRun, memberName: "worker" }),
  )
  check(approve.startsWith("Error: team_approve_shutdown"), `team_approve_shutdown reports an unknown run (got ${JSON.stringify(approve.slice(0, 100))})`)

  const reject = contentOf(
    "team_reject_shutdown",
    await editor.execute("team_reject_shutdown", { teamRunId: unknownRun, memberName: "worker", reason: "not yet" }),
  )
  check(reject.startsWith("Error: team_reject_shutdown"), `team_reject_shutdown reports an unknown run (got ${JSON.stringify(reject.slice(0, 100))})`)

  const message = contentOf(
    "team_send_message",
    await editor.execute("team_send_message", { teamRunId: unknownRun, to: "worker", body: "hello" }),
  )
  check(message.startsWith("Error: team_send_message"), `team_send_message reports an unknown run (got ${JSON.stringify(message.slice(0, 100))})`)
  note(`team lifecycle (unknown run): delete/shutdown/approve/reject/send all answer content`)
}

async function checkDelegateCalls(editor: FakeEditor, taskEditor: FakeEditor): Promise<void> {
  // Abort is the one path that is deterministic without a model provider: the guard answers at once
  // and the V1 session spawn is drained in the background.
  const controller = new AbortController()
  controller.abort()
  const taskText = contentOf(
    "task",
    await taskEditor.execute("task", { prompt: "s1c abort probe", category: "quick" }, { signal: controller.signal }),
  )
  check(taskText.includes("was aborted"), `task honours v2ctx.signal (got ${JSON.stringify(taskText.slice(0, 120))})`)

  const callOmo = contentOf(
    "call_omo_agent",
    await editor.execute("call_omo_agent", {
      description: "s1c probe",
      prompt: "say hi",
      subagent_type: "not-a-real-agent",
      run_in_background: false,
    }),
  )
  check(
    callOmo.startsWith("Error") || callOmo.includes("Invalid agent type"),
    `call_omo_agent answers a readable error without a provider (got ${JSON.stringify(callOmo.slice(0, 120))})`,
  )
  note(`task: ${JSON.stringify(taskText.slice(0, 80))}`)
  note(`call_omo_agent: ${JSON.stringify(callOmo.slice(0, 80))}`)
}

async function main(): Promise<void> {
  const started = Date.now()
  _resetToolBridgeStateForTesting()
  setToolBridgeDirectory(projectDir)
  writeTeamFixtures()

  const host = createFakeHost()
  setToolBridgePermission((host.context as unknown as { readonly permission?: unknown }).permission)
  note(`[s1c-selftest] bun=${process.versions.bun ?? "?"} project=${projectDir} cwd=${process.cwd()}`)

  const enabled = enabledConfig()
  const { editor, result } = await checkRegistration(host, enabled)
  const taskEditor = checkTaskOverride(result)

  // A second, `team_mode`-off build: the feature gate must be visible without touching config files.
  const disabledResult = await createV2GroupCToolsRecord({
    context: host.context,
    directory: projectDir,
    pluginConfig: disabledConfig(),
  })
  const disabledEditor = new FakeEditor()
  registerGroup(disabledEditor, disabledResult)
  checkEqual(disabledResult.subsystems?.teamModeEnabled, false, "the disabled build reports team_mode off")

  await checkBackground(editor)
  await checkLongWaitGuard()
  await checkMonitors(editor)
  await checkTeamCreate(disabledEditor, editor)
  checkTeamPreprocess()
  await checkTeamTmuxRequirement(host)
  await checkTeamTasks(editor)
  await checkTeamQueries(editor)
  await checkTeamLifecycleErrors(editor)
  await checkDelegateCalls(editor, taskEditor)

  const elapsed = Date.now() - started
  note(`[s1c-selftest] ${checks} checks, ${failures.length} failure(s), ${elapsed}ms`)

  if (failures.length > 0) {
    for (const failure of failures) console.error(`FAIL: ${failure}`)
    process.exit(1)
  }
  note("[s1c-selftest] PASS")
  process.exit(0)
}

main().catch((error: unknown) => {
  console.error(`[s1c-selftest] crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`)
  process.exit(1)
})
