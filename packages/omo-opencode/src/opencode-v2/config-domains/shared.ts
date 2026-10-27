/**
 * Shared plumbing for the V2 config-domain projections (S3b).
 *
 * V2 has no global `config` hook. Each surface owns a `transform(editor)` callback that the host may
 * invoke more than once (reload, second `setup` for the same location), so every projection here is:
 *
 *   - idempotent: the editor is read through `get()` before anything is added/set,
 *   - isolated: one entry failing never aborts the domain or the following domains,
 *   - observable: one log line per applied/skipped/failed entry, plus a per-domain summary.
 *
 * The editor is reached structurally (`asRecord` + `Reflect.apply`) exactly like `hooks.ts` does:
 * the released host package types are not part of this plugin's build graph.
 */
import * as crypto from "node:crypto"

import { log } from "../../shared/logger"
import { asRecord, type UnknownRecord } from "../adapter/types"

export const CONFIG_DOMAIN_LOG_PREFIX = "[omo-v2] config domain"

/** The exact line the acceptance gate greps for a domain this host cannot accept. */
export function unsupportedDomainLine(domain: string): string {
  return `${CONFIG_DOMAIN_LOG_PREFIX} unsupported: ${domain}`
}

/**
 * Records a domain the V2 host has no writable surface for. Never throws and never pretends the
 * projection happened: the line goes to the plugin log and to stderr so an operator sees it even
 * when only the host's own output is being watched.
 */
export function logUnsupportedDomain(domain: string, reason: string): void {
  const line = unsupportedDomainLine(domain)
  log(line, { domain, reason })
  console.error(`${line} (${reason})`)
}

/** Deterministic JSON: object keys sorted, so equal payloads always hash equally. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const record = value as UnknownRecord
  const keys = Object.keys(record).sort()
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`
}

export function hashPayload(value: unknown): string {
  return crypto.createHash("sha256").update(stableStringify(value), "utf8").digest("hex").slice(0, 16)
}

/** Structural access to a domain method; `undefined` when the host does not expose it. */
export function domainMethod(domain: unknown, method: string): Function | undefined {
  const fn = asRecord(domain)?.[method]
  return typeof fn === "function" ? fn : undefined
}

export async function callDomainMethod(domain: unknown, method: string, input?: unknown): Promise<unknown> {
  const fn = domainMethod(domain, method)
  if (fn === undefined) {
    throw new Error(`${CONFIG_DOMAIN_LOG_PREFIX}: domain method ${method}() is not available on this host`)
  }
  const args = input === undefined ? [] : [input]
  return await (Reflect.apply(fn, domain, args) as Promise<unknown>)
}

/**
 * Runs `callback` inside the domain's transform.
 *
 * The host only *registers* the callback: it runs it later (often right after the returned promise
 * resolves, sometimes after a `list()`). Waiting for the first invocation is what makes the
 * applied/unchanged/skipped counts in the report truthful instead of always zero.
 */
export async function runTransform(
  domain: unknown,
  callback: (editor: unknown) => void,
  options: { readonly waitMs?: number } = {},
): Promise<{ readonly registered: boolean; readonly invoked: boolean; readonly error?: string }> {
  const transform = domainMethod(domain, "transform")
  if (transform === undefined) return { registered: false, invoked: false, error: "transform() is not available" }

  let invocations = 0
  let markInvoked: (() => void) | undefined
  const invoked = new Promise<void>((resolve) => {
    markInvoked = resolve
  })
  const wrapped = (editor: unknown): void => {
    try {
      callback(editor)
    } finally {
      invocations += 1
      markInvoked?.()
    }
  }

  try {
    await (Reflect.apply(transform, domain, [wrapped]) as Promise<unknown>)
  } catch (error) {
    return { registered: false, invoked: false, error: error instanceof Error ? error.message : String(error) }
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    invoked,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, options.waitMs ?? 2000)
    }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  return { registered: true, invoked: invocations > 0 }
}

