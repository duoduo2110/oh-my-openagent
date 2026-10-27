/**
 * Abort and long-wait guards for the C-group tools (S1c).
 *
 * Two V1 tools can wait a long time by design:
 *
 *   `task` / `call_omo_agent`  block until a child session finishes (sync mode). The V1 poller has
 *                              its own timeout, but nothing under V2 makes it stop when the *host*
 *                              cancels the call, so a user abort would keep the model waiting on a
 *                              result nobody will read.
 *   `background_output`        `block: true` polls the background task until it leaves
 *                              pending/running, up to `timeout` (60s default, 10min max).
 *
 * Both are wrapped here, above the V1 definition, so no V1 file changes:
 *
 *   - `abort` (V1) is the bridge's mapping of `v2ctx.signal` (see `adaptContext`); the first abort
 *     answers with a readable string instead of waiting for the V1 loop.
 *   - a bounded deadline (opt-in per tool, derived from the tool's own `timeout` argument plus a
 *     small slack) answers when the V1 loop somehow fails to return. With `block: true, timeout:
 *     1000`, `background_output` therefore answers in ≤ 4s instead of hanging the host call.
 *
 * The abandoned promise is drained (`void promise.catch(...)`) so losing the race can never surface
 * as an unhandled rejection.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"

import { log } from "../../shared/logger"

export const TOOL_GUARD_LOG_PREFIX = "[omo-v2] tool guard"

/** Extra time beyond the tool's own timeout before the guard stops waiting. */
export const LONG_WAIT_SLACK_MS = 3_000
/** `background_output` floor/ceiling, mirroring the V1 argument contract (60s default, 10min max). */
export const BACKGROUND_OUTPUT_DEFAULT_TIMEOUT_MS = 60_000
export const BACKGROUND_OUTPUT_MAX_TIMEOUT_MS = 600_000

export type DeadlineOptions = {
  /** Argument carrying the wait budget. */
  readonly timeoutArg: string
  readonly defaultTimeoutMs: number
  readonly maxTimeoutMs: number
  /** Only calls that can actually block get a deadline (e.g. `block: true`). */
  readonly applies: (args: Record<string, unknown>) => boolean
}

export type GuardOptions = {
  readonly name: string
  /** Omitted: abort-only (a blocking delegation has no budget of its own). */
  readonly deadline?: DeadlineOptions
}

type ExecuteLike = (args: unknown, context: ToolContext) => Promise<unknown>
type Outcome =
  | { readonly kind: "result"; readonly value: unknown }
  | { readonly kind: "message"; readonly message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function waitBudget(args: Record<string, unknown>, deadline: DeadlineOptions): number {
  const raw = args[deadline.timeoutArg]
  const requested = typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined
  const base = requested ?? deadline.defaultTimeoutMs
  return Math.min(base, deadline.maxTimeoutMs) + LONG_WAIT_SLACK_MS
}

function abortedMessage(toolName: string, elapsedMs: number): string {
  return `Error: ${toolName} was aborted after ${elapsedMs}ms. Nothing is waiting on this call any more; ` +
    "the work it started may still be running, so check its session or background task before retrying."
}

function deadlineMessage(toolName: string, waitMs: number): string {
  return `Error: ${toolName} did not answer within ${waitMs}ms and was released. ` +
    "The task is still running in the background; call again with a longer timeout, or read it with a non-blocking call."
}

/**
 * Wraps one V1 tool so the call answers on abort, and on a bounded deadline when it is configured.
 * The returned tool keeps the V1 description and arguments: only `execute` changes.
 */
export function guardToolCall(definition: ToolDefinition, options: GuardOptions): ToolDefinition {
  const execute = definition.execute as unknown as ExecuteLike

  const guarded = async (rawArgs: unknown, context: ToolContext): Promise<unknown> => {
    const args = isRecord(rawArgs) ? rawArgs : {}
    const startedAt = Date.now()
    const cleanup: Array<() => void> = []
    const outcomes: Array<Promise<Outcome>> = []

    const run: Promise<Outcome> = execute(rawArgs, context).then((value) => ({ kind: "result", value }))

    const signal = context.abort
    if (signal !== undefined) {
      const abortOutcome = new Promise<Outcome>((resolve) => {
        if (signal.aborted) {
          resolve({ kind: "message", message: abortedMessage(options.name, 0) })
          return
        }
        const onAbort = (): void => {
          resolve({ kind: "message", message: abortedMessage(options.name, Date.now() - startedAt) })
        }
        signal.addEventListener("abort", onAbort, { once: true })
        cleanup.push(() => signal.removeEventListener("abort", onAbort))
      })
      outcomes.push(abortOutcome)
    }

    const deadline = options.deadline
    if (deadline !== undefined && deadline.applies(args)) {
      const waitMs = waitBudget(args, deadline)
      const deadlineOutcome = new Promise<Outcome>((resolve) => {
        const timer = setTimeout(() => {
          resolve({ kind: "message", message: deadlineMessage(options.name, waitMs) })
        }, waitMs)
        cleanup.push(() => clearTimeout(timer))
      })
      outcomes.push(deadlineOutcome)
    }

    if (outcomes.length === 0) return run

    try {
      const winner = await Promise.race([run, ...outcomes])
      if (winner.kind === "result") return winner.value
      // The V1 call keeps running on its own timer; drain it so the loser cannot surface as an
      // unhandled rejection, and record why the wait ended in the plugin log.
      void run.catch((error: unknown) => {
        log(`${TOOL_GUARD_LOG_PREFIX} abandoned call settled`, {
          tool: options.name,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      log(`${TOOL_GUARD_LOG_PREFIX} released ${options.name}`, {
        elapsedMs: Date.now() - startedAt,
        message: winner.message,
      })
      return winner.message
    } finally {
      for (const release of cleanup) release()
    }
  }

  return { ...definition, execute: guarded as unknown as ToolDefinition["execute"] }
}
