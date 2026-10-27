/**
 * `session_list` / `session_read` / `session_search` / `session_info` on V2 (S1b).
 *
 * The V1 factories are reused untouched. Their storage layer (`tools/session-manager/storage.ts`)
 * already prefers the SDK when `isSqliteBackend()` is true, and under V2 the SDK client is the S4
 * shim: `session.list` -> `ctx.session.list`, `session.messages` -> `ctx.session.context` rebuilt
 * into `{info, parts}`, `session.get` -> `ctx.session.get`, `session.todo` -> the plugin todo store.
 * So the only wiring left here is handing the factories a `PluginInput` whose `client` is that shim.
 *
 * One honest caveat: the SDK path is gated on `isSqliteBackend()`, which the V2 container satisfies
 * (an `opencode` binary on PATH >= 1.1.53 plus `~/.local/share/opencode/opencode.db`). On a host
 * without the SQLite backend the same factories fall back to the legacy JSON files, which V2 does
 * not write — that is reported by the factory itself (`Session not found`), not hidden here.
 */
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"

import { createSessionManagerTools } from "../../tools/session-manager"
import { setStorageClient } from "../../tools/session-manager/storage"

export const SESSION_TOOL_NAMES = [
  "session_list",
  "session_read",
  "session_search",
  "session_info",
] as const

type ExecuteLike = (args: unknown, context: ToolContext) => Promise<unknown>

/**
 * `tools/session-manager` keeps the SDK client module-global, and the S2a runtime assembles its own
 * `createSessionManagerTools` right after this registration. Whichever assembly ran last would own
 * the client, so each call pins this registration's shim first: the tools must read through *this*
 * location's context no matter what ran after them.
 */
function withPinnedStorageClient(definition: ToolDefinition, input: PluginInput): ToolDefinition {
  const execute = definition.execute as unknown as ExecuteLike
  const pinned: ExecuteLike = async (args, context) => {
    setStorageClient(input.client)
    return execute(args, context)
  }
  return { ...definition, execute: pinned as unknown as ToolDefinition["execute"] }
}

export function createSessionTools(input: PluginInput): Record<string, ToolDefinition> {
  const tools = createSessionManagerTools(input)
  const pinned: Record<string, ToolDefinition> = {}
  for (const [name, definition] of Object.entries(tools)) {
    pinned[name] = withPinnedStorageClient(definition, input)
  }
  return pinned
}
