/**
 * Command domain projection (S3b).
 *
 * V1 registers commands as *templates* in `config.command`; the host substitutes `$ARGUMENTS`,
 * `$SESSION_ID` and `$TIMESTAMP` and sends the result as the first user message.
 *
 * V2's `CommandEditor` is different: `add({ name, description, execute })`. There is no template
 * field and no `get()`, so a command is pure code. The projection therefore registers an `execute`
 * that renders the *V1 template* (unchanged text, same substitutions) and hands it to
 * `ctx.session.prompt()` for the invoking session — same prompt, different transport.
 *
 * Only the six commands the plugin's schema owns are projected (`goal`, `refactor`, `ulw-execute`,
 * `stop-continuation`, `remove-ai-slops`, `hyperplan`); `handoff` is a code-only command the schema
 * does not list, so it is deliberately left to the V1 host.
 */
import type { OhMyOpenCodeConfig } from "../../config"
import { BuiltinCommandNameSchema } from "../../config/schema/commands"
import { loadBuiltinCommands } from "../../features/builtin-commands"
import { log } from "../../shared/logger"
import { asRecord } from "../adapter/types"
import {
  CONFIG_DOMAIN_LOG_PREFIX,
  alreadyApplied,
  editorAdd,
  editorGet,
  errorMessage,
  hashPayload,
  isRecord,
  listDomainNames,
  markApplied,
  runTransform,
} from "./shared"

/** The six commands `config/schema/commands.ts` owns, in schema order. */
export const V2_BUILTIN_COMMAND_NAMES = BuiltinCommandNameSchema.options

export type CommandTemplateInput = {
  readonly argumentsText: string
  readonly sessionID?: string
  readonly timestamp: string
}

function replaceAll(text: string, needle: string, value: string): string {
  return text.split(needle).join(value)
}

/**
 * Substitutes the three V1 placeholders. A template without `$ARGUMENTS` (the refactor family)
 * gets the user's text appended as a `<user-request>` block instead of being dropped — the V1 host
 * passes those arguments to the model the same way, just implicitly.
 */
export function renderCommandTemplate(template: string, input: CommandTemplateInput): string {
  let rendered = replaceAll(template, "$SESSION_ID", input.sessionID ?? "")
  rendered = replaceAll(rendered, "$TIMESTAMP", input.timestamp)
  rendered = replaceAll(rendered, "$ARGUMENTS", input.argumentsText)
  const hasPlaceholder = template.includes("$ARGUMENTS") || template.includes("$SESSION_ID")
  const extra = input.argumentsText.trim()
  if (!hasPlaceholder && extra.length > 0) {
    rendered = `${rendered.replace(/\s+$/, "")}\n\n<user-request>\n${input.argumentsText}\n</user-request>`
  }
  return rendered
}

export type CommandDomainReport = {
  readonly available: boolean
  readonly expected: readonly string[]
  readonly added: readonly string[]
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>
  readonly listed: readonly string[]
  readonly hash: string
}

export type ApplyCommandDomainArgs = {
  readonly context: unknown
  readonly directory: string
  readonly pluginConfig: Partial<OhMyOpenCodeConfig>
}

function resolveSessionPrompter(context: unknown): {
  readonly call: ((input: { sessionID: string; text: string }) => Promise<unknown>) | undefined
} {
  const session = asRecord(context)?.["session"]
  const prompt = asRecord(session)?.["prompt"]
  if (session === undefined || typeof prompt !== "function") return { call: undefined }
  return {
    call: async ({ sessionID, text }) =>
      await (Reflect.apply(prompt, session, [{ sessionID, prompt: { text } }]) as Promise<unknown>),
  }
}

