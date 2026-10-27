import type { Context } from "@opencode/plugin/tui/plugin"

/** OpenCode 2's TUI plugin context, under a local name. */
export type V2TuiContext = Context

/**
 * `ctx.location.directory`, with the data layer's default location as the fallback. A host that
 * cannot build a location still gets a usable directory instead of an empty sidebar.
 */
export function tuiDirectory(ctx: Context): string {
  const fromLocation = (ctx.location as { readonly directory?: unknown } | undefined)?.directory
  if (typeof fromLocation === "string" && fromLocation.length > 0) return fromLocation
  try {
    const fallback = ctx.data.location.default()
    if (typeof fallback?.directory === "string" && fallback.directory.length > 0) {
      return fallback.directory
    }
  } catch {
    // fall through to cwd
  }
  return process.cwd()
}

/**
 * Whether the context carries the surfaces the V2 TUI port needs. A minimal V1-shaped or test
 * context answers false, and the entry keeps the startup notice without pretending to wire UI.
 */
export function hasTuiSurface(ctx: Context): boolean {
  const candidate = ctx as {
    readonly ui?: { readonly slot?: unknown; readonly toast?: { readonly show?: unknown } }
    readonly keymap?: { readonly layer?: unknown }
    readonly data?: { readonly on?: unknown }
  }
  return (
    typeof candidate.ui?.slot === "function" &&
    typeof candidate.ui?.toast?.show === "function" &&
    typeof candidate.keymap?.layer === "function" &&
    typeof candidate.data?.on === "function"
  )
}
