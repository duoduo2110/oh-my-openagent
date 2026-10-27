import { parseVersion } from "../../shared/opencode-version"
import { getConfigContext } from "./config-context"

/**
 * OpenCode 2 hosts are detected by the major version the installer already probed from the
 * `opencode` binary. A null version (binary missing, or a test that never probed) stays on the
 * V1 path on purpose: writing V2-only keys into a 1.x config would silently drop the plugin.
 */
export function isOpenCodeV2Host(version: string | null = getConfigContext().version): boolean {
  if (!version) return false
  return (parseVersion(version)[0] ?? 0) >= 2
}
