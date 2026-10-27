/**
 * Skill domain projection (S3b).
 *
 * V1 exposes skills as slash commands built from the skill's markdown (`config.command`), plus the
 * skill tool's own registry. V2 has a first-class `ctx.skill` domain:
 *
 *   `SkillEditor = { list, get, add({ id, name, description?, autoinvoke?, path, content }), update, remove }`
 *
 * So the projection registers the *same* skills the V1 assembly discovers — the merged list from
 * `createSkillContext` (user/config/project/agents/openCode/shared sources plus the packaged
 * built-ins; 31 entries in the container) — as V2 skills whose `path` points at the real `SKILL.md`
 * on disk. `content` is the skill body the V1 loader already extracted, so the text the model sees
 * is identical between the two harnesses.
 *
 * A skill whose file cannot be found is logged and skipped: V2 derives the skill's base directory
 * from `path`, so a synthesized path would make relative references resolve somewhere that does not
 * exist.
 */
import * as fs from "node:fs"
import * as path from "node:path"

import { sharedSkillsRootPath } from "@oh-my-opencode/shared-skills"

import type { OhMyOpenCodeConfig } from "../../config"
import type { LoadedSkill } from "../../features/opencode-skill-loader/types"
import { createSkillContext } from "../../plugin/skill-context"
import { log } from "../../shared/logger"
import { asRecord } from "../adapter/types"
import {
  CONFIG_DOMAIN_LOG_PREFIX,
  alreadyApplied,
  editorAdd,
  editorGet,
  errorMessage,
  hashPayload,
  markApplied,
  runTransform,
} from "./shared"

export type V2SkillInfo = {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly autoinvoke: boolean
  readonly path: string
  readonly content: string
}

export type SkillProjection = {
  readonly skill: V2SkillInfo
  readonly source: "resolvedPath" | "path" | "sharedSkillsRoot"
}

function isFile(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

function skillFileFrom(base: string): string | undefined {
  if (base.endsWith(".md")) return isFile(base) ? base : undefined
  const joined = path.join(base, "SKILL.md")
  return isFile(joined) ? joined : undefined
}

/** First existing `SKILL.md`, in the order the V1 loader itself resolved the skill. */
export function resolveSkillFile(skill: LoadedSkill): { readonly file: string; readonly source: SkillProjection["source"] } | undefined {
  if (typeof skill.resolvedPath === "string") {
    const file = skillFileFrom(skill.resolvedPath)
    if (file !== undefined) return { file, source: "resolvedPath" }
  }
  if (typeof skill.path === "string") {
    const file = skillFileFrom(skill.path)
    if (file !== undefined) return { file, source: "path" }
  }
  const shared = skillFileFrom(path.join(sharedSkillsRootPath(), skill.name))
  if (shared !== undefined) return { file: shared, source: "sharedSkillsRoot" }
  return undefined
}

function readBody(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8")
  } catch {
    return undefined
  }
}

/** Builds the V2 skill record from a V1 `LoadedSkill`; `undefined` when no real file is behind it. */
export function toV2SkillInfo(skill: LoadedSkill): SkillProjection | undefined {
  const resolved = resolveSkillFile(skill)
  if (resolved === undefined) return undefined

  const template = skill.definition.template
  const body = typeof template === "string" && template.trim().length > 0
    ? template
    : readBody(resolved.file)
  if (body === undefined) return undefined

  const description = typeof skill.definition.description === "string" && skill.definition.description.length > 0
    ? skill.definition.description
    : skill.metadata?.["description"]

  return {
    source: resolved.source,
    skill: {
      id: skill.name,
      name: skill.name,
      ...(description === undefined ? {} : { description }),
      // V1 skills are invoked explicitly (slash command or skill tool); auto-invocation is a V2-only
      // behaviour the V1 config never enabled, so it stays off.
      autoinvoke: false,
      path: resolved.file,
      content: body,
    },
  }
}

