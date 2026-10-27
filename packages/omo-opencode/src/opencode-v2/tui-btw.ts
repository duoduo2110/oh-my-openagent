import type { JsonValue, SessionInfo } from "@opencode/client/promise"
import type { Context } from "@opencode/plugin/tui/plugin"
import type { JSX } from "@opentui/solid/jsx-runtime"
import { createSignal } from "solid-js"

import { getBtwSideMetadata } from "../features/btw-side/metadata"
import { createBtwAdoptionGuard } from "../features/btw-side/tui-adoption-guard"
import { createBtwEscapeReturn } from "../features/btw-side/tui-escape-return"
import { createBtwSideController } from "../features/btw-side/tui-controller"
import type {
  BtwPromptRef,
  BtwSession,
  BtwSessionMessage,
} from "../features/btw-side/tui-controller-types"
import { createBtwParentValidator } from "../features/btw-side/tui-parent-validator"
import {
  buildBtwPickerOptions,
  parseBtwPickerValue,
} from "../features/btw-side/tui-picker-options"
import { loadBtwSessionCatalog } from "../features/btw-side/tui-session-catalog"
import { log } from "../shared/logger"
import { slotElement, type TuiSolidRuntime } from "./tui-nodes"
import { tuiDirectory } from "./tui-context"

const NAVIGATION_POLL_MS = 1_000
type JsonRecord = { readonly [key: string]: JsonValue }
const PICKER_HINT = "BTW is unavailable before the session starts."

/**
 * BTW side conversations on OpenCode 2.
 *
 * The controller, the catalog, the picker options and the double-escape gesture are the V1 modules,
 * unchanged: they only ever spoke to an injected dependency set, so the port is a dependency
 * adapter plus the API calls that really differ (router, toasts, dialogs, keymap, events).
 *
 * What OpenCode 2 does not have is a plugin-visible composer: there is no `ui.Prompt`, no prompt
 * ref and no `session_prompt` slot. The draft half of V1's flow therefore degrades — the question
 * comes from a dialog, and the queued question is submitted through the client instead of a
 * mounted composer. See `syntheticPromptRef`.
 */
export type TuiBtwOptions = {
  readonly solid: TuiSolidRuntime
  readonly intervalMs?: number
}

export type TuiBtwRegistration = {
  /** Synchronous on purpose: on process exit the host may not await async cleanups. */
  readonly dispose: () => void
  /** Retained side sessions, for the self-test. */
  readonly sides: () => readonly string[]
}

