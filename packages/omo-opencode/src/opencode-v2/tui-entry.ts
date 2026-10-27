import * as Plugin from "@opencode/plugin/tui/plugin"

import { validatePluginConfig } from "../config/validate"
import { computeView } from "../features/tui-sidebar/compute-view"
import {
  deriveAgents,
  deriveConfig,
  deriveJobBoard,
  deriveLoop,
  deriveRoster,
} from "../features/tui-sidebar/derivers"
import { readMirror } from "../features/tui-sidebar/mirror-io"
import { resolveRoster } from "../features/tui-sidebar/roster-resolver"
import type { SidebarView } from "../features/tui-sidebar/state-types"
import { log } from "../shared/logger"
import {
  OPENCODE_V2_NOTICE_DURATION_MS,
  OPENCODE_V2_NOTICE_MESSAGE,
  OPENCODE_V2_NOTICE_TITLE,
} from "./startup-notice"
import { registerTuiBtw } from "./tui-btw"
import { hasTuiSurface, tuiDirectory, type V2TuiContext } from "./tui-context"
import type { TuiSolidRuntime } from "./tui-nodes"
import { registerTuiSidebar } from "./tui-sidebar"

type NoticeToast = {
  readonly ui: {
    readonly toast: {
      readonly show: (options: {
        readonly title: string
        readonly message: string
        readonly variant: "warning"
        readonly duration: number
      }) => void
    }
  }
}

export function showOpenCodeV2Notice(context: NoticeToast): void {
  context.ui.toast.show({
    title: OPENCODE_V2_NOTICE_TITLE,
    message: OPENCODE_V2_NOTICE_MESSAGE,
    variant: "warning",
    duration: OPENCODE_V2_NOTICE_DURATION_MS,
  })
}

/** The sidebar's data source, unchanged from V1: config validator + the on-disk mirror. */
export async function readTuiSidebarView(directory: string): Promise<SidebarView> {
  const validation = validatePluginConfig(directory)
  const mirror = readMirror(directory)
  const roster = resolveRoster(directory)
  return computeView({
    config: deriveConfig(validation),
    roster: deriveRoster(roster),
    agents: deriveAgents(mirror),
    jobs: deriveJobBoard(mirror),
    loop: deriveLoop(mirror),
  })
}

export function isTuiSidebarEnabled(directory: string): boolean {
  try {
    return validatePluginConfig(directory).config.tui?.sidebar?.enabled !== false
  } catch (error) {
    log("[opencode-v2] tui sidebar config unreadable", { error: String(error) })
    return true
  }
}

/**
 * OpenCode 2 TUI entry. It reuses V1's sidebar view model, derivers and BTW controller, and only
 * swaps the host API: one slot claim per region instead of re-registration plus `requestRender()`,
 * a Solid signal instead of a manual repaint, `keymap.layer` instead of `keymap.registerLayer`,
 * `data.on` instead of `event.on`, and a promise dialog instead of the dialog stack.
 */
export const opencodeV2Tui = Plugin.define({
  id: "oh-my-openagent:tui",
  setup: async (context) => {
    showOpenCodeV2Notice(context)
    const ctx = context as V2TuiContext
    if (!hasTuiSurface(ctx)) {
      log("[opencode-v2] tui not wired", {
        reason: "context has no slot/keymap/data surface",
      })
      return
    }

    // V2 requires the host to provide OpenTUI; without it nothing can be rendered.
    const solid = (await import("@opentui/solid").catch(() => undefined)) as
      | TuiSolidRuntime
      | undefined
    if (solid === undefined) {
      log("[opencode-v2] tui degraded", {
        reason: "@opentui/solid is unavailable; no slot is claimed",
      })
      return
    }

    const directory = tuiDirectory(ctx)
    const disposers: Array<() => void> = []

    if (isTuiSidebarEnabled(directory)) {
      try {
        const initialView = await readTuiSidebarView(directory)
        disposers.push(
          registerTuiSidebar(ctx, { directory, initialView, readView: readTuiSidebarView, solid })
            .dispose,
        )
      } catch (error) {
        log("[opencode-v2] tui sidebar registration failed", { error: String(error) })
      }
    } else {
      log("[opencode-v2] tui sidebar disabled by config", { directory })
    }

    try {
      disposers.push(registerTuiBtw(ctx, { solid }).dispose)
    } catch (error) {
      log("[opencode-v2] tui btw-side registration failed", { error: String(error) })
    }

    log("[opencode-v2] tui registered", {
      directory,
      regions: disposers.length,
    })

    // Synchronous by design: an exiting TUI does not await plugin cleanups, so every registration
    // the host owns is released here without a promise boundary.
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          log("[opencode-v2] tui dispose failed", { error: String(error) })
        }
      }
      log("[opencode-v2] tui disposed", {})
    }
  },
})
