import { createInterface } from "node:readline/promises"
import color from "picocolors"
import { PLUGIN_NAME, PUBLISHED_PACKAGE_NAME } from "../shared"
import type { InstallArgs } from "./types"
import {
  addPluginToOpenCodeConfig,
  detectCurrentConfig,
  getOpenCodeVersion,
  isOpenCodeInstalled,
  writeOmoConfig,
} from "./config-manager"
import {
  SYMBOLS,
  argsToConfig,
  detectedToInitialValues,
  formatConfigSummary,
  printBox,
  printError,
  printHeader,
  printInfo,
  printStep,
  printSuccess,
  printWarning,
  validateNonTuiArgs,
} from "./install-validators"
import { getUnsupportedOpenCodeVersionMessage } from "./minimum-opencode-version"
import { starGitHubRepositories } from "./star-request"
import { getNoModelProvidersWarning, hasAnyConfiguredProvider } from "./provider-availability"
import { ensureTuiPluginEntry } from "./config-manager/add-tui-plugin-to-tui-config"
import { isOpenCodeV2Host } from "./config-manager/v2-host"
import { refreshOpenCodePluginSandboxes } from "./config-manager/refresh-opencode-plugin-sandbox"
import * as astGrepInstall from "./install-ast-grep-sg"

export async function runCliInstaller(args: InstallArgs, version: string): Promise<number> {
  const validation = validateNonTuiArgs(args)
  if (!validation.valid) {
    printHeader(false)
    printError("Validation failed:")
    for (const err of validation.errors) {
      console.log(`  ${SYMBOLS.bullet} ${err}`)
    }
    console.log()
    printInfo(
      `Usage: bunx ${PUBLISHED_PACKAGE_NAME} install --no-tui --claude=<no|yes|max20> --gemini=<no|yes> --copilot=<no|yes>`,
    )
    console.log()
    return 1
  }

  const config = argsToConfig(args)
  const hasOpenCode = config.hasOpenCode
  const detected = hasOpenCode
    ? detectCurrentConfig()
    : {
        isInstalled: false,
        installedVersion: null,
        hasClaude: false,
        isMax20: false,
        hasOpenAI: false,
        hasGemini: false,
        hasCopilot: false,
        hasOpencodeZen: false,
        hasZaiCodingPlan: false,
        hasKimiForCoding: false,
        hasOpencodeGo: false,
        hasBailianCodingPlan: false,
        hasMinimaxCnCodingPlan: false,
        hasMinimaxCodingPlan: false,
        hasVercelAiGateway: false,
      }
  const isUpdate = hasOpenCode && detected.isInstalled

  printHeader(isUpdate)

  const totalSteps = hasOpenCode ? 4 : 2
  let step = 1

  if (hasOpenCode) {
    printStep(step++, totalSteps, "Checking OpenCode installation...")
    const installed = await isOpenCodeInstalled()
    const openCodeVersion = await getOpenCodeVersion()
    if (!installed) {
      printWarning(
        "OpenCode binary not found. Plugin will be configured, but you'll need to install OpenCode to use it.",
      )
      printInfo("Visit https://opencode.ai/docs for installation instructions")
    } else {
      printSuccess(`OpenCode ${openCodeVersion ?? ""} detected`)

      const unsupportedVersionMessage = getUnsupportedOpenCodeVersionMessage(openCodeVersion)
      if (unsupportedVersionMessage) {
        printWarning(unsupportedVersionMessage)
        return 1
      }
    }
  }

  if (isUpdate) {
    const initial = detectedToInitialValues(detected)
    printInfo(`Current config: Claude=${initial.claude}, Gemini=${initial.gemini}`)
  }

  if (hasOpenCode) {
    printStep(step++, totalSteps, `Adding ${PLUGIN_NAME} plugin...`)
    const pluginResult = await addPluginToOpenCodeConfig(version)
    if (!pluginResult.success) {
      printError(`Failed: ${pluginResult.error}`)
      return 1
    }
    printSuccess(
      `Plugin ${isUpdate ? "verified" : "added"} ${SYMBOLS.arrow} ${color.dim(pluginResult.configPath)}`,
    )
    // OpenCode 2 keeps its TUI plugin list in `cli.json` (written by addPluginToOpenCodeConfig);
    // `tui.json` is the 1.x shape and must not be written for a 2.x host.
    if (!isOpenCodeV2Host()) {
      try {
        ensureTuiPluginEntry()
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        printWarning(`Could not update OpenCode TUI config: ${message}`)
      }
    }
    // OpenCode's Npm.add() never re-resolves a tag while its per-spec sandbox
    // exists, so a stale sandbox would keep serving the previous version even
    // after this install. Remove the sandboxes for the spec(s) just written;
    // the next OpenCode start reinstalls the current channel version (#5367).
    try {
      const { removed, deferred, failed } = refreshOpenCodePluginSandboxes()
      if (removed.length > 0) {
        printInfo("Refreshed the OpenCode plugin cache; the next OpenCode start loads the installed version.")
      }
      if (deferred.length > 0) {
        printInfo("OpenCode is running from its plugin cache; it refreshes when the last OpenCode window closes. Restart OpenCode to load the installed version.")
      }
      for (const { dir, message } of failed) {
        printWarning(`Could not refresh the OpenCode plugin cache at ${dir} (${message}). Close OpenCode and delete that directory, or OpenCode keeps loading the previous version.`)
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      printWarning(`Could not refresh the OpenCode plugin cache: ${message}`)
    }

    printStep(step++, totalSteps, `Writing ${PLUGIN_NAME} configuration...`)
    const omoResult = writeOmoConfig(config)
    if (!omoResult.success) {
      printError(`Failed: ${omoResult.error}`)
      return 1
    }
    printSuccess(`Config written ${SYMBOLS.arrow} ${color.dim(omoResult.configPath)}`)
    await astGrepInstall.installAstGrepForOpenCode({ log: printWarning })
  }

  printBox(formatConfigSummary(config), isUpdate ? "Updated Configuration" : "Installation Complete")

  if (config.hasOpenCode && !config.hasClaude) {
    printInfo(
      "Note: Sisyphus agent performs best with Claude Opus 5. " +
        "Other models work but may have reduced orchestration quality.",
    )
  }

  if (config.hasOpenCode && !hasAnyConfiguredProvider(config)) {
    printWarning(getNoModelProvidersWarning())
  }

  console.log(`${SYMBOLS.star} ${color.bold(color.green(isUpdate ? "Configuration updated!" : "Installation complete!"))}`)
  if (hasOpenCode) {
    console.log(`  Run ${color.cyan("opencode")} to start!`)
  }
  console.log()

  printInfo(
    "Anonymous telemetry is enabled by default. Disable it with OMO_SEND_ANONYMOUS_TELEMETRY=0 or OMO_DISABLE_POSTHOG=1.",
  )
  printInfo("Docs: docs/legal/privacy-policy.md and docs/legal/terms-of-service.md")
  console.log()

  printBox(
    `${color.bold("Pro Tip:")} Include ${color.cyan("ultrawork")} (or ${color.cyan("ulw")}) in your prompt.\n` +
      `All features work like magic-parallel agents, background tasks,\n` +
      `deep exploration, and relentless execution until completion.`,
    "The Magic Word",
  )

  if (args.tui) {
    await maybePromptForGitHubStars()
  }
  console.log(color.dim("oMoMoMoMo... Enjoy!"))
  console.log()

  if (hasOpenCode && (config.hasClaude || config.hasGemini || config.hasCopilot) && !args.skipAuth) {
    printBox(
      `Run ${color.cyan("opencode auth login")} and select your provider:\n` +
        (config.hasClaude ? `  ${SYMBOLS.bullet} Anthropic ${color.gray("→ Claude Pro/Max")}\n` : "") +
        (config.hasGemini ? `  ${SYMBOLS.bullet} Google ${color.gray("→ Gemini")}\n` : "") +
        (config.hasCopilot ? `  ${SYMBOLS.bullet} GitHub ${color.gray("→ Copilot")}` : ""),
      "Authenticate Your Providers",
    )
  }

  return 0
}

async function maybePromptForGitHubStars(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return

  const readline = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await readline.question(`${SYMBOLS.star} ${color.yellow("Star the repos on GitHub?")} ${color.dim("[y/N]")} `)
    if (!isYes(answer)) return
  } finally {
    readline.close()
  }

  const results = await starGitHubRepositories()
  const failed = results.filter((result) => !result.ok)
  if (failed.length === 0) {
    printSuccess("Starred GitHub repositories")
    console.log()
    return
  }

  printWarning("Could not star every repository. Make sure GitHub CLI is installed and authenticated.")
  for (const result of failed) {
    console.log(`  ${SYMBOLS.bullet} ${result.repository}`)
  }
  console.log()
}

function isYes(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return normalized === "y" || normalized === "yes"
}