export function registerTuiBtw(ctx: Context, options: TuiBtwOptions): TuiBtwRegistration {
  const { solid } = options
  const directory = tuiDirectory(ctx)
  const [version, setVersion] = createSignal(0)
  const bump = (): void => {
    setVersion((value) => value + 1)
  }

  const currentSessionID = (): string | undefined => {
    const route = ctx.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }

  const adoptionGuard = createBtwAdoptionGuard(currentSessionID)
  const parentValidator = createBtwParentValidator({
    fetchStatus: async (sessionID) => {
      try {
        const session = await ctx.client.session.get({ sessionID })
        return session?.id === sessionID ? "exists" : "retry"
      } catch (error) {
        log("[btw-side] Failed to validate parent session", { sessionID, error: String(error) })
        return "retry"
      }
    },
  })

  const controller = createBtwSideController({
    getCurrentSessionID: currentSessionID,
    getSession: (sessionID) => toBtwSession(ctx.data.session.get(sessionID)),
    getMessages: (sessionID) => toBtwMessages(ctx.data.session.message.list(sessionID)),
    createSession: async (input) => {
      const created = await ctx.client.session.create({
        title: input.title,
        ...(input.agent === undefined ? {} : { agent: input.agent }),
        ...(input.model === undefined ? {} : { model: input.model }),
        metadata: input.metadata as JsonRecord,
        location: { directory },
      })
      return { id: created.id, title: created.title ?? input.title }
    },
    navigateSession: (sessionID) => {
      ctx.ui.router.navigate({ type: "session", sessionID })
    },
    abortSession: async (sessionID) => {
      await ctx.client.session.interrupt({ sessionID })
    },
    deleteSession: async (sessionID) => {
      await ctx.client.session.remove({ sessionID })
    },
    showToast: (message) => {
      ctx.ui.toast.show({ variant: "warning", message })
    },
    requestRender: bump,
  })

  /**
   * V1 handed the queued question to the newly mounted composer of the side session, which then
   * submitted it. OpenCode 2 exposes no composer, so this ref stands in for one: `set` stages the
   * text, `submit` sends it through the client. Same outcome for the user — the side session starts
   * on the question — without pretending a composer exists.
   */
  function syntheticPromptRef(sessionID: string): BtwPromptRef {
    let draft = ""
    return {
      get hasAttachments() {
        return false
      },
      get input() {
        return draft
      },
      set: (input) => {
        draft = input
      },
      submit: () => {
        const text = draft
        draft = ""
        if (text.length === 0) return
        void ctx.client.session.prompt({ sessionID, text }).catch((error: unknown) => {
          log("[btw-side] Failed to send the BTW question", { sessionID, error: String(error) })
          ctx.ui.toast.show({
            variant: "error",
            message: "BTW session created, but its first question could not be sent.",
          })
        })
      },
    }
  }

  function adopt(sessionID: string, parentSessionID: string): void {
    controller.adopt(parentSessionID, sessionID)
    bump()
  }

  async function adoptSideSession(sessionID: string): Promise<void> {
    if (controller.side(sessionID) !== undefined) return
    try {
      let metadata = getBtwSideMetadata(toMetadataSource(ctx.data.session.get(sessionID)))
      if (metadata === undefined) {
        const fetched = await ctx.client.session.get({ sessionID })
        void ctx.data.session.sync(sessionID)
        metadata = getBtwSideMetadata(toMetadataSource(fetched))
      }
      if (metadata === undefined) return
      if (!adoptionGuard.canApply(sessionID, metadata.parent_session_id)) return
      if (!(await parentValidator.exists(metadata.parent_session_id))) return
      if (!adoptionGuard.canApply(sessionID, metadata.parent_session_id)) return
      adopt(sessionID, metadata.parent_session_id)
      log("[btw-side] V2 adopted side session", { sessionID })
    } catch (error) {
      log("[btw-side] Failed to adopt side session", { sessionID, error: String(error) })
    }
  }

  async function startFromQuestion(
    question: string,
    parentSessionID: string | undefined,
  ): Promise<boolean> {
    // The controller reads the question out of a `/btw <question>` draft (that is the V1 command
    // shape, and the only one it queues), so the dialog's answer is staged in that form. The title,
    // the queued question and the boundary check then all come from the same V1 code path.
    const trimmed = question.trim()
    let draft = trimmed.length === 0 ? "" : `/btw ${trimmed}`
    const draftRef: BtwPromptRef = {
      hasAttachments: false,
      get input() {
        return draft
      },
      set: (input) => {
        draft = input
      },
      submit: () => undefined,
    }
    const started = await controller.startFromPrompt(draftRef, parentSessionID)
    if (!started) return false
    const state = controller.state()
    if (state.phase !== "open") return true
    // Attaching the ref is what flushes the queued question, exactly as a mounted composer did.
    controller.attachPromptRef(state.sideSessionID, syntheticPromptRef(state.sideSessionID))
    return true
  }

  async function openBtwPicker(): Promise<boolean> {
    const sessionID = currentSessionID()
    if (sessionID === undefined) {
      ctx.ui.toast.show({ variant: "warning", message: PICKER_HINT })
      return false
    }
    if (controller.side(sessionID) === undefined) await adoptSideSession(sessionID)

    let loaded: Awaited<ReturnType<typeof loadBtwSessionCatalog>>
    try {
      loaded = await loadBtwSessionCatalog({
        currentSessionID: sessionID,
        directory,
        listSessions: async ({ limit }) => ({
          data: (await ctx.client.session.list({ limit })).data.map(toCatalogSession),
        }),
      })
    } catch (error) {
      log("[btw-side] Failed to list BTW sessions", { sessionID, error: String(error) })
      ctx.ui.toast.show({ variant: "error", message: "Unable to list BTW conversations." })
      return false
    }
    if (loaded.catalog === undefined) {
      ctx.ui.toast.show({
        variant: "warning",
        message: loaded.truncated
          ? "The BTW list is too large to show completely."
          : "This BTW conversation no longer has a main session.",
      })
      return false
    }
    if (loaded.truncated) {
      ctx.ui.toast.show({
        variant: "warning",
        message: "The BTW list is too large to show completely.",
      })
    }
    for (const [index, side] of loaded.catalog.sides.entries()) {
      controller.adopt(loaded.catalog.main.id, side.id, index + 1)
    }
    const picker = buildBtwPickerOptions(loaded.catalog, sessionID)
    const chosen = await ctx.ui.dialog.select<string>({
      title: "BTW conversations",
      placeholder: "Choose Main, a retained BTW, or New BTW",
      options: picker.options.map((option) => ({
        title: option.title,
        value: option.value,
        description: option.description,
        category: option.category,
        ...(option.disabled === undefined ? {} : { disabled: option.disabled }),
      })),
    })
    if (chosen === undefined) return false
    const selection = parseBtwPickerValue(chosen)
    if (selection === undefined) return false
    if (selection.type === "session") {
      ctx.ui.router.navigate({ type: "session", sessionID: selection.sessionID })
      return true
    }
    const question = await ctx.ui.dialog.prompt({
      title: "BTW conversation",
      description: "What should the side conversation work on?",
      placeholder: "Ask something without interrupting the main turn",
    })
    if (question === undefined) return false
    return startFromQuestion(question, selection.parentSessionID)
  }

  const escapeReturn = createBtwEscapeReturn({
    isCurrentSideIdle: () => {
      const sessionID = currentSessionID()
      if (sessionID === undefined) return false
      if (controller.side(sessionID) === undefined) return false
      const permission = ctx.data.session.permission.list(sessionID) ?? []
      return ctx.data.session.status(sessionID) !== "running" && permission.length === 0
    },
    // OpenCode 2's dialog API exposes no "is a dialog open" flag. Plugin dialogs own the keys while
    // they are up, so the gesture never sees them; this stays false instead of guessing.
    isDialogOpen: () => false,
    // The V1 pending-sequence buffer has no V2 equivalent; there is nothing to clear.
    clearPending: () => undefined,
    returnToParent: () => {
      controller.returnToParent()
    },
  })

  ctx.keymap.layer(() => ({
    priority: 20_000,
    commands: [
      {
        id: "omo.btw.open",
        title: "Start BTW side conversation",
        description:
          "Start or switch retained side conversations without interrupting the main turn",
        group: "Session",
        bind: "ctrl+/",
        palette: true,
        slash: { name: "btw", aliases: ["side"] },
        run: () => {
          void openBtwPicker()
        },
      },
      {
        id: "omo.btw.close",
        title: "Close BTW conversation",
        group: "Session",
        enabled: () => controller.canCloseCurrentSide(),
        run: () => {
          void controller.close()
        },
      },
      {
        id: "omo.btw.return",
        title: "Return from BTW to its main session",
        group: "Session",
        enabled: () => controller.side(currentSessionID() ?? "") !== undefined,
        run: () => {
          controller.returnToParent()
        },
      },
    ],
  }))

  const renderer = ctx.renderer as unknown as {
    readonly stdin?: {
      prependListener?: (event: string, handler: (data: string | Buffer) => void) => unknown
      off?: (event: string, handler: (data: string | Buffer) => void) => unknown
    }
    readonly _internalKeyInput?: {
      prependListener?: (event: string, handler: (event: BtwKeyEvent) => void) => unknown
      off?: (event: string, handler: (event: BtwKeyEvent) => void) => unknown
    }
  }

  const isPickerKey = (event: BtwKeyEvent): boolean =>
    event.eventType === "press" &&
    event.ctrl === true &&
    (event.name === "/" || event.name === "_" || event.name === "7")

  let openingPicker = false
  const openPickerFromShortcut = (): void => {
    if (openingPicker) return
    openingPicker = true
    escapeReturn.reset()
    void openBtwPicker()
      .catch((error: unknown) => {
        log("[btw-side] Failed to open picker from keyboard shortcut", { error: String(error) })
        ctx.ui.toast.show({ variant: "error", message: "Unable to open BTW conversations." })
      })
      .finally(() => {
        openingPicker = false
      })
  }

  const handleKey = (event: BtwKeyEvent): void => {
    if (isPickerKey(event)) {
      event.preventDefault?.()
      event.stopPropagation?.()
      openPickerFromShortcut()
      return
    }
    // The gesture is the V1 module; only its key-input wrapper differs (OpenTUI's own KeyEvent
    // shape versus the small surface both call sites use).
    escapeReturn.handle({
      event,
      setData: () => undefined,
      getData: () => undefined,
      consume: (consumeOptions?: { preventDefault?: boolean; stopPropagation?: boolean }) => {
        if (consumeOptions?.preventDefault !== false) event.preventDefault?.()
        if (consumeOptions?.stopPropagation !== false) event.stopPropagation?.()
      },
    } as unknown as Parameters<typeof escapeReturn.handle>[0])
  }

  const handleStdin = (data: string | Buffer): void => {
    const sequence = typeof data === "string" ? data : data.toString("utf8")
    // xterm emits every Ctrl slash alias as 0x1f, which OpenTUI drops before the keymap sees it.
    if (sequence !== "\u001f") return
    openPickerFromShortcut()
  }

  renderer._internalKeyInput?.prependListener?.("keypress", handleKey)
  renderer.stdin?.prependListener?.("data", handleStdin)

  // V1 put this label to the right of the composer (`session_prompt_right`). OpenCode 2 publishes no
  // such slot; `prompt.footer.status` is the equivalent place inside the composer's footer.
  const disposeLabel = ctx.ui.slot({
    append: "prompt.footer.status",
    render: () =>
      renderLabel(solid, ctx.theme.text.muted, () => {
        // Reading the signal here is what re-renders the label when the controller's state changes.
        version()
        return labelFor(controller, currentSessionID())
      }),
  })

  const unsubscribeDeleted = ctx.data.on("session.deleted", (event) => {
    const sessionID = event.data.sessionID
    adoptionGuard.markDeleted(sessionID)
    parentValidator.markDeleted(sessionID)
    controller.handleSessionDeleted(sessionID)
  })

  let lastSessionID: string | undefined
  const timer = setInterval(() => {
    const sessionID = currentSessionID()
    if (sessionID === lastSessionID) return
    lastSessionID = sessionID
    void controller.handleNavigation(sessionID ?? "")
    if (sessionID !== undefined) void adoptSideSession(sessionID)
  }, options.intervalMs ?? NAVIGATION_POLL_MS)

  log("[btw-side] V2 controls registered", {
    commands: ["omo.btw.open", "omo.btw.close", "omo.btw.return"],
    slot: "prompt.footer.status",
  })

  return {
    sides: () => controller.sides().map((side) => side.sideSessionID),
    dispose: () => {
      // Everything the host owns is released synchronously; the controller's own teardown waits on
      // in-flight creations and is therefore not awaited (an exiting TUI never awaits it).
      clearInterval(timer)
      renderer._internalKeyInput?.off?.("keypress", handleKey)
      renderer.stdin?.off?.("data", handleStdin)
      disposeLabel()
      unsubscribeDeleted()
      adoptionGuard.dispose()
      void controller.dispose()
      log("[btw-side] V2 controls released", {})
    },
  }
}

