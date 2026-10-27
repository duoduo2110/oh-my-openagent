import type { Context } from "@opencode/plugin/tui/plugin"
import { createSignal } from "solid-js"

import { viewKey } from "../features/tui-sidebar/compute-view"
import { POLL_INTERVAL_MS } from "../features/tui-sidebar/constants"
import { buildViewNodes } from "../features/tui-sidebar/render-view"
import type { SidebarView } from "../features/tui-sidebar/state-types"
import { log } from "../shared/logger"
import { materializeNodes, slotElement, type TuiSolidRuntime } from "./tui-nodes"
import { toSidebarTheme } from "./tui-theme"

/**
 * The sidebar keeps V1's information architecture (config banner -> ULW loop -> agents -> jobs, or
 * the idle model roster) and V1's data source (the on-disk mirror written by the server plugin plus
 * the config validator). Only the transport changed:
 *
 *  - V1 re-registered a slot and called `renderer.requestRender()` on every poll.
 *  - V2 owns a placeholder claim for the session's lifetime and re-renders through a Solid signal.
 */
export type TuiSidebarDependencies = {
  readonly directory: string
  readonly initialView: SidebarView
  readonly readView: (directory: string) => Promise<SidebarView>
  readonly solid: TuiSolidRuntime
  readonly intervalMs?: number
  readonly reportPollError?: (error: Error) => void
}

export type TuiSidebarRegistration = {
  readonly dispose: () => void
  readonly view: () => SidebarView
}

export function registerTuiSidebar(
  ctx: Context,
  dependencies: TuiSidebarDependencies,
): TuiSidebarRegistration {
  const { solid, directory } = dependencies
  const [view, setView] = createSignal<SidebarView>(dependencies.initialView)
  const reportPollError =
    dependencies.reportPollError ??
    ((error: Error) => log("[tui-sidebar] polling failed", { error }))

  let currentKey = viewKey(dependencies.initialView)
  let disposed = false
  let inFlight = false
  let rendered = false

  // One claim for the sidebar's whole lifetime: the render function reads the signal, so a poll that
  // finds a different view only has to set it.
  const disposeSlot = ctx.ui.slot({
    append: "sidebar.content",
    render: () => {
      const current = view()
      if (!rendered) {
        rendered = true
        log("[tui-sidebar] V2 view rendered", { kind: current.kind })
      }
      const root = solid.createElement("box")
      solid.setProp(root, "flexDirection", "column")
      // The accessor is what makes the tree reactive: Solid re-runs it when `view` changes, which is
      // the OpenCode 2 shape of V1's `requestRender()`.
      solid.insert(root, () => materializeNodes(buildViewNodes(view(), toSidebarTheme(ctx.theme)), solid))
      return slotElement(root)
    },
  })

  const tick = async (): Promise<void> => {
    if (disposed || inFlight) return
    inFlight = true
    try {
      const next = await dependencies.readView(directory)
      if (disposed) return
      const nextKey = viewKey(next)
      if (nextKey === currentKey) return
      currentKey = nextKey
      setView(next)
    } catch (error) {
      if (error instanceof Error) {
        reportPollError(error)
      } else {
        throw error
      }
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(() => {
    void tick()
  }, dependencies.intervalMs ?? POLL_INTERVAL_MS)

  log("[tui-sidebar] V2 slot claimed", { slot: "sidebar.content", directory })

  return {
    view: () => view(),
    dispose: () => {
      disposed = true
      clearInterval(timer)
      disposeSlot()
      log("[tui-sidebar] V2 slot released", { slot: "sidebar.content" })
    },
  }
}