export async function applyCommandDomain(args: ApplyCommandDomainArgs): Promise<CommandDomainReport> {
  const definitions = loadBuiltinCommands(args.pluginConfig.disabled_commands, {
    // The V1 list uses `isAgentRegistered` to pick the ulw-execute agent; the V2 projection never
    // needs the agent name (the template carries it), so keep the deterministic branch.
    useRegisteredAgents: false,
    teamModeEnabled: args.pluginConfig.team_mode?.enabled ?? false,
  })

  const wanted = V2_BUILTIN_COMMAND_NAMES.filter((name) => definitions[name] !== undefined)
  const missing = V2_BUILTIN_COMMAND_NAMES.filter((name) => definitions[name] === undefined)
  for (const name of missing) {
    log(`${CONFIG_DOMAIN_LOG_PREFIX} command disabled`, { name, reason: "disabled_commands" })
  }

  const prompter = resolveSessionPrompter(args.context)
  const added: string[] = []
  const skipped: Array<{ readonly name: string; readonly reason: string }> = []
  const hash = hashPayload(
    wanted.map((name) => [name, (definitions[name] as { template?: unknown }).template ?? ""]),
  )
  const snapshotKey = `command::${args.directory}`

  if (alreadyApplied(snapshotKey, hash)) {
    log(`${CONFIG_DOMAIN_LOG_PREFIX} command reused`, { hash, expected: wanted })
    return {
      available: true,
      expected: wanted,
      added: [],
      skipped: wanted.map((name) => ({ name, reason: "already applied in this process" })),
      listed: await listDomainNames(asRecord(args.context)?.["command"]),
      hash,
    }
  }

  const transform = await runTransform(asRecord(args.context)?.["command"], (editor) => {
    for (const name of wanted) {
      const definition = definitions[name] as { description?: unknown; template?: unknown }
      const template = typeof definition.template === "string" ? definition.template : ""
      const description = typeof definition.description === "string" ? definition.description : undefined
      if (editorGet(editor, name) !== undefined) {
        skipped.push({ name, reason: "already registered" })
        continue
      }
      try {
        editorAdd(editor, {
          name,
          ...(description === undefined ? {} : { description }),
          execute: async (invocation: unknown) => {
            const record = asRecord(invocation) ?? {}
            const prompt = asRecord(record["prompt"])
            const text = typeof prompt?.["text"] === "string" ? prompt["text"] : ""
            const sessionID = typeof record["sessionID"] === "string" ? record["sessionID"] : undefined
            const rendered = renderCommandTemplate(template, {
              argumentsText: text,
              ...(sessionID === undefined ? {} : { sessionID }),
              timestamp: new Date().toISOString(),
            })
            if (prompter.call === undefined) {
              const reason = "ctx.session.prompt is not available; the rendered template was dropped"
              log(`${CONFIG_DOMAIN_LOG_PREFIX} command execute failed`, { name, reason })
              return
            }
            try {
              await prompter.call({ sessionID: sessionID ?? "", text: rendered })
              log(`${CONFIG_DOMAIN_LOG_PREFIX} command executed`, { name, sessionID: sessionID ?? null, length: rendered.length })
            } catch (error) {
              log(`${CONFIG_DOMAIN_LOG_PREFIX} command execute failed`, { name, reason: errorMessage(error) })
            }
          },
        })
        added.push(name)
      } catch (error) {
        const reason = errorMessage(error)
        skipped.push({ name, reason })
        log(`${CONFIG_DOMAIN_LOG_PREFIX} command failed`, { name, reason })
      }
    }
    log(`${CONFIG_DOMAIN_LOG_PREFIX} command callback`, { added: [...added], skipped })
  })

  if (!transform.registered) {
    log(`${CONFIG_DOMAIN_LOG_PREFIX} command domain unavailable`, { reason: transform.error })
  } else {
    markApplied(snapshotKey, hash)
  }
  applyDomainBeforeFirstUse(args.context)

  const listed = await listDomainNames(asRecord(args.context)?.["command"])
  log(`${CONFIG_DOMAIN_LOG_PREFIX} command`, {
    available: transform.registered,
    invoked: transform.invoked,
    expected: wanted,
    added,
    skipped,
    listed,
    hash,
  })

  return { available: transform.registered, expected: wanted, added, skipped, listed, hash }
}

/** Applies the session-prompt availability check once per process (kept for symmetry/log parity). */
function applyDomainBeforeFirstUse(context: unknown): void {
  const prompter = resolveSessionPrompter(context)
  if (prompter.call !== undefined) return
  log(`${CONFIG_DOMAIN_LOG_PREFIX} command execute unavailable`, {
    reason: "ctx.session.prompt is missing; registered commands will no-op when invoked",
  })
}

/** True when the domain exposes `transform()` — used by the report, never to fake success. */
export function commandDomainAvailable(context: unknown): boolean {
  const domain = asRecord(context)?.["command"]
  return isRecord(domain) && typeof domain["transform"] === "function"
}
