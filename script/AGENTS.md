# script/ -- Build/Publish Automation

**Generated:** 2026-08-24

## OVERVIEW

Build, publish, QA, and repo-invariant automation. Run via `bun run <script>` from root package.json. Singular directory name (not "scripts/" -- the root `scripts/` dir holds node helpers like `check-third-party-notices.mjs`).

## SCRIPTS (top-level)

| File | Purpose |
|------|---------|
| `build-binaries.ts` | Writes 12 generated Node launcher packages for darwin/linux/windows (AVX2 + baseline) |
| `build-cli-node.ts` | Node-runtime CLI bundle (`dist/cli-node`) for environments without Bun |
| `build.ts` | Main build entry (`bun run build`) |
| `build-codex-install.ts` | Bundle the Codex installer entrypoints into `packages/omo-codex/scripts/install-dist/`. Also embeds a source-freshness marker (`// omo-codex-install:<sourceDigest>:<bodyDigest>`) as line 2 of the generated bundle and exports `buildCodexInstaller()` / `digestCodexInstallerSources()` / `parseCodexInstallerArtifact()` for non-destructive freshness checks; guarded by `import.meta.main` |
| `build-omo-schema.ts` + `build-omo-schema-document.ts` | Generate the unified OMO config schema + companion document |
| `ensure-vendored-lsp-daemon.ts` | Build/watch the vendored LSP daemon (daemon bin + lock-dir watch) |
| `test-fast.ts` | `bun run test:fast` partitioned suite: `opencode-memory` -> `senpi` -> root-rest via `bunfig.win2.toml`. Groups run detached (own process groups) and are killed with the parent on SIGINT/SIGTERM; a spawned group inherits `OMO_TEST_FAST_ACTIVE=1` and re-entry refuses to recurse |
| `ci-fast-path.mjs` | CI skip classifier (`classifyCiMode`): runtime-touching paths (`isRuntimePath`: every path except an explicit allowlist of web, prose such as top-level Markdown and README/CHANGELOG/AGENTS-style Markdown outside `packages/*/src`, and listed repository metadata) are reported but no longer select the OS matrix; on pull requests only platform-specific paths force the full OS matrix: every path a macOS/Windows-only `ci.yml` step names (derived by `ci-platform-invocations.mjs`, guarded by `ci-platform-invocations.test.ts`), plus native crates and Cargo files, the launcher `bin/`, platform packages and native packaging, the Windows Git Bash runtime, the Codex installer, windows/win32/darwin/macos/.platform. basenames, the CI workflows, `.github/actions/` and `.github/scripts/`, as do the `run-full-ci` / `ci:full-matrix` labels, while pushes and merge groups always run it (#10856) |
| `ci-leg-tests-guard.mjs` | Last step of every OS test leg (`judgeLeg`): fails a leg whose required tests were all skipped; points to the optional label run for diagnosis and a push/reopen with the label for required checks; passes an intended skip with a notice and job-summary line |
| `telemetry-schema-block.mjs` | Generate the telemetry schema doc block (`generateTelemetrySchemaBlock`) |
| `remove-stale-self-package-tests.ts` | Prune self-package tests that reference deleted sources |
| `agent-command-string-scan.ts` | Scan tracked sources for unsafe agent command strings; allowlisted exceptions live in `agent-command-string-audit.allowlist.json` |
| `verify-npm-payload.mjs` | npm payload verification |
| `build-help-schemas.ts` | Generate CLI help schemas |
| `build-schema.ts` + `build-schema-document.ts` | Zod schema to JSON Schema for `assets/oh-my-opencode.schema.json` |
| `json-schema-defaulted-optional.ts` | Drops Zod-defaulted fields from generated `required` so both config schemas accept configs that omit them (#6445) |
| `build-model-capabilities.ts` | Refresh the generated model-capabilities artifact consumed by `packages/model-core/` |
| `patch-node-require-shim.ts` | Patches `dist/index.js` for Node/Electron require compatibility |
| `publish.ts` | Local multi-package publish alternative (platform packages + npm) |
| `generate-changelog.ts` | Release notes from git log, filters bot commits (imports `RELEASE_VERSION_PATTERN` from `release-latest-flag.ts`) |
| `stats.ts` | npm + GitHub-release download counts (`gh api --paginate --slurp`; weekly `stats.yml`) |
| `update-frontend-upstreams.mjs` | Bump shared-skills submodules + rewrite ATTRIBUTION pins (`--check` verifies) |

## SUBDIRS

- `fixtures/` -- shared script test fixtures (vendored LSP build owner).
- `agent/` -- dev-env contract: `setup.sh`, `cleanup.sh`, `cleanup-hook.sh`, `docker-dev.sh`, `qa-sandbox.sh`, `qa-docker.sh` (see root AGENTS.md DEVELOPMENT ENVIRONMENT).

## TESTS (61 `*.test.ts`)

The `ci:full-matrix` label launches the separate `ci-full-matrix-label.yml` caller; its `full-matrix / ...` checks are optional and do not gate merge. Keep the label and push a commit or reopen the PR to run the full matrix in required checks. Normal `ci.yml` does not trigger on labels. `ci-label-workflow-policy.test.ts` guards target branches, distinct workflow identity, the reusable call, and concurrency behind the exact job label gate. The classifier still receives the caller's PR labels.


| File | Invariant |
|------|-----------|
| `package-registration-audit.test.ts` | Workspaces registered, devDeps aligned, ROADMAP reverse-dependency edges stay zero, shim inventory complete |
| `shared-core-extraction-guard.test.ts` | `packages/*-core` stay harness-neutral (no harness-adapter imports/deps) |
| `agent-env.test.ts` / `agent-harness-wiring.test.ts` / `agents-md-dev-env.test.ts` | Dev-env scripts, harness wiring files, and the root AGENTS.md DEVELOPMENT ENVIRONMENT section stay in sync |
| `codex-install-bundle-freshness.test.ts` | The COMMITTED Codex installer bundle matches its sources: reads the bundle from the git index (`git show :packages/omo-codex/scripts/install-dist/install-local.mjs`), checks the build marker is present and self-consistent, and asserts the current source digest matches it |
| `agent-command-string-audit.test.ts` (+ `agent-command-string-scan.test.ts`) | Bare/unsafe agent command strings in tracked sources must be allowlisted (`agent-command-string-audit.allowlist.json`, categorized) |
| `ci-root-test-partition.test.ts` / `root-test-config.test.ts` | `ci.yml` root test job and the `bunfig.*.toml` partition stay in sync |
| `root-test-serial-quarantine.ts` | Single source of truth for the test files every parallel CI leg runs serially first, with the documented reason per entry; pinned into both parallel bunfigs and both leg commands by `ci-root-test-partition.test.ts` |
| `test-environment-isolation.test.ts` | The test preload strips `OPENCODE_SERVER_PASSWORD` so credentials never reach tests |

## TSCONFIG

`tsconfig.json` is script-specific (separate from package `src/`). It includes all top-level `script/*.ts` files so build and release automation stay in the Bun-typed TypeScript project instead of falling back to inferred LSP projects. Typechecked via `bun run typecheck:script`.

## NOTE

CI uses plain `bun test`; there is no sharding or split isolation runner.