type BtwKeyEvent = {
  readonly eventType: string
  readonly name: string
  readonly ctrl?: boolean
  readonly preventDefault?: () => void
  readonly stopPropagation?: () => void
}

function renderLabel(
  solid: TuiSolidRuntime,
  color: unknown,
  label: () => string | undefined,
): JSX.Element {
  const node = solid.createElement("text")
  solid.setProp(node, "fg", color)
  solid.insert(node, () => label() ?? "")
  return slotElement(node)
}

function toCatalogSession(session: SessionInfo): {
  id: string
  title: string
  metadata?: Record<string, unknown>
  time: { created: number; updated: number }
} {
  return {
    id: session.id,
    title: session.title ?? "",
    ...(session.metadata === undefined
      ? {}
      : { metadata: session.metadata as Record<string, unknown> }),
    time: { created: session.time.created, updated: session.time.updated },
  }
}

function toMetadataSource(session: unknown): { metadata?: Record<string, unknown> } {
  const metadata = readField(session, "metadata")
  if (typeof metadata !== "object" || metadata === null) return {}
  return { metadata: metadata as Record<string, unknown> }
}

function toBtwSession(session: unknown): BtwSession | undefined {
  const id = readField(session, "id")
  if (typeof id !== "string" || id.length === 0) return undefined
  const title = readField(session, "title")
  const agent = readField(session, "agent")
  const model = readField(session, "model")
  const modelID = readField(model, "id")
  const providerID = readField(model, "providerID")
  return {
    id,
    title: typeof title === "string" ? title : "",
    ...(typeof agent === "string" && agent.length > 0 ? { agent } : {}),
    ...(typeof modelID === "string" && typeof providerID === "string"
      ? { model: { providerID, id: modelID } }
      : {}),
  }
}

