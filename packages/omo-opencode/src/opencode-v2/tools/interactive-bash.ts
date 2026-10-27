/**
 * `interactive_bash` on V2 (S1b).
 *
 * The V1 tool definition (description + args + executor) is reused; only the tmux availability
 * check is made explicit. V1 gates the *registration* on `isInteractiveBashEnabled()` (tmux on
 * PATH), which would silently hide the tool on a host without tmux — and a model that never sees
 * `interactive_bash` cannot tell whether the capability is missing or the command was wrong.
 *
 * So under V2 the tool is always registered and a missing tmux is answered with an error *string*
 * (never an exception), which is what the task spec asks for. The registration is announced with
 * `requires tmux` so an operator sees the dependency in the plugin log.
 */
import type { ToolDefinition } from "@opencode-ai/plugin/tool"

import { interactive_bash } from "../../tools/interactive-bash"
import { getTmuxPath } from "../../tools/interactive-bash/tmux-path-resolver"
import { log } from "../../shared/logger"

export const INTERACTIVE_BASH_TOOL_NAMES = ["interactive_bash"] as const
export const INTERACTIVE_BASH_REQUIREMENT = "requires tmux"

export const TMUX_MISSING_MESSAGE = `Error: ${INTERACTIVE_BASH_REQUIREMENT}, and this host has no tmux binary on PATH.

interactive_bash drives a real terminal session through tmux; without it there is nothing to drive.
Install tmux (apt-get install -y tmux) and restart OpenCode so the tool can find it, or use the Bash
tool for one-shot commands — they do not need a terminal. Do not retry interactive_bash until tmux is
available.`

type ExecuteLike = (args: { tmux_command: string }, context: Parameters<typeof interactive_bash.execute>[1]) => Promise<unknown>

export function createInteractiveBashTool(): ToolDefinition {
  const execute = interactive_bash.execute as unknown as ExecuteLike
  const guarded: ExecuteLike = async (args, context) => {
    const tmuxPath = await getTmuxPath()
    if (tmuxPath === null || tmuxPath.length === 0) {
      log("[omo-v2] interactive_bash unavailable", { reason: "tmux missing", command: args.tmux_command })
      return TMUX_MISSING_MESSAGE
    }
    return execute(args, context)
  }
  return { ...interactive_bash, execute: guarded as unknown as ToolDefinition["execute"] }
}
