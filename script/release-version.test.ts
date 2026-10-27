import { expect, test } from "bun:test"
import { resolveReleaseVersion } from "./release-version.mjs"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

test("the actual metadata step validates before npm reads and forwards channel outputs", () => {
  const root = fileURLToPath(new URL("../", import.meta.url))
  const workflow = Bun.YAML.parse(readFileSync(join(root, ".github/workflows/publish.yml"), "utf8")) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> }
  const run = workflow.jobs["release-metadata"].steps.find((step) => step.name === "Calculate version")?.run
  if (!run) throw new Error("Missing metadata entrypoint")
  const dir = mkdtempSync(join(tmpdir(), "release-version-"))
  try {
    for (const [version, only, tag, valid] of [
      ["5.0.0-beta.63", "true", "beta", false],
      ["5.0.0-beta.63", "false", "beta", true],
    ] as const) {
      const output = join(dir, "output")
      const calls = join(dir, "calls")
      writeFileSync(output, "")
      writeFileSync(calls, "")
      const result = spawnSync("bash", ["-e", "-c", `npm() { printf '%s\\n' "$*" >> "$CALLS"; printf '5.0.0-beta.60\\n'; }\n${run}`], {
        cwd: root, encoding: "utf8", timeout: 10_000,
        env: { ...process.env, RAW_VERSION: version, LAZYCODEX_ONLY: only, PUBLISH_LAZYCODEX: "true", GITHUB_OUTPUT: output, CALLS: calls },
      })
      expect(result.status, result.stderr).toBe(valid ? 0 : 1)
      const metadata = readFileSync(output, "utf8")
      if (valid) {
        expect(metadata).toContain(`version=${version}\n`)
        expect(metadata).toContain(`dist_tag=${tag}\n`)
        expect(readFileSync(calls, "utf8")).toBe(`view other-ai@${tag} version\n`)
      } else {
        expect(metadata).toBe("")
        expect(readFileSync(calls, "utf8")).toBe("")
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})



test("reserved identifier cannot escape the namespace through malformed versions", () => {
  for (const version of ["5.0.0", "5.0.0-beta.1", "5.0.0-beta.1.other", "5.0.0-beta.1.other.0", "5.0.0-beta.1.other.01", "5.0.0-beta.other.1.extra", "05.0.0-other.1", "5.0.0-beta.01.other.1", "5.0.0-latest.other.1"]) {
    expect(() => resolveReleaseVersion(version)).toThrow()
  }
  for (const version of ["5.0.0-other.1", "5.0.0-beta.other.1", "5.0.0-other"]) {
    expect(() => resolveReleaseVersion(version)).toThrow()
  }
})
