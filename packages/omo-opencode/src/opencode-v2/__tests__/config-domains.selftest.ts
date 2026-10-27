/**
 * S3b self-test. Run inside the Docker dev container:
 *
 *   scripts/v2/docker.sh run bun packages/omo-opencode/src/opencode-v2/__tests__/config-domains.selftest.ts
 *
 * A script (not a `bun test` file) because it drives the real V1 MCP/command/skill builders and the
 * real on-disk `SKILL.md` files. Every assertion mirrors a fact the V2.1.4 host forced on this
 * stage, driven through a fake context whose domains behave like the measured editors
 * (`list/get/set/remove` for mcp and skill, `add` only for command):
 *
 *   - V2 MCP entries use `disabled` where V1 used `enabled`, and the local stdio command array must
 *     stay byte-identical (`lsp`).
 *   - V2 commands are code, not templates: the projection must still deliver the V1 template text.
 *   - V2 skills need a real `path`; every packaged skill must resolve to an existing SKILL.md.
 *   - A second projection pass must add nothing (the host replays `transform`).
 *   - `tools`/`permission` land in agent frontmatter with the V1->V2 tool renames applied.
 *
 * Exits non-zero on the first failing stage, printing what failed.
 */
import * as fs from "node:fs"

import type { OhMyOpenCodeConfig } from "../../config"
import { createBuiltinMcps } from "../../mcp"
import { V2_BUILTIN_COMMAND_NAMES, applyCommandDomain } from "../config-domains/command"
import { applyMcpDomain, toV2McpConfig } from "../config-domains/mcp"
import { reportUnsupportedConfigDomains } from "../config-domains/provider"
import { applySkillDomain } from "../config-domains/skill"
import { resetDomainSnapshots } from "../config-domains/shared"
import {
  resolveAgentToolPermissionOverlay,
  V2_TOOL_RENAMES,
  withToolPermissionOverlay,
} from "../config-domains/agent-tool-overlay"
import { renderAgentMarkdown } from "../agents/agent-markdown"

const failures: string[] = []
let checks = 0

function check(condition: boolean, message: string): void {
  checks += 1
  if (!condition) failures.push(message)
}

function checkEqual<T>(actual: T, expected: T, message: string): void {
  check(
    actual === expected,
    `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`,
  )
}

function note(line: string): void {
  console.log(line)
}

type MapEditor = {
  readonly get: (key: string) => unknown
  readonly set: (key: string, value: unknown) => void
  readonly add: (value: unknown) => void
  readonly remove: (key: string) => void
  readonly list: () => ReadonlyArray<readonly [string, unknown]>
}

/** Commands carry an `execute` function, so a structuredClone would throw: clone data only. */
function cloneIfPlain(value: unknown): unknown {
  try {
    return structuredClone(value)
  } catch {
    return value
  }
}

function makeEditor(): { editor: MapEditor; entries: Map<string, unknown>; writes: string[] } {
  const entries = new Map<string, unknown>()
  const writes: string[] = []
  const editor: MapEditor = {
    get: (key) => entries.get(key),
    set: (key, value) => {
      writes.push(key)
      entries.set(key, cloneIfPlain(value))
    },
    add: (value) => {
      const record = value as { id?: unknown; name?: unknown }
      const key = typeof record.id === "string" ? record.id : String(record.name)
      writes.push(key)
      entries.set(key, cloneIfPlain(value))
    },
    remove: (key) => {
      entries.delete(key)
    },
    list: () => [...entries.entries()],
  }
  return { editor, entries, writes }
}

function makeDomain(editor: MapEditor, options: { readonly withTransform?: boolean } = {}) {
  const domain: Record<string, unknown> = {
    list: async () => ({ location: {}, data: editor.list().map(([name]) => ({ name })) }),
  }
  if (options.withTransform !== false) {
    domain["transform"] = async (callback: (editor: MapEditor) => void) => {
      callback(editor)
      return { dispose: async () => undefined }
    }
  }
  return domain
}

