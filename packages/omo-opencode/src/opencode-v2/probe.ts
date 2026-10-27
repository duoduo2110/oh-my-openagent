/**
 * S0 host probe for the OpenCode V2 port.
 *
 * It exists to falsify three high-risk assumptions with the smallest possible amount of code:
 *
 *   R2  V2 accepts a tool whose `input` is a plain JSON Schema and whose `execute` resolves
 *       an object result (`{ output }`) rather than a bare string.
 *   R7  `setup` runs once per host location (a counter proves how many times it actually ran).
 *   R8  The host runtime exposes Bun globals (`Bun`, `process.versions.bun`).
 *
 * Everything is logged to the regular plugin log so `scripts/v2/docker.sh e2e-s0` can assert on
 * it. The probe is intentionally idempotent: running `setup` again must not duplicate tools or
 * rewrite files that are already correct.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { Context } from "@opencode/plugin/promise/plugin"

import { log } from "../shared/logger"

export const PROBE_TOOL_NAME = "omo_v2_probe"
export const PROBE_AGENT_FILENAME = "omo-v2-probe.md"
export const PROBE_LOG_PREFIX = "[omo-v2-probe]"

export const PROBE_AGENT_MARKDOWN = [
  "---",
  "description: OpenCode V2 host probe agent (S0 evidence only).",
  "mode: subagent",
  "---",
  "",
  "OpenCode V2 host probe agent.",
  "",
].join("\n")

const PROBE_INPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: { echo: { type: "string" } },
  required: ["echo"],
  additionalProperties: false,
}

const PROBE_OUTPUT_SCHEMA: Record<string, unknown> = { type: "string" }

let setupCount = 0
let transformCount = 0

type BunLike = { readonly version?: string }

function readBunGlobal(): BunLike | undefined {
  return (globalThis as { Bun?: BunLike }).Bun
}

function readProcessBunVersion(): string | undefined {
  const versions = process.versions as unknown as Record<string, string | undefined>
  return versions["bun"]
}

function readLocationDirectory(context: Context): string {
  return String(context.location.directory)
}

function resolveAgentFilePath(): string {
  const configHome = process.env["XDG_CONFIG_HOME"]?.trim()
  const base = configHome && configHome.length > 0 ? configHome : path.join(process.env["HOME"] ?? os.homedir(), ".config")
  return path.join(base, "opencode", "agent", PROBE_AGENT_FILENAME)
}

/**
 * Writes the probe agent markdown next to the host's other agent definitions.
 * Returns whether the file had to be written; an identical file is left untouched.
 */
export function ensureProbeAgentFile(): { readonly filePath: string; readonly written: boolean; readonly preExisted: boolean } {
  const filePath = resolveAgentFilePath()
  const preExisted = fs.existsSync(filePath)
  if (preExisted && fs.readFileSync(filePath, "utf8") === PROBE_AGENT_MARKDOWN) {
    return { filePath, written: false, preExisted: true }
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  const temporary = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporary, PROBE_AGENT_MARKDOWN, "utf8")
  fs.renameSync(temporary, filePath)
  return { filePath, written: true, preExisted }
}

function readEcho(input: unknown): string {
  if (typeof input !== "object" || input === null) return ""
  const echo = (input as { echo?: unknown }).echo
  return typeof echo === "string" ? echo : ""
}

async function registerProbeTool(context: Context): Promise<readonly string[]> {
  await context.tool.transform((editor) => {
    transformCount += 1
    if (editor.get(PROBE_TOOL_NAME) === undefined) {
      editor.add({
        name: PROBE_TOOL_NAME,
        description: "OpenCode V2 host probe tool. Echoes its `echo` input as `omo-v2-probe:<echo>`.",
        input: PROBE_INPUT_SCHEMA,
        output: PROBE_OUTPUT_SCHEMA,
        execute: async (input) => ({ output: `omo-v2-probe:${readEcho(input)}` }),
      })
    }
    log(`${PROBE_LOG_PREFIX} tool-transform#${transformCount}`, {
      tools: editor.list().map((tool) => tool.name),
      probePresent: editor.get(PROBE_TOOL_NAME) !== undefined,
    })
  })

  const tools = await context.tool.list()
  return tools.map((tool) => tool.name).sort()
}

export async function runOpenCodeV2Probe(context: Context): Promise<void> {
  setupCount += 1
  const location = readLocationDirectory(context)
  const bun = readBunGlobal()
  const bunVersion = bun?.version
  const bunFromProcess = readProcessBunVersion()
  const agentFile = ensureProbeAgentFile()

  // One line per setup call; `e2e-s0` counts these to settle R7.
  log(`${PROBE_LOG_PREFIX} setup#${setupCount} location=${location}`)
  log(`${PROBE_LOG_PREFIX} detail`, {
    setup: setupCount,
    location,
    locationProject: String(context.location.project.directory),
    bun: {
      typeofBun: typeof bun,
      version: bunVersion ?? null,
      processVersionsBun: bunFromProcess ?? null,
    },
    contextKeys: Object.keys(context).sort(),
    agentFile,
  })

  const tools = await registerProbeTool(context)
  log(`${PROBE_LOG_PREFIX} tools`, { count: tools.length, tools })
}