export type SkillDomainReport = {
  readonly available: boolean
  readonly discovered: number
  readonly expected: readonly string[]
  readonly added: readonly string[]
  readonly unchanged: readonly string[]
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>
  readonly listed: readonly string[]
  readonly hash: string
}

export type ApplySkillDomainArgs = {
  readonly context: unknown
  readonly directory: string
  readonly pluginConfig: Partial<OhMyOpenCodeConfig>
}

export async function applySkillDomain(args: ApplySkillDomainArgs): Promise<SkillDomainReport> {
  const skillContext = await createSkillContext({
    directory: args.directory,
    pluginConfig: args.pluginConfig as OhMyOpenCodeConfig,
  })

  const projections: SkillProjection[] = []
  const skipped: Array<{ readonly name: string; readonly reason: string }> = []
  for (const skill of skillContext.mergedSkills) {
    const projection = toV2SkillInfo(skill)
    if (projection === undefined) {
      const reason = "no readable SKILL.md behind the skill; V2 needs a real path for its base directory"
      skipped.push({ name: skill.name, reason })
      log(`${CONFIG_DOMAIN_LOG_PREFIX} skill skipped`, { name: skill.name, reason })
      continue
    }
    projections.push(projection)
  }

  const hash = hashPayload(projections.map((entry) => [entry.skill.name, entry.skill.path]))
  const snapshotKey = `skill::${args.directory}`

  if (alreadyApplied(snapshotKey, hash)) {
    log(`${CONFIG_DOMAIN_LOG_PREFIX} skill reused`, { hash, expected: projections.length })
    return {
      available: true,
      discovered: skillContext.mergedSkills.length,
      expected: projections.map((entry) => entry.skill.name),
      added: [],
      unchanged: projections.map((entry) => entry.skill.name),
      skipped,
      listed: await listSkillNames(args.context),
      hash,
    }
  }

  const added: string[] = []
  const unchanged: string[] = []
  const transform = await runTransform(asRecord(args.context)?.["skill"], (editor) => {
    for (const projection of projections) {
      const info = projection.skill
      try {
        if (editorGet(editor, info.id) !== undefined) {
          unchanged.push(info.id)
          continue
        }
        editorAdd(editor, info)
        added.push(info.id)
      } catch (error) {
        const reason = errorMessage(error)
        skipped.push({ name: info.id, reason })
        log(`${CONFIG_DOMAIN_LOG_PREFIX} skill failed`, { name: info.id, reason })
      }
    }
    log(`${CONFIG_DOMAIN_LOG_PREFIX} skill callback`, {
      added: added.length,
      unchanged: unchanged.length,
      skipped,
    })
  })

  if (!transform.registered) {
    log(`${CONFIG_DOMAIN_LOG_PREFIX} skill domain unavailable`, { reason: transform.error })
  } else {
    markApplied(snapshotKey, hash)
  }

  const listed = await listSkillNames(args.context)
  log(`${CONFIG_DOMAIN_LOG_PREFIX} skill`, {
    available: transform.registered,
    invoked: transform.invoked,
    discovered: skillContext.mergedSkills.length,
    expected: projections.length,
    added,
    unchanged,
    skipped,
    listedCount: listed.length,
    hash,
  })

  return {
    available: transform.registered,
    discovered: skillContext.mergedSkills.length,
    expected: projections.map((entry) => entry.skill.name),
    added,
    unchanged,
    skipped,
    listed,
    hash,
  }
}

async function listSkillNames(context: unknown): Promise<string[]> {
  const skill = asRecord(context)?.["skill"]
  const list = asRecord(skill)?.["list"]
  if (skill === undefined || typeof list !== "function") return []
  try {
    const payload = asRecord(await (Reflect.apply(list, skill, []) as Promise<unknown>))
    const data = payload?.["data"]
    if (!Array.isArray(data)) return []
    return data
      .map((entry) => asRecord(entry)?.["name"])
      .filter((name): name is string => typeof name === "string")
      .sort()
  } catch {
    return []
  }
}
