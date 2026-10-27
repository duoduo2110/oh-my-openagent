/**
 * MCP domain projection (S3b).
 *
 * V1 hands the host a `config.mcp` map; V2 has `ctx.mcp.transform(editor)` with
 * `list/get/set/update/remove`. The V1 map is the source of truth here — the four built-ins
 * (`websearch`, `context7`, `grep_app`, `lsp`) are produced by `createBuiltinMcps`, unchanged, and
 * only the *transport shape* changes:
 *
 *   V1 `{ type: "local",  command: string[], enabled, cwd?, environment? }`
 *   V2 `{ type: "local",  command: string[], disabled?, cwd?, environment? }`
 *      -> command/args are passed through byte-for-byte (the `lsp` stdio command must stay identical
 *         to V1 or the daemon resolves a different executable).
 *
 *   V1 `{ type: "remote", url, enabled, headers?, oauth?: false }`
 *   V2 `{ type: "remote", url, disabled?, headers?, oauth?: false }`
 *      -> `enabled` is inverted into V2's `disabled`.
 *
 * A single built-in that cannot be expressed (missing url/command, non-string command entry) is
 * logged and skipped; the remaining servers are still applied.
 */
import type { OhMyOpenCodeConfig } from "../../config"
import { createBuiltinMcps } from "../../mcp"
import { log } from "../../shared/logger"
import {
  CONFIG_DOMAIN_LOG_PREFIX,
  editorGet,
  editorSet,
  errorMessage,
  hashPayload,
  isRecord,
  listDomainNames,
  runTransform,
  stableStringify,
  stringRecord,
} from "./shared"

export const BUILTIN_MCP_NAMES = ["websearch", "context7", "grep_app", "lsp"] as const

export type V2McpServerConfig =
  | {
      readonly type: "local"
      readonly command: readonly string[]
      readonly disabled?: boolean
      readonly cwd?: string
      readonly environment?: Record<string, string>
    }
  | {
      readonly type: "remote"
      readonly url: string
      readonly disabled?: boolean
      readonly headers?: Record<string, string>
      readonly oauth?: false
    }

export type McpConversion =
  | { readonly ok: true; readonly config: V2McpServerConfig }
  | { readonly ok: false; readonly reason: string }

/** Converts one V1 MCP entry; never guesses a transport the source did not declare. */
export function toV2McpConfig(name: string, value: unknown): McpConversion {
  if (!isRecord(value)) return { ok: false, reason: `${name}: entry is not an object` }
  const type = value["type"]
  const disabled = value["enabled"] === false ? true : undefined

  if (type === "local") {
    const command = value["command"]
    if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
      return { ok: false, reason: `${name}: local MCP has no string command array` }
    }
    const cwd = value["cwd"]
    const environment = stringRecord(value["environment"])
    if (value["environment"] !== undefined && environment === undefined) {
      return { ok: false, reason: `${name}: local MCP environment is not a string map` }
    }
    return {
      ok: true,
      config: {
        type: "local",
        command: command as string[],
        ...(disabled === undefined ? {} : { disabled }),
        ...(typeof cwd === "string" ? { cwd } : {}),
        ...(environment === undefined ? {} : { environment }),
      },
    }
  }

  if (type === "remote") {
    const url = value["url"]
    if (typeof url !== "string" || url.length === 0) {
      return { ok: false, reason: `${name}: remote MCP has no url` }
    }
    const headers = stringRecord(value["headers"])
    if (value["headers"] !== undefined && headers === undefined) {
      return { ok: false, reason: `${name}: remote MCP headers is not a string map` }
    }
    return {
      ok: true,
      config: {
        type: "remote",
        url,
        ...(disabled === undefined ? {} : { disabled }),
        ...(headers === undefined ? {} : { headers }),
        ...(value["oauth"] === false ? { oauth: false as const } : {}),
      },
    }
  }

  return { ok: false, reason: `${name}: unsupported transport ${String(type)}` }
}

export type McpDomainReport = {
  readonly available: boolean
  readonly expected: readonly string[]
  readonly applied: readonly string[]
  readonly unchanged: readonly string[]
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>
  readonly listed: readonly string[]
  readonly hash: string
}

export type ApplyMcpDomainArgs = {
  readonly context: unknown
  readonly directory: string
  readonly pluginConfig: Partial<OhMyOpenCodeConfig>
  readonly disabledMcps: readonly string[]
}

export async function applyMcpDomain(args: ApplyMcpDomainArgs): Promise<McpDomainReport> {
  // Same call the V1 `mcp-config-handler` makes, with the same arguments: disabled list, plugin
  // config (websearch settings, disabled_tools) and the location directory as `cwd`.
  const v1Mcps = createBuiltinMcps([...args.disabledMcps], args.pluginConfig, { cwd: args.directory })

  const converted: Array<{ readonly name: string; readonly config: V2McpServerConfig }> = []
  const skipped: Array<{ readonly name: string; readonly reason: string }> = []
  for (const name of Object.keys(v1Mcps).sort()) {
    const result = toV2McpConfig(name, v1Mcps[name as keyof typeof v1Mcps])
    if (result.ok) {
      converted.push({ name, config: result.config })
      continue
    }
    skipped.push({ name, reason: result.reason })
    log(`${CONFIG_DOMAIN_LOG_PREFIX} mcp skipped`, { name, reason: result.reason })
  }

  const applied: string[] = []
  const unchanged: string[] = []
  const failed: Array<{ readonly name: string; readonly reason: string }> = []

  const transform = await runTransform(readMcpDomain(args.context), (editor) => {
    for (const entry of converted) {
      try {
        const existing = editorGet(editor, entry.name)
        if (existing !== undefined && stableStringify(existing) === stableStringify(entry.config)) {
          unchanged.push(entry.name)
          continue
        }
        editorSet(editor, entry.name, entry.config)
        applied.push(entry.name)
      } catch (error) {
        // One bad server must not take the others down.
        const reason = errorMessage(error)
        failed.push({ name: entry.name, reason })
        log(`${CONFIG_DOMAIN_LOG_PREFIX} mcp failed`, { name: entry.name, reason })
        console.error(`${CONFIG_DOMAIN_LOG_PREFIX} mcp failed: ${entry.name} (${reason})`)
      }
    }
    // Logged from inside the callback: the host may invoke it long after `transform()` resolves, so
    // this is the only place where the applied/unchanged counts are guaranteed to be complete.
    log(`${CONFIG_DOMAIN_LOG_PREFIX} mcp callback`, {
      applied: [...applied],
      unchanged: [...unchanged],
      failed,
    })
  })

  if (!transform.registered) {
    log(`${CONFIG_DOMAIN_LOG_PREFIX} mcp domain unavailable`, { reason: transform.error })
  }

  const listed = await listDomainNames(readMcpDomain(args.context))
  const hash = hashPayload(converted.map((entry) => [entry.name, entry.config]))
  log(`${CONFIG_DOMAIN_LOG_PREFIX} mcp`, {
    available: transform.registered,
    invoked: transform.invoked,
    expected: converted.map((entry) => entry.name),
    applied,
    unchanged,
    skipped,
    failed,
    listed,
    hash,
  })

  return {
    available: transform.registered,
    expected: converted.map((entry) => entry.name),
    applied,
    unchanged,
    skipped: [...skipped, ...failed],
    listed,
    hash,
  }
}

/** The `mcp` domain itself, for the post-transform `list()` evidence line. */
export function readMcpDomain(context: unknown): unknown {
  return isRecord(context) ? context["mcp"] : undefined
}
