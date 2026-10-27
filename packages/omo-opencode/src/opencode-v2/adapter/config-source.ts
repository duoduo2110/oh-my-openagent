/**
 * V1 `config.get()` on OpenCode V2 (S4).
 *
 * The V2 setup `Context` has no config domain: `@opencode/plugin` 2.1.4 exposes `app`
 * (`{ name, version, channel }`), `agent`, `model`, `provider`, `skill`, `storage`, `rpc`, ... but no
 * `config`, while the client's `ConfigApi` is only reachable through a server the plugin does not
 * have. Answering `{}` made V1 fall back on built-in defaults (skill sources, formatters, default
 * model), so the module rebuilds the merged shape from sources that really exist:
 *
 *   1. `ctx.model.default()`      -> `model: "<providerID>/<modelID>"`
 *   2. `ctx.provider.list()`      -> `provider: { [id]: { id, name, models } }`
 *   3. `ctx.agent.list()`         -> `agent: { [name]: { description, mode, model } }`
 *   4. `ctx.skill.list()`         -> `skill` inventory (used by `app.skills`, not the V1 config)
 *   5. the config files the host itself reads (`opencode.json[c]` in the project, then the global
 *      config dir) -> every other key (`formatter`, `skills`, `experimental`, ...)
 *
 * Disk values come first and live values win, so a stale project file cannot override what the host
 * actually resolved. The snapshot is cached per directory: `config.get()` is called from tool
 * execution paths, not once per session.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"

import { log } from "../../shared/logger"
import { getOpenCodeConfigDir } from "../../shared/opencode-config-dir"
import { readJsoncFile } from "../../shared/jsonc-parser"
import { asRecord, callDomain, readRecord, readString, unwrapData, type UnknownRecord } from "./types"

export const CONFIG_SOURCE_LOG_PREFIX = "[omo-v2] config.get source"

export type ConfigSnapshot = {
  readonly config: UnknownRecord
  readonly sources: readonly string[]
  readonly notes: readonly string[]
}

const CONFIG_FILES = ["opencode.jsonc", "opencode.json"] as const

function readFirstConfig(dir: string): { config: UnknownRecord; file?: string } {
  for (const name of CONFIG_FILES) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const parsed = readJsoncFile<unknown>(path)
    const record = asRecord(parsed)
    if (record !== undefined) return { config: record, file: path }
  }
  return { config: {} }
}

/** Project config, then the walk-up `.opencode/` variant, then the user-level config dir. */
function readDiskConfig(directory: string): { config: UnknownRecord; sources: string[] } {
  const sources: string[] = []
  let config: UnknownRecord = {}

  const globalDir = ((): string | undefined => {
    try {
      return getOpenCodeConfigDir({ binary: "opencode" })
    } catch {
      return undefined
    }
  })()

  const candidates = [
    globalDir,
    join(directory, ".opencode"),
    directory,
  ].filter((value): value is string => typeof value === "string" && value.length > 0)

  // Lowest precedence first: the user config is the base, the project config refines it.
  for (const dir of candidates.reverse()) {
    const read = readFirstConfig(dir)
    if (read.file !== undefined) {
      sources.push(read.file)
      config = { ...config, ...read.config }
    }
  }

  return { config, sources }
}

function providerModelsOf(entry: UnknownRecord): UnknownRecord {
  const models = entry["models"]
  const out: UnknownRecord = {}
  if (models instanceof Map) {
    for (const [id, model] of models) out[String(id)] = { id: String(id), ...(asRecord(model) ?? {}) }
    return out
  }
  const record = asRecord(models)
  if (record === undefined) return out
  for (const [id, model] of Object.entries(record)) {
    out[id] = { id, ...(asRecord(model) ?? {}) }
  }
  return out
}

async function collectLive(modelInput: {
  readonly model?: object
  readonly provider?: object
  readonly agent?: object
}, notes: string[]): Promise<UnknownRecord> {
  const live: UnknownRecord = {}

  if (modelInput.model !== undefined) {
    try {
      const payload = unwrapData(await callDomain(modelInput.model, "default"))
      const record = asRecord(payload) ?? asRecord(asRecord(payload)?.["data"])
      const providerID = readString(record, "providerID")
      const modelID = readString(record, "id") ?? readString(record, "modelID")
      if (providerID !== undefined && modelID !== undefined) live["model"] = `${providerID}/${modelID}`
    } catch (error) {
      notes.push(`model.default failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (modelInput.provider !== undefined) {
    try {
      const payload = unwrapData(await callDomain(modelInput.provider, "list"))
      const list = Array.isArray(payload) ? payload : []
      const providers: UnknownRecord = {}
      for (const entry of list) {
        const record = asRecord(entry) ?? {}
        const info = readRecord(record, "provider") ?? record
        const id = readString(info, "id") ?? readString(record, "id")
        if (id === undefined) continue
        providers[id] = {
          id,
          name: readString(info, "name") ?? id,
          models: providerModelsOf(record),
        }
      }
      if (Object.keys(providers).length > 0) live["provider"] = providers
    } catch (error) {
      notes.push(`provider.list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  if (modelInput.agent !== undefined) {
    try {
      const payload = unwrapData(await callDomain(modelInput.agent, "list"))
      const list = Array.isArray(payload) ? payload : []
      const agents: UnknownRecord = {}
      for (const entry of list) {
        const record = asRecord(entry) ?? {}
        const name = readString(record, "name") ?? readString(record, "id")
        if (name === undefined) continue
        const model = readRecord(record, "model")
        const providerID = readString(model, "providerID")
        const modelID = readString(model, "id") ?? readString(model, "modelID")
        agents[name] = {
          ...(readString(record, "description") === undefined ? {} : { description: readString(record, "description") }),
          ...(readString(record, "mode") === undefined ? {} : { mode: readString(record, "mode") }),
          ...(providerID === undefined || modelID === undefined ? {} : { model: `${providerID}/${modelID}` }),
        }
      }
      if (Object.keys(agents).length > 0) live["agent"] = agents
    } catch (error) {
      notes.push(`agent.list failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return live
}

export type ConfigSourceOptions = {
  readonly directory: string
  readonly model?: object
  readonly provider?: object
  readonly agent?: object
}

/**
 * Builds the snapshot once per directory. A rejected promise is not cached, so a transient host
 * error does not pin `{}` for the rest of the process.
 */
export async function readV1ConfigSnapshot(options: ConfigSourceOptions): Promise<ConfigSnapshot> {
  const disk = readDiskConfig(options.directory)
  const notes: string[] = []
  const live = await collectLive(options, notes)
  const config: UnknownRecord = { ...disk.config, ...live }

  if (Object.keys(config).length === 0) {
    notes.push("no live V2 config domain and no opencode.json[c] found; V1 will use its own defaults")
  }

  return { config, sources: disk.sources, notes }
}

export function createConfigCache(): {
  readonly get: (options: ConfigSourceOptions) => Promise<ConfigSnapshot>
  readonly invalidate: () => void
} {
  const cache = new Map<string, ConfigSnapshot>()
  let announced = false

  return {
    get: async (options) => {
      const cached = cache.get(options.directory)
      if (cached !== undefined) return cached
      const snapshot = await readV1ConfigSnapshot(options)
      cache.set(options.directory, snapshot)
      if (!announced) {
        announced = true
        log(CONFIG_SOURCE_LOG_PREFIX, {
          directory: options.directory,
          sources: snapshot.sources,
          keys: Object.keys(snapshot.config).sort(),
          notes: snapshot.notes,
        })
      }
      return snapshot
    },
    invalidate: () => cache.clear(),
  }
}
