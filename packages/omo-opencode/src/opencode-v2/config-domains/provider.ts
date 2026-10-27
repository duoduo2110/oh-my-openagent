/**
 * Provider / model / formatter domains (S3b) — deliberately *not* projected.
 *
 * The V1 `config-handler` touches provider state in two places:
 *
 *   1. `applyOpenGatewayProviderConfig(config)` — when `OPENGATEWAY_API_KEY` is present it writes a
 *      `config.provider.opengateway` entry (name, npm, env, baseURL, and a static model catalog).
 *   2. `applyProviderConfig({ config, modelCacheState, ... })` — it only *reads* `config.provider`
 *      to fill two in-memory caches (vision-capable models, per-model context limits) and then
 *      restores `config.formatter` untouched.
 *
 * V2 cannot accept either one without inventing data:
 *   - `ProviderEditor.add()` takes a complete `Provider.Info` plus a full `Model.Info[]`
 *     (capabilities, limits, cost, modalities...). V1 writes *overrides* — name/npm/env/baseURL and
 *     a catalog of model ids — so a V2 `add()` would have to fabricate the missing fields.
 *   - `ModelEditor` edits existing models only; it cannot create a provider.
 *   - There is no formatter domain at all, and V1's net effect on `config.formatter` is "unchanged".
 *
 * So every one of those is reported through the exact `[omo-v2] config domain unsupported: <domain>`
 * line, naming what the host is missing. Reporting is the honest outcome here: a silently dropped
 * projection is how a port starts lying about its own completeness.
 */
import { OPENGATEWAY_ENV_VAR } from "../../features/opengateway-provider"
import { log } from "../../shared/logger"
import { CONFIG_DOMAIN_LOG_PREFIX, hashPayload, logUnsupportedDomain } from "./shared"

export type UnsupportedDomainEntry = {
  readonly domain: string
  readonly reason: string
  readonly v1Source: string
}

export const UNSUPPORTED_CONFIG_DOMAINS = ["provider", "model", "formatter", "agent"] as const

export type UnsupportedDomainReport = {
  readonly domains: readonly UnsupportedDomainEntry[]
  readonly hash: string
}

export type ReportUnsupportedDomainsArgs = {
  readonly env?: NodeJS.ProcessEnv
}

export function reportUnsupportedConfigDomains(
  args: ReportUnsupportedDomainsArgs = {},
): UnsupportedDomainReport {
  const env = args.env ?? process.env
  const openGatewayConfigured = typeof env[OPENGATEWAY_ENV_VAR] === "string" && env[OPENGATEWAY_ENV_VAR] !== ""

  const domains: UnsupportedDomainEntry[] = [
    {
      domain: "provider",
      v1Source: "features/opengateway-provider::applyOpenGatewayProviderConfig + plugin-handlers/provider-config-handler",
      reason:
        "V2 ProviderEditor.add() needs a full Provider.Info + Model.Info inventory, while V1 writes provider overrides"
        + (openGatewayConfigured
          ? `; ${OPENGATEWAY_ENV_VAR} is set, so the V1 side would have added the opengateway provider — not projected`
          : ""),
    },
    {
      domain: "model",
      v1Source: "plugin-handlers/provider-config-handler::applyProviderConfig",
      reason:
        "V1 only fills the vision-capable / context-limit caches by reading the host provider config; "
        + "V2 model.transform can edit existing models but cannot create an unavailable provider",
    },
    {
      domain: "formatter",
      v1Source: "plugin-handlers/config-handler (config.formatter restore)",
      reason: "V2 has no formatter domain, and V1's net effect on config.formatter is 'unchanged'",
    },
    {
      domain: "agent",
      v1Source: "plugin-handlers/agent-config-handler (host config.agent merge)",
      reason:
        "V2 has no agent.add(); user agents come from markdown discovery, so only the built-in ten are "
        + "materialized (S3a) and host-config agent entries are left to the host",
    },
  ]

  for (const entry of domains) logUnsupportedDomain(entry.domain, entry.reason)

  const report: UnsupportedDomainReport = {
    domains,
    hash: hashPayload(domains.map((entry) => [entry.domain, entry.reason])),
  }
  log(`${CONFIG_DOMAIN_LOG_PREFIX} unsupported summary`, {
    domains: domains.map((entry) => entry.domain),
    hash: report.hash,
  })
  return report
}
