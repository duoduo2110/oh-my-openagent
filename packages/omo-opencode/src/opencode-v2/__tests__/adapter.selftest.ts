/**
 * S2a selftest: assemble the V1 runtime on a fake OpenCode V2 context.
 *
 * Run inside the v2 container (the repo has no host node_modules):
 *
 *   bun packages/omo-opencode/src/opencode-v2/__tests__/adapter.selftest.ts
 *
 * It proves the wiring contract without a host: the V1 engine builds hooks/managers/tools from a
 * shimmed `PluginInput`, the singleton is reused on a second call, dispose is idempotent, and the
 * client shim degrades out loud instead of returning made-up data.
 *
 * Everything runs under a throwaway HOME/XDG sandbox so the real plugin config is never touched.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "omo-v2-adapter-selftest-"))
const projectDir = path.join(sandbox, "project")
const configDir = path.join(sandbox, "config")
fs.mkdirSync(projectDir, { recursive: true })
fs.mkdirSync(path.join(configDir, "opencode"), { recursive: true })

process.env["HOME"] = sandbox
process.env["XDG_CONFIG_HOME"] = configDir
process.env["XDG_DATA_HOME"] = path.join(sandbox, "data")
process.env["XDG_STATE_HOME"] = path.join(sandbox, "state")
process.env["XDG_CACHE_HOME"] = path.join(sandbox, "cache")
process.env["DO_NOT_TRACK"] = "1"

const MIN_HOOKS = 10
/**
 * V1 default-config baseline, measured from a real assembly (S2a selftest, OpenCode 2.1.4 host):
 * 13 core tools. The gated extras (`edit` behind `hashline_edit`, four `task_*` behind
 * `experimental.task_system`, `interactive_bash`, team/monitor) are off by default, so 25 is not
 * reachable without a config that turns them on. The name list below is the real assertion; the
 * count just keeps the shape check obvious.
 */
const MIN_TOOLS = 13
const EXPECTED_TOOLS = [
  "grep",
  "glob",
  "task",
  "skill",
  "skill_mcp",
  "call_omo_agent",
  "look_at",
  "background_output",
  "background_cancel",
  "session_info",
  "session_list",
  "session_read",
  "session_search",
] as const

type Check = { readonly name: string; readonly ok: boolean; readonly detail: string }

const checks: Check[] = []

function record(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail })
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`)
}

type FakeContext = {
  readonly location: {
    readonly directory: string
    readonly project: { readonly id: string; readonly directory: string; readonly canonical: string }
  }
  readonly app: { readonly name: string; readonly version: string; readonly channel: string }
  readonly session: Record<string, unknown>
  readonly agent: Record<string, unknown>
  readonly model: Record<string, unknown>
  readonly provider: Record<string, unknown>
  readonly skill: Record<string, unknown>
}

function createFakeContext(directory: string): FakeContext {
  return {
    location: {
      directory,
      project: { id: "prj_selftest", directory, canonical: directory },
    },
    app: { name: "omo-v2-selftest", version: "0.0.0", channel: "local" },
    session: {
      list: async () => ({ data: [], cursor: {} }),
      get: async () => ({ id: "ses_selftest", projectID: "prj_selftest" }),
      create: async () => ({ id: "ses_selftest", projectID: "prj_selftest" }),
      context: async () => [],
      active: async () => ({}),
      interrupt: async () => undefined,
      prompt: async () => ({ id: "msg_selftest" }),
      compact: async () => ({ id: "msg_compact" }),
    },
    agent: { list: async () => ({ location: { directory }, data: [] }) },
    model: { list: async () => ({ location: { directory }, data: [] }) },
    provider: { list: async () => ({ location: { directory }, data: [] }) },
    skill: {},
  }
}

async function main(): Promise<void> {
  const adapter = await import("../adapter")
  const context = createFakeContext(projectDir)

  const startedAt = Date.now()
  const runtime = await adapter.createOpenCodeV2Runtime(context)
  const assembleMs = Date.now() - startedAt

  if (runtime === undefined) {
    record("runtime assembled", false, "createOpenCodeV2Runtime returned undefined")
    return
  }

  record("runtime assembled", true, `${assembleMs}ms`)
  record(
    "hook count",
    runtime.report.hookCount >= MIN_HOOKS,
    `${runtime.report.hookCount} (min ${MIN_HOOKS}) keys=${runtime.report.hookKeys.join(",")}`,
  )
  record(
    "tool count",
    runtime.report.toolCount >= MIN_TOOLS,
    `${runtime.report.toolCount} (min ${MIN_TOOLS})`,
  )
  const missingTools = EXPECTED_TOOLS.filter((name) => !runtime.report.toolNames.includes(name))
  record(
    "core tool names",
    missingTools.length === 0,
    missingTools.length === 0 ? `${EXPECTED_TOOLS.length} present` : `missing ${missingTools.join(",")}`,
  )
  record(
    "managers",
    runtime.report.managerNames.length >= 4,
    runtime.report.managerNames.join(","),
  )
  record("agents", runtime.report.agentCount >= 10, `${runtime.report.agentCount}`)
  record(
    "dispose is a function",
    typeof runtime.dispose === "function",
    typeof runtime.dispose,
  )

  const second = await adapter.createOpenCodeV2Runtime(context)
  record(
    "singleton reuse",
    second !== undefined && second.hooks === runtime.hooks,
    second === undefined ? "second call returned undefined" : "same hooks object",
  )

  const shim = runtime.report.directory.length > 0
  record("plugin input directory", shim, runtime.report.directory)

  let missingThrew = false
  try {
    const input = await import("../adapter/plugin-input")
    const built = input.createV1PluginInput(context)
    const shimClient = built.input.client as unknown as Record<string, unknown>
    const missing = shimClient["notARealNamespace"] as unknown as Record<string, unknown>
    const fn = missing["notARealMethod"] as () => unknown
    fn()
  } catch (error) {
    missingThrew = error instanceof Error && error.message.includes("client shim missing")
  }
  record("missing method throws loudly", missingThrew, missingThrew ? "ok" : "no throw")

  let disposeTwiceOk = true
  try {
    await runtime.dispose()
    await runtime.dispose()
    await second?.dispose()
  } catch (error) {
    disposeTwiceOk = false
    record("dispose twice", false, String(error))
  }
  if (disposeTwiceOk) record("dispose twice", true, "no throw")

  record(
    "runtime cleared after release",
    adapter.getOpenCodeV2Runtime() === undefined,
    "singleton dropped",
  )

  const broken = await adapter.createOpenCodeV2Runtime({ location: { directory: "", project: {} } })
  record(
    "assembly failure returns undefined",
    broken === undefined,
    broken === undefined ? "undefined (setup cannot take the host down)" : "returned a runtime",
  )

  adapter._resetOpenCodeV2RuntimeForTesting()
}

try {
  await main()
} catch (error) {
  console.error("selftest crashed:", error)
  process.exitCode = 1
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true })
}

const failed = checks.filter((check) => !check.ok)
console.log(`\nS2a adapter selftest: ${checks.length - failed.length}/${checks.length} passed`)
if (failed.length > 0) {
  console.error(`failed: ${failed.map((check) => check.name).join(", ")}`)
  process.exitCode = 1
}
