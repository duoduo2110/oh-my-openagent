import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { PLUGIN_NAME } from "../../shared"
import { addPluginToOpenCodeConfig } from "./add-plugin-to-opencode-config"
import { detectCurrentConfig } from "./detect-current-config"
import { initConfigContext, resetConfigContext } from "./config-context"
import * as pluginNameWithVersion from "./plugin-name-with-version"
import { ensureV2CliPluginEntry, pluginSpecName } from "./v2-plugin-config"
import { isOpenCodeV2Host } from "./v2-host"

const tempDirs: string[] = []

function tempConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "omo-v2-config-"))
  tempDirs.push(dir)
  return dir
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8")
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
}

function useConfigDir(dir: string): void {
  process.env.OPENCODE_CONFIG_DIR = dir
  resetConfigContext()
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  resetConfigContext()
  delete process.env.OPENCODE_CONFIG_DIR
})

describe("isOpenCodeV2Host", () => {
  it("#given a 2.x version #when asking the host generation #then it reports V2", () => {
    expect(isOpenCodeV2Host("2.1.4")).toBe(true)
    expect(isOpenCodeV2Host("2.0.0-beta.3")).toBe(true)
  })

  it("#given a 1.x version or no version #when asking the host generation #then it stays on V1", () => {
    expect(isOpenCodeV2Host("1.19.4")).toBe(false)
    expect(isOpenCodeV2Host(null)).toBe(false)
  })

  it("#given no probed version #when the config context is empty #then it does not guess V2", () => {
    resetConfigContext()
    expect(isOpenCodeV2Host()).toBe(false)
  })
})

describe("addPluginToOpenCodeConfig on an OpenCode 2 host", () => {
  let configDir = ""
  let getPluginNameWithVersionSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    configDir = tempConfigDir()
    useConfigDir(configDir)
    // A 2.x host: the version the installer probed is what decides the config shape.
    initConfigContext("opencode", "2.1.4")
    getPluginNameWithVersionSpy = spyOn(pluginNameWithVersion, "getPluginNameWithVersion")
      .mockResolvedValue(`${PLUGIN_NAME}@5.1.48`)
  })

  afterEach(() => {
    getPluginNameWithVersionSpy.mockRestore()
  })

  it("#given a fresh config #when installing #then it writes the V2 plugins key and the cli.json TUI entry", async () => {
    // given
    writeJson(join(configDir, "opencode.json"), {})

    // when
    const result = await addPluginToOpenCodeConfig("5.1.48")

    // then
    expect(result.success).toBe(true)
    const serverConfig = readJson(join(configDir, "opencode.json"))
    expect(serverConfig.plugins).toEqual([{ package: `${PLUGIN_NAME}@5.1.48` }])
    expect(serverConfig.plugin).toBeUndefined()

    const cliConfig = readJson(join(configDir, "cli.json"))
    expect(cliConfig.plugins).toEqual([`${PLUGIN_NAME}@5.1.48`])
    expect(existsSync(join(configDir, "tui.json"))).toBe(false)
  })

  it("#given a config without a file #when installing #then it creates a V2-only server config", async () => {
    // when
    const result = await addPluginToOpenCodeConfig("5.1.48")

    // then
    expect(result.success).toBe(true)
    const serverConfig = readJson(join(configDir, "opencode.json"))
    expect(serverConfig.plugins).toEqual([{ package: `${PLUGIN_NAME}@5.1.48` }])
    expect(serverConfig.plugin).toBeUndefined()
  })

  it("#given foreign entries and other keys #when installing twice #then foreign entries survive and nothing duplicates", async () => {
    // given
    writeJson(join(configDir, "opencode.json"), {
      $schema: "https://opencode.ai/config.json",
      theme: "dark",
      plugins: [{ package: "someone-else@1.2.3" }],
    })
    writeJson(join(configDir, "cli.json"), { theme: "dark", plugins: ["someone-else"] })

    // when
    const first = await addPluginToOpenCodeConfig("5.1.48")
    const cliAfterFirst = readFileSync(join(configDir, "cli.json"), "utf-8")
    const second = await addPluginToOpenCodeConfig("5.1.48")

    // then
    expect(first.success).toBe(true)
    expect(second.success).toBe(true)
    const serverConfig = readJson(join(configDir, "opencode.json"))
    expect(serverConfig.plugins).toEqual([
      { package: "someone-else@1.2.3" },
      { package: `${PLUGIN_NAME}@5.1.48` },
    ])
    expect(serverConfig.theme).toBe("dark")
    const cliConfig = readJson(join(configDir, "cli.json"))
    expect(cliConfig.plugins).toEqual(["someone-else", `${PLUGIN_NAME}@5.1.48`])
    expect(cliConfig.theme).toBe("dark")
    expect(readFileSync(join(configDir, "cli.json"), "utf-8")).toBe(cliAfterFirst)
  })

  it("#given a config that still carries the V1 plugin key #when installing on V2 #then our entry moves to plugins and the V1 key is dropped", async () => {
    // given
    writeJson(join(configDir, "opencode.json"), {
      plugin: [`${PLUGIN_NAME}@5.0.0`, "someone-else"],
    })

    // when
    const result = await addPluginToOpenCodeConfig("5.1.48")

    // then
    expect(result.success).toBe(true)
    const serverConfig = readJson(join(configDir, "opencode.json"))
    expect(serverConfig.plugins).toEqual([{ package: `${PLUGIN_NAME}@5.1.48` }])
    // A foreign V1 entry is not ours to rewrite.
    expect(serverConfig.plugin).toEqual(["someone-else"])
  })

  it("#given a jsonc config with comments #when installing on V2 #then comments survive and the plugins key is added", async () => {
    // given
    const jsoncPath = join(configDir, "opencode.jsonc")
    writeFileSync(jsoncPath, `{\n  // keep me\n  "theme": "dark"\n}\n`, "utf-8")

    // when
    const result = await addPluginToOpenCodeConfig("5.1.48")

    // then
    expect(result.success).toBe(true)
    const content = readFileSync(jsoncPath, "utf-8")
    expect(content).toContain("// keep me")
    expect(content).toContain('"plugins"')
    expect(existsSync(join(configDir, "opencode.json"))).toBe(false)
  })
})

