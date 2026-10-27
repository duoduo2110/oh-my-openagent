import { describe, expect, it } from "bun:test"

import { renderCommandTemplate, V2_BUILTIN_COMMAND_NAMES } from "./config-domains/command"
import { toV2McpConfig } from "./config-domains/mcp"
import {
  resolveAgentToolPermissionOverlay,
  V2_TOOL_RENAMES,
  withToolPermissionOverlay,
} from "./config-domains/agent-tool-overlay"

describe("S3b MCP domain conversion", () => {
  it("inverts V1 `enabled` into V2 `disabled` for remote servers", () => {
    // given
    const enabled = toV2McpConfig("grep_app", { type: "remote", url: "https://mcp.grep.app", enabled: true, oauth: false })
    const disabled = toV2McpConfig("grep_app", { type: "remote", url: "https://mcp.grep.app", enabled: false })

    // then
    expect(enabled.ok && enabled.config.type).toBe("remote")
    expect(enabled.ok && enabled.config["disabled"]).toBeUndefined()
    expect(disabled.ok && disabled.config["disabled"]).toBe(true)
  })

  it("passes a local stdio command array through unchanged", () => {
    // given
    const command = ["/usr/bin/bun", "run", "lsp", "mcp"]

    // when
    const result = toV2McpConfig("lsp", { type: "local", command, enabled: true, cwd: "/repo" })

    // then
    expect(result.ok).toBe(true)
    expect(JSON.stringify(result.ok ? result.config["command"] : null)).toBe(JSON.stringify(command))
  })

  it("rejects a local entry with no command instead of guessing one", () => {
    // when
    const result = toV2McpConfig("lsp", { type: "local", command: [], enabled: true })

    // then
    expect(result.ok).toBe(false)
  })
})

describe("S3b command templates", () => {
  it("substitutes the V1 placeholders", () => {
    // given
    const template = "<task>$ARGUMENTS</task>\nSession: $SESSION_ID\nAt: $TIMESTAMP"

    // when
    const rendered = renderCommandTemplate(template, {
      argumentsText: "refactor src",
      sessionID: "ses_1",
      timestamp: "2026-01-01T00:00:00.000Z",
    })

    // then
    expect(rendered).toContain("refactor src")
    expect(rendered).toContain("ses_1")
    expect(rendered).not.toContain("$ARGUMENTS")
    expect(rendered).not.toContain("$SESSION_ID")
  })

  it("appends arguments for a template without a placeholder", () => {
    // when
    const rendered = renderCommandTemplate("<command-instruction/>", {
      argumentsText: "only this",
      timestamp: "2026-01-01T00:00:00.000Z",
    })

    // then
    expect(rendered).toContain("<user-request>")
    expect(rendered).toContain("only this")
  })

  it("projects the six commands the config schema owns", () => {
    expect(V2_BUILTIN_COMMAND_NAMES.length).toBe(6)
    expect(V2_BUILTIN_COMMAND_NAMES).toContain("ulw-execute")
  })
})

describe("S3b tools/permission overlay", () => {
  it("renames V1 tool names to the V2 ones", () => {
    expect(V2_TOOL_RENAMES["bash"]).toBe("shell")
    expect(V2_TOOL_RENAMES["task"]).toBe("subagent")
    expect(V2_TOOL_RENAMES["write"]).toBe("edit")
  })

  it("projects only explicitly configured switches", () => {
    // given
    const overlay = resolveAgentToolPermissionOverlay({
      disabled_tools: ["bash"],
      agents: { oracle: { permission: { write: "deny" } } },
    })

    // then
    expect(overlay.global.tools).toEqual({ shell: false })
    expect(overlay.perAgent.get("oracle")?.permission).toEqual({ edit: "deny" })
    expect(overlay.perAgent.get("librarian")).toBeUndefined()
  })

  it("skips nested V1 permissions and reports them as notes", () => {
    // given
    const overlay = resolveAgentToolPermissionOverlay({
      agents: { explorer: { permission: { bash: { "git *": "deny" } } } },
    })

    // then
    expect(overlay.perAgent.get("explorer")).toBeUndefined()
    expect(overlay.notes.some((note) => note.includes("not allow|deny|ask"))).toBe(true)
  })

  it("folds the overlay into the agent config the renderer flattens", () => {
    // given
    const overlay = resolveAgentToolPermissionOverlay({ disabled_tools: ["task"] })

    // when
    const config = withToolPermissionOverlay({ mode: "primary" } as object, [overlay.global])

    // then
    expect((config as { tools?: Record<string, boolean> }).tools).toEqual({ subagent: false })
  })

  it("replaces the factory's V1 tool name instead of writing both", () => {
    // given: the V1 factory already wrote `bash: allow`, and the user config denies bash
    const overlay = resolveAgentToolPermissionOverlay({ agents: { sisyphus: { permission: { bash: "deny" } } } })
    const own = overlay.perAgent.get("sisyphus")

    // when
    const config = withToolPermissionOverlay({ permission: { bash: "allow", grep: "deny" } } as object, [
      own ?? { tools: {}, permission: {}, renames: [] },
    ])

    // then
    expect((config as { permission?: Record<string, string> }).permission).toEqual({
      grep: "deny",
      shell: "deny",
    })
  })
})
