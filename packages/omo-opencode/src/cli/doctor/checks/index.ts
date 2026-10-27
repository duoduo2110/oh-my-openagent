import type { CheckDefinition } from "../framework/types"
import { CHECK_IDS, CHECK_NAMES } from "../framework/constants"
import { checkSystem, gatherSystemInfo } from "./system"
import { checkConfig } from "./config"
import { checkBrowserProvider } from "./browser-provider"
import { checkDeprecatedReasoningKeys } from "./deprecated-reasoning-keys"
import { checkTools, gatherToolsSummary } from "./tools"
import { checkModels } from "./model-resolution"
import { checkTelemetry } from "./telemetry"
import { checkTeamMode } from "./team-mode"
import { checkTuiPluginConfig } from "./tui-plugin-config"
import { gatherEditionDistTags, resolveLatestVersion } from "./latest-version"

export type { CheckDefinition }
export * from "./model-resolution-types"
export { gatherSystemInfo, gatherToolsSummary }
export { gatherEditionDistTags, resolveLatestVersion }

export function getAllCheckDefinitions(): CheckDefinition[] {
  return [
    { id: "browser-provider", name: "Browser Provider", check: checkBrowserProvider },
    {
      id: CHECK_IDS.SYSTEM,
      name: CHECK_NAMES[CHECK_IDS.SYSTEM],
      check: checkSystem,
      critical: true,
    },
    {
      id: CHECK_IDS.CONFIG,
      name: CHECK_NAMES[CHECK_IDS.CONFIG],
      check: checkConfig,
    },
    {
      id: CHECK_IDS.TUI_PLUGIN,
      name: CHECK_NAMES[CHECK_IDS.TUI_PLUGIN],
      check: checkTuiPluginConfig,
    },
    {
      id: "deprecated-reasoning-keys",
      name: "Deprecated Reasoning Keys",
      check: checkDeprecatedReasoningKeys,
    },
    {
      id: CHECK_IDS.TOOLS,
      name: CHECK_NAMES[CHECK_IDS.TOOLS],
      check: checkTools,
    },
    {
      id: CHECK_IDS.MODELS,
      name: CHECK_NAMES[CHECK_IDS.MODELS],
      check: checkModels,
    },
    {
      id: CHECK_IDS.TELEMETRY,
      name: CHECK_NAMES[CHECK_IDS.TELEMETRY],
      check: checkTelemetry,
    },
    {
      id: CHECK_IDS.TEAM_MODE,
      name: CHECK_NAMES[CHECK_IDS.TEAM_MODE],
      check: checkTeamMode,
    },
  ]
}
