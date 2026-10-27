/// <reference types="bun-types" />

import type { Context } from "@opencode/plugin/tui/plugin"
import type { ResolvedTheme } from "@opencode/theme/tui"

import type { TuiSolidRuntime } from "../tui-nodes"

export type FakeNode = {
  readonly tag: string
  readonly props: Record<string, unknown>
  readonly children: unknown[]
}

export type SlotClaim = {
  readonly [key: string]: unknown
  readonly render: (input: never) => unknown
}

export type FakeHost = {
  readonly context: Context
  readonly claims: SlotClaim[]
  readonly toasts: Array<{ message: string; variant?: string }>
  readonly navigations: Array<Record<string, unknown>>
  readonly layerFactories: Array<() => unknown>
  readonly keyHandlers: Array<(event: Record<string, unknown>) => void>
  readonly stdinHandlers: Array<(data: string | Buffer) => void>
  readonly deletedHandlers: Array<(event: { data: { sessionID: string } }) => void>
  readonly dialogs: Array<{ kind: string; options: Record<string, unknown> }>
  readonly prompts: Array<{ sessionID: string; text: string }>
  readonly sessions: Map<string, Record<string, unknown>>
  readonly route: { type: string; sessionID?: string }
  readonly solid: TuiSolidRuntime<FakeNode>
  readonly disposedClaims: () => number
  readonly render: (index: number) => FakeNode | undefined
  readonly renderTexts: (index: number) => string[]
}

export type FakeHostOptions = {
  readonly directory?: string
  readonly sessions?: Record<string, Record<string, unknown>>
  readonly route?: { type: string; sessionID?: string }
  readonly selectAnswer?: unknown
  readonly promptAnswer?: unknown
  readonly status?: "idle" | "running"
}

export function createFakeHost(options: FakeHostOptions = {}): FakeHost {
  const claims: SlotClaim[] = []
  const toasts: Array<{ message: string; variant?: string }> = []
  const navigations: Array<Record<string, unknown>> = []
  const layerFactories: Array<() => unknown> = []
  const keyHandlers: Array<(event: Record<string, unknown>) => void> = []
  const stdinHandlers: Array<(data: string | Buffer) => void> = []
  const deletedHandlers: Array<(event: { data: { sessionID: string } }) => void> = []
  const dialogs: Array<{ kind: string; options: Record<string, unknown> }> = []
  const prompts: Array<{ sessionID: string; text: string }> = []
  const sessions = new Map<string, Record<string, unknown>>(Object.entries(options.sessions ?? {}))
  const route = options.route ?? { type: "home" }
  let disposedClaims = 0
  const directory = options.directory ?? "/tmp/omo-tui-test"

  const solid: TuiSolidRuntime<FakeNode> = {
    createElement: (tag) => ({ tag, props: {}, children: [] }),
    setProp: (node, name, value) => {
      node.props[name] = typeof value === "function" ? (value as () => unknown)() : value
      return value
    },
    insert: (parent, child) => {
      parent.children.push(child)
      return undefined
    },
  }

  const context = {
    options: {},
    location: { directory },
    app: { version: "2.1.4", channel: "latest" },
    themeMode: "dark",
    theme: fakeTheme(),
    client: {
      session: {
        get: async ({ sessionID }: { sessionID: string }) => {
          const session = sessions.get(sessionID)
          if (session === undefined) throw new Error(`no session ${sessionID}`)
          return session
        },
        list: async () => ({ data: [...sessions.values()] }),
        create: async (input: Record<string, unknown>) => {
          const id = `side-${sessions.size + 1}`
          const session = {
            id,
            title: input["title"] ?? "",
            metadata: input["metadata"] ?? {},
            time: { created: sessions.size + 1, updated: sessions.size + 2 },
            location: { directory },
          }
          sessions.set(id, session)
          return session
        },
        prompt: async ({ sessionID, text }: { sessionID: string; text: string }) => {
          prompts.push({ sessionID, text })
          return {}
        },
        interrupt: async () => undefined,
        remove: async ({ sessionID }: { sessionID: string }) => {
          sessions.delete(sessionID)
        },
      },
    },
    data: {
      on: (type: string, handler: (event: { data: { sessionID: string } }) => void) => {
        if (type === "session.deleted") deletedHandlers.push(handler)
        return () => {
          const index = deletedHandlers.indexOf(handler)
          if (index >= 0) deletedHandlers.splice(index, 1)
        }
      },
      session: {
        get: (sessionID: string) => sessions.get(sessionID),
        list: () => [...sessions.values()],
        sync: async () => undefined,
        status: () => options.status ?? "idle",
        message: {
          list: (sessionID: string) =>
            sessions.has(sessionID)
              ? [{ id: "msg_1", type: "user", time: { created: 1 } }]
              : [],
        },
        permission: { list: () => [] },
      },
      location: { default: () => ({ directory }) },
    },
    keymap: {
      layer: (factory: () => unknown) => {
        layerFactories.push(factory)
      },
      commands: () => [],
      shortcuts: () => [],
      pending: () => [],
      active: () => [],
      dispatch: () => undefined,
      mode: { current: () => "base", push: () => () => undefined },
    },
    ui: {
      slot: (claim: SlotClaim) => {
        claims.push(claim)
        return () => {
          disposedClaims += 1
        }
      },
      toast: {
        show: (input: { message: string; variant?: string }) => {
          toasts.push({ message: input.message, variant: input.variant })
        },
      },
      dialog: {
        select: async (input: Record<string, unknown>) => {
          dialogs.push({ kind: "select", options: input })
          return options.selectAnswer
        },
        prompt: async (input: Record<string, unknown>) => {
          dialogs.push({ kind: "prompt", options: input })
          return options.promptAnswer
        },
        confirm: async () => undefined,
        alert: async () => undefined,
        show: () => undefined,
        clear: () => undefined,
        set: () => undefined,
      },
      router: {
        register: () => () => undefined,
        navigate: (destination: Record<string, unknown>) => {
          navigations.push(destination)
          if (destination["type"] === "session") {
            route.type = "session"
            if (typeof destination["sessionID"] === "string") route.sessionID = destination["sessionID"]
          }
        },
        current: () => route,
      },
      panel: {
        open: () => false,
        close: () => undefined,
        current: () => undefined,
      },
      tabs: {
        enabled: () => true,
        list: () => [],
        open: () => false,
        focus: () => false,
        move: () => false,
        close: () => false,
      },
      model: { current: () => undefined, variant: { list: () => [], set: () => false } },
      format: { path: (value: string) => value },
    },
    storage: { store: () => [{}, async () => undefined], memory: () => [{}, () => undefined] },
    attention: { notify: async () => ({ ok: true, notification: false, sound: false }) },
    renderer: {
      requestRender: () => undefined,
      stdin: {
        prependListener: (event: string, handler: (data: string | Buffer) => void) => {
          if (event === "data") stdinHandlers.push(handler)
        },
        off: (event: string, handler: (data: string | Buffer) => void) => {
          const index = stdinHandlers.indexOf(handler)
          if (index >= 0) stdinHandlers.splice(index, 1)
        },
      },
      _internalKeyInput: {
        prependListener: (event: string, handler: (event: Record<string, unknown>) => void) => {
          if (event === "keypress") keyHandlers.push(handler)
        },
        off: (event: string, handler: (event: Record<string, unknown>) => void) => {
          const index = keyHandlers.indexOf(handler)
          if (index >= 0) keyHandlers.splice(index, 1)
        },
      },
    },
    markdown: { registerCodeBlockRenderer: () => () => undefined },
  }

  const render = (index: number): FakeNode | undefined =>
    resolveNode(claims[index]?.render(undefined as never))

  return {
    context: context as unknown as Context,
    claims,
    toasts,
    navigations,
    layerFactories,
    keyHandlers,
    stdinHandlers,
    deletedHandlers,
    dialogs,
    prompts,
    sessions,
    route,
    solid,
    disposedClaims: () => disposedClaims,
    render,
    renderTexts: (index) => collectTexts(render(index)),
  }
}

