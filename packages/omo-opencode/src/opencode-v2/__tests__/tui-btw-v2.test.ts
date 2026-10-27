/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test"

import { BTW_SIDE_METADATA_KEY, createBtwSideMetadata } from "../../features/btw-side/metadata"
import { registerTuiBtw } from "../tui-btw"
import { createFakeHost, type FakeHost } from "./tui-fake-host"

const MAIN_SESSION = "ses_main"
const SIDE_SESSION = "ses_side"

function sideMetadata(parentSessionID: string): Record<string, unknown> {
  return {
    [BTW_SIDE_METADATA_KEY]: createBtwSideMetadata({
      parentSessionID,
      boundaryMessageID: "msg_boundary",
    }),
  }
}

function sessionRecord(args: {
  readonly id: string
  readonly title: string
  readonly created: number
  readonly metadata?: Record<string, unknown>
}): Record<string, unknown> {
  return {
    id: args.id,
    title: args.title,
    metadata: args.metadata ?? {},
    time: { created: args.created, updated: args.created },
    location: { directory: "/tmp/omo-tui-test" },
  }
}

type Command = {
  readonly id?: string
  readonly title?: string
  readonly bind?: unknown
  readonly slash?: { readonly name: string; readonly aliases?: readonly string[] }
  readonly enabled?: boolean | (() => boolean)
  readonly run: () => unknown
}

function commands(host: FakeHost): Command[] {
  const factory = host.layerFactories[0]
  if (factory === undefined) throw new Error("no keymap layer registered")
  const layer = factory() as { readonly commands?: readonly Command[] }
  return [...(layer.commands ?? [])]
}

function keypress(host: FakeHost, event: Record<string, unknown>): void {
  for (const handler of [...host.keyHandlers]) handler(event)
}

describe("V2 BTW side registration", () => {
  it("registers the V1 commands with the V2 keymap, plus a slash entry and the footer label", () => {
    // given
    const host = createFakeHost()

    // when
    const btw = registerTuiBtw(host.context, { solid: host.solid })

    // then
    const registered = commands(host)
    expect(registered.map((command) => command.id)).toEqual([
      "omo.btw.open",
      "omo.btw.close",
      "omo.btw.return",
    ])
    const open = registered[0]
    expect(open?.bind).toBe("ctrl+/")
    expect(open?.slash?.name).toBe("btw")
    expect(open?.slash?.aliases).toEqual(["side"])
    expect(host.claims[0]?.["append"]).toBe("prompt.footer.status")
    expect(host.deletedHandlers).toHaveLength(1)
    expect(host.keyHandlers).toHaveLength(1)
    expect(host.stdinHandlers).toHaveLength(1)

    void btw.dispose()
  })

  it("opens the picker from ctrl+/ and navigates to a retained side session", async () => {
    // given
    const host = createFakeHost({
      sessions: {
        [MAIN_SESSION]: sessionRecord({ id: MAIN_SESSION, title: "Main", created: 1 }),
        [SIDE_SESSION]: sessionRecord({
          id: SIDE_SESSION,
          title: "BTW · investigate",
          created: 2,
          metadata: sideMetadata(MAIN_SESSION),
        }),
      },
      route: { type: "session", sessionID: MAIN_SESSION },
      selectAnswer: `session:${SIDE_SESSION}`,
    })
    const btw = registerTuiBtw(host.context, { solid: host.solid })

    // when
    keypress(host, { eventType: "press", name: "/", ctrl: true })
    await Bun.sleep(10)

    // then
    expect(host.dialogs.map((dialog) => dialog.kind)).toEqual(["select"])
    const options = host.dialogs[0]?.options["options"] as Array<{ value: string }>
    expect(options.some((option) => option.value === `session:${SIDE_SESSION}`)).toBe(true)
    expect(host.navigations).toEqual([{ type: "session", sessionID: SIDE_SESSION }])
    expect(btw.sides()).toEqual([SIDE_SESSION])

    await btw.dispose()
  })

  it("starts a new side conversation from a dialog prompt and delivers the question", async () => {
    // given
    const host = createFakeHost({
      sessions: {
        [MAIN_SESSION]: sessionRecord({ id: MAIN_SESSION, title: "Main", created: 1 }),
      },
      route: { type: "session", sessionID: MAIN_SESSION },
      selectAnswer: `new:${MAIN_SESSION}`,
      promptAnswer: "why did the build break?",
    })
    const btw = registerTuiBtw(host.context, { solid: host.solid })

    // when
    keypress(host, { eventType: "press", name: "/", ctrl: true })
    await Bun.sleep(20)

    // then
    expect(host.dialogs.map((dialog) => dialog.kind)).toEqual(["select", "prompt"])
    const created = [...host.sessions.values()].find((session) => session["id"] !== MAIN_SESSION)
    expect(created).toBeDefined()
    expect(host.navigations.at(-1)).toEqual({ type: "session", sessionID: created?.["id"] })
    expect(host.prompts).toEqual([
      { sessionID: created?.["id"] as string, text: "why did the build break?" },
    ])

    await btw.dispose()
  })

  it("warns instead of opening a picker outside a session", async () => {
    // given
    const host = createFakeHost()
    const btw = registerTuiBtw(host.context, { solid: host.solid })

    // when
    keypress(host, { eventType: "press", name: "/", ctrl: true })
    await Bun.sleep(10)

    // then
    expect(host.dialogs).toHaveLength(0)
    expect(host.toasts.map((toast) => toast.message)).toContain(
      "BTW is unavailable before the session starts.",
    )

    await btw.dispose()
  })

  it("treats the 0x1f stdin alias as the picker shortcut", async () => {
    // given
    const host = createFakeHost({
      sessions: {
        [MAIN_SESSION]: sessionRecord({ id: MAIN_SESSION, title: "Main", created: 1 }),
      },
      route: { type: "session", sessionID: MAIN_SESSION },
    })
    const btw = registerTuiBtw(host.context, { solid: host.solid })

    // when
    for (const handler of [...host.stdinHandlers]) handler("\u001f")
    await Bun.sleep(10)

    // then
    expect(host.dialogs.map((dialog) => dialog.kind)).toEqual(["select"])

    await btw.dispose()
  })

  it("adopts a retained side session when the route changes to it", async () => {
    // given
    const host = createFakeHost({
      sessions: {
        [MAIN_SESSION]: sessionRecord({ id: MAIN_SESSION, title: "Main", created: 1 }),
        [SIDE_SESSION]: sessionRecord({
          id: SIDE_SESSION,
          title: "BTW · investigate",
          created: 2,
          metadata: sideMetadata(MAIN_SESSION),
        }),
      },
      route: { type: "session", sessionID: MAIN_SESSION },
    })
    const btw = registerTuiBtw(host.context, { solid: host.solid, intervalMs: 5 })

    // when
    host.route.sessionID = SIDE_SESSION
    await Bun.sleep(40)

    // then
    expect(btw.sides()).toContain(SIDE_SESSION)
    expect(host.renderTexts(0).join(" ")).toContain("BTW")

    await btw.dispose()
  })

  it("releases the layer, listeners, label claim and controller on dispose", async () => {
    // given
    const host = createFakeHost()
    const btw = registerTuiBtw(host.context, { solid: host.solid })

    // when
    await btw.dispose()

    // then
    expect(host.disposedClaims()).toBe(1)
    expect(host.keyHandlers).toHaveLength(0)
    expect(host.stdinHandlers).toHaveLength(0)
    expect(host.deletedHandlers).toHaveLength(0)
    expect(btw.sides()).toEqual([])
  })
})
