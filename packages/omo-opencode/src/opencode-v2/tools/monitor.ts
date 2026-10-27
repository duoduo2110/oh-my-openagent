/**
 * `monitor_start` / `monitor_stop` / `monitor_list` / `monitor_output` on V2 (S1c).
 *
 * The four V1 factories are reused unchanged through `createMonitorTools`. What matters under V2:
 *
 *   permission   `monitor_start` asks before running a command. V1 calls `ctx.ask()` with
 *                `{ permission: "bash", patterns: [command], always: [command] }`; the bridge maps
 *                that onto `ctx.permission.assert()` (installed by S1b's `setToolBridgePermission`),
 *                so a denial reaches the model as `[ERROR] monitor_start denied: <reason>` — the V1
 *                answer — and never as a silent allow.
 *   feature gate V1 registers these tools only when `monitor.enabled` is true. V2 registers them
 *                always (a tool that vanishes cannot explain itself) and keeps the V1 decision
 *                inside `checkMonitorCommandPermission`, which fails closed with
 *                "monitor feature disabled" while `monitor_list`/`monitor_output` stay answerable.
 *   session      `monitor_list` is built with an empty session id on purpose: the V1 factory then
 *                falls back to the calling `ToolContext.sessionID`, which the bridge fills from the
 *                V2 session, so a session only ever lists its own monitors.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

import type { PluginContext } from "../../plugin/types"
import { createMonitorTools } from "../../tools/monitor"
import type { GroupCToolDeps } from "./deps-c"

export const MONITOR_TOOL_NAMES = [
  "monitor_start",
  "monitor_stop",
  "monitor_list",
  "monitor_output",
] as const

export const MONITOR_REQUIREMENT = "requires monitor.enabled for monitor_start"

export function createMonitorToolsC(deps: GroupCToolDeps): Record<string, ToolDefinition> {
  // `createMonitorTools` only reads `pluginConfig` (for the monitor caps); everything else the
  // tools need arrives per call through the adapted tool context.
  const pluginContext = Object.assign({}, deps.input, {
    pluginConfig: deps.pluginConfig,
  }) as unknown as PluginContext

  return createMonitorTools(deps.monitorManager, pluginContext)
}
