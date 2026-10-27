/**
 * Structural views over the OpenCode V2 setup context (S2a).
 *
 * The V1 engine reads a `PluginInput` (`client`, `directory`, `worktree`, `project`, `serverUrl`,
 * `$`). V2 hands the plugin a `Context` with domains (`session`, `agent`, `model`, ...) instead of
 * an SDK client. These types are deliberately structural and narrow: the adapter only needs the
 * location plus a handful of domain objects, and keeping them loose means this file never has to
 * track the host package's private type graph.
 */

export type UnknownRecord = Record<string, unknown>

export type V2LocationLike = {
  readonly directory: string
  readonly workspaceID?: string
  readonly project: {
    readonly id?: string
    readonly directory?: string
    readonly canonical?: string
  }
}

export type V2ContextLike = {
  readonly location: V2LocationLike
  readonly session?: object
  readonly agent?: object
  readonly model?: object
  readonly provider?: object
  readonly skill?: object
  readonly worktree?: object
  readonly app?: object
}

export function asRecord(value: unknown): UnknownRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as UnknownRecord
}

export function readRecord(source: unknown, key: string): UnknownRecord | undefined {
  return asRecord(asRecord(source)?.[key])
}

export function readString(source: unknown, key: string): string | undefined {
  const value = asRecord(source)?.[key]
  return typeof value === "string" ? value : undefined
}

export function readNumber(source: unknown, key: string): number | undefined {
  const value = asRecord(source)?.[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

export function readArray(source: unknown, key: string): readonly unknown[] | undefined {
  const value = asRecord(source)?.[key]
  return Array.isArray(value) ? value : undefined
}

/**
 * Calls a V2 domain method. `Reflect.apply` keeps the receiver intact without widening the domain
 * to an index signature, which a concrete host interface cannot satisfy.
 */
export async function callDomain(domain: unknown, method: string, input?: unknown): Promise<unknown> {
  const receiver = asRecord(domain)
  const fn = receiver?.[method]
  if (typeof fn !== "function") {
    throw new Error(`[omo-v2] V2 domain method ${method} is not available on this host`)
  }
  const args = input === undefined ? [] : [input]
  return await (Reflect.apply(fn, receiver, args) as Promise<unknown>)
}

/**
 * V2 methods answer with the bare payload; a few wrap it as `{ data }` (list endpoints). V1 code
 * expects the `{ data }` envelope, so both shapes are normalised to the payload here.
 */
export function unwrapData(value: unknown): unknown {
  const record = asRecord(value)
  if (record !== undefined && "data" in record) return record["data"]
  return value
}

/** Drops undefined entries so a V2 call never receives `{ limit: undefined }`. */
export function compactInput(values: UnknownRecord): UnknownRecord {
  const out: UnknownRecord = {}
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value
  }
  return out
}