export function editorGet(editor: unknown, key: string): unknown {
  const fn = domainMethod(editor, "get")
  if (fn === undefined) return undefined
  return Reflect.apply(fn, editor, [key])
}

export function editorAdd(editor: unknown, value: unknown): void {
  const fn = domainMethod(editor, "add")
  if (fn === undefined) throw new Error(`${CONFIG_DOMAIN_LOG_PREFIX}: editor.add() is not available`)
  Reflect.apply(fn, editor, [value])
}

export function editorSet(editor: unknown, key: string, value: unknown): void {
  const fn = domainMethod(editor, "set")
  if (fn === undefined) throw new Error(`${CONFIG_DOMAIN_LOG_PREFIX}: editor.set() is not available`)
  Reflect.apply(fn, editor, [key, value])
}

/** Entries the host lists, normalised to `{ name }` records (the editors' own `list()` or the API). */
export function listedNames(value: unknown): string[] {
  const payload = asRecord(value)?.["data"] ?? value
  if (!Array.isArray(payload)) return []
  const names: string[] = []
  for (const entry of payload) {
    if (typeof entry === "string") {
      names.push(entry)
      continue
    }
    const record = asRecord(entry)
    const name = record?.["name"]
    if (typeof name === "string" && name.length > 0) names.push(name)
  }
  return names.sort()
}

/** `list()` on a domain, both the bare-array and `{ data }` shapes. Some domains want an input. */
export async function listDomainNames(domain: unknown): Promise<string[]> {
  const list = domainMethod(domain, "list")
  if (list === undefined) return []
  for (const args of [[], [{}]] as const) {
    try {
      const payload = await (Reflect.apply(list, domain, [...args]) as Promise<unknown>)
      const names = listedNames(payload)
      if (names.length > 0) return names
    } catch {
      // try the next call shape; a host that rejects the argument list is not fatal here
    }
  }
  return []
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Module-level snapshot: one hash per `location::domain`, reset only by a process restart. */
const appliedSnapshots = new Map<string, string>()

export function alreadyApplied(key: string, hash: string): boolean {
  return appliedSnapshots.get(key) === hash
}

export function markApplied(key: string, hash: string): void {
  appliedSnapshots.set(key, hash)
}

/** Test hook: forget every snapshot so a selftest can replay a first `setup`. */
export function resetDomainSnapshots(): void {
  appliedSnapshots.clear()
}

/** `ctx.storage` is optional on some hosts; every call degrades to "no persisted evidence". */
export type ConfigDomainStorage = {
  readonly get: (key: string) => Promise<unknown>
  readonly set: (key: string, value: unknown) => Promise<void>
}

export function storageOf(context: unknown): ConfigDomainStorage | undefined {
  const storage = asRecord(context)?.["storage"]
  const get = domainMethod(storage, "get")
  const set = domainMethod(storage, "set")
  if (storage === undefined || get === undefined || set === undefined) return undefined
  return {
    get: (key) => Reflect.apply(get, storage, [key]) as Promise<unknown>,
    set: (key, value) => Reflect.apply(set, storage, [key, value]) as Promise<void>,
  }
}

export const DOMAIN_STORAGE_ROOT = "v2-config-domains"

export async function readStoredHash(
  storage: ConfigDomainStorage | undefined,
  domain: string,
): Promise<string | undefined> {
  if (storage === undefined) return undefined
  try {
    const stored = asRecord(await storage.get(`${DOMAIN_STORAGE_ROOT}/${domain}`))
    const hash = stored?.["hash"]
    return typeof hash === "string" ? hash : undefined
  } catch {
    return undefined
  }
}

export async function persistDomain(
  storage: ConfigDomainStorage | undefined,
  domain: string,
  payload: UnknownRecord,
): Promise<void> {
  if (storage === undefined) return
  try {
    await storage.set(`${DOMAIN_STORAGE_ROOT}/${domain}`, payload)
  } catch (error) {
    log(`${CONFIG_DOMAIN_LOG_PREFIX} storage`, { domain, error: errorMessage(error) })
  }
}

export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined
    result[key] = entry
  }
  return result
}
