/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Context } from "@opencode/plugin/tui/plugin"

import type { SidebarView } from "../../features/tui-sidebar/state-types"
import { opencodeV2Tui, readTuiSidebarView, showOpenCodeV2Notice } from "../tui-entry"
import { registerTuiSidebar } from "../tui-sidebar"
import { toSidebarTheme } from "../tui-theme"
import { collectTexts, createFakeHost, fakeTheme } from "./tui-fake-host"

const ACTIVE_VIEW: SidebarView = {
  kind: "active",
  loop: {
    kind: "live",
    goalsDone: 2,
    goalsTotal: 5,
    pass: 3,
    fail: 1,
    pending: 2,
    blocked: 0,
    activeGoal: "ship the port",
  },
  agents: { kind: "list", agents: [{ name: "oracle", status: "running" }] },
  jobs: {
    kind: "list",
    jobs: [{ title: "review", status: "running", toolCalls: 4, lastTool: "grep" }],
  },
  configBanner: { kind: "none" },
}

const IDLE_VIEW: SidebarView = {
  kind: "idle",
  roster: { kind: "rows", rows: [{ label: "Build", model: "anthropic/claude" }] },
}

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "omo-tui-v2-"))
  temporaryDirectories.push(directory)
  return directory
}

describe("V2 sidebar slot", () => {
  it("claims sidebar.content once and keeps the V1 information architecture", () => {
    // given
    const host = createFakeHost()
    const sidebar = registerTuiSidebar(host.context, {
      directory: "/tmp/omo-tui-test",
      initialView: ACTIVE_VIEW,
      readView: async () => ACTIVE_VIEW,
      solid: host.solid,
      intervalMs: 10_000,
    })

    // when
    const texts = host.renderTexts(0)

    // then
    expect(host.claims).toHaveLength(1)
    expect(host.claims[0]?.["append"]).toBe("sidebar.content")
    expect(texts).toContain("ULW")
    expect(texts).toContain("Agents")
    expect(texts).toContain("Jobs")
    expect(texts.some((line) => line.includes("goals 2/5"))).toBe(true)
    expect(texts.some((line) => line.includes("review running 4 grep"))).toBe(true)

    sidebar.dispose()
  })

  it("paints section headings with the resolved theme palette", () => {
    // given
    const host = createFakeHost()
    const sidebar = registerTuiSidebar(host.context, {
      directory: "/tmp/omo-tui-test",
      initialView: ACTIVE_VIEW,
      readView: async () => ACTIVE_VIEW,
      solid: host.solid,
      intervalMs: 10_000,
    })

    // when
    const bordered = boxesWithBorderColor(host.render(0))

    // then
    expect(bordered.length).toBeGreaterThan(0)
    expect(bordered[0]).toEqual({ rgba: "border" })

    sidebar.dispose()
  })

  it("re-renders through the signal when a poll finds a different view", async () => {
    // given
    const host = createFakeHost()
    let reads = 0
    const sidebar = registerTuiSidebar(host.context, {
      directory: "/tmp/omo-tui-test",
      initialView: ACTIVE_VIEW,
      readView: async () => {
        reads += 1
        return IDLE_VIEW
      },
      solid: host.solid,
      intervalMs: 5,
    })

    // when
    await Bun.sleep(40)
    const texts = host.renderTexts(0)

    // then
    expect(reads).toBeGreaterThan(0)
    expect(sidebar.view().kind).toBe("idle")
    expect(texts).toContain("Models")
    expect(texts.some((line) => line.includes("Build anthropic/claude"))).toBe(true)
    expect(texts).not.toContain("ULW")

    sidebar.dispose()
  })

  it("releases the claim and stops polling on dispose", async () => {
    // given
    const host = createFakeHost()
    let reads = 0
    const sidebar = registerTuiSidebar(host.context, {
      directory: "/tmp/omo-tui-test",
      initialView: ACTIVE_VIEW,
      readView: async () => {
        reads += 1
        return ACTIVE_VIEW
      },
      solid: host.solid,
      intervalMs: 5,
    })

    // when
    sidebar.dispose()
    const readsAtDispose = reads
    await Bun.sleep(40)

    // then
    expect(reads).toBe(readsAtDispose)
    expect(host.disposedClaims()).toBe(1)
  })

  it("reports poll failures instead of throwing into the renderer", async () => {
    // given
    const host = createFakeHost()
    const errors: Error[] = []
    const sidebar = registerTuiSidebar(host.context, {
      directory: "/tmp/omo-tui-test",
      initialView: ACTIVE_VIEW,
      readView: async () => {
        throw new Error("mirror exploded")
      },
      solid: host.solid,
      intervalMs: 5,
      reportPollError: (error) => errors.push(error),
    })

    // when
    await Bun.sleep(30)

    // then
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]?.message).toBe("mirror exploded")
    sidebar.dispose()
  })
})

