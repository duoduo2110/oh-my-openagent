/**
 * tools / permission projection (S3b).
 *
 * V1 implements tool and permission switches by mutating the *host* config object:
 * `config.tools = { ... }`, `config.permission = { ... }`, and per-agent `agent.<name>.tools /
 * .permission`. V2 has no `tools`/`permission` domain, so the only place those switches can live is
 * an agent's markdown frontmatter — `tools { tool: boolean }` and
 * `permission { tool: allow|deny|ask }`, which V2.1.4 reads into `Agent.Info.permissions[]` (S3a
 * measured this).
 *
 * Scope rule: **only what the V1 config explicitly specifies** is projected.
 *   - `disabled_tools` (the plugin's own list) applies to every materialized agent as
 *     `tools: { <v2 name>: false }` — V1 removes those tools from registration entirely.
 *   - `agents.<name>.tools` / `agents.<name>.permission` apply to that one agent.
 *   - The V1 handler's *hard-coded* defaults (e.g. `task: "deny"` on librarian, `call_omo_agent`,
 *     `task_*`, `teammate`, `grep_app_*`) are NOT projected: they name V1-only tools that do not
 *     exist on this host, so writing them would be a lie about the V2 tool surface.
 *
 * V2 renamed three tool names relative to V1; the mapping is applied here and recorded in the
 * report so the log shows exactly what was rewritten.
 */
import type { OhMyOpenCodeConfig } from "../../config"

/** V1 tool name -> V2 tool name. Anything absent is passed through unchanged. */
export const V2_TOOL_RENAMES: Readonly<Record<string, string>> = {
  bash: "shell",
  task: "subagent",
  write: "edit",
  edit: "edit",
}

export const V2_PERMISSION_EFFECTS = ["allow", "deny", "ask"] as const
export type V2PermissionEffect = (typeof V2_PERMISSION_EFFECTS)[number]

export type AgentFrontmatterOverlay = {
  readonly tools: Readonly<Record<string, boolean>>
  readonly permission: Readonly<Record<string, V2PermissionEffect>>
  /** `v1: v2` pairs for every name this overlay rewrote. */
  readonly renames: readonly string[]
}

export type AgentToolPermissionOverlay = {
  /** Applies to every built-in agent, from plugin-level switches (`disabled_tools`). */
  readonly global: AgentFrontmatterOverlay
  /** Per-agent switches from explicit `agents.<name>` overrides. */
  readonly perAgent: ReadonlyMap<string, AgentFrontmatterOverlay>
  readonly notes: readonly string[]
}

const EMPTY_OVERLAY: AgentFrontmatterOverlay = { tools: {}, permission: {}, renames: [] }

function isEffect(value: unknown): value is V2PermissionEffect {
  return typeof value === "string" && (V2_PERMISSION_EFFECTS as readonly string[]).includes(value)
}

function emptyOverlay(): { tools: Record<string, boolean>; permission: Record<string, V2PermissionEffect>; renames: string[] } {
  return { tools: {}, permission: {}, renames: [] }
}

function toOverlay(state: ReturnType<typeof emptyOverlay>): AgentFrontmatterOverlay {
  return { tools: state.tools, permission: state.permission, renames: [...new Set(state.renames)].sort() }
}

function applyToolSwitch(
  state: ReturnType<typeof emptyOverlay>,
  name: string,
  value: boolean,
): void {
  const renamed = V2_TOOL_RENAMES[name]
  const v2Name = renamed ?? name
  if (renamed !== undefined && renamed !== name) state.renames.push(`${name}->${renamed}`)
  // An explicit permission for the same action wins over a tools/disabled switch; `flattenPermissions`
  // resolves the remaining conflicts (permission is emitted before tools).
  if (state.tools[v2Name] === undefined) state.tools[v2Name] = value
}

function applyPermissionSwitch(
  state: ReturnType<typeof emptyOverlay>,
  name: string,
  value: V2PermissionEffect,
): void {
  const renamed = V2_TOOL_RENAMES[name]
  const v2Name = renamed ?? name
  if (renamed !== undefined && renamed !== name) state.renames.push(`${name}->${renamed}`)
  state.permission[v2Name] = value
}