export function resolveNode(node: unknown): FakeNode | undefined {
  const resolved = typeof node === "function" ? (node as () => unknown)() : node
  if (resolved === undefined || resolved === null) return undefined
  if (Array.isArray(resolved)) return resolveNode(resolved[0])
  if (typeof resolved !== "object") return undefined
  return resolved as FakeNode
}

export function collectTexts(node: FakeNode | undefined): string[] {
  if (node === undefined) return []
  const out: string[] = []
  const walk = (current: FakeNode): void => {
    for (const child of current.children) {
      const resolved = typeof child === "function" ? (child as () => unknown)() : child
      if (typeof resolved === "string") {
        out.push(resolved)
        continue
      }
      const next = resolveNode(resolved)
      if (next !== undefined) walk(next)
    }
  }
  walk(node)
  return out
}

function fakeColor(rgba: string): { readonly rgba: string } {
  return { rgba }
}

export function fakeTheme(): ResolvedTheme {
  return {
    text: {
      base: fakeColor("text"),
      muted: fakeColor("textMuted"),
      faint: fakeColor("faint"),
      action: {} as never,
      formfield: {} as never,
      feedback: {
        error: { base: fakeColor("error"), muted: fakeColor("errorMuted") },
        warning: { base: fakeColor("warning"), muted: fakeColor("warningMuted") },
        success: { base: fakeColor("success"), muted: fakeColor("successMuted") },
        info: { base: fakeColor("info"), muted: fakeColor("infoMuted") },
      },
    },
    border: { base: fakeColor("border") },
    hue: { accent: { 500: fakeColor("accent") } },
    markdown: {},
    syntax: {},
    categorical: [],
    scrollbar: {},
    diff: {},
    background: {},
    source: () => undefined,
    increase: () => fakeColor("x"),
    decrease: () => fakeColor("x"),
    surface: () => ({}) as never,
  } as unknown as ResolvedTheme
}
