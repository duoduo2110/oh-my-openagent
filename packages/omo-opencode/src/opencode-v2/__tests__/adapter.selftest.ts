/**
 * S2a selftest: assemble the V1 runtime on a fake OpenCode V2 context.
 *
 * Run inside the v2 container (the repo has no host node_modules):
 *
 *   bun packages/omo-opencode/src/opencode-v2/__tests__/adapter.selftest.ts
 *
 * It proves the wiring contract without a host:
 *   - the V1 engine builds hooks/managers/tools from a shimmed `PluginInput`;
 *   - one runtime per *location*: two locations get two runtimes, each with its own directory
 *     baked into the session translation, and concurrent setups of one location assemble once;
 *   - reference counting per location: releasing A leaves B usable, and a released location is
 *     dropped from the map instead of being handed to the next setup;
 *   - dispose is idempotent, and the client shim degrades out loud instead of returning made-up
 *     data;
 *   - the V2 hook disable list reaches the V1 hook factories (defaults off, controls on), and the
 *     list itself is what gates them.
 *
 * Everything runs under a throwaway HOME/XDG sandbox so the real plugin config is never touched.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { V2ContextLike } from "../adapter/types"

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "omo-v2-adapter-selftest-"))
const projectDir = path.join(sandbox, "project")
const secondDir = path.join(sandbox, "project-two")
const concurrentDir = path.join(sandbox, "project-three")
const disabledProbeDir = path.join(sandbox, "project-four")
const configDir = path.join(sandbox, "config")
for (const dir of [projectDir, secondDir, concurrentDir, disabledProbeDir, path.join(configDir, "opencode")]) {
  fs.mkdirSync(dir, { recursive: true })
}

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

/**
 * S4: only the hooks whose *writer* has no V2 counterpart stay off. The four message-reading hooks
 * were released because `session.messages` now rebuilds real `{info, parts}` from `session.context()`.
 */
const EXPECTED_DISABLED_FACTORIES = [
  "compactionTodoPreserver",
  "todoContinuationEnforcer",
] as const
/**
 * Released in S4: gone from the default list, and assembled. `preemptive-compaction` is checked only
 * against the list: its factory additionally sits behind `experimental.preemptive_compaction`.
 */
