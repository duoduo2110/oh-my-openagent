export type ReportOnlyList = Readonly<Record<string, readonly string[]>>

/** A report-only entry ending in "$" names one temp entry exactly; any other entry is a prefix of the names derived from it. */
export function reportOnlyEntryMatches(entry: string, name: string): boolean {
  return entry.endsWith("$") ? name === entry.slice(0, -1) : name.startsWith(entry)
}

// Windows PowerShell writes an execution-policy probe script to %TEMP% whenever it starts, named
// __PSScriptPolicyTest_ + .NET Path.GetRandomFileName() (8 + 3 lowercase alphanumerics) + .ps1 or .psm1.
// The OS shell creates and abandons it; no test owns it. Anything not exactly that shape is still a leak.
const POWERSHELL_POLICY_PROBE = /^__PSScriptPolicyTest_[a-z0-9]{8}\.[a-z0-9]{3}\.psm?1$/

// Bun extracts a compiled shared library of its own into TMPDIR as `.bun-<pid>-<hex>.so` when it
// dlopens a native addon (bun:ffi / the built-in sqlite path). The runtime creates and abandons it,
// no test owns it, and the hash makes the name unique per build: anything with another shape is a leak.
const BUN_NATIVE_TEMP = /^\.bun-\d+-[0-9a-f]+\.(?:so|dylib|dll)$/

export function isOsCreatedTempEntry(name: string): boolean {
  return POWERSHELL_POLICY_PROBE.test(name) || BUN_NATIVE_TEMP.test(name)
}

export function reportOnlyOwner(name: string, list: ReportOnlyList): string | undefined {
  for (const [owner, entries] of Object.entries(list)) {
    if (entries.some((entry) => reportOnlyEntryMatches(entry, name))) return owner
  }
  return undefined
}
