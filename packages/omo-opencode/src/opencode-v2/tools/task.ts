/**
 * `task_create` / `task_update` on V2 (S1b).
 *
 * The V1 factories own the task files (atomic write + lock) and are reused as-is. What needs work
 * under V2 is the second half of their contract: "Syncs to OpenCode Todo API after update"
 * (`tools/task/todo-sync.ts`). That helper reads through `ctx.client.session.todo` — the S4 shim,
 * which works — but *writes* through the `opencode/session/todo` virtual module, which V2 does not
 * ship, so the write silently disappears and `session_read(include_todos)` would never show a task.
 *
 * So each execute mirrors its result into the plugin-side session todo store
 * (`adapter/todo-store.ts`) — the same store instance the shim reads, keyed by the same
 * `ctx.storage`. That keeps write and read on one channel and keeps sessions partitioned (the key
 * is `omo-v2/session-todo/<sessionID>`). The merge rule is the one `syncTaskToTodo` uses:
 *
 *   pending/in_progress/completed -> an entry with id + subject + status
 *   deleted                       -> the entry is removed
 *   metadata.priority             -> carried over, default `medium`
 *
 * A read-back or a store write that fails is logged, never thrown: the task file is already
 * written, and a missing todo must not turn a successful create into an error.
 */
import type { ToolDefinition } from "@opencode-ai/plugin"
import type { ToolContext } from "@opencode-ai/plugin/tool"

import { log } from "../../shared/logger"
import { createTaskCreateTool, createTaskUpdateTool } from "../../tools/task"
import type { OhMyOpenCodeConfig } from "../../config"
import type { PluginInput } from "@opencode-ai/plugin"
import { getSessionTodoStore } from "../adapter/todo-store"

export const TASK_WRITE_TOOL_NAMES = ["task_create", "task_update"] as const

const TASK_TODO_LOG_PREFIX = "[omo-v2] task todo"

const PRIORITIES = new Set(["low", "medium", "high"])

type ExecuteLike = (args: unknown, context: ToolContext) => Promise<unknown>

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function textOf(result: unknown): string | undefined {
  if (typeof result === "string") return result
  const record = asRecord(result)
  const output = record?.["output"]
  return typeof output === "string" ? output : undefined
}

function todoStatusOf(status: unknown): string | undefined {
  switch (status) {
    case "in_progress":
      return "in_progress"
    case "completed":
      return "completed"
    case "deleted":
      return undefined
    default:
      return "pending"
  }
}

function priorityOf(metadata: unknown): string {
  const priority = asRecord(metadata)?.["priority"]
  return typeof priority === "string" && PRIORITIES.has(priority) ? priority : "medium"
}

async function mirrorTaskTodo(args: {
  readonly storage: unknown
  readonly sessionID: string
  readonly payload: unknown
}): Promise<boolean> {
  const task = asRecord(asRecord(args.payload)?.["task"])
  const id = typeof task?.["id"] === "string" ? task["id"] : undefined
  const subject = typeof task?.["subject"] === "string" ? task["subject"] : undefined
  if (id === undefined || subject === undefined || args.sessionID.length === 0) return false

  const store = getSessionTodoStore(args.storage)
  const current = await store.read(args.sessionID)
  // Match by id when both sides have one, else by content — `syncTaskToTodo`'s rule.
  const next = current.filter((todo) => (todo.id === undefined ? todo.content !== subject : todo.id !== id))
  const status = todoStatusOf(task?.["status"])
  if (status !== undefined) {
    next.push({ id, content: subject, status, priority: priorityOf(task?.["metadata"]) })
  }
  await store.write(args.sessionID, next)
  return true
}

/**
 * Wraps a V1 task tool so its result also lands in the session todo store that the shim reads.
 * The task file write (the actual business logic) stays entirely inside the V1 tool.
 */
export function withTaskTodoMirror(definition: ToolDefinition, storage: unknown): ToolDefinition {
  const execute = definition.execute as unknown as ExecuteLike
  const mirrored: ExecuteLike = async (args, context) => {
    const result = await execute(args, context)
    const text = textOf(result)
    if (text === undefined) return result
    try {
      const payload: unknown = JSON.parse(text)
      const written = await mirrorTaskTodo({
        storage,
        sessionID: context.sessionID,
        payload,
      })
      if (written) {
        log(`${TASK_TODO_LOG_PREFIX} mirrored`, {
          sessionID: context.sessionID,
          id: asRecord(asRecord(payload)?.["task"])?.["id"],
        })
      }
    } catch (error) {
      log(`${TASK_TODO_LOG_PREFIX} mirror failed`, {
        sessionID: context.sessionID,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return result
  }
  return { ...definition, execute: mirrored as unknown as ToolDefinition["execute"] }
}

/**
 * `experimental.task_system` stays off for the V1 registry, but S1a already registered
 * `task_get`/`task_list` unconditionally and this stage must prove all ten B tools, so the write
 * half is registered too. `disabled_tools` still withholds them, which is the documented V2 way.
 */
export function createTaskWriteTools(args: {
  readonly pluginConfig: Partial<OhMyOpenCodeConfig>
  readonly input: PluginInput
  readonly storage: unknown
}): Record<string, ToolDefinition> {
  return {
    task_create: withTaskTodoMirror(createTaskCreateTool(args.pluginConfig, args.input), args.storage),
    task_update: withTaskTodoMirror(createTaskUpdateTool(args.pluginConfig, args.input), args.storage),
  }
}
