import type { ResolvedTheme } from "@opencode/theme/tui"

/**
 * The flat palette `features/tui-sidebar/render-view.ts` reads. OpenCode 2 replaced V1's
 * `theme.current` (flat RGBA fields) with a resolved token tree, so the sidebar keeps its own
 * vocabulary and this adapter is the single place the two meet.
 *
 * `accent` has no direct V1 twin: it maps onto the middle step of OpenCode 2's accent hue, which is
 * the same emphasis V1's accent colour carried.
 */
export type TuiSidebarTheme = {
  readonly text: unknown
  readonly textMuted: unknown
  readonly borderSubtle: unknown
  readonly info: unknown
  readonly accent: unknown
  readonly success: unknown
  readonly warning: unknown
  readonly error: unknown
}

export const EMPTY_SIDEBAR_THEME: TuiSidebarTheme = {
  text: undefined,
  textMuted: undefined,
  borderSubtle: undefined,
  info: undefined,
  accent: undefined,
  success: undefined,
  warning: undefined,
  error: undefined,
}

export function toSidebarTheme(theme: ResolvedTheme | undefined): TuiSidebarTheme {
  if (theme === undefined) return EMPTY_SIDEBAR_THEME
  const feedback = theme.text.feedback
  return {
    text: theme.text.base,
    textMuted: theme.text.muted,
    borderSubtle: theme.border.base,
    info: feedback.info.base,
    accent: theme.hue.accent[500],
    success: feedback.success.base,
    warning: feedback.warning.base,
    error: feedback.error.base,
  }
}
