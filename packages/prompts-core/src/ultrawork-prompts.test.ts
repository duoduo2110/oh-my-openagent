import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { ultraworkPromptVariants } from "./index"

describe("ultrawork prompt variants", () => {
  test("#given package surface #when inspected #then the ultrawork variants are exported", () => {
    // given

    // when
    const ultraworkVariantNames = Object.keys(ultraworkPromptVariants)

    // then
    expect(ultraworkVariantNames).toEqual(["planner", "gpt", "gemini", "glm", "default"])
  })
})
