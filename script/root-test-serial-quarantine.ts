// Single source of truth for the root-test files that must run in one serial
// process before the rest of the suite runs under `bun test --parallel`.
//
// Every CI leg that parallelizes the root suite runs this exact list serially
// first, then parallelizes the remainder with a bunfig whose pathIgnorePatterns
// contain these same paths. Three legs (Windows shard 2, Linux, macOS) consume
// the list, so it lives here instead of being pasted into each one; the
// contract test in script/ci-root-test-partition.test.ts pins the workflow
// commands and both bunfig configs against this array.
//
// Entries are removed only when the underlying isolation requirement is fixed
// at its root, never to make a leg faster.

export interface SerialQuarantineEntry {
  /** Repo-relative test path, exactly as bun test and pathIgnorePatterns spell it. */
  readonly path: string
  /** Why this file cannot share a process pool with the rest of the suite. */
  readonly reason: string
}

export const ROOT_TEST_SERIAL_QUARANTINE: readonly SerialQuarantineEntry[] = [
  {
    path: "packages/shared-skills/provenance-gate.test.ts",
    reason: "walks the whole shared-skills tree and is starved by concurrent filesystem load",
  },
  {
    path: "script/release-version.test.ts",
    reason: "five sequential Git Bash spawns of the publish workflow's metadata step; one spawn exhausted its 10s budget under Windows --parallel while the test's own work is string parsing (run 34962017319)",
  },
] as const

/** Quarantined paths in workflow/bunfig order. */
export const ROOT_TEST_SERIAL_QUARANTINE_PATHS: readonly string[] =
  ROOT_TEST_SERIAL_QUARANTINE.map((entry) => entry.path)

/**
 * Per-file test budget for the sequential POSIX legs. Bun applies a preload's setDefaultTimeout to
 * the first file only, so every multi-file `bun test` in CI passes the flag explicitly; this is the
 * POSIX value, matched by test-setup.ts (20s) and the Windows wrapper (30s).
 */
export const POSIX_TEST_TIMEOUT_MS = 20_000

/** The serial `bun test` argument list each parallel leg runs before its parallel pass. */
export function serialQuarantineCommand(): string {
  return `bun test --timeout ${POSIX_TEST_TIMEOUT_MS} ${ROOT_TEST_SERIAL_QUARANTINE_PATHS.join(" ")}`
}
