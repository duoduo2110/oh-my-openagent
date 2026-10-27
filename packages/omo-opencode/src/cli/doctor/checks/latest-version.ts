import { extractChannel } from "../../../hooks/auto-update-checker"
import { fetchNpmDistTags, type NpmDistTags } from "../../config-manager/npm-dist-tags"
import { EDITION_PACKAGE_NAMES } from "../framework/constants"
import type { SystemInfo } from "../framework/types"

export type FetchDistTags = (packageName: string) => Promise<NpmDistTags | null>

export interface LatestVersionInput {
  systemInfo: SystemInfo
  distTags: NpmDistTags | null
}

export function gatherEditionDistTags(
  fetchDistTags: FetchDistTags = fetchNpmDistTags
): Promise<NpmDistTags | null> {
  return fetchDistTags(EDITION_PACKAGE_NAMES.opencode)
}

function resolveInstalledVersion(input: LatestVersionInput): string | null {
  return input.systemInfo.pluginVersion
}

export function resolveLatestVersion(input: LatestVersionInput): string | null {
  if (!input.distTags) return null
  const channel = extractChannel(resolveInstalledVersion(input))
  return input.distTags[channel] ?? input.distTags.latest ?? null
}