describe("addPluginToOpenCodeConfig on an OpenCode 1.x host", () => {
  let configDir = ""
  let getPluginNameWithVersionSpy: ReturnType<typeof spyOn>

  beforeEach(() => {
    configDir = tempConfigDir()
    useConfigDir(configDir)
    initConfigContext("opencode", "1.19.4")
    getPluginNameWithVersionSpy = spyOn(pluginNameWithVersion, "getPluginNameWithVersion")
      .mockResolvedValue(`${PLUGIN_NAME}@5.1.48`)
  })

  afterEach(() => {
    getPluginNameWithVersionSpy.mockRestore()
  })

  it("#given a 1.x host #when installing #then the V1 plugin key is written and no V2 files appear", async () => {
    // given
    writeJson(join(configDir, "opencode.json"), { theme: "dark" })

    // when
    const result = await addPluginToOpenCodeConfig("5.1.48")

    // then
    expect(result.success).toBe(true)
    const serverConfig = readJson(join(configDir, "opencode.json"))
    expect(serverConfig.plugin).toEqual([`${PLUGIN_NAME}@5.1.48`])
    expect(serverConfig.plugins).toBeUndefined()
    expect(serverConfig.theme).toBe("dark")
    expect(existsSync(join(configDir, "cli.json"))).toBe(false)
  })
})

describe("detectCurrentConfig on an OpenCode 2 host", () => {
  it("#given a V2 server config #when detecting #then the plugin counts as installed", () => {
    // given
    const configDir = tempConfigDir()
    useConfigDir(configDir)
    initConfigContext("opencode", "2.1.4")
    writeJson(join(configDir, "opencode.json"), { plugins: [{ package: `${PLUGIN_NAME}@5.1.48` }] })

    // when
    const detected = detectCurrentConfig()

    // then
    expect(detected.isInstalled).toBe(true)
    expect(detected.installedVersion).toBe("5.1.48")
  })

  it("#given a V2 config without our entry #when detecting #then it is not installed", () => {
    // given
    const configDir = tempConfigDir()
    useConfigDir(configDir)
    initConfigContext("opencode", "2.1.4")
    writeJson(join(configDir, "opencode.json"), { plugins: [{ package: "someone-else" }] })

    // when
    const detected = detectCurrentConfig()

    // then
    expect(detected.isInstalled).toBe(false)
  })
})

describe("ensureV2CliPluginEntry", () => {
  it("#given no cli.json #when ensuring the TUI entry #then it creates the file once", () => {
    // given
    const dir = tempConfigDir()

    // when
    const first = ensureV2CliPluginEntry({ configDir: dir, entry: PLUGIN_NAME })
    const second = ensureV2CliPluginEntry({ configDir: dir, entry: PLUGIN_NAME })

    // then
    expect(first).toEqual({ changed: true, reason: "added" })
    expect(second).toEqual({ changed: false, reason: "already-present" })
    expect(readJson(join(dir, "cli.json")).plugins).toEqual([PLUGIN_NAME])
  })

  it("#given our entry under another version #when ensuring #then it rewrites instead of appending a second copy", () => {
    // given
    const dir = tempConfigDir()
    writeJson(join(dir, "cli.json"), { plugins: [`${PLUGIN_NAME}@5.0.0`, "someone-else"] })

    // when
    const result = ensureV2CliPluginEntry({ configDir: dir, entry: `${PLUGIN_NAME}@5.1.48` })

    // then
    expect(result).toEqual({ changed: true, reason: "added" })
    expect(readJson(join(dir, "cli.json")).plugins).toEqual(["someone-else", `${PLUGIN_NAME}@5.1.48`])
  })

  it("#given a local package entry #when ensuring #then the file spec is used as-is", () => {
    // given
    const dir = tempConfigDir()

    // when
    const result = ensureV2CliPluginEntry({ configDir: dir, entry: "file:/tmp/omo-plugin" })

    // then
    expect(result).toEqual({ changed: true, reason: "added" })
    expect(readJson(join(dir, "cli.json")).plugins).toEqual(["file:/tmp/omo-plugin"])
  })

  it("#given a cli.json whose plugins is not an array #when ensuring #then it is left untouched", () => {
    // given
    const dir = tempConfigDir()
    writeJson(join(dir, "cli.json"), { plugins: "oh-my-openagent" })

    // when
    const result = ensureV2CliPluginEntry({ configDir: dir, entry: PLUGIN_NAME })

    // then
    expect(result).toEqual({ changed: false, reason: "malformed" })
    expect(readJson(join(dir, "cli.json")).plugins).toBe("oh-my-openagent")
  })
})

describe("pluginSpecName", () => {
  it("#given package specs #when normalizing #then the version tag is dropped", () => {
    expect(pluginSpecName(`${PLUGIN_NAME}@5.1.48`)).toBe(PLUGIN_NAME)
    expect(pluginSpecName(PLUGIN_NAME)).toBe(PLUGIN_NAME)
    expect(pluginSpecName("file:/tmp/omo")).toBe("file:/tmp/omo")
  })
})
