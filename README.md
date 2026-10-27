[English](README.md) | [简体中文](README.zh-cn.md)

# oh-my-openagent

An [OpenCode](https://opencode.ai/docs) plugin: multi-model orchestration, background agents, LSP and AST tools, and a large skill library.

- **OpenCode 1.x** - fully supported.
- **OpenCode 2** - support is being ported. The plugin loads, but its agents, tools and hooks are not active there yet.

## Install

```bash
bunx oh-my-opencode install
```

The installer registers the plugin in `~/.config/opencode/opencode.json`, writes `~/.omo/omo.jsonc` for model assignments, links the TUI plugin and installs the bundled `ast-grep` helper. Non-interactive installs need `--claude`, `--gemini` and `--copilot`:

```bash
bunx oh-my-opencode install --no-tui --claude=max20 --openai=yes --gemini=yes --copilot=no
```

Then run `opencode` in your project. Ask for something small first.

## Check the install

```bash
bunx oh-my-opencode doctor
```

`doctor` reports the OpenCode version, the plugin and TUI entries, model resolution per agent, bundled tools and telemetry state. Add `--status` for the compact dashboard or `--json` for machine-readable output.

## What the plugin adds

- **Agents** - Sisyphus and friends: an orchestrator plus specialised review, research and implementation agents.
- **Background work** - delegate tasks that keep running while your session continues.
- **Tools** - LSP navigation and diagnostics, AST-grep search and rewrite, hashline edits, a comment checker.
- **Skills and commands** - `ulw` / `ultrawork` planning and execution loops, review workflows, and per-project overrides.
- **Configuration** - `~/.omo/omo.jsonc`: models per agent, categories and feature switches. Schema: [`assets/omo.schema.json`](assets/omo.schema.json).

## Docs

- [Installation](docs/guide/installation.md)
- [CLI reference](docs/reference/cli.md)
- [Configuration](docs/reference/omo-json.md)
- [Orchestration](docs/guide/orchestration.md)
- [Telemetry and privacy](docs/legal/privacy-policy.md)

## Development

Every build and test runs in Docker; the host never installs dependencies:

```bash
scripts/v2/docker.sh install
scripts/v2/docker.sh typecheck
scripts/v2/docker.sh build-plugin
scripts/v2/docker.sh e2e-load
```

## License

[SUL-1.0](LICENSE.md)