export function resolveAgentToolPermissionOverlay(
  pluginConfig: Partial<OhMyOpenCodeConfig>,
): AgentToolPermissionOverlay {
  const notes: string[] = []
  const globalState = emptyOverlay()

  for (const name of pluginConfig.disabled_tools ?? []) {
    if (typeof name !== "string" || name.length === 0) continue
    applyToolSwitch(globalState, name, false)
  }

  const perAgent = new Map<string, AgentFrontmatterOverlay>()
  const overrides = pluginConfig.agents ?? {}
  for (const [agentName, override] of Object.entries(overrides)) {
    if (override === undefined) continue
    const record = override as { tools?: Record<string, boolean>; permission?: Record<string, unknown> }
    const state = emptyOverlay()

    for (const [name, value] of Object.entries(record.tools ?? {})) {
      if (typeof value !== "boolean") {
        notes.push(`${agentName}.tools.${name}: not a boolean, skipped`)
        continue
      }
      applyToolSwitch(state, name, value)
    }

    for (const [name, value] of Object.entries(record.permission ?? {})) {
      if (!isEffect(value)) {
        // Nested V1 permissions (`bash: { "git *": "deny" }`) have no flat V2 equivalent.
        notes.push(`${agentName}.permission.${name}: not allow|deny|ask, skipped`)
        continue
      }
      applyPermissionSwitch(state, name, value)
    }

    const overlay = toOverlay(state)
    if (Object.keys(overlay.tools).length === 0 && Object.keys(overlay.permission).length === 0) continue
    perAgent.set(agentName.toLowerCase(), overlay)
  }

  return { global: toOverlay(globalState), perAgent, notes }
}

/** Overlays that apply to one agent: the plugin-wide switches first, then that agent's own. */
export function overlaysForAgent(
  overlay: AgentToolPermissionOverlay,
  agentName: string,
): readonly AgentFrontmatterOverlay[] {
  const own = overlay.perAgent.get(agentName.toLowerCase())
  return own === undefined ? [overlay.global] : [overlay.global, own]
}

export function mergeOverlays(overlays: readonly AgentFrontmatterOverlay[]): AgentFrontmatterOverlay {
  if (overlays.length === 0) return EMPTY_OVERLAY
  const state = emptyOverlay()
  for (const overlay of overlays) {
    for (const [name, value] of Object.entries(overlay.tools)) state.tools[name] = value
    for (const [name, value] of Object.entries(overlay.permission)) state.permission[name] = value
    for (const rename of overlay.renames) state.renames.push(rename)
  }
  return toOverlay(state)
}

/**
 * Returns a copy of the V1 agent config with the overlay folded into `tools` / `permission`.
 * `renderAgentMarkdown` already flattens both fields, so nothing downstream needs to change.
 */
export function withToolPermissionOverlay<T extends object>(
  config: T,
  overlays: readonly AgentFrontmatterOverlay[],
): T {
  const merged = mergeOverlays(overlays)
  if (Object.keys(merged.tools).length === 0 && Object.keys(merged.permission).length === 0) return config
  const record = config as Record<string, unknown>
  const existingTools = { ...(isStringBooleanRecord(record["tools"]) ? record["tools"] : {}) }
  const existingPermission = { ...(isStringRecord(record["permission"]) ? record["permission"] : {}) }

  // The factory already wrote the V1 name (e.g. `bash`); V2 maps it to `shell` on read, so keeping
  // both would yield two permission rows for one action. Drop the V1 name when the overlay supplies
  // its V2 replacement.
  for (const rename of merged.renames) {
    const [from, to] = rename.split("->")
    if (from === undefined || to === undefined || from === to) continue
    if (merged.tools[to] !== undefined) delete existingTools[from]
    if (merged.permission[to] !== undefined) delete existingPermission[from]
  }

  return {
    ...config,
    tools: { ...existingTools, ...merged.tools },
    permission: { ...existingPermission, ...merged.permission },
  } as T
}

function isStringBooleanRecord(value: unknown): value is Record<string, boolean> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
