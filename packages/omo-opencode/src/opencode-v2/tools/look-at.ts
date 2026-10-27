/**
 * `look_at` on V2 (S1b).
 *
 * Reuses the V1 factory. The tool drives a child session through the V1 SDK surface
 * (`session.get` -> `session.create` -> `session.prompt` -> `session.messages`), all of which the S4
 * shim maps onto `ctx.session.get/create/prompt/context`. So the multimodal sub-session works on V2
 * with the same agent markdown (S3a materialized `multimodal-looker`), and a failure surfaces as the
 * V1 error *string* rather than an exception.
 *
 * Honoured V1 gate: the tool is not registered when `disabled_agents` disables `multimodal-looker`
 * (`createCoreTools` does the same), because then the child agent does not exist.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"

import { MULTIMODAL_LOOKER_AGENT } from "../../tools/look-at/constants"
import { createLookAt } from "../../tools/look-at"
import { log } from "../../shared/logger"
import type { GroupBToolDeps } from "./deps"

export const LOOK_AT_TOOL_NAMES = ["look_at"] as const

export function isLookAtDisabled(deps: GroupBToolDeps): boolean {
  return (deps.pluginConfig.disabled_agents ?? [])
    .some((agent) => agent.toLowerCase() === MULTIMODAL_LOOKER_AGENT)
}

export function createLookAtTools(deps: GroupBToolDeps): Record<string, ToolDefinition> {
  if (isLookAtDisabled(deps)) {
    log("[omo-v2] tool skipped look_at", { reason: `agent ${MULTIMODAL_LOOKER_AGENT} is disabled` })
    return {}
  }
  return { look_at: createLookAt(deps.input) }
}
