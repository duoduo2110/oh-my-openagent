/**
 * V2 hook disable list (Gate 2 followup 3).
 *
 * The V2 client shim answers `session.messages` with empty `parts`, `session.todo` with `[]` and
 * `session.status` with a bare "running" (`./adapter/client-shim`). A V1 hook that reads those
 * values does not notice the gap: it keeps running on fabricated state and acts on it (rewrites a
 * transcript, injects a compaction prompt, re-prompts a session because "no todo is done"). That is
 * worse than not running the hook at all, so those hooks are switched off at *assembly* through the
 * V1 `disabled_hooks` config gate (`create-plugin-module` -> `isHookEnabled`): the factory is never
 * called, so there is no handler to fire and no fabricated state to read.
 *
 * Names are the real ones from `src/config/schema/hooks.ts` (`HookNameSchema`); the file:line next
 * to each default is the place that reads the shimmed client:
 *
 *   claude-code-hooks            hooks/claude-code-hooks/transcript.ts (session.messages)
 *                                hooks/claude-code-hooks/handlers/tool-execute-after-handler.ts
 *   compaction-context-injector  hooks/compaction-context-injector/session-prompt-config-resolver.ts
 *   preemptive-compaction        hooks/preemptive-compaction-no-text-tail.ts (session.messages)
 *   compaction-todo-preserver    hooks/compaction-todo-preserver/hook.ts (session.todo)
 *   todo-continuation-enforcer   hooks/todo-continuation-enforcer/idle-event.ts (session.todo)
 *   session-notification         hooks/session-todo-status.ts (session.todo)
 *
 * Overriding:
 *   - `OMO_V2_DISABLED_HOOKS` (comma separated) and/or the user's own `disabled_hooks` in
 *     `omo.jsonc` add names on top of the defaults;
 *   - `-<name>` (or `!<name>`) re-enables a default;
 *   - `*` disables every hook in `HookNameSchema`.
 */

import { HookNameSchema } from "../../config/schema/hooks"

export const DISABLED_HOOKS_ENV = "OMO_V2_DISABLED_HOOKS"
export const DISABLE_ALL_HOOKS = "*"
export const DISABLED_HOOKS_LOG_PREFIX = "[omo-v2] hooks disabled"

export type DefaultDisabledHook = {
  readonly hook: string
  /** Where the hook reads the shimmed V2 client; this is why it is off by default. */
  readonly evidence: string
}

export const DEFAULT_DISABLED_HOOKS: readonly DefaultDisabledHook[] = [
  { hook: "claude-code-hooks", evidence: "claude-code-hooks/transcript.ts: session.messages" },
  { hook: "compaction-context-injector", evidence: "compaction-context-injector/session-prompt-config-resolver.ts: session.messages" },
  { hook: "preemptive-compaction", evidence: "preemptive-compaction-no-text-tail.ts: session.messages" },
  { hook: "compaction-todo-preserver", evidence: "compaction-todo-preserver/hook.ts: session.todo" },
  { hook: "todo-continuation-enforcer", evidence: "todo-continuation-enforcer/idle-event.ts: session.todo" },
  { hook: "session-notification", evidence: "session-todo-status.ts: session.todo" },
]

export type DisabledHookState = {
  /** Hook names to hand to `disabled_hooks`; always a subset of `HookNameSchema`. */
  readonly hooks: readonly string[]
  /** `*` was requested: every known hook is listed in `hooks`. */
  readonly all: boolean
  /** Entries above that are not in `HookNameSchema` (typos stay visible instead of silent). */
  readonly unknown: readonly string[]
  /** Default names switched back on with `-<name>` / `!<name>`. */
  readonly reenabled: readonly string[]
}

export type ResolveDisabledHooksInput = {
  readonly env?: NodeJS.ProcessEnv
  /** The user's own `disabled_hooks`; `-<name>` entries re-enable a V2 default. */
  readonly configDisabledHooks?: readonly string[]
}

const KNOWN_HOOKS: readonly string[] = HookNameSchema.options

function splitEntries(value: string | undefined): string[] {
  if (typeof value !== "string") return []
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/**
 * Defaults are always the base: the env var and the config add to them (`-<name>` removes one), so
 * an operator cannot silently re-enable a hook that must not read the shim by setting an unrelated
 * value. `*` is the only entry that replaces the base set entirely.
 */
export function resolveDisabledHooks(input: ResolveDisabledHooksInput = {}): DisabledHookState {
  const requested = [
    ...DEFAULT_DISABLED_HOOKS.map((entry) => entry.hook),
    ...(input.configDisabledHooks ?? []),
    ...splitEntries(input.env?.[DISABLED_HOOKS_ENV]),
  ]

  const known = new Set(KNOWN_HOOKS)
  const disabled = new Set<string>()
  const unknown = new Set<string>()
  const reenabled = new Set<string>()
  let all = false

  for (const raw of requested) {
    if (raw === DISABLE_ALL_HOOKS) {
      all = true
      continue
    }
    const negated = raw.startsWith("-") || raw.startsWith("!")
    const name = (negated ? raw.slice(1) : raw).trim()
    if (name.length === 0) continue
    if (negated) {
      if (name === DISABLE_ALL_HOOKS) {
        all = false
        continue
      }
      if (known.has(name)) {
        disabled.delete(name)
        reenabled.add(name)
      }
      continue
    }
    if (!known.has(name)) {
      unknown.add(name)
      continue
    }
    disabled.add(name)
  }

  if (all) {
    for (const name of KNOWN_HOOKS) disabled.add(name)
  }

  return {
    hooks: [...disabled].sort(),
    all,
    unknown: [...unknown].sort(),
    reenabled: [...reenabled].sort(),
  }
}

/** The exact one-line evidence an operator greps for: `[omo-v2] hooks disabled: a,b`. */
export function formatDisabledHooks(state: { readonly hooks: readonly string[] }): string {
  return state.hooks.length === 0 ? "<none>" : state.hooks.join(",")
}

/**
 * Merges the V2 list into a V1 config. The user's own entries are kept as they are: V1 already
 * honours them, and `-<name>` is a V2-only marker that V1 would ignore anyway.
 */
export function applyDisabledHooks<T extends { readonly disabled_hooks?: readonly string[] }>(
  config: T,
  state: DisabledHookState,
): T {
  if (state.hooks.length === 0) return config
  const merged = new Set<string>([...(config.disabled_hooks ?? []), ...state.hooks])
  return { ...config, disabled_hooks: [...merged] }
}
