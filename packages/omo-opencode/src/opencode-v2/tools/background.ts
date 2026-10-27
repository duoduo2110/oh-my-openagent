/**
 * `background_output` / `background_cancel` on V2 (S1c).
 *
 * Both definitions come from the V1 `createBackgroundTools` factory, handed the C group's
 * `BackgroundManager` and the S4 client shim. What V2 adds is the wait discipline for
 * `background_output`:
 *
 *   - `block: false` answers at once (V1 behaviour, unchanged);
 *   - `block: true` gets a hard deadline of `timeout` (default 60s, capped at 10min) plus 3s of
 *     slack, and answers on `v2ctx.signal` too. Without it, a poll loop that stops making progress
 *     would hold the host call open forever; with it, the model always receives a readable string.
 *
 * A task that does not exist is not an error in V1 — it answers "Task not found: bg_..." — so the
 * unknown-id path is a normal, testable answer rather than a thrown message.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

import { createBackgroundTools } from "../../tools"
import type { GroupCToolDeps } from "./deps-c"
import {
  BACKGROUND_OUTPUT_DEFAULT_TIMEOUT_MS,
  BACKGROUND_OUTPUT_MAX_TIMEOUT_MS,
  guardToolCall,
} from "./guards"

export const BACKGROUND_TOOL_NAMES = ["background_output", "background_cancel"] as const

export function createBackgroundToolsC(deps: GroupCToolDeps): Record<string, ToolDefinition> {
  const tools = createBackgroundTools(deps.backgroundManager, deps.input.client)
  return {
    background_output: guardToolCall(tools.background_output, {
      name: "background_output",
      deadline: {
        timeoutArg: "timeout",
        defaultTimeoutMs: BACKGROUND_OUTPUT_DEFAULT_TIMEOUT_MS,
        maxTimeoutMs: BACKGROUND_OUTPUT_MAX_TIMEOUT_MS,
        // Only a blocking read can wait; `full_session` and the default status read return at once.
        applies: (args) => args["block"] === true,
      },
    }),
    background_cancel: guardToolCall(tools.background_cancel, { name: "background_cancel" }),
  }
}
