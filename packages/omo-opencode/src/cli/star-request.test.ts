import { describe, expect, test } from "bun:test"
import { STAR_REPOSITORIES, formatGitHubStarCommand, starGitHubRepositories } from "./star-request"

describe("star-request", () => {
  test("formats the legacy GitHub CLI command for manual fallback output", () => {
    // given
    const repository = "code-yeongyu/oh-my-openagent"

    // when
    const command = formatGitHubStarCommand(repository)

    // then
    expect(command).toBe("gh api --silent --method PUT /user/starred/code-yeongyu/oh-my-openagent >/dev/null 2>&1 || true")
  })

  test("stars the plugin repository", async () => {
    // given
    const starred: string[] = []

    // when
    const results = await starGitHubRepositories(async (repository) => {
      starred.push(repository)
    })

    // then
    expect(starred).toEqual(["code-yeongyu/oh-my-openagent"])
    expect(results).toEqual([{ repository: "code-yeongyu/oh-my-openagent", ok: true }])
  })

  test("stars exactly the repositories listed in STAR_REPOSITORIES, in order", async () => {
    // given
    const starred: string[] = []

    // when
    const results = await starGitHubRepositories(async (repository) => {
      starred.push(repository)
    })

    // then
    expect(starred).toEqual([...STAR_REPOSITORIES])
    expect(results).toEqual(STAR_REPOSITORIES.map((repository) => ({ repository, ok: true })))
  })

  test("keeps going when one repository cannot be starred", async () => {
    // given
    // when
    const results = await starGitHubRepositories(async (repository) => {
      if (repository === "code-yeongyu/oh-my-openagent") throw new Error("gh auth missing")
    })

    // then
    expect(results).toEqual([
      { repository: "code-yeongyu/oh-my-openagent", ok: false, error: "gh auth missing" },
    ])
  })
})
