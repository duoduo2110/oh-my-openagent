/**
 * Plugin-side session todo store (S4).
 *
 * OpenCode 2.1.4 has **no** todo API and no todo tool: `SessionApi` exposes no `todo` operation
 * (`session.context`, `session.message.get`, `session.compact`, ...), the host's 26 tools contain no
 * `todowrite`, and `@opencode/schema` only knows an `experimental.todo` boolean flag. The V1 SDK's
 * `session.todo()` therefore has no V2 endpoint to read, and returning a fabricated `[]` made every
 * V1 consumer believe "there is no pending work".
 *
 * The honest replacement is a plugin-owned store keyed per session on `ctx.storage`
 * (`StorageDomain.get/set/remove/scan`, verified in `@opencode/plugin` 2.1.4). It is the single
 * source the shim reads, so reads and writes cannot disagree. Producers:
 *
 *   - a todo-carrying tool invocation (`todowrite` / `todo_write` / `task_create` / `task_update`)
 *     observed by the hook bridge -> `captureToolInput()`;
 *   - a host that does expose a todo domain -> `write()` (the shim prefers the host when present);
 *   - the e2e selftest, which proves the read/write round trip.
 *
 * Without a producer the store stays empty, which is *true* information ("nothing recorded"),
 * unlike a synthesised list. Every backend/state transition is logged once so an operator can see
 * which path is live.
 */
import { log } from "../../shared/logger"
import { asRecord, readArray, readString } from "./types"

export const TODO_STORE_LOG_PREFIX = "[omo-v2] session todo store"
export const TODO_STORAGE_PREFIX = "omo-v2/session-todo/"

export type TodoInfo = {
  readonly id?: string
  readonly content: string
  readonly status: string
  readonly priority: string
}

export type TodoStoreStats = {
  readonly backend: "storage" | "memory"
  readonly reads: number
  readonly writes: number
  readonly errors: number
  readonly captured: number
}

export type SessionTodoStore = {
  readonly read: (sessionID: string) => Promise<TodoInfo[]>
  readonly write: (sessionID: string, todos: readonly TodoInfo[]) => Promise<void>
  /** Folds a tool call's `todos`/`todo` argument into the store; returns false when it had none. */
  readonly captureToolInput: (sessionID: string, tool: string, input: unknown) => Promise<boolean>
  readonly stats: () => TodoStoreStats
  readonly notes: () => readonly string[]
}

const TODO_TOOLS = new Set(["todowrite", "todo_write", "task_create", "task_update"])

function normalizeTodo(value: unknown): TodoInfo | undefined {
  const record = asRecord(value)
  if (record === undefined) return undefined
  const content = readString(record, "content") ?? readString(record, "text") ?? readString(record, "subject")
  if (content === undefined || content.length === 0) return undefined
  const id = readString(record, "id")
  return {
    ...(id === undefined ? {} : { id }),
    content,
    status: readString(record, "status") ?? "pending",
    priority: readString(record, "priority") ?? "medium",
  }
}

function normalizeTodos(value: unknown): TodoInfo[] | undefined {
  const list = Array.isArray(value) ? value : readArray(asRecord(value) ?? {}, "todos")
  if (!Array.isArray(list)) return undefined
  return list
    .map((entry) => normalizeTodo(entry))
    .filter((entry): entry is TodoInfo => entry !== undefined)
}

function isTodo(value: unknown): value is TodoInfo {
  const record = asRecord(value)
  return record !== undefined && typeof record["content"] === "string" && typeof record["status"] === "string"
}

export function createSessionTodoStore(storageInput: unknown): SessionTodoStore {
  const storage = asRecord(storageInput)
  const canStore = typeof storage?.["get"] === "function" && typeof storage?.["set"] === "function"
  const memory = new Map<string, TodoInfo[]>()
  const notes: string[] = []
  let reads = 0
  let writes = 0
  let errors = 0
  let captured = 0
  let announced = false

  const note = (message: string): void => {
    if (!notes.includes(message)) notes.push(message)
  }

  if (!canStore) {
    note("ctx.storage is unavailable: todos live in process memory and do not survive a restart")
    log(TODO_STORE_LOG_PREFIX, { backend: "memory", reason: "no ctx.storage.get/set on this host" })
  } else if (!announced) {
    announced = true
    log(TODO_STORE_LOG_PREFIX, { backend: "storage", prefix: TODO_STORAGE_PREFIX })
  }

  const keyOf = (sessionID: string): string => `${TODO_STORAGE_PREFIX}${sessionID}`

  const readFromStorage = async (sessionID: string): Promise<TodoInfo[] | undefined> => {
    if (!canStore || storage === undefined) return undefined
    const storageGet = storage["get"]
    if (typeof storageGet !== "function") return undefined
    try {
      const value = await Reflect.apply(storageGet, storage, [keyOf(sessionID)])
      const record = asRecord(value)
      const list = record === undefined ? value : readArray(record, "todos")
      if (!Array.isArray(list)) return record === undefined && value === undefined ? undefined : []
      return list.filter(isTodo).map((entry) => ({ ...entry }))
    } catch (error) {
      errors += 1
      note(`storage.get failed: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  const read = async (sessionID: string): Promise<TodoInfo[]> => {
    reads += 1
    const stored = await readFromStorage(sessionID)
    if (stored !== undefined) {
      memory.set(sessionID, stored)
      return stored.map((entry) => ({ ...entry }))
    }
    return (memory.get(sessionID) ?? []).map((entry) => ({ ...entry }))
  }

  const write = async (sessionID: string, todos: readonly TodoInfo[]): Promise<void> => {
    writes += 1
    const snapshot = todos.map((entry) => ({ ...entry }))
    memory.set(sessionID, snapshot)
    if (!canStore || storage === undefined) return
    const storageSet = storage["set"]
    if (typeof storageSet !== "function") return
    try {
      await Reflect.apply(storageSet, storage, [
        keyOf(sessionID),
        { todos: snapshot, updatedAt: new Date().toISOString() },
      ])
    } catch (error) {
      errors += 1
      note(`storage.set failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const captureToolInput = async (
    sessionID: string,
    tool: string,
    input: unknown,
  ): Promise<boolean> => {
    const name = tool.trim().toLowerCase()
    if (!TODO_TOOLS.has(name) || sessionID.length === 0) return false
    const record = asRecord(input)
    const todos = normalizeTodos(record?.["todos"] ?? record?.["todo"])
    if (todos === undefined) return false
    captured += 1
    await write(sessionID, todos)
    log(TODO_STORE_LOG_PREFIX, { captured: true, tool: name, sessionID, count: todos.length })
    return true
  }

  return {
    read,
    write,
    captureToolInput,
    stats: () => ({
      backend: canStore ? "storage" : "memory",
      reads,
      writes,
      errors,
      captured,
    }),
    notes: () => [...notes],
  }
}

/**
 * One store per storage object. The shim and the hook bridge both fold todos into it, and a memory
 * backend (a host without `ctx.storage`) must be the same map in both places or they disagree.
 */
const stores = new WeakMap<object, SessionTodoStore>()

export function getSessionTodoStore(storage: unknown): SessionTodoStore {
  const record = asRecord(storage)
  if (record === undefined) {
    // No object to key on: a per-call store is still correct, it just cannot be shared.
    return createSessionTodoStore(storage)
  }
  const existing = stores.get(record)
  if (existing !== undefined) return existing
  const created = createSessionTodoStore(record)
  stores.set(record, created)
  return created
}