function boxesWithBorderColor(node: unknown): unknown[] {
  const found: unknown[] = []
  const walk = (current: unknown): void => {
    const resolved = typeof current === "function" ? (current as () => unknown)() : current
    if (resolved === undefined || resolved === null || typeof resolved !== "object") return
    const box = resolved as { tag?: string; props?: Record<string, unknown>; children?: unknown[] }
    if (box.props?.["borderColor"] !== undefined) found.push(box.props["borderColor"])
    for (const child of box.children ?? []) walk(child)
  }
  walk(node)
  return found
}

describe("V2 theme adapter", () => {
  it("maps the resolved token tree onto the sidebar's flat palette", () => {
    // when
    const theme = toSidebarTheme(fakeTheme())

    // then
    expect(theme.text).toEqual({ rgba: "text" })
    expect(theme.textMuted).toEqual({ rgba: "textMuted" })
    expect(theme.borderSubtle).toEqual({ rgba: "border" })
    expect(theme.warning).toEqual({ rgba: "warning" })
    expect(theme.accent).toEqual({ rgba: "accent" })
  })

  it("degrades to an empty palette instead of throwing when the host has no theme", () => {
    // when
    const theme = toSidebarTheme(undefined)

    // then
    expect(theme.text).toBeUndefined()
    expect(theme.error).toBeUndefined()
  })
})

describe("V2 TUI entry", () => {
  it("registers the sidebar, the BTW layer and the footer label, then releases them", async () => {
    // given
    const host = createFakeHost({ directory: temporaryDirectory() })

    // when
    const cleanup = await opencodeV2Tui.setup(host.context)

    // then
    expect(opencodeV2Tui.id).toBe("oh-my-openagent:tui")
    expect(host.claims.map((claim) => claim["append"])).toEqual([
      "sidebar.content",
      "prompt.footer.status",
    ])
    expect(host.layerFactories).toHaveLength(1)
    expect(host.toasts.some((toast) => toast.message.includes("OpenCode 2 support is active"))).toBe(true)

    await (cleanup as () => void)()
    expect(host.disposedClaims()).toBe(2)
    expect(host.keyHandlers).toHaveLength(0)
    expect(host.stdinHandlers).toHaveLength(0)
    expect(host.deletedHandlers).toHaveLength(0)
  })

  it("keeps the startup notice when the context has no TUI surface", async () => {
    // given
    const toasts: Array<{ message: string }> = []
    const minimal = {
      ui: { toast: { show: (input: { message: string }) => toasts.push(input) } },
    } as unknown as Context

    // when
    const cleanup = await opencodeV2Tui.setup(minimal)

    // then
    expect(toasts).toHaveLength(1)
    expect(cleanup).toBeUndefined()
  })

  it("shows the support notice as a single warning toast", () => {
    // given
    const toasts: Array<{ title: string; message: string; variant: string }> = []

    // when
    showOpenCodeV2Notice({
      ui: { toast: { show: (input) => toasts.push(input) } },
    })

    // then
    expect(toasts).toHaveLength(1)
    expect(toasts[0]?.variant).toBe("warning")
    expect(toasts[0]?.message).toContain("V2适配矩阵-OpenCode-V2-Parity.md")
    expect(toasts[0]?.message).not.toContain("install")
  })

  it("reads the sidebar view from the same config and mirror sources as V1", async () => {
    // when
    const view = await readTuiSidebarView(temporaryDirectory())

    // then
    expect(["active", "broken", "idle"]).toContain(view.kind)
  })
})

// Guards the helper itself: a fake host with an unclaimed slot must not look like a rendered view.
describe("V2 test harness", () => {
  it("returns no texts for an unclaimed slot", () => {
    const host = createFakeHost()
    expect(collectTexts(host.render(0))).toEqual([])
  })
})
