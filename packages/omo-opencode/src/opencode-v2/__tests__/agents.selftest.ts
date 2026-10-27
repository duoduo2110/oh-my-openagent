/**
 * S3a self-test. Run inside the Docker dev container:
 *
 *   scripts/v2/docker.sh run bun packages/omo-opencode/src/opencode-v2/__tests__/agents.selftest.ts
 *
 * A script (not a `bun test` file) because it drives the real V1 agent factories and the real
 * filesystem. Every assertion mirrors a fact the V2.1.4 host forced on this stage:
 *
 *   - V2 has no `agent.add()`: only markdown files are discoverable, so the frontmatter must carry
 *     what the host actually reads (`mode`, `model`, `permission`, ...) and nothing it drops.
 *   - `setup` runs again after a host restart, so materialization must be byte-idempotent.
 *   - a disabled agent must lose its file — but never a user-authored file of the same name.
 *
 * Exits non-zero on the first failing stage, printing what failed.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import type { AgentConfig } from "@opencode-ai/sdk"

import { buildBuiltinAgentConfigs, materializeAgentMarkdowns, V2_BUILTIN_AGENT_NAMES } from "../agents"
import {
  globalAgentDirectory,
  projectAgentDirectory,
  resolveAgentScopeDirectory,
  resolveV2AgentScope,
} from "../agents"
import {
  AGENT_GENERATED_COMMENT,
  AGENT_MARKER_PREFIX,
  agentMarkerLine,
  flattenPermissions,
  isManagedAgentMarkdown,
  renderAgentMarkdown,
} from "../agents/agent-markdown"

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

function makeTempDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `omo-v2-agents-${label}-`))
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

function frontmatter(content: string): string[] {
  const lines = content.split("\n")
  if (lines[0] !== "---") return []
  const end = lines.indexOf("---", 1)
  return end === -1 ? [] : lines.slice(1, end)
}

function frontmatterValue(content: string, key: string): string | undefined {
  const line = frontmatter(content).find((entry) => entry.startsWith(`${key}:`))
  return line?.slice(key.length + 1).trim()
}

function tempFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".omo.tmp")) : []
}

// ---------------------------------------------------------------------------------------------
// 1. The ten configs come from the V1 factories, not from a copy.
// ---------------------------------------------------------------------------------------------

const scratch = makeTempDir("build")
const { agents, warnings: buildWarnings } = await buildBuiltinAgentConfigs({
  directory: scratch,
  pluginConfig: {},
})

checkEqual(agents.size, 10, "buildBuiltinAgentConfigs returns ten agents")
checkEqual(
  [...agents.keys()].join(","),
  V2_BUILTIN_AGENT_NAMES.join(","),
  "agent order matches the V1 BuiltinAgentName list",
)
for (const name of V2_BUILTIN_AGENT_NAMES) {
  const config = agents.get(name)
  check(config !== undefined, `${name} has a config`)
  check(typeof config?.prompt === "string" && (config?.prompt.length ?? 0) > 100, `${name} carries a factory prompt`)
  check(typeof config?.description === "string" && (config?.description.length ?? 0) > 10, `${name} carries a description`)
}
checkEqual(agents.get("sisyphus")?.mode, "primary", "sisyphus is primary")
checkEqual(agents.get("hephaestus")?.mode, "primary", "hephaestus is primary")
checkEqual(agents.get("atlas")?.mode, "primary", "atlas is primary")
checkEqual(agents.get("sisyphus-junior")?.mode, "subagent", "sisyphus-junior is a subagent")
checkEqual(agents.get("oracle")?.mode, "subagent", "oracle is a subagent")
note(`build: ${agents.size} agents (${buildWarnings.length} warnings)`)

// ---------------------------------------------------------------------------------------------
// 2. Rendering: only keys V2 actually reads, and the prompt stays the factory prompt.
// ---------------------------------------------------------------------------------------------

const sisyphus = agents.get("sisyphus") as AgentConfig
const rendered = renderAgentMarkdown(sisyphus, { name: "sisyphus", model: "openai/gpt-5", onUnsupported: () => undefined })
const fm = frontmatter(rendered)
check(fm.includes(AGENT_GENERATED_COMMENT), "rendered file carries the generated-by comment")
check(fm.includes(agentMarkerLine("sisyphus")), "rendered file carries the omo-v2-agent marker")
checkEqual(frontmatterValue(rendered, "mode"), "primary", "rendered mode is primary")
checkEqual(frontmatterValue(rendered, "model"), JSON.stringify("openai/gpt-5"), "rendered model is the validated provider/model")
check(fm.some((line) => line === "permission:"), "rendered file carries a permission block")
check(rendered.endsWith("\n"), "rendered file ends with a newline")
check(rendered.includes(String(sisyphus.prompt).trim().slice(-200)), "body is the factory prompt verbatim")

const withoutModel = renderAgentMarkdown(sisyphus, { name: "sisyphus", onUnsupported: () => undefined })
checkEqual(frontmatterValue(withoutModel, "model"), undefined, "no model line when the host cannot serve the model")
checkEqual(frontmatterValue(withoutModel, "variant"), undefined, "no variant line without a model (model-coupled)")
checkEqual(frontmatterValue(withoutModel, "reasoningEffort"), undefined, "no reasoningEffort line without a model")

const unsupported: string[] = []
renderAgentMarkdown(sisyphus, { name: "sisyphus", onUnsupported: (key, reason) => unsupported.push(`${key}: ${reason}`) })
check(unsupported.some((entry) => entry.startsWith("variant:")), "dropping a model-coupled key is reported, not silent")

const nested = flattenPermissions(
  { permission: { bash: { "git *": "deny" }, write: "deny" } } as unknown as AgentConfig,
  (key) => unsupported.push(`nested:${key}`),
)
checkEqual(nested.length, 1, "nested permission maps are dropped, flat ones kept")
checkEqual(nested[0]?.[0], "write", "flat permission key survives")
const fromTools = flattenPermissions({ tools: { grep: false, glob: true } } as unknown as AgentConfig)
checkEqual(JSON.stringify(fromTools), JSON.stringify([["grep", "deny"], ["glob", "allow"]]), "V1 tools booleans become permission effects")

const markerless = "---\ndescription: user file\nmode: subagent\n---\nuser\n"
check(!isManagedAgentMarkdown(markerless, "momus"), "a user-authored file is not treated as ours")
check(isManagedAgentMarkdown(rendered, "sisyphus"), "our own file is recognised")
check(!isManagedAgentMarkdown(rendered, "oracle"), "the marker is per agent name")

// ---------------------------------------------------------------------------------------------
// 3. Writing: explicit project scope, idempotency, atomicity, deletion of disabled agents only.
// ---------------------------------------------------------------------------------------------

const projectDir = makeTempDir("project")
const writes: Array<[string, unknown]> = []
function lastStoredIndex(key: string): number {
  for (let index = writes.length - 1; index >= 0; index -= 1) {
    if (writes[index]?.[0] === key) return index
  }
  return -1
}

const storage = {
  get: async (key: string) => {
    const index = lastStoredIndex(key)
    return index === -1 ? undefined : writes[index]?.[1]
  },
  set: async (key: string, value: unknown) => {
    writes.push([key, value])
  },
  remove: async (key: string) => {
    const index = lastStoredIndex(key)
    if (index !== -1) writes.splice(index, 1)
  },
}

const first = await materializeAgentMarkdowns({
  locationDirectory: projectDir,
  scope: "project",
  agents,
  hostModels: ["openai/gpt-5"],
  storage,
})
const scopeDir = path.join(projectDir, ".opencode", "agent")
checkEqual(first.scope, "project", "explicit project scope is honoured")
checkEqual(first.directory, scopeDir, "project scope writes under <location>/.opencode/agent")
checkEqual(first.written.length, 10, "first pass writes all ten files")
checkEqual(first.skipped.length, 0, "first pass skips nothing")
checkEqual(first.missing.length, 0, "first pass misses nothing")
checkEqual(tempFiles(scopeDir).length, 0, "atomic write leaves no temp files behind")
check(writes.length >= 10, "content hashes are persisted in ctx.storage")
for (const name of V2_BUILTIN_AGENT_NAMES) {
  check(readIfExists(path.join(scopeDir, `${name}.md`)) !== undefined, `${name}.md exists on disk`)
}
const firstBytes = readIfExists(path.join(scopeDir, "sisyphus.md"))
checkEqual(frontmatterValue(firstBytes ?? "", "model"), undefined, "a model outside the host list is not written")

const second = await materializeAgentMarkdowns({
  locationDirectory: projectDir,
  scope: "project",
  agents,
  hostModels: ["openai/gpt-5"],
  storage,
})
checkEqual(second.written.length, 0, "second pass writes nothing")
checkEqual(second.skipped.length, 10, "second pass reports skipped=10")
checkEqual(readIfExists(path.join(scopeDir, "sisyphus.md")), firstBytes, "second pass leaves bytes untouched")
check(second.warnings.some((warning) => warning.includes("not in the host model list")), "unresolvable model is reported")

// A user-authored file with one of our names must survive a disable.
fs.writeFileSync(path.join(scopeDir, "momus.md"), markerless, "utf8")
const disabledPass = await materializeAgentMarkdowns({
  locationDirectory: projectDir,
  scope: "project",
  agents,
  disabled: ["momus"],
  hostModels: ["openai/gpt-5"],
  storage,
})
check(disabledPass.agents.every((entry) => entry.name !== "momus"), "a disabled agent is not materialized")
checkEqual(readIfExists(path.join(scopeDir, "momus.md")), markerless, "a user-authored file is never deleted")

const managedDisable = await materializeAgentMarkdowns({
  locationDirectory: projectDir,
  scope: "project",
  agents,
  disabled: ["metis"],
  hostModels: ["openai/gpt-5"],
  storage,
})
checkEqual(managedDisable.removed.includes("metis"), true, "a generated file is removed when its agent is disabled")
checkEqual(readIfExists(path.join(scopeDir, "metis.md")), undefined, "the generated file is really gone")

// ---------------------------------------------------------------------------------------------
// 4. Scope resolution: global by default, project opt-in, and a loud fallback.
// ---------------------------------------------------------------------------------------------

const scopeHome = makeTempDir("scope-home")
const scopeEnv = { HOME: scopeHome, XDG_CONFIG_HOME: scopeHome }

checkEqual(resolveV2AgentScope({}), "global", "default scope is global (the project dir belongs to the user's repo)")
checkEqual(
  resolveV2AgentScope({ OMO_V2_AGENT_SCOPE: "project" }),
  "project",
  "OMO_V2_AGENT_SCOPE=project opts back in",
)
checkEqual(resolveV2AgentScope({ OMO_V2_AGENT_SCOPE: "global" }), "global", "explicit global stays global")

const defaultResolution = resolveAgentScopeDirectory({ locationDirectory: projectDir, env: scopeEnv })
checkEqual(defaultResolution.scope, "global", "the default resolution picks global")
checkEqual(
  defaultResolution.directory,
  globalAgentDirectory(scopeEnv),
  "global scope resolves to $XDG_CONFIG_HOME/opencode/agent",
)
checkEqual(defaultResolution.warnings.length, 0, "a writable global directory warns about nothing")
check(
  fs.statSync(defaultResolution.directory).isDirectory(),
  "the global agent directory is created on demand",
)

const optInResolution = resolveAgentScopeDirectory({
  locationDirectory: projectDir,
  env: { ...scopeEnv, OMO_V2_AGENT_SCOPE: "project" },
})
checkEqual(optInResolution.scope, "project", "project opt-in resolution picks project")
checkEqual(optInResolution.directory, projectAgentDirectory(projectDir), "project scope resolves next to the location")

// A global directory that cannot be created (XDG_CONFIG_HOME is a regular file) must degrade to
// the project scope with a warning instead of failing setup.
const blockerHome = makeTempDir("scope-blocked")
const blockerFile = path.join(blockerHome, "not-a-directory")
fs.writeFileSync(blockerFile, "occupied", "utf8")
const fallbackResolution = resolveAgentScopeDirectory({
  locationDirectory: projectDir,
  env: { HOME: blockerHome, XDG_CONFIG_HOME: blockerFile },
})
checkEqual(fallbackResolution.scope, "project", "an unusable global directory falls back to project scope")
checkEqual(
  fallbackResolution.directory,
  projectAgentDirectory(projectDir),
  "the fallback writes to the project agent directory",
)
check(
  fallbackResolution.warnings.some((warning) => warning.includes("not writable")),
  "the fallback is reported as a warning",
)
note(`scope: default=${defaultResolution.scope} optIn=${optInResolution.scope} fallback=${fallbackResolution.scope}`)

// ---------------------------------------------------------------------------------------------
// 5. Explicit global scope: XDG_CONFIG_HOME/opencode/agent, same bytes, no location directory.
// ---------------------------------------------------------------------------------------------

const globalHome = makeTempDir("global-home")
const globalPass = await materializeAgentMarkdowns({
  locationDirectory: projectDir,
  scope: "global",
  agents,
  hostModels: ["openai/gpt-5"],
  env: { HOME: globalHome, XDG_CONFIG_HOME: globalHome },
})
const globalDir = path.join(globalHome, "opencode", "agent")
checkEqual(globalPass.directory, globalDir, "global scope writes under $XDG_CONFIG_HOME/opencode/agent")
checkEqual(globalPass.written.length, 10, "global pass writes ten files")
checkEqual(
  readIfExists(path.join(globalDir, "oracle.md")),
  readIfExists(path.join(scopeDir, "oracle.md")),
  "the same agent renders the same bytes in both scopes",
)
check(!path.join(globalDir, "oracle.md").startsWith(projectDir), "global scope never touches the project directory")

// ---------------------------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------------------------

for (const dir of [scratch, projectDir, globalHome, scopeHome, blockerHome]) {
  fs.rmSync(dir, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.error(`\nFAIL: ${failures.length}/${checks} checks failed`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

note(`OK: ${checks} checks passed (agents=10, idempotent, global default + project opt-in, managed-file deletion)`)
