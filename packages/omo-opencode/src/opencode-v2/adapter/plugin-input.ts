/**
 * Builds the V1-compatible `PluginInput` from the OpenCode V2 setup context (S2a).
 *
 * V1 fields and how they are sourced:
 *
 *   client                  the shim in ./client-shim (V2 domains behind V1 SDK call shapes)
 *   directory               `ctx.location.directory` (S0 verified `/repo` in the e2e host)
 *   worktree / project      `ctx.location.project` (`directory` canonical checkout, `id`)
 *   serverUrl               left undefined on purpose. V2's setup context exposes no server URL,
 *                           and V1 treats an absent URL as "not a serve process" (see
 *                           create-managers.ts), which is exactly the safe default for the port.
 *                           Fabricating one would mark the tmux server as in-process and point it
 *                           at a port nothing listens on.
 *   $                       V1 never touches it on the paths the port runs; a loud missing shim
 *                           keeps that assumption falsifiable instead of silently passing.
 *   experimental_workspace  V2 has no workspace adapter registration; registration is logged.
 */
import type { PluginInput } from "@opencode-ai/plugin"

import { log } from "../../shared/logger"
import { createMissingShim, createV1ClientShim } from "./client-shim"
import type { V2ContextLike } from "./types"

export type PluginInputReport = {
  readonly directory: string
  readonly worktree: string
  readonly projectID: string
  readonly hasServerUrl: boolean
}

export type BuiltPluginInput = {
  readonly input: PluginInput
  readonly report: PluginInputReport
}

export function createV1PluginInput(context: V2ContextLike): BuiltPluginInput {
  const location = context.location
  const directory = location.directory
  if (typeof directory !== "string" || directory.length === 0) {
    throw new Error("[omo-v2] cannot build PluginInput: ctx.location.directory is empty")
  }

  const worktree = location.project.directory ?? directory
  const projectID = location.project.id ?? "omo-v2-project"
  const now = Date.now()

  const input = {
    client: createV1ClientShim({ context, directory }),
    project: {
      id: projectID,
      worktree,
      time: { created: now, updated: now },
    },
    directory,
    worktree,
    experimental_workspace: {
      register: (type: string): void => {
        log("[omo-v2] workspace adapter registration ignored", { type })
      },
    },
    // See the file header: absent by design, not an oversight.
    serverUrl: undefined,
    $: createMissingShim(["$"]),
  } as unknown as PluginInput

  return {
    input,
    report: { directory, worktree, projectID, hasServerUrl: false },
  }
}