function makeStorage(): { domain: Record<string, unknown>; store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    store,
    domain: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value))
      },
      remove: async (key: string) => {
        store.delete(key)
      },
    },
  }
}

type FakeHost = {
  readonly context: Record<string, unknown>
  readonly mcp: ReturnType<typeof makeEditor>
  readonly command: ReturnType<typeof makeEditor>
  readonly skill: ReturnType<typeof makeEditor>
  readonly prompts: unknown[]
  readonly storage: ReturnType<typeof makeStorage>
}

function makeHost(directory: string): FakeHost {
  const mcp = makeEditor()
  const command = makeEditor()
  const skill = makeEditor()
  const prompts: unknown[] = []
  const storage = makeStorage()
  const context: Record<string, unknown> = {
    location: { directory },
    mcp: makeDomain(mcp.editor),
    command: makeDomain(command.editor),
    skill: makeDomain(skill.editor),
    session: {
      prompt: async (input: unknown) => {
        prompts.push(input)
      },
    },
    storage: storage.domain,
  }
  return { context, mcp, command, skill, prompts, storage }
}

const repoRoot = process.cwd()
const pluginConfig: Partial<OhMyOpenCodeConfig> = {}

// ---------------------------------------------------------------------------------------------
// 1. MCP: transport conversion + V1-identical local command + replay safety.
// ---------------------------------------------------------------------------------------------

const host = makeHost(repoRoot)
const mcpFirst = await applyMcpDomain({ context: host.context, directory: repoRoot, pluginConfig, disabledMcps: [] })
note(`mcp: expected=${mcpFirst.expected.join(",")} applied=${mcpFirst.applied.join(",")} skipped=${mcpFirst.skipped.length}`)
checkEqual(mcpFirst.available, true, "mcp domain transform ran")
check(mcpFirst.expected.includes("context7"), "context7 projected")
check(mcpFirst.expected.includes("grep_app"), "grep_app projected")
check(mcpFirst.expected.includes("lsp"), "lsp projected")
checkEqual(mcpFirst.applied.length, mcpFirst.expected.length, "every built-in MCP was set once")

const v1Mcp = createBuiltinMcps([], pluginConfig, { cwd: repoRoot })
const lspV1 = v1Mcp.lsp as { command: string[]; cwd?: string; environment?: Record<string, string> }
const lspWritten = host.mcp.entries.get("lsp") as {
  type: string
  command: readonly string[]
  cwd?: string
  environment?: Record<string, string>
}
checkEqual(lspWritten.type, "local", "lsp stays a local stdio server")
check(
  JSON.stringify(lspWritten.command) === JSON.stringify(lspV1.command),
  "lsp command array is byte-identical to the V1 createBuiltinMcps output",
)
checkEqual(lspWritten.cwd, lspV1.cwd, "lsp cwd carried over from V1")
check(
  JSON.stringify(lspWritten.environment) === JSON.stringify(lspV1.environment),
  "lsp environment carried over from V1",
)

const remote = toV2McpConfig("grep_app", { type: "remote", url: "https://mcp.grep.app", enabled: true, oauth: false })
check(remote.ok && remote.config.type === "remote" && remote.config["disabled"] === undefined, "enabled:true maps to no `disabled` key")
const disabledRemote = toV2McpConfig("x", { type: "remote", url: "https://x", enabled: false })
check(disabledRemote.ok && disabledRemote.config["disabled"] === true, "enabled:false maps to disabled:true")
const brokenLocal = toV2McpConfig("y", { type: "local", command: [] })
check(!brokenLocal.ok, "a local MCP without a command array is reported, not guessed")