const EXPECTED_RELEASED_FACTORIES = [
  "claudeCodeHooks",
  "compactionContextInjector",
  "sessionNotification",
] as const
const EXPECTED_ENABLED_FACTORIES = ["keywordDetector", "commentChecker"] as const

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

  // ---- one location: assembly, counts, singleton reuse ---------------------------------------
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

  // ---- hook disable list: the defaults reach the V1 hook factories --------------------------
  const disabledFactories = EXPECTED_DISABLED_FACTORIES.filter(
    (name) => runtime.report.hookFactories[name] !== false,
  )
  record(
    "default disabled hooks not assembled",
    disabledFactories.length === 0 && runtime.report.disabledHooks.length >= 2,
    disabledFactories.length === 0
      ? `off=${runtime.report.disabledHooks.join(",")}`
      : `still assembled: ${disabledFactories.join(",")}`,
  )
  const releasedFactories = EXPECTED_RELEASED_FACTORIES.filter(
    (name) => runtime.report.hookFactories[name] !== true,
  )
  record(
    "S4 released hooks are assembled again",
    releasedFactories.length === 0,
    releasedFactories.length === 0
      ? EXPECTED_RELEASED_FACTORIES.join(",")
      : `still off: ${releasedFactories.join(",")}`,
  )
  const enabledFactories = EXPECTED_ENABLED_FACTORIES.filter(
    (name) => runtime.report.hookFactories[name] !== true,
  )
  record(
    "unrelated hooks still assembled",
    enabledFactories.length === 0,
    enabledFactories.length === 0
      ? EXPECTED_ENABLED_FACTORIES.join(",")
      : `missing: ${enabledFactories.join(",")}`,
  )

  // ---- per-location isolation ---------------------------------------------------------------
  const secondRuntime = await adapter.createOpenCodeV2Runtime(createFakeContext(secondDir))
  record(
    "second location gets its own runtime",
    secondRuntime !== undefined
      && secondRuntime.hooks !== runtime.hooks
      && secondRuntime.managers !== runtime.managers
      && secondRuntime.report.directory === secondDir,
    secondRuntime === undefined
      ? "second location returned undefined"
      : `dir=${secondRuntime.report.directory}`,
  )
  record(
    "first location keeps its runtime",
    runtime.report.directory === projectDir
      && adapter._getOpenCodeV2RuntimeForTesting(projectDir)?.hooks === runtime.hooks,
    `${runtime.report.directory}`,
  )

  // The shim bakes `ctx.location.directory` into every translated session; two locations must not
  // share it, or a session created in one would be reported as living in the other.
  const directories: string[] = []
  for (const dir of [projectDir, secondDir]) {
    const { input } = (await import("../adapter/plugin-input")).createV1PluginInput(createFakeContext(dir))
    const client = input.client as unknown as {
      session: { get: (input: unknown) => Promise<{ data?: { directory?: string } }> }
    }
    const response = await client.session.get({ path: { id: "ses_selftest" } })
    directories.push(String(response.data?.directory))
  }
  record(
    "toV1Session directory follows the location",
    directories[0] === projectDir && directories[1] === secondDir,
    directories.join(" | "),
  )

  // ---- concurrent setup of one location assembles once --------------------------------------
  const concurrent = await Promise.all([
    adapter.createOpenCodeV2Runtime(createFakeContext(concurrentDir)),
    adapter.createOpenCodeV2Runtime(createFakeContext(concurrentDir)),
  ])
  const [concurrentA, concurrentB] = concurrent
  record(
    "concurrent setups share one assembly",
    concurrentA !== undefined
      && concurrentB !== undefined
      && concurrentA.report === concurrentB.report
      && concurrentA.hooks === concurrentB.hooks,
    concurrentA === undefined || concurrentB === undefined
      ? "an assembly returned undefined"
      : `same report=${concurrentA.report === concurrentB.report}`,
  )
  record(
    "one runtime entry per location",
    adapter._runtimeLocationKeysForTesting().join(",") === [projectDir, secondDir, concurrentDir].sort().join(","),
    adapter._runtimeLocationKeysForTesting().join(","),
  )

  // ---- dispose is per location and reference counted ---------------------------------------
  let secondLocationDisposed = false
  const originalSecondDispose = secondRuntime?.hooks.dispose
  if (secondRuntime !== undefined) {
    secondRuntime.hooks.dispose = async (): Promise<void> => {
      secondLocationDisposed = true
      await originalSecondDispose?.()
    }
  }

  let disposeTwiceOk = true
  try {
    await runtime.dispose()
    await runtime.dispose()
    await second?.dispose()
    await second?.dispose()
  } catch (error) {
    disposeTwiceOk = false
    record("dispose twice", false, String(error))
  }
  if (disposeTwiceOk) record("dispose twice", true, "no throw")

  record(
    "runtime cleared after release",
    adapter._getOpenCodeV2RuntimeForTesting(projectDir) === undefined,
    "location dropped from the map",
  )
  record(
    "releasing one location leaves the other usable",
    secondLocationDisposed === false
      && adapter._getOpenCodeV2RuntimeForTesting(secondDir)?.hooks === secondRuntime?.hooks
      && adapter._runtimeLocationKeysForTesting().includes(secondDir),
    `disposed=${secondLocationDisposed} keys=${adapter._runtimeLocationKeysForTesting().join(",")}`,
  )

  // A setup after the previous runtime was released must assemble again, not reuse a corpse.
  const reassembled = await adapter.createOpenCodeV2Runtime(createFakeContext(projectDir))
  record(
    "released location assembles again",
    reassembled !== undefined
      && reassembled.hooks !== runtime.hooks
      && reassembled.report !== runtime.report,
    reassembled === undefined ? "returned undefined" : "fresh runtime",
  )
  await reassembled?.dispose()
  await secondRuntime?.dispose()
  await concurrentA?.dispose()
  await concurrentB?.dispose()
  record(
    "all locations released",
    adapter._runtimeLocationKeysForTesting().length === 0,
    adapter._runtimeLocationKeysForTesting().join(",") || "<empty>",
  )

  // ---- the disable list is the gate (an extra name changes the outcome) ---------------------
  const overrideRuntime = await adapter.assembleV1RuntimeOnV2(
    createFakeContext(disabledProbeDir) as unknown as V2ContextLike,
    { additionalDisabledHooks: ["keyword-detector"] },
  )
  record(
    "extra disabled hook is gated too",
    overrideRuntime.report.hookFactories["keywordDetector"] === false
      && overrideRuntime.report.disabledHooks.includes("keyword-detector")
      && overrideRuntime.report.hookFactories["commentChecker"] === true,
    `keywordDetector=${String(overrideRuntime.report.hookFactories["keywordDetector"])} commentChecker=${String(overrideRuntime.report.hookFactories["commentChecker"])}`,
  )
  await overrideRuntime.dispose()

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

  const broken = await adapter.createOpenCodeV2Runtime({ location: { directory: "", project: {} } })
  record(
    "assembly failure returns undefined",
    broken === undefined,
    broken === undefined ? "undefined (setup cannot take the host down)" : "returned a runtime",
  )

  // ---- failed assembly: stage tag, release order, nothing published -------------------------
  // A real failure has to be injected from inside the assembly (a broken dependency is not a test),
  // so `failAtStage` throws from the same override the production path runs in. What is asserted is
  // the contract the catch block owes: the stage is named, everything already built is released in
  // the documented order exactly once, and the location is left empty instead of half-owned.
  {
    const logger = await import("../../shared/logger")
    const stageLines: string[] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]): void => {
      // The adapter prints the stage line to stderr as well as to the plugin log; capture it
      // instead of letting it look like a crash in the selftest output.
      stageLines.push(args.map((arg) => String(arg)).join(" "))
    }

    const readFailureSummary = (logPath: string, stage: string): {
      stage?: string
      released?: string[]
      releaseFailures?: unknown[]
    } | undefined => {
      let text = ""
      try {
        text = fs.readFileSync(logPath, "utf8")
      } catch {
        return undefined
      }
      const line = text
        .split("\n")
        .find((entry) => entry.includes(`[omo-v2] assembly failed at ${stage}:`))
      if (line === undefined) return undefined
      const jsonStart = line.indexOf(' {"stage":')
      if (jsonStart < 0) return undefined
      try {
        return JSON.parse(line.slice(jsonStart + 1)) as {
          stage?: string
          released?: string[]
          releaseFailures?: unknown[]
        }
      } catch {
        return undefined
      }
    }

    const logPath = logger.getLogFilePath()

    /**
     * The release order the failed-assembly path promises, allowing the optional steps that only
     * exist when that part was built (the runtime skill source is behind a flag). Every observed
     * step must be one of the allowed ones and appear at most once: a duplicated step is exactly the
     * "released twice" bug this guards.
     */
    const releasedInOrder = (
      released: readonly string[],
      expected: readonly string[],
      allowed: readonly string[],
    ): boolean => {
      if (new Set(released).size !== released.length) return false
      const unexpected = released.filter((step) => !allowed.includes(step))
      if (unexpected.length > 0) return false
      let cursor = 0
      for (const step of released) {
        if (step === expected[cursor]) cursor += 1
      }
      return cursor === expected.length
    }

    /** Runs one injected assembly and returns what the failure path reported. */
    const failAssembly = async (stage: "tools" | "hooks"): Promise<{
      message: string
      stderr: string
      summary: { stage?: string; released?: string[]; releaseFailures?: unknown[] } | undefined
    }> => {
      const dir = path.join(sandbox, `project-fail-${stage}`)
      fs.mkdirSync(dir, { recursive: true })
      stageLines.length = 0
      let message = ""
      try {
        await adapter.assembleV1RuntimeOnV2(
          createFakeContext(dir) as unknown as V2ContextLike,
          { failAtStage: stage },
        )
        message = "<no throw>"
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      logger._flushForTesting()
      const summary = readFailureSummary(logPath, stage)
      record(
        `injected ${stage} failure leaves nothing published for that location`,
        adapter._getOpenCodeV2RuntimeForTesting(dir) === undefined
          && !adapter._runtimeLocationKeysForTesting().includes(dir),
        `keys=${adapter._runtimeLocationKeysForTesting().join(",") || "<empty>"}`,
      )
      // Re-assembling the same location must work: a failed attempt holds no in-flight entry.
      const retried = await adapter.createOpenCodeV2Runtime(createFakeContext(dir))
      record(
        `location is usable again after the injected ${stage} failure`,
        retried !== undefined,
        retried === undefined ? "retry returned undefined" : "retry assembled",
      )
      await retried?.dispose()
      return { message, stderr: stageLines.find((line) => line.includes("assembly failed")) ?? "", summary }
    }

    try {
      const tools = await failAssembly("tools")
      record(
        "injected tools failure is reported at the tools stage",
        tools.message.includes("injected assembly failure at tools")
          && tools.stderr.startsWith("[omo-v2] assembly failed at tools:")
          && tools.summary?.stage === "tools",
        `message=${tools.message} stderr=${tools.stderr}`,
      )
      const toolsReleased = tools.summary?.released ?? []
      record(
        "tools failure releases what was built, in order, once",
        releasedInOrder(
          toolsReleased,
          ["tuiStateMirror.stop", "backgroundManager.shutdown", "skillMcpManager.disconnectAll"],
          ["runtimeSkillSource.stop", "tuiStateMirror.stop", "backgroundManager.shutdown", "skillMcpManager.disconnectAll"],
        ),
        `released=${toolsReleased.join(",") || "<none>"} failures=${JSON.stringify(tools.summary?.releaseFailures ?? [])}`,
      )

      const hooks = await failAssembly("hooks")
      const hooksReleased = hooks.summary?.released ?? []
      record(
        "injected hooks failure is reported at the hooks stage",
        hooks.message.includes("injected assembly failure at hooks")
          && hooks.stderr.startsWith("[omo-v2] assembly failed at hooks:")
          && hooks.summary?.stage === "hooks",
        `message=${hooks.message} stderr=${hooks.stderr}`,
      )
      // Hooks are torn down before the managers they were built on, and no step repeats: a second
      // release of the same object is what the failed-assembly path must never do.
      record(
        "hooks failure releases hooks then managers, in order, once",
        releasedInOrder(
          hooksReleased,
          ["disposeHooks", "tuiStateMirror.stop", "backgroundManager.shutdown", "skillMcpManager.disconnectAll"],
          ["runtimeSkillSource.stop", "disposeHooks", "tuiStateMirror.stop", "backgroundManager.shutdown", "skillMcpManager.disconnectAll"],
        ),
        `released=${hooksReleased.join(",") || "<none>"} failures=${JSON.stringify(hooks.summary?.releaseFailures ?? [])}`,
      )
      record(
        "no release step failed during either cleanup",
        (tools.summary?.releaseFailures ?? []).length === 0
          && (hooks.summary?.releaseFailures ?? []).length === 0,
        `tools=${JSON.stringify(tools.summary?.releaseFailures ?? [])} hooks=${JSON.stringify(hooks.summary?.releaseFailures ?? [])}`,
      )
      record(
        "failed assemblies published no location",
        adapter._runtimeLocationKeysForTesting().length === 0,
        adapter._runtimeLocationKeysForTesting().join(",") || "<empty>",
      )
    } finally {
      console.error = originalConsoleError
    }
  }

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
