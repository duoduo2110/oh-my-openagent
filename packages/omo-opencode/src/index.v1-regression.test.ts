import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import pluginModule, { omoPlugin } from "./index"
import { PROBE_AGENT_FILENAME, PROBE_LOG_PREFIX } from "./opencode-v2/probe"
import { OPENCODE_V2_NOTICE_MESSAGE } from "./opencode-v2/startup-notice"
import { _flushForTesting, getLogFilePath } from "./shared/logger"

/**
 * V1 regression gate.
 *
 * The repository now ships one harness (OpenCode) but two runtime entries: the V1 `server`/`tui`
 * hooks and the OpenCode 2 `setup`. Loading the plugin under OpenCode 1.x must never reach the V2
 * path — no "OpenCode 2" notice, no probe file writes, no probe log lines — or a V1 user would
 * see V2 migration chatter and stray agent files in their config.
 */

const HOME_KEYS = ["HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME"] as const

type SavedEnv = Record<string, string | undefined>

const originalEnv: SavedEnv = Object.fromEntries(HOME_KEYS.map((key) => [key, process.env[key]]))

let sandbox: string
let v1LogSlice: string
let v1Hooks: Record<string, unknown>

function readLogDelta(fromByte: number): string {
  const logPath = getLogFilePath()
  if (!existsSync(logPath)) return ""
  return readFileSync(logPath).subarray(fromByte).toString("utf8")
}

function logSize(): number {
  const logPath = getLogFilePath()
  return existsSync(logPath) ? readFileSync(logPath).byteLength : 0
}

function probeAgentPath(): string {
  return join(sandbox, "config", "opencode", "agent", PROBE_AGENT_FILENAME)
}

function v2ProbeContext() {
  return {
    location: { directory: sandbox, project: { directory: sandbox } },
    tool: {
      transform: async () => undefined,
      list: async () => [],
    },
  }
}

describe("OpenCode V1 regression gate", () => {
  beforeAll(async () => {
    sandbox = mkdtempSync(join(tmpdir(), "omo-v1-gate-"))
    process.env["HOME"] = join(sandbox, "home")
    process.env["XDG_CONFIG_HOME"] = join(sandbox, "config")
    process.env["XDG_DATA_HOME"] = join(sandbox, "data")
    process.env["XDG_CACHE_HOME"] = join(sandbox, "cache")
    process.env["XDG_STATE_HOME"] = join(sandbox, "state")

    const before = logSize()

    // Exactly what an OpenCode 1.x loader does: call `server`, never `setup`.
    const hooks = await pluginModule.server(
      { directory: sandbox, client: {}, serverUrl: new URL("http://127.0.0.1:1") } as never,
      {},
    )
    v1Hooks = hooks as unknown as Record<string, unknown>
    _flushForTesting()
    v1LogSlice = readLogDelta(before)
  }, 60_000)

  afterAll(() => {
    for (const key of HOME_KEYS) {
      const value = originalEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    if (sandbox) rmSync(sandbox, { recursive: true, force: true })
  })

  it("#given the plugin module #when OpenCode 1.x inspects it #then the V1 server export is present and shared with the named export", () => {
    // given
    const definition: Record<string, unknown> = pluginModule

    // then
    expect(typeof definition["server"]).toBe("function")
    expect(omoPlugin).toBe(definition["server"])
    expect(definition["tui"]).toBeUndefined()
  })

  it("#given the V1 entry point #when the server hook runs #then tools and hook handlers are assembled", () => {
    // given
    const tools = v1Hooks["tool"] as Record<string, unknown>

    // then
    expect(typeof tools).toBe("object")
    expect(Object.keys(tools).length).toBeGreaterThan(0)
    expect(typeof v1Hooks["config"]).toBe("function")
    expect(typeof v1Hooks["chat.message"]).toBe("function")
    expect(typeof v1Hooks["tool.execute.before"]).toBe("function")
  })

  it("#given the V1 entry point #when the server hook runs #then the V2 startup notice is never emitted", () => {
    // then
    expect(v1LogSlice).not.toContain(OPENCODE_V2_NOTICE_MESSAGE)
    expect(v1LogSlice).not.toContain("OpenCode 2 support is active")
    expect(v1LogSlice).not.toContain("[opencode-v2] loaded without the V1 runtime")
  })

  it("#given the V1 entry point #when the server hook runs #then no V2 probe runs and no probe agent file is written", () => {
    // then
    expect(v1LogSlice).not.toContain(PROBE_LOG_PREFIX)
    expect(existsSync(probeAgentPath())).toBe(false)
  })

  it("#given the V2 setup entry #when it runs #then the probe does write its agent file (the gate above is not vacuous)", async () => {
    // given
    const before = logSize()

    // when
    await (pluginModule as unknown as { setup: (context: unknown) => Promise<void> }).setup(v2ProbeContext())
    _flushForTesting()

    // then
    const delta = readLogDelta(before)
    expect(delta).toContain(`${PROBE_LOG_PREFIX} setup#`)
    expect(existsSync(probeAgentPath())).toBe(true)
  })
})