const hostReplay = makeHost(repoRoot)
await applyMcpDomain({ context: hostReplay.context, directory: repoRoot, pluginConfig, disabledMcps: [] })
const writesAfterFirst = hostReplay.mcp.writes.length
resetDomainSnapshots()
const mcpSecond = await applyMcpDomain({ context: hostReplay.context, directory: repoRoot, pluginConfig, disabledMcps: [] })
checkEqual(hostReplay.mcp.writes.length, writesAfterFirst, "second MCP projection writes nothing (editor get() guard)")
checkEqual(mcpSecond.applied.length, 0, "second MCP projection reports no applied entry")
check(mcpSecond.unchanged.length > 0, "second MCP projection reports the entries as unchanged")

const disabledHost = makeHost(repoRoot)
const mcpDisabled = await applyMcpDomain({
  context: disabledHost.context,
  directory: repoRoot,
  pluginConfig: { disabled_mcps: ["grep_app"] },
  disabledMcps: ["grep_app"],
})
check(!mcpDisabled.expected.includes("grep_app"), "disabled_mcps removes the server from the projection")

// ---------------------------------------------------------------------------------------------
// 2. Command: six names, template payload, replay safety.
// ---------------------------------------------------------------------------------------------

resetDomainSnapshots()
const commandHost = makeHost(repoRoot)
const commandReport = await applyCommandDomain({ context: commandHost.context, directory: repoRoot, pluginConfig })
note(`command: added=${commandReport.added.join(",")} skipped=${commandReport.skipped.length}`)
checkEqual(commandReport.expected.length, V2_BUILTIN_COMMAND_NAMES.length, "six builtin commands are projected")
for (const name of V2_BUILTIN_COMMAND_NAMES) {
  check(commandHost.command.entries.has(name), `command ${name} registered on the V2 editor`)
  const definition = commandHost.command.entries.get(name) as { execute?: unknown; description?: unknown }
  check(typeof definition.execute === "function", `command ${name} carries an execute()`)
  check(typeof definition.description === "string", `command ${name} carries a description`)
}

const goal = commandHost.command.entries.get("goal") as { execute: (input: unknown) => Promise<void> }
await goal.execute({ sessionID: "ses_test", prompt: { text: "ship the port" }, delivery: { type: "steer" } })
const prompted = commandHost.prompts[0] as { sessionID: string; prompt: { text: string } }
checkEqual(prompted.sessionID, "ses_test", "execute() prompts the invoking session")
check(prompted.prompt.text.includes("ship the port"), "the user's arguments reach the rendered template")
check(!prompted.prompt.text.includes("$ARGUMENTS"), "the $ARGUMENTS placeholder is substituted")
checkEqual(goal !== undefined, true, "goal execute resolved")

const commandWritesBefore = commandHost.command.writes.length
const commandReplay = await applyCommandDomain({ context: commandHost.context, directory: repoRoot, pluginConfig })
checkEqual(commandHost.command.writes.length, commandWritesBefore, "second command projection adds nothing in this process")
checkEqual(commandReplay.added.length, 0, "second command projection reports no new command")

// ---------------------------------------------------------------------------------------------
// 3. Skill: real paths, packaged skills included, replay safety.
// ---------------------------------------------------------------------------------------------

resetDomainSnapshots()
const skillHost = makeHost(repoRoot)
const skillReport = await applySkillDomain({ context: skillHost.context, directory: repoRoot, pluginConfig })
note(`skill: discovered=${skillReport.discovered} projected=${skillReport.expected.length} added=${skillReport.added.length} skipped=${JSON.stringify(skillReport.skipped.map((entry) => entry.name))}`)
checkEqual(skillReport.available, true, "skill domain transform ran")
check(skillReport.discovered >= 18, `skill discovery found at least the 18 packaged skills (${skillReport.discovered})`)
checkEqual(skillReport.expected.length, skillReport.added.length, "every discovered skill with a file was added")
check(skillReport.expected.includes("dotgrid-reasoning") || skillReport.expected.length > 0, "skill ids are present")

