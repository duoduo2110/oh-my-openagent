/**
 * OpenCode V2 config-domain projections (S3b).
 *
 * V2 has no global `config` hook. Each surface owns a `transform(editor)` callback, so the V1 config
 * handler's single mutation of `config.mcp / config.command / config.skills` becomes four
 * independent projections here (see the sibling modules):
 *
 *   MCP         config.mcp                    -> ctx.mcp.transform        (set/update)
 *   Command     config.command (templates)    -> ctx.command.transform    (add + execute)
 *   Skill       config.command (skill entries)-> ctx.skill.transform      (add)
 *   tools/perm  config.tools / .permission    -> agent markdown frontmatter (agents.ts)
 *
 * Domains the host cannot accept (provider / model / formatter / host agent merge) are *reported*,
 * never faked: `[omo-v2] config domain unsupported: <domain>` in the plugin log.
 *
 * Isolation and ordering: one domain failing logs and continues; `setup` must never fail because a
 * projection did. Every projection is replay-safe (editor `get()` guard + a per-process payload
 * hash), so a second `setup` for the same location adds nothing twice.
 */
import type { OhMyOpenCodeConfig } from "../config"
import { loadPluginConfig } from "../plugin-config"
import { log } from "../shared/logger"
import type { UnknownRecord } from "./adapter/types"
import { asRecord } from "./adapter/types"
import {
  CONFIG_DOMAIN_LOG_PREFIX,
  DOMAIN_STORAGE_ROOT,
  errorMessage,
  hashPayload,
  persistDomain,
  resetDomainSnapshots,
  storageOf,
} from "./config-domains/shared"
import { resolveAgentToolPermissionOverlay, type AgentToolPermissionOverlay } from "./config-domains/agent-tool-overlay"
import { applyCommandDomain, type CommandDomainReport } from "./config-domains/command"
import { applyMcpDomain, type McpDomainReport } from "./config-domains/mcp"
import { reportUnsupportedConfigDomains, type UnsupportedDomainReport } from "./config-domains/provider"
import { applySkillDomain, type SkillDomainReport } from "./config-domains/skill"

export { resetDomainSnapshots }

export type ConfigDomainToolPermissionReport = {
  readonly globalTools: readonly string[]
  readonly globalDenied: readonly string[]
  readonly perAgent: ReadonlyArray<{ readonly agent: string; readonly tools: readonly string[]; readonly permission: readonly string[] }>
  readonly renames: readonly string[]
  readonly notes: readonly string[]
}

export type ConfigDomainReport = {
  readonly directory: string
  readonly mcp: McpDomainReport | undefined
  readonly command: CommandDomainReport | undefined
  readonly skill: SkillDomainReport | undefined
  readonly unsupported: UnsupportedDomainReport
  readonly toolPermission: ConfigDomainToolPermissionReport
  readonly failures: ReadonlyArray<{ readonly domain: string; readonly reason: string }>
}

function locationDirectoryOf(context: unknown): string {
  const location = asRecord(asRecord(context)?.["location"])
  const directory = location?.["directory"]
  return typeof directory === "string" ? directory : ""
}

function toolPermissionReport(overlay: AgentToolPermissionOverlay): ConfigDomainToolPermissionReport {
  const renames = new Set<string>()
  const collect = (entries: readonly string[]): void => {
    for (const entry of entries) renames.add(entry)
  }
  collect(overlay.global.renames)
  const perAgent = [...overlay.perAgent.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([agent, entry]) => {
      collect(entry.renames)
      return {
        agent,
        tools: Object.keys(entry.tools).sort(),
        permission: Object.keys(entry.permission).sort(),
      }
    })
  return {
    globalTools: Object.keys(overlay.global.tools).sort(),
    globalDenied: Object.entries(overlay.global.tools)
      .filter(([, value]) => value === false)
      .map(([name]) => name)
      .sort(),
    perAgent,
    renames: [...renames].sort(),
    notes: overlay.notes,
  }
}

async function runDomain<T>(
  domain: string,
  failures: Array<{ readonly domain: string; readonly reason: string }>,
  run: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await run()
  } catch (error) {
    const reason = errorMessage(error)
    failures.push({ domain, reason })
    log(`${CONFIG_DOMAIN_LOG_PREFIX} ${domain} projection failed`, { domain, reason })
    console.error(`${CONFIG_DOMAIN_LOG_PREFIX} ${domain} projection failed: ${reason}`)
    return undefined
  }
}

export async function applyOpenCodeV2ConfigDomains(context: unknown): Promise<ConfigDomainReport> {
  const directory = locationDirectoryOf(context)
  const pluginConfig: OhMyOpenCodeConfig = loadPluginConfig(directory, context)
  const storage = storageOf(context)
  const failures: Array<{ readonly domain: string; readonly reason: string }> = []

  const mcp = await runDomain("mcp", failures, () =>
    applyMcpDomain({
      context,
      directory,
      pluginConfig,
      disabledMcps: pluginConfig.disabled_mcps ?? [],
    }),
  )
  const command = await runDomain("command", failures, () =>
    applyCommandDomain({ context, directory, pluginConfig }),
  )
  const skill = await runDomain("skill", failures, () =>
    applySkillDomain({ context, directory, pluginConfig }),
  )

  const unsupported = reportUnsupportedConfigDomains()
  const overlay = resolveAgentToolPermissionOverlay(pluginConfig)
  const toolPermission = toolPermissionReport(overlay)

  log(`${CONFIG_DOMAIN_LOG_PREFIX} tools/permission`, {
    source: "V1 plugin config -> agent markdown frontmatter",
    appliedBy: "materializeOpenCodeV2Agents",
    ...toolPermission,
  })
  for (const note of overlay.notes) log(`${CONFIG_DOMAIN_LOG_PREFIX} tools/permission note`, { note })

  const report: ConfigDomainReport = {
    directory,
    mcp,
    command,
    skill,
    unsupported,
    toolPermission,
    failures,
  }

  for (const [domain, hash] of [
    ["mcp", mcp?.hash],
    ["command", command?.hash],
    ["skill", skill?.hash],
    ["unsupported", unsupported.hash],
    ["tools-permission", hashPayload(toolPermission)],
  ] as const) {
    if (hash === undefined) continue
    const payload: UnknownRecord = {
      domain,
      hash,
      directory,
      appliedAt: new Date().toISOString(),
      storageRoot: DOMAIN_STORAGE_ROOT,
    }
    await persistDomain(storage, domain, payload)
  }

  log(`${CONFIG_DOMAIN_LOG_PREFIX} summary`, {
    directory,
    mcp: mcp === undefined ? null : { expected: mcp.expected, applied: mcp.applied, unchanged: mcp.unchanged, listed: mcp.listed },
    command: command === undefined ? null : { expected: command.expected, added: command.added, listed: command.listed },
    skill:
      skill === undefined
        ? null
        : { discovered: skill.discovered, expected: skill.expected.length, added: skill.added.length, listed: skill.listed.length },
    unsupported: unsupported.domains.map((entry) => entry.domain),
    toolPermission,
    failures,
  })

  return report
}
