#!/usr/bin/env bash
set -euo pipefail
bun test --timeout 20000 packages/shared-skills/provenance-gate.test.ts script/release-version.test.ts
bun --config=bunfig.win2.parallel.toml test --timeout 20000
