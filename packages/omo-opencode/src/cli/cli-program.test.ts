import { describe, test, expect } from "bun:test"
import { readFile } from "node:fs/promises"
import path from "node:path"

describe("cli-program", () => {
  test("install command exposes 'setup' as an alias so the historical install path keeps working", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cli-program.ts"),
      "utf-8",
    )

    // when
    const installBlock = cliProgramSource.match(
      /program\s*\n\s*\.command\("install"\)([\s\S]*?)\.action\(/,
    )

    // then
    expect(installBlock).not.toBeNull()
    expect(installBlock?.[1]).toContain('.alias("setup")')
  })

  test("config migrate command exposes dry-run and JSON-only controls", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cli-program.ts"),
      "utf-8",
    )

    // when
    const migrateBlock = cliProgramSource.match(
      /\.command\("config"\)([\s\S]*?)configureRuntimeCommands/,
    )

    // then
    expect(migrateBlock).not.toBeNull()
    expect(migrateBlock?.[1]).toContain('.command("migrate")')
    expect(migrateBlock?.[1]).toContain('.option("--dry-run"')
    expect(migrateBlock?.[1]).toContain('.option("--json"')
    expect(migrateBlock?.[1]).toContain("runConfigMigrate")
  })

  test("doctor command stays OpenCode-only: no harness/platform selection is offered", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cli-program.ts"),
      "utf-8",
    )

    // when
    const doctorBlock = cliProgramSource.match(
      /program\s*\n\s*\.command\("doctor"\)([\s\S]*?)\.action\(/,
    )

    // then
    expect(doctorBlock).not.toBeNull()
    expect(doctorBlock?.[1]).toContain('.option("--status"')
    expect(doctorBlock?.[1]).toContain('.option("--verbose"')
    expect(doctorBlock?.[1]).toContain('.option("--json"')
    expect(doctorBlock?.[1]).not.toContain("--platform")
    expect(cliProgramSource).not.toContain("resolveDoctorTarget")
    expect(cliProgramSource).not.toContain(".choices([")
  })

  test("cleanup/uninstall is not registered as a Harness-specific command", async () => {
    // given
    const cliProgramSource = await readFile(
      path.resolve(import.meta.dir, "cli-program.ts"),
      "utf-8",
    )

    // then
    expect(cliProgramSource).not.toContain('.command("cleanup")')
    expect(cliProgramSource).not.toContain("cleanup-command")
  })
})

test("program configures explicit '-h, --help' help option for consistent help-flag ordering", async () => {
  // given
  const cliProgramSource = await readFile(
    path.resolve(import.meta.dir, "cli-program.ts"),
    "utf-8",
  )

  // when
  const programBlock = cliProgramSource.match(
    /program\s*\n((?:\s*\.\w+\([^)]*\)\s*\n?)*)/,
  )

  // then
  expect(programBlock).not.toBeNull()
  expect(programBlock?.[1]).toContain('.helpOption("-h, --help", "Display help for command")')
})

test("program registers runtime commands", async () => {
  // given
  const cliProgramSource = await readFile(
    path.resolve(import.meta.dir, "cli-program.ts"),
    "utf-8",
  )

  // when
  const registersRuntimeCommands = cliProgramSource.includes("configureRuntimeCommands(program)")

  // then
  expect(registersRuntimeCommands).toBe(true)
})
