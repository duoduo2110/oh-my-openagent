import { describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { isUserFacingPath, shippingPolicy } from "./changelog-shipping-policy.mjs"

// The changelog gate's definition of a shipped path (#10841 keeps it unchanged under fragments), checked against
// this repository's real tracked tree and manifests.
const root = fileURLToPath(new URL("..", import.meta.url))
const tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean)
const policy = shippingPolicy(tracked, (path) => readFileSync(join(root, path), "utf8"))
const manifestPolicy = (manifest: Record<string, unknown>) => shippingPolicy(["package.json"], () => JSON.stringify(manifest))

describe("shipped path classifier", () => {
  test.each([
    "packages/omo-opencode/src/tools/delegate-task/categories.ts",
    "packages/omo-opencode/src/testing/create-plugin-module.ts",
    "packages/shared-skills/skills/ulw-research/SKILL.md",
    ".agents/skills/opencode-qa/SKILL.md",
    "bin/oh-my-opencode.js", "postinstall.mjs", "package.json",
    "script/build-binaries.ts", "script/build-cli-node.ts",
    "script/build.ts", "script/qa/strip-ansi.mjs", "script/qa/web-terminal-redaction.mjs",
  ])("requires a note for %s", (path) => {
    expect(tracked).toContain(path)
    expect(isUserFacingPath(path, policy)).toBe(true)
  })
  test.each([
    "packages/isolation-core/src/backends/git-fixture.ts",
    "packages/isolation-core/src/merge/abandoned-concurrent-merge.fixture.ts",
    "packages/isolation-core/src/merge/merge-fixture.ts",
    "packages/omo-opencode/src/testing/module-mock-lifecycle.ts",
    "packages/omo-opencode/src/features/team-mode/test-support/async-test-helpers.ts",
    "scripts/check-third-party-notices.mjs",
    ".github/workflows/ci.yml", "bun.lock",
  ])("does not require a note for %s", (path) => {
    expect(tracked).toContain(path)
    expect(isUserFacingPath(path, policy)).toBe(false)
  })
  test("uses manifest glob, bin and negative entries", () => {
    const packagePolicy = manifestPolicy({ files: ["assets/*.json", "!assets/private.json"], bin: { cli: "launcher.mjs" } })
    expect(isUserFacingPath("assets/runtime.json", packagePolicy)).toBe(true)
    expect(isUserFacingPath("assets/private.json", packagePolicy)).toBe(false)
    expect(isUserFacingPath("launcher.mjs", packagePolicy)).toBe(true)
    expect(isUserFacingPath("unpublished.mjs", packagePolicy)).toBe(false)
  })
})
