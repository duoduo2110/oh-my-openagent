import color from "picocolors"
import type { DoctorResult } from "./types"
import { SYMBOLS, UPDATE_COMMANDS, LATEST_UNAVAILABLE_TEXT } from "./constants"
import { formatHeader, formatIssue } from "./format-shared"

function formatOkSummary(result: DoctorResult, headline: string, installedVersion: string): string[] {
  const latest = result.latestVersion ?? LATEST_UNAVAILABLE_TEXT
  return [
    ` ${color.green(SYMBOLS.check)} ${color.green(
      `${headline} · Installed: ${installedVersion} · Latest: ${latest}`
    )}`,
    `   Update: ${UPDATE_COMMANDS.opencode}`,
  ]
}

export function formatDefault(result: DoctorResult): string {
  const lines: string[] = []

  lines.push(formatHeader())

  const allIssues = result.results.flatMap((r) => r.issues)

  if (allIssues.length === 0) {
    const pluginVer = result.systemInfo.pluginVersion ?? "unknown"
    lines.push(...formatOkSummary(result, "System OK", pluginVer))
  } else {
    const issueCount = allIssues.filter((i) => i.severity === "error").length
    const warnCount = allIssues.filter((i) => i.severity === "warning").length

    const totalStr = `${issueCount + warnCount} ${issueCount + warnCount === 1 ? "issue" : "issues"}`
    lines.push(` ${color.yellow(SYMBOLS.warn)} ${totalStr} found:\n`)

    allIssues.forEach((issue, index) => {
      lines.push(formatIssue(issue, index + 1))
      lines.push("")
    })
  }

  return lines.join("\n")
}