function toBtwMessages(messages: readonly unknown[]): BtwSessionMessage[] {
  const out: BtwSessionMessage[] = []
  for (const entry of messages) {
    const id = readField(entry, "id")
    if (typeof id !== "string" || id.length === 0) continue
    const type = readField(entry, "type") ?? readField(entry, "role")
    const completed = readField(readField(entry, "time"), "completed")
    out.push({
      info: {
        id,
        role: type === "user" ? "user" : "assistant",
        ...(typeof completed === "number" ? { time: { completed } } : {}),
      },
    })
  }
  return out
}

function readField(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined
  return (value as Record<string, unknown>)[key]
}

function labelFor(
  controller: ReturnType<typeof createBtwSideController>,
  currentSessionID: string | undefined,
): string | undefined {
  if (currentSessionID === undefined) return undefined
  const state = controller.state()
  if (state.phase === "creating" && currentSessionID === state.parentSessionID) {
    return "BTW starting..."
  }
  if (state.phase === "open" && currentSessionID === state.parentSessionID) {
    return "BTW retained · ctrl+/ picker"
  }
  if (state.phase === "open" && currentSessionID === state.sideSessionID) {
    const sideNumber = controller.sideNumber(state.sideSessionID)
    const sideLabel = sideNumber === undefined ? "BTW side" : `BTW #${sideNumber}`
    return `${sideLabel} · esc esc return · ctrl+/ picker · ctrl+c delete`
  }
  if (controller.side(currentSessionID) !== undefined) {
    return "BTW side · esc esc return · ctrl+/ picker"
  }
  return undefined
}
