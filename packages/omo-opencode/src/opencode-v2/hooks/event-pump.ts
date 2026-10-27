/**
 * Async pump for the V1 `event` hook under OpenCode V2 (S2b-1).
 *
 * V1 handed the plugin an `event({ event })` callback and the host called it. V2 exposes
 * `ctx.event.subscribe({ signal })` as an `AsyncIterable`, so the bridge owns the loop: `setup`
 * must not block on it, and `cleanup` must be able to stop it deterministically.
 *
 * Contract:
 *   - starting never awaits the stream: the loop is a floating promise that resolves in `finally`;
 *   - every event is processed inside its own `try/catch`, so one bad payload cannot kill the pump;
 *   - `stop()` aborts the signal and waits at most `stopTimeoutMs` for the loop to end, so a stream
 *     that ignores the abort can never hang host shutdown;
 *   - counters freeze once `stop()` runs: an event delivered late is ignored, not processed.
 */
import { log } from "../../shared/logger"

export const EVENT_PUMP_LOG_PREFIX = "[omo-v2] hook event pump"

export type EventPumpStats = {
  readonly started: boolean
  readonly stopped: boolean
  readonly processed: number
  readonly errors: number
  readonly types: Readonly<Record<string, number>>
}

export type EventPumpHandle = {
  readonly stats: () => EventPumpStats
  /** Aborts the subscription, waits (bounded) for the loop and returns the frozen counters. */
  readonly stop: () => Promise<EventPumpStats>
}

export type EventPumpOptions = {
  readonly subscribe: (options: { readonly signal: AbortSignal }) => AsyncIterable<unknown>
  readonly onEvent: (event: unknown) => Promise<void> | void
  readonly onError: (error: unknown) => void
  readonly stopTimeoutMs?: number
}

const DEFAULT_STOP_TIMEOUT_MS = 2_000
/** Bounds the per-type map so a long session cannot grow it without limit. */
const MAX_TRACKED_TYPES = 64

export const EMPTY_EVENT_PUMP_STATS: EventPumpStats = {
  started: false,
  stopped: false,
  processed: 0,
  errors: 0,
  types: {},
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function typeOf(event: unknown): string {
  if (typeof event !== "object" || event === null) return "non-object"
  const type = (event as { readonly type?: unknown }).type
  return typeof type === "string" && type.length > 0 ? type : "untyped"
}

function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}

export function startEventPump(options: EventPumpOptions): EventPumpHandle {
  const controller = new AbortController()
  const counts = new Map<string, number>()
  let processed = 0
  let errors = 0
  let started = false
  let stopped = false
  let stopping = false

  const snapshot = (): EventPumpStats => ({
    started,
    stopped,
    processed,
    errors,
    types: Object.fromEntries(counts),
  })

  const record = (event: unknown): void => {
    processed += 1
    const type = typeOf(event)
    const seen = counts.get(type) ?? 0
    if (seen > 0 || counts.size < MAX_TRACKED_TYPES) counts.set(type, seen + 1)
  }

  const loop = (async (): Promise<void> => {
    try {
      const stream = options.subscribe({ signal: controller.signal })
      started = true
      log(`${EVENT_PUMP_LOG_PREFIX} started`)
      for await (const event of stream) {
        if (stopping) break
        record(event)
        try {
          await options.onEvent(event)
        } catch (error) {
          errors += 1
          options.onError(error)
          if (errors <= 3) {
            log(`${EVENT_PUMP_LOG_PREFIX} event failed`, { error: errorMessage(error), errors })
          }
        }
      }
    } catch (error) {
      if (!stopping) {
        errors += 1
        options.onError(error)
        log(`${EVENT_PUMP_LOG_PREFIX} stream failed`, { error: errorMessage(error) })
      }
    } finally {
      stopped = true
      log(`${EVENT_PUMP_LOG_PREFIX} stopped`, { processed, errors, types: Object.fromEntries(counts) })
    }
  })()

  // A rejected loop would surface as an unhandled rejection in the host; the loop above already
  // catches, this is the belt-and-braces guard for a synchronous throw inside the async IIFE.
  loop.catch((error: unknown) => {
    errors += 1
    options.onError(error)
  })

  const stop = async (): Promise<EventPumpStats> => {
    if (!stopping) {
      stopping = true
      controller.abort()
    }
    await Promise.race([loop, delay(options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS)])
    return snapshot()
  }

  return { stats: snapshot, stop }
}