for (const [name, value] of skillHost.skill.entries) {
  const info = value as { path?: unknown; content?: unknown; id?: unknown; name?: unknown }
  check(typeof info.path === "string" && fs.existsSync(info.path), `skill ${name} path exists on disk (${String(info.path)})`)
  check(typeof info.content === "string" && info.content.trim().length > 0, `skill ${name} carries content`)
  checkEqual(info.name, name, `skill ${name} id and name agree`)
}

const skillWritesBefore = skillHost.skill.writes.length
const skillReplay = await applySkillDomain({ context: skillHost.context, directory: repoRoot, pluginConfig })
checkEqual(skillHost.skill.writes.length, skillWritesBefore, "second skill projection adds nothing in this process")
checkEqual(skillReplay.added.length, 0, "second skill projection reports no new skill")

// ---------------------------------------------------------------------------------------------
// 4. tools / permission -> agent frontmatter (V2 tool renames).
// ---------------------------------------------------------------------------------------------

const overlayConfig: Partial<OhMyOpenCodeConfig> = {
  disabled_tools: ["bash", "task"],
  agents: {
    sisyphus: { permission: { bash: "deny", write: "ask" }, tools: { grep: false } },
  },
}
const overlay = resolveAgentToolPermissionOverlay(overlayConfig)
note(`overlay: global=${JSON.stringify(overlay.global)} agent=${JSON.stringify([...overlay.perAgent.keys()])}`)
checkEqual(V2_TOOL_RENAMES["bash"], "shell", "bash renames to shell")
checkEqual(V2_TOOL_RENAMES["task"], "subagent", "task renames to subagent")
checkEqual(overlay.global.tools["shell"], false, "disabled_tools bash becomes tools.shell=false")
checkEqual(overlay.global.tools["subagent"], false, "disabled_tools task becomes tools.subagent=false")
const sisyphusOverlay = overlay.perAgent.get("sisyphus")
check(sisyphusOverlay !== undefined, "explicit sisyphus override becomes an overlay")
checkEqual(sisyphusOverlay?.permission["shell"], "deny", "override bash:deny becomes permission.shell:deny")
checkEqual(sisyphusOverlay?.permission["edit"], "ask", "override write:ask becomes permission.edit:ask")
checkEqual(sisyphusOverlay?.tools["grep"], false, "override tools.grep:false kept")
check(
  (sisyphusOverlay?.renames ?? []).includes("bash->shell"),
  "renames are recorded for the log evidence",
)
check(overlay.perAgent.get("librarian") === undefined, "unconfigured agents get no per-agent overlay")

const mergedConfig = withToolPermissionOverlay(
  { description: "test", mode: "primary", prompt: "body" },
  [overlay.global, sisyphusOverlay === undefined ? overlay.global : sisyphusOverlay],
)
const markdown = renderAgentMarkdown(mergedConfig as never, { name: "sisyphus" })
check(markdown.includes('"shell": deny'), "frontmatter carries permission shell: deny")
check(markdown.includes('"edit": ask'), "frontmatter carries permission edit: ask")
check(markdown.includes('"subagent": deny'), "frontmatter carries the global subagent deny")
note("frontmatter:\n" + markdown.split("---")[1])

// ---------------------------------------------------------------------------------------------
// 5. Domains the host cannot accept are reported, never faked.
// ---------------------------------------------------------------------------------------------

const unsupported = reportUnsupportedConfigDomains({ env: {} })
const domainNames = unsupported.domains.map((entry) => entry.domain).sort()
note(`unsupported: ${domainNames.join(",")}`)
checkEqual(domainNames.join(","), "agent,formatter,model,provider", "provider/model/formatter/agent are reported unsupported")
for (const entry of unsupported.domains) {
  check(entry.reason.length > 20, `unsupported domain ${entry.domain} carries a reason`)
}

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length}/${checks} checks failed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

note(`OK: ${checks} checks passed (mcp=builtin, command=6, skill=discovered, tools/permission frontmatter, unsupported reported)`)
