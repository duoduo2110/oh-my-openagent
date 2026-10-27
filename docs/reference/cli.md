# CLI Reference

The `oh-my-opencode` / `oh-my-openagent` / `omo-agent-toolkit` bins are the same CLI, shipped with the plugin.

```bash
bunx oh-my-opencode <command> [options]
```

## Commands

| Command | Purpose |
|---|---|
| `install` (alias `setup`) | Install or update the plugin in OpenCode. `--no-tui` runs non-interactively. |
| `run <message>` | Run an OpenCode session and wait until todos and background tasks finish. |
| `doctor` | Diagnose the installation. `--status`, `--verbose`, `--json`. |
| `get-local-version` | Show the installed version, the latest published version and the update channel. |
| `config migrate` | Migrate legacy OmO configuration into `~/.omo/omo.jsonc`. `--dry-run`, `--json`. |
| `refresh-model-capabilities` | Refresh the cached models.dev capability snapshot. |
| `boulder` | Show boulder progress, elapsed time and per-task statistics. |
| `worktree-sweep` | Report or remove stale linked git worktrees. Dry-run by default; `--apply` removes. |
| `mcp-oauth` | Log in, log out or inspect OAuth state for remote MCP servers. |
| `account-keys` | Manage device keys for the OmO account. |
| `service-auth` | Device-flow login for the hosted OmO service. |
| `version` | Print the plugin version. |

## install

```bash
bunx oh-my-opencode install
bunx oh-my-opencode install --no-tui --claude=max20 --openai=yes --gemini=yes --copilot=no
```

Non-interactive installs require `--claude`, `--gemini` and `--copilot`. Provider flags accept `no` / `yes` (and `max20` for `--claude`). See [Installation](../guide/installation.md).

## run

```bash
bunx oh-my-opencode run "Fix the bug in index.ts"
bunx oh-my-opencode run --agent Sisyphus --model anthropic/claude-sonnet-4 "Implement feature X"
```

`run` differs from `opencode run`: it waits for todo completion and for every child session to go idle. Attach to a running server with `--attach <url>` or pin one with `--port`.

Agent resolution: `--agent`, then `OPENCODE_DEFAULT_AGENT`, then `default_run_agent` in `.omo/omo.jsonc`, then Sisyphus.

## doctor

```bash
bunx oh-my-opencode doctor            # problems only
bunx oh-my-opencode doctor --status   # compact dashboard
bunx oh-my-opencode doctor --verbose  # full detail
bunx oh-my-opencode doctor --json     # machine-readable
```

Exit code is non-zero when a critical check fails: the OpenCode binary, the plugin entry, or the configuration.

## Exit codes

`0` success, `1` failure. `run` forwards the session's own exit status.
