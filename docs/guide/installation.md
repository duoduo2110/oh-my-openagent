# Installation

oh-my-openagent (OmO) is an OpenCode plugin. Everything below installs into OpenCode; there is no separate binary to install.

> OpenCode 2 support is being ported. The plugin loads on OpenCode 2, but its agents, tools and hooks are not active there yet. Use OpenCode 1.x for the full plugin.

## Requirements

- [OpenCode](https://opencode.ai/docs) 1.4.0 or newer
- [Bun](https://bun.sh) 1.4 or newer (or `npx`)

## Install

```bash
bunx oh-my-opencode install
```

The installer adds `oh-my-openagent` to your OpenCode config (`~/.config/opencode/opencode.json`), writes `~/.omo/omo.jsonc` for model assignments, links the TUI plugin, and installs the `ast-grep` helper it uses for code search.

Non-interactive:

```bash
bunx oh-my-opencode install --no-tui --claude=max20 --openai=yes --gemini=yes --copilot=no
```

Required non-interactive flags: `--claude`, `--gemini`, `--copilot`. Optional provider flags: `--openai`, `--opencode-zen`, `--zai-coding-plan`, `--kimi-for-coding`, `--opencode-go`, `--bailian-coding-plan`, `--minimax-cn-coding-plan`, `--minimax-coding-plan`, `--vercel-ai-gateway`.

The installer prints the model assignment it wrote. `~/.omo/omo.jsonc` is the file to edit when you want a different model, provider or per-agent override.

## Verify

```bash
bunx oh-my-opencode doctor
```

`doctor` reports the OpenCode binary and version, the plugin entry, the TUI plugin entry, the model resolution for each agent, the bundled tools (LSP, ast-grep, comment checker, MCP) and telemetry state. `--status` prints a compact dashboard, `--json` prints machine-readable output.

Start OpenCode afterwards and ask for something small first:

```bash
opencode
```

## Authentication

OmO never stores provider credentials itself; it uses OpenCode's:

```bash
opencode auth login
```

Pick Anthropic for Claude Pro/Max, Google for Gemini, or GitHub for Copilot. Subscription flags you passed to the installer only decide which models the generated config points at.

## Update

```bash
bunx oh-my-opencode@latest install
```

Re-running the installer is safe: it keeps your provider choices, rewrites the plugin entry to the current version and refreshes OpenCode's plugin cache so the next start loads the installed build. `bunx oh-my-opencode get-local-version` shows the installed version, the latest one, and whether a pinned version is suppressing updates.

## Uninstall

Remove the `oh-my-openagent` entry from `~/.config/opencode/opencode.json`, then delete `~/.omo/omo.jsonc` if you no longer want the model assignments.

## Configuration

- `~/.config/opencode/opencode.json` - OpenCode config, including the plugin entry.
- `~/.omo/omo.jsonc` - OmO config: models per agent, categories, and feature switches. See [omo.json Configuration Reference](../reference/omo-json.md).
- Project overrides live in `<project>/.omo/omo.jsonc`.

## Troubleshooting

- `doctor` reports the plugin as not loaded: restart OpenCode after installing; OpenCode caches the plugin per installed spec.
- A model resolves to a fallback: run `doctor --verbose` to see which provider key is missing, then `opencode auth login`.
- LSP tools stay disabled: the bundled LSP needs a language server on `PATH`; `doctor` lists what it found.

## Telemetry

Anonymous usage telemetry is on by default. Disable it with `OMO_SEND_ANONYMOUS_TELEMETRY=0` or `OMO_DISABLE_POSTHOG=1`. Details: [privacy policy](../legal/privacy-policy.md).
