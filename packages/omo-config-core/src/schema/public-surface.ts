/**
 * The published (external) shape of the omo config surface.
 *
 * The loader in `config.ts` deliberately keeps parsing the retired harness blocks so an existing
 * `omo.json` written before the single-harness convergence still loads and can be migrated. That
 * tolerance must not leak into `assets/omo.schema.json`: the artifact is what editors and agents
 * read as "what this config accepts today", and advertising a harness that no longer ships sends
 * later agents chasing config keys with no runtime behind them (#single-harness).
 *
 * So there are two definitions on purpose:
 *   - `OmoConfigSchema` / `OmoConfigLayerSchema` / `OmoConfigProfileSchema` — internal, tolerant.
 *   - `RETIRED_CONFIG_SURFACES` + `stripRetiredConfigSurfaces()` — external, applied when the
 *     published JSON Schema is generated.
 */

/**
 * Section names removed from the published schema, at every depth (root, profiles.<P>, layers).
 * `[native]`, `[senpi]` and `[codex]` named harnesses that no longer exist; `computer` is the
 * native-only computer-use block, which has no host on the single OpenCode harness.
 */
export const RETIRED_CONFIG_SURFACES: readonly string[] = ["[native]", "[senpi]", "[codex]", "computer"]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Walks a generated JSON Schema and removes the retired sections from every `properties` map,
 * plus any `required` entry naming them. Purely structural: it never touches `definitions` keys
 * that are reached through `$ref` from a surviving property.
 */
export function stripRetiredConfigSurfaces(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map(stripRetiredConfigSurfaces)
  }
  if (!isRecord(node)) {
    return node
  }

  const output: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(node)) {
    if (key === "properties" && isRecord(value)) {
      const kept: Record<string, unknown> = {}
      for (const [propertyName, propertyValue] of Object.entries(value)) {
        if (RETIRED_CONFIG_SURFACES.includes(propertyName)) continue
        kept[propertyName] = stripRetiredConfigSurfaces(propertyValue)
      }
      output[key] = kept
      continue
    }
    if (key === "required" && Array.isArray(value)) {
      const kept = value.filter((entry) => !(typeof entry === "string" && RETIRED_CONFIG_SURFACES.includes(entry)))
      if (kept.length > 0) output[key] = kept
      continue
    }
    output[key] = stripRetiredConfigSurfaces(value)
  }
  return output
}
