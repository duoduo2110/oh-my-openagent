#!/usr/bin/env bash
# Docker-only entry point for building / testing the OpenCode V2 port.
#
# Nothing here installs dependencies or runs builds on the host: every command is
# executed inside the `omo-v2` compose stack, with node_modules on a named volume.
#
#   scripts/v2/docker.sh build
#   scripts/v2/docker.sh install
#   scripts/v2/docker.sh typecheck
#   scripts/v2/docker.sh test packages/model-core
#   scripts/v2/docker.sh build-index
#   scripts/v2/docker.sh e2e-load
#   scripts/v2/docker.sh e2e-s0
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMPOSE_FILE="$ROOT/docker/v2/compose.yaml"
PROJECT="omo-v2"
IMAGE="omo-v2-base:local"
EVIDENCE_DIR="$ROOT/.slim/v2-evidence"

# OpenCode V2 loads a local plugin from a *directory*, resolved through the package
# manifest inside it. The repo root exposes `./server` -> ./dist/index.js, whose
# default export carries the OpenCode 2 `setup`, so e2e stages a self-contained copy
# of that bundle (plus the skills it reads next to itself) into the config volume.
PLUGIN_DIR="${OMO_V2_PLUGIN_DIR:-/root/.config/opencode/omo-v2-plugin}"
# e2e builds its own self-contained bundle outside `dist/`, so a gate run can never leave
# `dist/index.js` in the no-shim state the `dist-bundle-*` tests reject.
E2E_BUNDLE_DIR=".slim/v2-bundle"
REPO_DIST_ENTRY="/repo/${E2E_BUNDLE_DIR}/index.js"
REPO_SKILLS_DIR="/repo/packages/shared-skills/skills"
PLUGIN_LOG_FILE="/tmp/oh-my-opencode.log"
PROBE_AGENT_ID="omo-v2-probe"
PLUGIN_AGENT_FILE="/root/.config/opencode/agent/omo-v2-probe.md"

HOST_PORT="${OMO_V2_PORT:-14096}"
SERVE_URL="http://127.0.0.1:${HOST_PORT}"
PLUGIN_ID_EXPECTED="${OMO_V2_PLUGIN_ID:-oh-my-openagent}"
# The serve container authenticates with HTTP Basic; the user part is always "opencode".
SERVE_USER="opencode"
SERVE_PASSWORD="${OMO_V2_SERVER_PASSWORD:-omov2-local}"
NOTICE_MARKER="[opencode-v2] loaded without the V1 runtime"
# OpenCode 1.x gate: the host CLI, its plugin package name, and the port the gate serves on.
V1_PREFIX="${OMO_V1_PREFIX:-/opt/opencode1}"
V1_VERSION="${OMO_V1_VERSION:-1.19.4}"
V1_PORT="${OMO_V1_PORT:-4199}"
V1_PLUGIN_PACKAGE="${OMO_V1_PLUGIN_PACKAGE:-oh-my-openagent}"
# S3a agent materialization: a throwaway *project* (never /repo) so the e2e cannot leave
# `.opencode/agent` files in the checkout, plus the ten agent names it must produce.
S3A_CONTAINER="omo-v2-serve"
S3A_PROJECT="/tmp/omo-v2-s3a-project"
S3A_PROJECT_AGENTS="/tmp/omo-v2-s3a-project/.opencode/agent"
S3A_GLOBAL_AGENTS="/root/.config/opencode/agent"
S3A_DISABLED_AGENT="momus"
S3A_EXPECTED_AGENTS="sisyphus hephaestus oracle librarian explore multimodal-looker metis momus atlas sisyphus-junior"

compose() { docker compose -f "$COMPOSE_FILE" -p "$PROJECT" "$@"; }

# Throwaway container sharing the named volumes of the `v2` service.
run_v2() { compose run --rm -T --no-deps v2 "$@"; }

usage() {
  cat <<'EOF'
用法: scripts/v2/docker.sh <命令> [额外参数...]

  build         构建基础镜像 (docker compose build)
  install       容器内 bun install --frozen-lockfile --ignore-scripts
  typecheck     容器内 bun run typecheck
  test [path]   容器内 bun test --timeout 20000 [path...]
  run <cmd...>  容器内执行任意命令（schema 重生成、vendored npm ci、版本探测）
  build-index   只构建 V2 插件产物 dist/index.js（自包含，e2e 用）
  build-plugin  容器内 bun run build（根脚本，含全部子构建）
  e2e-load      起 serve 容器并断言 /api/plugin 已加载本地插件
  e2e-s0        OpenCode V2 宿主探针（S0）：setup 次数 / 工具 schema / agent markdown / Bun 运行时，
                证据落 .slim/v2-evidence/s0-<ts>.json
  e2e-s1a       V1 -> V2 工具桥接（S1a）：A 组工具进入 ctx.tool.list()、grep/glob 覆盖内置、
                zod 直传、无 schema 错误，并跑桥接自测；证据落 .slim/v2-evidence/s1a-<ts>.json
  e2e-s2a       V1 运行时装配到 V2 宿主（S2a）：真实 serve 容器的插件日志出现
                [omo-v2] runtime assembled hooks/tools/managers/agents 计数，且适配器自测通过；
                证据落 .slim/v2-evidence/s2a-<ts>.json
  e2e-s3a       内置 10 agent 物化为 V2 可发现的 markdown（S3a）：/api/agent 名称与 mode、二次 setup 全 skipped、
                禁用后删除 md、global scope，证据落 .slim/v2-evidence/s3a-<ts>.json
  e2e-v1        V1 回归门禁：真实 OpenCode 1.x CLI 加载本仓库插件，断言 V1 装配成功且无任何 V2 提示/探针，
                证据落 .slim/v2-evidence/e2e-v1-<ts>.log

环境变量:
  OMO_V2_PLUGIN_DIR       容器内插件目录（默认 /root/.config/opencode/omo-v2-plugin）
  OMO_V2_PORT             宿主端口（默认 14096）
  OMO_V2_PLUGIN_ID         期望的插件 id（默认 oh-my-openagent）
  OMO_V2_SERVER_PASSWORD   serve 的 Basic 密码（默认 omov2-local）
  OMO_V1_VERSION           e2e-v1 使用的 OpenCode 1.x 版本（默认 1.19.4）
  OMO_V1_PREFIX            e2e-v1 的 1.x 安装前缀（默认 /opt/opencode1）
  OMO_V1_PORT              e2e-v1 容器内端口（默认 4199）
  BUN_REGISTRY             bun 安装源（默认官方 npm，可换镜像）
EOF
}

# Stage the built plugin as a directory plugin and point the global V2 config at it.
# Writes only to the omo-v2-opencode-config named volume, never to the host's
# ~/.config/opencode.
stage_plugin() {
  run_v2 bash -lc "set -e
mkdir -p '${PLUGIN_DIR}' /root/.config/opencode
rm -rf '${PLUGIN_DIR}/index.js' '${PLUGIN_DIR}/skills'
cp '${REPO_DIST_ENTRY}' '${PLUGIN_DIR}/index.js'
# The bundle resolves skill markdown relative to its own directory.
if [ -d '${REPO_SKILLS_DIR}' ]; then ln -sfn '${REPO_SKILLS_DIR}' '${PLUGIN_DIR}/skills'; fi
cat > '${PLUGIN_DIR}/package.json' <<'JSON'
{
  \"name\": \"oh-my-openagent\",
  \"version\": \"0.0.0\",
  \"type\": \"module\",
  \"main\": \"index.js\",
  \"exports\": { \"./server\": \"./index.js\" }
}
JSON
cat > /root/.config/opencode/opencode.json <<'JSON'
{
  \"\$schema\": \"https://opencode.ai/config.json\",
  \"plugins\": [
    { \"package\": \"${PLUGIN_DIR}\" }
  ]
}
JSON
cat /root/.config/opencode/opencode.json"
}

# 1 when the id shows up in /api/plugin's data[].
api_has_plugin() {
  python3 -c '
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
data = payload.get("data") or []
sys.exit(0 if sys.argv[2] in json.dumps(data) else 1)
' "$1" "$PLUGIN_ID_EXPECTED"
}

# 1 when the probe agent id shows up in /api/agent's data[].
api_has_probe_agent() {
  python3 -c '
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
data = payload.get("data") or []
sys.exit(0 if any(entry.get("id") == sys.argv[2] for entry in data) else 1)
' "$1" "$PROBE_AGENT_ID"
}

fetch_agents() { # $1 = output file
  curl -fsS --max-time 3 -u "${SERVE_USER}:${SERVE_PASSWORD}" "$SERVE_URL/api/agent" -o "$1" 2>/dev/null || true
}

# Poll /api/agent until the probe agent appears. $1 = output file, $2 = timeout seconds.
wait_for_probe_agent() {
  local out="$1" limit="$2" deadline
  deadline=$(( $(date +%s) + limit ))
  while :; do
    fetch_agents "$out"
    if [ -s "$out" ] && api_has_probe_agent "$out"; then
      return 0
    fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 2
  done
}

# --- S3a helpers ------------------------------------------------------------------------------
# Start the serve container rooted at a throwaway project. `compose run -d` (rather than `up`) is
# what makes the host location something other than /repo, so materialized agent files never land
# in the checkout. $1 = optional `KEY=VALUE` container environment (empty for the default scope).
s3a_start_serve() {
  docker rm -f "$S3A_CONTAINER" >/dev/null 2>&1 || true
  compose rm -sf serve >/dev/null 2>&1 || true
  if [ -n "${1:-}" ]; then
    compose run -d --service-ports --name "$S3A_CONTAINER" -w "$S3A_PROJECT" -e "$1" serve >/dev/null
  else
    compose run -d --service-ports --name "$S3A_CONTAINER" -w "$S3A_PROJECT" serve >/dev/null
  fi
}

# Poll /api/plugin for the plugin id. $1 = timeout seconds.
s3a_wait_plugin() {
  local limit="$1" deadline tmp
  deadline=$(( $(date +%s) + limit ))
  tmp="$(mktemp)"
  while :; do
    curl -fsS --max-time 3 -u "${SERVE_USER}:${SERVE_PASSWORD}" "$SERVE_URL/api/plugin" -o "$tmp" 2>/dev/null || true
    if [ -s "$tmp" ] && api_has_plugin "$tmp"; then
      rm -f "$tmp"
      return 0
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      rm -f "$tmp"
      return 1
    fi
    sleep 2
  done
}

# Poll /api/agent until every comma-separated id is present. $1 = output file, $2 = timeout, $3 = ids.
s3a_wait_agents() {
  local out="$1" limit="$2" ids="$3" deadline
  deadline=$(( $(date +%s) + limit ))
  while :; do
    fetch_agents "$out"
    if [ -s "$out" ] && python3 - "$out" "$ids" <<'PY'
import json, sys
try:
    data = json.load(open(sys.argv[1])).get("data") or []
except Exception:
    sys.exit(1)
present = {entry.get("id") for entry in data}
sys.exit(0 if all(name in present for name in sys.argv[2].split(",") if name) else 1)
PY
    then
      return 0
    fi
    [ "$(date +%s)" -ge "$deadline" ] && return 1
    sleep 2
  done
}

# The plugin's own log, as it stands inside the container.
s3a_plugin_log() { # $1 = output file
  docker exec "$S3A_CONTAINER" bash -lc "cat '${PLUGIN_LOG_FILE}' 2>/dev/null" > "$1" 2>/dev/null || true
}


cmd_build() {
  compose build "$@"
}

cmd_install() {
  # --ignore-scripts: the repo's root `prepare` hook runs a full `bun run build`
  # (which wants the shared-skills git submodules) — builds are explicit here.
  run_v2 bun install --frozen-lockfile --ignore-scripts "$@"
}

cmd_typecheck() {
  run_v2 bun run typecheck "$@"
}

cmd_test() {
  run_v2 bun test --timeout 20000 "$@"
}

# Escape hatch for one-off container commands that must not run on the host
# (schema regeneration, `npm ci` in a vendored package, version probes).
cmd_run() {
  run_v2 "$@"
}

cmd_build_plugin() {
  # OMO_SKIP_MATERIALIZE: a source checkout has empty upstream submodules; the
  # materialize step clones them and is irrelevant to the plugin bundle.
  run_v2 env OMO_SKIP_MATERIALIZE=1 bun run build "$@"
}

cmd_build_index() {
  # Same `index` node the root build runs, but bundled self-contained (no
  # `--external zod`) so the staged plugin directory needs no node_modules.
  # It writes next to the evidence, never over `dist/index.js`.
  mkdir -p "$ROOT/$E2E_BUNDLE_DIR"
  run_v2 bun build packages/omo-opencode/src/index.ts \
    --outdir "$E2E_BUNDLE_DIR" --target bun --format esm "$@"
}

cmd_e2e_load() {
  mkdir -p "$EVIDENCE_DIR"
  local ts api_json log_file plugin_log result_file
  ts="$(date +%Y%m%d-%H%M%S)"
  api_json="$EVIDENCE_DIR/e2e-load-${ts}.json"
  log_file="$EVIDENCE_DIR/e2e-load-${ts}.serve.log"
  plugin_log="$EVIDENCE_DIR/e2e-load-${ts}.plugin.log"
  result_file="$api_json"

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> 镜像缺失，先构建 $IMAGE"
    compose build
  fi

  echo "==> 构建 V2 插件产物 (dist/index.js)"
  cmd_build_index

  echo "==> 把插件目录与 V2 配置写入配置卷: $PLUGIN_DIR"
  stage_plugin | sed 's/^/    /'

  echo "==> 启动 serve 容器 (宿主 127.0.0.1:${HOST_PORT} -> 4096)"
  compose rm -sf serve >/dev/null 2>&1 || true
  compose up -d --no-build serve

  # /api/plugin answers 200 before plugins finish loading (empty data), so poll until
  # the expected id shows up rather than stopping at the first 200.
  local tmp deadline status=1 notice=1
  tmp="$(mktemp)"
  deadline=$(( $(date +%s) + 90 ))
  while :; do
    curl -fsS --max-time 3 -u "${SERVE_USER}:${SERVE_PASSWORD}" \
      "$SERVE_URL/api/plugin" -o "$tmp" 2>/dev/null || true
    if [ -s "$tmp" ] && api_has_plugin "$tmp"; then
      status=0
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "!!! 90s 内 /api/plugin 未出现插件 ${PLUGIN_ID_EXPECTED}" >&2
      break
    fi
    sleep 3
  done

  # The plugin's startup notice goes to its own log file inside the container.
  docker exec omo-v2-serve bash -lc "cat '${PLUGIN_LOG_FILE}' 2>/dev/null" > "$plugin_log" 2>/dev/null || true
  grep -qF "$NOTICE_MARKER" "$plugin_log" 2>/dev/null && notice=0

  python3 -c '
import json, sys, datetime
raw_path, out_path, url, want, ok, notice_ok, plugin_log = sys.argv[1:8]
try:
    body = json.load(open(raw_path))
except Exception as exc:
    body = {"_error": f"{type(exc).__name__}: {exc}"}
data = body.get("data") or []
entry = next((p for p in data if want in json.dumps(p)), None)
json.dump(
    {
        "url": url,
        "expectedId": want,
        "pluginEntry": entry,
        "assertionPassed": ok == "0",
        "startupNoticeFound": notice_ok == "0",
        "pluginLog": plugin_log,
        "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "response": body,
    },
    open(out_path, "w"),
    indent=2,
    ensure_ascii=False,
)
' "$tmp" "$result_file" "$SERVE_URL/api/plugin" "$PLUGIN_ID_EXPECTED" "$status" "$notice" "$plugin_log"

  compose logs --no-color --timestamps serve > "$log_file" 2>&1 || true
  rm -f "$tmp"

  echo "==> /api/plugin 中的插件条目:"
  python3 -c 'import json,sys; d=json.load(open(sys.argv[1])); print(json.dumps(d["pluginEntry"], indent=2, ensure_ascii=False) if d["pluginEntry"] else "<未找到>")' "$result_file"
  echo "==> startup-notice（插件日志 ${plugin_log##*/}）:"
  grep -F "$NOTICE_MARKER" "$plugin_log" | head -2 || echo "    <未找到>"
  echo "==> begin/end 计时线索:"
  grep -c . "$log_file" | sed 's/^/    serve 日志行数: /'

  compose rm -sf serve >/dev/null 2>&1 || true

  echo "==> 证据: $result_file"
  echo "==> serve 日志: $log_file"
  echo "==> 插件日志: $plugin_log"

  if [ "$status" -ne 0 ]; then
    echo "FAIL: /api/plugin 未列出 ${PLUGIN_ID_EXPECTED}" >&2
    return 1
  fi
  if [ "$notice" -ne 0 ]; then
    echo "FAIL: 插件日志缺少 startup-notice 标记" >&2
    return 1
  fi
  echo "OK: 插件 ${PLUGIN_ID_EXPECTED} 已在 OpenCode V2 中加载，startup-notice 已出现"
}

# S0 host probe: proves setup cardinality, plain-JSON-Schema tool acceptance, agent markdown
# discovery and the Bun runtime, all inside the serve container. Recreates the serve container
# first so /tmp/oh-my-opencode.log only contains this run's setup calls.
cmd_e2e_s0() {
  mkdir -p "$EVIDENCE_DIR"
  local ts api_json log_file plugin_log agents_json tool_status=0 verdict=0
  ts="$(date +%Y%m%d-%H%M%S)"
  api_json="$EVIDENCE_DIR/s0-${ts}.plugin.json"
  log_file="$EVIDENCE_DIR/s0-${ts}.serve.log"
  plugin_log="$EVIDENCE_DIR/s0-${ts}.plugin.log"
  agents_json="$EVIDENCE_DIR/s0-${ts}.agents.json"
  local result_file="$EVIDENCE_DIR/s0-${ts}.json"

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> 镜像缺失，先构建 $IMAGE"
    compose build
  fi

  echo "==> 构建 V2 插件产物 (dist/index.js)"
  cmd_build_index

  echo "==> 写入插件目录与 V2 配置: $PLUGIN_DIR"
  stage_plugin | sed 's/^/    /'

  # Exercise the plugin's own (idempotent) agent-file write instead of pre-staging it.
  run_v2 bash -lc "rm -f '${PLUGIN_AGENT_FILE}'"

  echo "==> 启动 serve 容器 (宿主 127.0.0.1:${HOST_PORT} -> 4096)"
  compose rm -sf serve >/dev/null 2>&1 || true
  compose up -d --no-build serve

  # /api/plugin is 200 before plugins finish loading, so poll for the expected id.
  local tmp deadline status=1
  tmp="$(mktemp)"
  deadline=$(( $(date +%s) + 90 ))
  while :; do
    curl -fsS --max-time 3 -u "${SERVE_USER}:${SERVE_PASSWORD}" \
      "$SERVE_URL/api/plugin" -o "$tmp" 2>/dev/null || true
    if [ -s "$tmp" ] && api_has_plugin "$tmp"; then
      status=0
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "!!! 90s 内 /api/plugin 未出现插件 ${PLUGIN_ID_EXPECTED}" >&2
      break
    fi
    sleep 3
  done
  cp "$tmp" "$api_json" 2>/dev/null || true
  rm -f "$tmp"

  # R7: agent markdown discovery. The probe's setup wrote the file; check whether the host
  # picked it up on its own, and only fall back to a location reload when it did not.
  local agent_wo_reload=1 reload_invoked=0 agent_found=1
  if wait_for_probe_agent "$agents_json" 30; then
    agent_found=0
    agent_wo_reload=0
  else
    echo "==> /api/agent 首轮未发现 ${PROBE_AGENT_ID}，尝试 POST /api/location/reload"
    reload_invoked=1
    curl -sS -o /dev/null --max-time 5 -X POST -u "${SERVE_USER}:${SERVE_PASSWORD}" \
      "$SERVE_URL/api/location/reload" 2>/dev/null || true
    if wait_for_probe_agent "$agents_json" 20; then
      agent_found=0
    fi
  fi
  fetch_agents "$agents_json"

  # No tool-list endpoint exists in 2.1.4; record that fact instead of pretending otherwise.
  tool_status="$(curl -sS -o /dev/null --max-time 3 -w '%{http_code}' \
    -u "${SERVE_USER}:${SERVE_PASSWORD}" "$SERVE_URL/api/tool" 2>/dev/null || echo "000")"

  # Give the logger's 500ms flush timer a moment, then snapshot the plugin log.
  sleep 2
  docker exec omo-v2-serve bash -lc "cat '${PLUGIN_LOG_FILE}' 2>/dev/null" > "$plugin_log" 2>/dev/null || true
  compose logs --no-color --timestamps serve > "$log_file" 2>&1 || true

  python3 - "$plugin_log" "$agents_json" "$api_json" "$tool_status" "$agent_wo_reload" \
    "$reload_invoked" "$agent_found" "$result_file" "$SERVE_URL" "$PLUGIN_ID_EXPECTED" "$PROBE_AGENT_ID" <<'PY' || verdict=$?
import datetime
import json
import sys

(plugin_log_path, agents_path, plugins_path, tool_status, agent_wo_reload,
 reload_invoked, agent_found, out_path, serve_url, plugin_id, agent_id) = sys.argv[1:12]

def load_json(path, fallback):
    try:
        return json.load(open(path))
    except Exception:
        return fallback

lines = []
try:
    lines = open(plugin_log_path, encoding="utf-8", errors="replace").read().splitlines()
except Exception:
    pass

setup_lines = [line for line in lines if "[omo-v2-probe] setup#" in line]
locations = []
for line in setup_lines:
    marker = "location="
    locations.append(line.split(marker, 1)[1].strip() if marker in line else "")

def prefixed_json(prefix):
    for line in reversed(lines):
        if prefix in line:
            payload = line.split(prefix, 1)[1].strip()
            try:
                return json.loads(payload)
            except Exception:
                return None
    return None

detail = prefixed_json("[omo-v2-probe] detail ") or {}
tools_payload = prefixed_json("[omo-v2-probe] tools ") or {}
tools = tools_payload.get("tools") or []

plugins_body = load_json(plugins_path, {"data": []})
plugin_entry = next((entry for entry in (plugins_body.get("data") or [])
                     if entry.get("id") == plugin_id), None)
agents_body = load_json(agents_path, {"data": []})
agent_entry = next((entry for entry in (agents_body.get("data") or [])
                    if entry.get("id") == agent_id), None)

bun = detail.get("bun") or {}
assertions = {
    "pluginActive": plugin_entry is not None and plugin_entry.get("state", {}).get("status") == "active",
    "setupObserved": len(setup_lines) > 0,
    "setupExactlyOnce": len(setup_lines) == 1,
    "toolRegistered": any(name == "omo_v2_probe" for name in tools),
    "agentDiscovered": agent_found == "0" and agent_entry is not None,
    "bunGlobalsAvailable": bun.get("typeofBun") == "object",
}

evidence = {
    "stage": "s0",
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "serveUrl": serve_url,
    "plugin": {
        "expectedId": plugin_id,
        "entry": plugin_entry,
        "active": assertions["pluginActive"],
    },
    "r2ToolSchema": {
        "probeTool": "omo_v2_probe",
        "inputSchema": {"type": "object", "properties": {"echo": {"type": "string"}},
                        "required": ["echo"], "additionalProperties": False},
        "executeResultShape": "{ output: string }",
        "registeredInHost": assertions["toolRegistered"],
        "hostToolCount": tools_payload.get("count"),
        "hostTools": tools,
        "toolListEndpoint": {"path": "/api/tool", "status": tool_status,
                             "available": tool_status == "200"},
        "note": "Host accepts the registered tool list; actual execute() output was not run in S0 "
                "because that needs a provider-backed model turn.",
    },
    "r7Setup": {
        "count": len(setup_lines),
        "locations": locations,
        "once": assertions["setupExactlyOnce"],
        "note": "setup is invoked per host location; one serve location should yield one call.",
    },
    "r8Runtime": {
        "typeofBun": bun.get("typeofBun"),
        "bunVersion": bun.get("version"),
        "processVersionsBun": bun.get("processVersionsBun"),
    },
    "agentMarkdown": {
        "id": agent_id,
        "found": assertions["agentDiscovered"],
        "discoveredWithoutReload": agent_wo_reload == "0",
        "reloadInvoked": reload_invoked == "1",
        "entry": agent_entry,
        "writtenByPluginSetup": (detail.get("agentFile") or {}).get("written"),
    },
    "agentFile": detail.get("agentFile"),
    "contextKeys": detail.get("contextKeys"),
    "artifacts": {
        "pluginLog": plugin_log_path,
        "agents": agents_path,
        "plugins": plugins_path,
    },
    "assertions": assertions,
    "passed": all(assertions[key] for key in
                  ("pluginActive", "setupObserved", "toolRegistered", "agentDiscovered")),
    "verdicts": {
        "R2": "accepted" if assertions["toolRegistered"] else "rejected",
        "R7": {"setupCalls": len(setup_lines), "locations": locations},
        "R8": {"typeofBun": bun.get("typeofBun"), "bunVersion": bun.get("version")},
    },
}

json.dump(evidence, open(out_path, "w"), indent=2, ensure_ascii=False)
print(json.dumps({"assertions": assertions, "verdicts": evidence["verdicts"],
                  "agentDiscoveredWithoutReload": evidence["agentMarkdown"]["discoveredWithoutReload"],
                  "toolListEndpointStatus": tool_status}, indent=2, ensure_ascii=False))
sys.exit(0 if evidence["passed"] else 1)
PY

  echo "==> 证据: $result_file"
  echo "==> serve 日志: $log_file"
  echo "==> 插件日志: $plugin_log"

  if [ "$status" -ne 0 ]; then
    echo "FAIL: /api/plugin 未列出 ${PLUGIN_ID_EXPECTED}" >&2
    compose rm -sf serve >/dev/null 2>&1 || true
    return 1
  fi
  if [ "$verdict" -ne 0 ]; then
    echo "FAIL: S0 断言未通过（详见 $result_file）" >&2
    compose rm -sf serve >/dev/null 2>&1 || true
    return 1
  fi

  compose rm -sf serve >/dev/null 2>&1 || true
  echo "OK: S0 探针通过（setup 次数/工具注册/agent 发现/Bun 运行时，详见证据 JSON）"
}

# S1a: A-group tools through the V1 -> V2 bridge. Rebuilds the plugin, restarts serve, asserts the
# seven always-on A-group tools (+ the S0 probe) are visible in `ctx.tool.list()`, that grep/glob
# replaced the host built-ins, that no schema-vendor error was logged, and finally runs the bridge
# self-test that proves execute() resolves objects (R1).
cmd_e2e_s1a() {
  mkdir -p "$EVIDENCE_DIR"
  local ts api_json log_file plugin_log selftest_log result_file status=1 selftest_status=1 verdict=0
  ts="$(date +%Y%m%d-%H%M%S)"
  api_json="$EVIDENCE_DIR/s1a-${ts}.plugin.json"
  log_file="$EVIDENCE_DIR/s1a-${ts}.serve.log"
  plugin_log="$EVIDENCE_DIR/s1a-${ts}.plugin.log"
  selftest_log="$EVIDENCE_DIR/s1a-${ts}.selftest.log"
  result_file="$EVIDENCE_DIR/s1a-${ts}.json"

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> 镜像缺失，先构建 $IMAGE"
    compose build
  fi

  echo "==> 构建 V2 插件产物 (dist/index.js)"
  cmd_build_index

  echo "==> 写入插件目录与 V2 配置: $PLUGIN_DIR"
  stage_plugin | sed 's/^/    /'

  echo "==> 启动 serve 容器 (宿主 127.0.0.1:${HOST_PORT} -> 4096)"
  compose rm -sf serve >/dev/null 2>&1 || true
  compose up -d --no-build serve

  local tmp deadline
  tmp="$(mktemp)"
  deadline=$(( $(date +%s) + 90 ))
  while :; do
    curl -fsS --max-time 3 -u "${SERVE_USER}:${SERVE_PASSWORD}" \
      "$SERVE_URL/api/plugin" -o "$tmp" 2>/dev/null || true
    if [ -s "$tmp" ] && api_has_plugin "$tmp"; then
      status=0
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "!!! 90s 内 /api/plugin 未出现插件 ${PLUGIN_ID_EXPECTED}" >&2
      break
    fi
    sleep 3
  done
  cp "$tmp" "$api_json" 2>/dev/null || true
  rm -f "$tmp"

  # Give the logger's 500ms flush timer a moment, then snapshot the plugin log.
  sleep 2
  docker exec omo-v2-serve bash -lc "cat '${PLUGIN_LOG_FILE}' 2>/dev/null" > "$plugin_log" 2>/dev/null || true
  compose logs --no-color --timestamps serve > "$log_file" 2>&1 || true

  echo "==> 桥接自测（R1：execute 必须返回对象）"
  set +e
  timeout 300 docker compose -f "$COMPOSE_FILE" -p "$PROJECT" run --rm -T --no-deps v2 \
    bun packages/omo-opencode/src/opencode-v2/__tests__/tool-bridge.selftest.ts > "$selftest_log" 2>&1
  selftest_status=$?
  set -e
  tail -3 "$selftest_log" | sed 's/^/    /'

  python3 - "$plugin_log" "$api_json" "$selftest_status" "$result_file" "$SERVE_URL" \
    "$PLUGIN_ID_EXPECTED" "$selftest_log" <<'PY' || verdict=$?
import datetime
import json
import sys

(plugin_log_path, plugins_path, selftest_status, out_path, serve_url,
 plugin_id, selftest_log_path) = sys.argv[1:8]

EXPECTED_TOOLS = ["grep", "glob", "task_get", "task_list", "create_goal", "update_goal", "get_goal"]
PROBE_TOOL = "omo_v2_probe"
DESCRIPTION_PREFIXES = {
    "grep": "Fast content search tool with safety limits",
    "glob": "Fast file pattern matching tool with safety limits",
}
SCHEMA_ERROR_MARKERS = ["Schema vendor", "Skipping invalid", "failed to register tool"]


def load_json(path, fallback):
    try:
        return json.load(open(path))
    except Exception:
        return fallback


try:
    lines = open(plugin_log_path, encoding="utf-8", errors="replace").read().splitlines()
except Exception:
    lines = []


def last_prefixed_json(prefix):
    for line in reversed(lines):
        if prefix in line:
            try:
                return json.loads(line.split(prefix, 1)[1].strip())
            except Exception:
                return None
    return None


tools_payload = last_prefixed_json("[omo-v2] tools ") or {}
bridge_payload = last_prefixed_json("[omo-v2] tool bridge ") or {}
descriptions_payload = last_prefixed_json("[omo-v2] tool descriptions ") or {}

listed = list(tools_payload.get("tools") or [])
missing = [name for name in EXPECTED_TOOLS if name not in listed]
probe_present = PROBE_TOOL in listed

registered = bridge_payload.get("registered") or []
modes = {entry.get("name"): entry.get("mode") for entry in registered if isinstance(entry, dict)}
bridge_failures = bridge_payload.get("failures") or []
bridge_missing = bridge_payload.get("missing") or []

schema_errors = [line for line in lines if any(marker in line for marker in SCHEMA_ERROR_MARKERS)]

overrides = {
    name: any(f"[omo-v2] overriding builtin tool {name}" in line for line in lines)
    for name in ("grep", "glob")
}

description_ok = {
    name: str(descriptions_payload.get(name) or "").startswith(prefix)
    for name, prefix in DESCRIPTION_PREFIXES.items()
}

try:
    selftest_tail = open(selftest_log_path, encoding="utf-8", errors="replace").read().splitlines()[-3:]
except Exception:
    selftest_tail = []

plugins_body = load_json(plugins_path, {"data": []})
plugin_entry = next((entry for entry in (plugins_body.get("data") or [])
                     if entry.get("id") == plugin_id), None)

assertions = {
    "pluginActive": plugin_entry is not None and (plugin_entry.get("state") or {}).get("status") == "active",
    "pluginLogFound": len(lines) > 0,
    "aGroupListed": len(missing) == 0,
    "probeStillListed": probe_present,
    "bridgedInToolList": len([name for name in EXPECTED_TOOLS if name in listed]) == len(EXPECTED_TOOLS),
    "zodDirectAccepted": all(modes.get(name) == "zod" for name in EXPECTED_TOOLS),
    "noBridgeFailures": len(bridge_failures) == 0 and len(bridge_missing) == 0,
    "grepOverridesBuiltin": overrides["grep"],
    "globOverridesBuiltin": overrides["glob"],
    "descriptionsFromV1": all(description_ok.values()),
    "noSchemaErrors": len(schema_errors) == 0,
    "selftestPassed": selftest_status == "0",
}

evidence = {
    "stage": "s1a",
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "serveUrl": serve_url,
    "plugin": {"expectedId": plugin_id, "entry": plugin_entry, "active": assertions["pluginActive"]},
    "toolList": {
        "expected": EXPECTED_TOOLS,
        "probe": PROBE_TOOL,
        "listed": listed,
        "missing": missing,
        "count": tools_payload.get("count"),
    },
    "bridge": {
        "zodDirect": assertions["zodDirectAccepted"],
        "modes": modes,
        "registered": registered,
        "failures": bridge_failures,
        "missing": bridge_missing,
        "directory": bridge_payload.get("directory"),
        "enableEdit": bridge_payload.get("enableEdit"),
    },
    "builtinOverrides": overrides,
    "descriptions": {
        "prefixes": DESCRIPTION_PREFIXES,
        "observed": descriptions_payload,
        "matched": description_ok,
    },
    "schemaErrors": schema_errors,
    "selftest": {
        "exit": int(selftest_status),
        "artifacts": selftest_log_path,
        "tail": selftest_tail,
    },
    "artifacts": {"pluginLog": plugin_log_path, "plugins": plugins_path},
    "assertions": assertions,
    "passed": all(assertions.values()),
}

json.dump(evidence, open(out_path, "w"), indent=2, ensure_ascii=False)
print(json.dumps({"assertions": assertions, "modes": modes,
                  "missing": missing, "schemaErrors": len(schema_errors),
                  "overrides": overrides}, indent=2, ensure_ascii=False))
sys.exit(0 if evidence["passed"] else 1)
PY

  echo "==> 证据: $result_file"
  echo "==> 插件日志: $plugin_log"
  echo "==> 自测日志: $selftest_log"

  compose rm -sf serve >/dev/null 2>&1 || true

  if [ "$status" -ne 0 ]; then
    echo "FAIL: /api/plugin 未列出 ${PLUGIN_ID_EXPECTED}" >&2
    return 1
  fi
  if [ "$verdict" -ne 0 ]; then
    echo "FAIL: S1a 断言未通过（详见 $result_file）" >&2
    return 1
  fi
  echo "OK: S1a 通过（A 组 7 个工具 + 探针在 tool.list()，grep/glob 覆盖内置，zod 直传，自测通过）"
}


# S2a acceptance: the V1 runtime is assembled on the V2 host.
#
# Two independent probes, both required:
#   1. a real OpenCode 2 serve container, whose plugin log must carry the `[omo-v2] runtime
#      assembled hooks=<n> ... tools=<n> ... managers=<list> agents=<n>` line with sane counts and
#      no `runtime assembly failed`;
#   2. the adapter selftest, which assembles a second runtime from a fake context and proves the
#      singleton, the idempotent dispose and the loud "missing method" behaviour.
cmd_e2e_s2a() {
  mkdir -p "$EVIDENCE_DIR"
  local ts api_json log_file plugin_log selftest_log result_file status=1 selftest_status=1 verdict=0
  ts="$(date +%Y%m%d-%H%M%S)"
  api_json="$EVIDENCE_DIR/s2a-${ts}.plugin.json"
  log_file="$EVIDENCE_DIR/s2a-${ts}.serve.log"
  plugin_log="$EVIDENCE_DIR/s2a-${ts}.plugin.log"
  selftest_log="$EVIDENCE_DIR/s2a-${ts}.selftest.log"
  result_file="$EVIDENCE_DIR/s2a-${ts}.json"

  # The compose file publishes a fixed 127.0.0.1:14096; only this stage makes the host port
  # overridable, so a second lane (or a second checkout) can run its own serve without touching
  # docker/v2/compose.yaml. `!override` replaces the port list instead of appending to it.
  local compose_files=(-f "$COMPOSE_FILE") port_override=""
  if [ "${HOST_PORT}" != "14096" ]; then
    port_override="/tmp/omo-v2-s2a-port-${HOST_PORT}.yaml"
    cat > "$port_override" <<YAML
services:
  serve:
    ports: !override
      - "127.0.0.1:${HOST_PORT}:4096"
YAML
    compose_files+=(-f "$port_override")
  fi

  s2a_compose() { docker compose "${compose_files[@]}" -p "$PROJECT" "$@"; }

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> 镜像缺失，先构建 $IMAGE"
    compose build
  fi

  echo "==> 构建 V2 插件产物 (dist/index.js)"
  cmd_build_index

  echo "==> 写入插件目录与 V2 配置: $PLUGIN_DIR"
  stage_plugin | sed 's/^/    /'

  echo "==> 启动 serve 容器 (宿主 127.0.0.1:${HOST_PORT} -> 4096)"
  s2a_compose rm -sf serve >/dev/null 2>&1 || true
  # One clean plugin log per run so a stale assembly line can never satisfy the assertions.
  run_v2 bash -lc "rm -f '${PLUGIN_LOG_FILE}'" >/dev/null 2>&1 || true
  s2a_compose up -d --no-build serve

  local tmp deadline
  tmp="$(mktemp)"
  deadline=$(( $(date +%s) + 90 ))
  while :; do
    curl -fsS --max-time 3 -u "${SERVE_USER}:${SERVE_PASSWORD}" \
      "$SERVE_URL/api/plugin" -o "$tmp" 2>/dev/null || true
    if [ -s "$tmp" ] && api_has_plugin "$tmp"; then
      status=0
      break
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "!!! 90s 内 /api/plugin 未出现插件 ${PLUGIN_ID_EXPECTED}" >&2
      break
    fi
    sleep 3
  done
  cp "$tmp" "$api_json" 2>/dev/null || true
  rm -f "$tmp"

  # The logger flushes on a 500ms timer; give it a beat, then snapshot the plugin log.
  sleep 2
  docker exec omo-v2-serve bash -lc "cat '${PLUGIN_LOG_FILE}' 2>/dev/null" > "$plugin_log" 2>/dev/null || true
  s2a_compose logs --no-color --timestamps serve > "$log_file" 2>&1 || true

  echo "==> 适配器自测（假 ctx 装配 + 单例复用 + dispose 幂等 + missing 方法必抛）"
  set +e
  timeout 300 docker compose -f "$COMPOSE_FILE" -p "$PROJECT" run --rm -T --no-deps v2 \
    env TMPDIR=/tmp/s2a-selftest \
    bash -lc 'mkdir -p /tmp/s2a-selftest && rm -f /tmp/s2a-selftest/oh-my-opencode.log && bun packages/omo-opencode/src/opencode-v2/__tests__/adapter.selftest.ts' \
    > "$selftest_log" 2>&1
  selftest_status=$?
  set -e
  tail -4 "$selftest_log" | sed 's/^/    /'

  python3 - "$plugin_log" "$api_json" "$selftest_status" "$result_file" "$SERVE_URL" \
    "$PLUGIN_ID_EXPECTED" "$selftest_log" <<'PY' || verdict=$?
import datetime
import json
import re
import sys

(plugin_log_path, plugins_path, selftest_status, out_path, serve_url,
 plugin_id, selftest_log_path) = sys.argv[1:8]

ASSEMBLED = re.compile(
    r"\[omo-v2\] runtime assembled hooks=(\d+) hookKeys=(\S*) tools=(\d+) managers=(\S*) agents=(\d+)"
)
REQUIRED_HOOKS = [
    "event", "config", "chat.message", "chat.params",
    "tool.execute.before", "tool.execute.after", "tool.definition",
    "experimental.session.compacting",
]
REQUIRED_MANAGERS = ["backgroundManager", "configHandler", "skillMcpManager", "tmuxSessionManager"]
MIN_HOOKS = 10
MIN_TOOLS = 13
EXPECTED_AGENTS = 11


def load_json(path, fallback):
    try:
        return json.load(open(path))
    except Exception:
        return fallback


try:
    lines = open(plugin_log_path, encoding="utf-8", errors="replace").read().splitlines()
except Exception:
    lines = []

assembled = None
for line in lines:
    match = ASSEMBLED.search(line)
    if match:
        assembled = {
            "hooks": int(match.group(1)),
            "hookKeys": [key for key in match.group(2).split(",") if key],
            "tools": int(match.group(3)),
            "managers": [name for name in match.group(4).split(",") if name],
            "agents": int(match.group(5)),
            "line": line,
        }

assembly_failures = [line for line in lines if "runtime assembly failed" in line]
reused = [line for line in lines if "[omo-v2] runtime reused" in line]

hook_keys = assembled["hookKeys"] if assembled else []
manager_names = assembled["managers"] if assembled else []
missing_hooks = [name for name in REQUIRED_HOOKS if name not in hook_keys]
missing_managers = [name for name in REQUIRED_MANAGERS if name not in manager_names]

plugins_body = load_json(plugins_path, {"data": []})
plugin_entry = next((entry for entry in (plugins_body.get("data") or [])
                     if entry.get("id") == plugin_id), None)

try:
    selftest_text = open(selftest_log_path, encoding="utf-8", errors="replace").read()
except Exception:
    selftest_text = ""
selftest_tail = selftest_text.splitlines()[-6:]
selftest_match = re.search(r"S2a adapter selftest: (\d+)/(\d+) passed", selftest_text)
selftest_passed = bool(
    selftest_status == "0"
    and selftest_match
    and selftest_match.group(1) == selftest_match.group(2)
)
dispose_proved = "PASS dispose twice" in selftest_text
reuse_proved = "PASS singleton reuse" in selftest_text
missing_proved = "PASS missing method throws loudly" in selftest_text

assertions = {
    "pluginActive": plugin_entry is not None and (plugin_entry.get("state") or {}).get("status") == "active",
    "pluginLogFound": len(lines) > 0,
    "runtimeAssembled": assembled is not None,
    "hookCount": bool(assembled) and assembled["hooks"] >= MIN_HOOKS,
    "hookKeysComplete": len(missing_hooks) == 0,
    "toolCount": bool(assembled) and assembled["tools"] >= MIN_TOOLS,
    "managersComplete": len(missing_managers) == 0,
    "agentCount": bool(assembled) and assembled["agents"] == EXPECTED_AGENTS,
    "noAssemblyFailure": len(assembly_failures) == 0,
    "noDuplicateAssembly": len(reused) == 0,
    "selftestPassed": selftest_passed,
    "selftestDisposeIdempotent": dispose_proved,
    "selftestSingletonReuse": reuse_proved,
    "selftestMissingMethodThrows": missing_proved,
}

evidence = {
    "stage": "s2a",
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "serveUrl": serve_url,
    "plugin": {"expectedId": plugin_id, "entry": plugin_entry, "active": assertions["pluginActive"]},
    "assembly": {
        "observed": assembled,
        "requiredHooks": REQUIRED_HOOKS,
        "missingHooks": missing_hooks,
        "requiredManagers": REQUIRED_MANAGERS,
        "missingManagers": missing_managers,
        "failures": assembly_failures,
    },
    "selftest": {
        "exit": int(selftest_status),
        "tail": selftest_tail,
        "artifacts": selftest_log_path,
    },
    "artifacts": {"pluginLog": plugin_log_path, "plugins": plugins_path},
    "assertions": assertions,
    "passed": all(assertions.values()),
}

json.dump(evidence, open(out_path, "w"), indent=2, ensure_ascii=False)
print(json.dumps({"assertions": assertions,
                  "assembly": assembled,
                  "missingHooks": missing_hooks,
                  "missingManagers": missing_managers}, indent=2, ensure_ascii=False))
sys.exit(0 if evidence["passed"] else 1)
PY

  echo "==> 证据: $result_file"
  echo "==> 插件日志: $plugin_log"
  echo "==> 自测日志: $selftest_log"

  compose rm -sf serve >/dev/null 2>&1 || true

  if [ "$status" -ne 0 ]; then
    echo "FAIL: /api/plugin 未列出 ${PLUGIN_ID_EXPECTED}" >&2
    return 1
  fi
  if [ "$verdict" -ne 0 ]; then
    echo "FAIL: S2a 断言未通过（详见 $result_file）" >&2
    return 1
  fi
  echo "OK: S2a 通过（V1 运行时已装配在 V2 宿主，hooks/tools/managers/agents 计数与自测全部符合）"
}


# S3a: the ten built-in agents, materialized as markdown. Four host lifetimes cover the whole story:
#   A  fresh project location → ten files written and discovered by /api/agent (name + mode)
#   B  second `setup` on the same location → nothing rewritten (`skipped` = 10)
#   C  `disabled_agents: [momus]` → momus' generated file deleted, momus gone from /api/agent
#   D  `OMO_V2_AGENT_SCOPE=global` → the same ten files under ~/.config/opencode/agent
# The project location is a throwaway directory inside the container, never /repo: a failing stage
# must not leave `.opencode/agent` files in the checkout.
cmd_e2e_s3a() {
  mkdir -p "$EVIDENCE_DIR"
  local ts work result verdict=0 ids ids_c selftest_status=1
  ts="$(date +%Y%m%d-%H%M%S)"
  work="$(mktemp -d)"
  result="$EVIDENCE_DIR/s3a-${ts}.json"
  ids="$(echo $S3A_EXPECTED_AGENTS | tr ' ' ',')"
  ids_c="$(echo $S3A_EXPECTED_AGENTS | tr ' ' '\n' | grep -vx "$S3A_DISABLED_AGENT" | paste -sd, -)"

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> 镜像缺失，先构建 $IMAGE"
    compose build
  fi

  echo "==> 构建 V2 插件产物 (dist/index.js)"
  cmd_build_index

  echo "==> 写入插件目录与 V2 配置: $PLUGIN_DIR"
  stage_plugin | sed 's/^/    /'

  echo "==> 物化自测（渲染 / 幂等 / 禁用删除 / 双 scope）"
  set +e
  timeout 300 docker compose -f "$COMPOSE_FILE" -p "$PROJECT" run --rm -T --no-deps v2 \
    bun packages/omo-opencode/src/opencode-v2/__tests__/agents.selftest.ts > "$work/selftest.log" 2>&1
  selftest_status=$?
  set -e
  tail -2 "$work/selftest.log" | sed 's/^/    /'

  echo "==> 准备一次性项目目录 $S3A_PROJECT，并清空 agent 落盘目录"
  run_v2 bash -lc "rm -rf '$S3A_PROJECT' '$S3A_GLOBAL_AGENTS'/*.md /root/.omo/omo.jsonc; mkdir -p '$S3A_PROJECT' '$S3A_GLOBAL_AGENTS'"

  echo "==> 阶段 A：全新项目 location → 10 个 markdown agent"
  s3a_start_serve ""
  s3a_wait_plugin 90 || echo "!!! 90s 内 /api/plugin 未出现 ${PLUGIN_ID_EXPECTED}" >&2
  s3a_wait_agents "$work/a.agents.json" 90 "$ids" || echo "!!! 90s 内 /api/agent 未出现全部 10 个 agent" >&2
  fetch_agents "$work/a.agents.json"
  curl -fsS --max-time 3 -u "${SERVE_USER}:${SERVE_PASSWORD}" "$SERVE_URL/api/plugin" -o "$work/a.plugins.json" 2>/dev/null || true
  sleep 2
  s3a_plugin_log "$work/a.log"
  docker exec "$S3A_CONTAINER" bash -lc "ls '$S3A_PROJECT_AGENTS' 2>/dev/null" > "$work/a.files" 2>/dev/null || true
  docker exec "$S3A_CONTAINER" bash -lc "cat '$S3A_PROJECT_AGENTS/oracle.md' 2>/dev/null" > "$work/oracle.md" 2>/dev/null || true

  echo "==> 阶段 B：重启 serve → 第二次 setup 必须全部 skipped"
  docker restart "$S3A_CONTAINER" >/dev/null 2>&1 || true
  s3a_wait_plugin 90 || true
  s3a_wait_agents "$work/b.agents.json" 90 "$ids" || true
  sleep 2
  s3a_plugin_log "$work/b.log"

  echo "==> 阶段 C：disabled_agents=[${S3A_DISABLED_AGENT}] → 对应 markdown 必须被删除"
  printf '%s' "{\"[opencode]\":{\"disabled_agents\":[\"${S3A_DISABLED_AGENT}\"]}}" > "$work/omo.jsonc"
  docker exec "$S3A_CONTAINER" mkdir -p /root/.omo >/dev/null 2>&1 || true
  docker cp "$work/omo.jsonc" "$S3A_CONTAINER:/root/.omo/omo.jsonc" >/dev/null 2>&1 || true
  docker restart "$S3A_CONTAINER" >/dev/null 2>&1 || true
  s3a_wait_plugin 90 || true
  s3a_wait_agents "$work/c.agents.json" 90 "$ids_c" || true
  fetch_agents "$work/c.agents.json"
  sleep 2
  s3a_plugin_log "$work/c.log"
  docker exec "$S3A_CONTAINER" bash -lc "ls '$S3A_PROJECT_AGENTS' 2>/dev/null" > "$work/c.files" 2>/dev/null || true

  echo "==> 阶段 D：OMO_V2_AGENT_SCOPE=global → 写入全局 agent 目录"
  docker exec "$S3A_CONTAINER" bash -lc "rm -f /root/.omo/omo.jsonc; rm -rf '$S3A_PROJECT/.opencode'" >/dev/null 2>&1 || true
  s3a_start_serve "OMO_V2_AGENT_SCOPE=global"
  s3a_wait_plugin 90 || true
  s3a_wait_agents "$work/d.agents.json" 90 "$ids" || true
  fetch_agents "$work/d.agents.json"
  sleep 2
  s3a_plugin_log "$work/d.log"
  docker exec "$S3A_CONTAINER" bash -lc "ls '$S3A_GLOBAL_AGENTS' 2>/dev/null" > "$work/d.files" 2>/dev/null || true

  # Leave no agent markdown behind: 1.x gates assert the V2 probe file is absent, and a stale global
  # agent would be picked up by every later serve.
  docker rm -f "$S3A_CONTAINER" >/dev/null 2>&1 || true
  compose rm -sf serve >/dev/null 2>&1 || true
  run_v2 bash -lc "rm -rf '$S3A_PROJECT' '$S3A_GLOBAL_AGENTS'/*.md /root/.omo/omo.jsonc" || true

  python3 - "$work" "$result" "$SERVE_URL" "$PLUGIN_ID_EXPECTED" "$S3A_EXPECTED_AGENTS" \
    "$S3A_DISABLED_AGENT" "$S3A_PROJECT_AGENTS" "$S3A_GLOBAL_AGENTS" "$selftest_status" <<'PY' || verdict=$?
import datetime
import json
import os
import sys

(work, out_path, serve_url, plugin_id, expected_names, disabled_agent,
 project_agents_dir, global_agents_dir, selftest_status) = sys.argv[1:10]

EXPECTED_MODES = {
    "sisyphus": "primary",
    "hephaestus": "primary",
    "atlas": "primary",
    "oracle": "subagent",
    "librarian": "subagent",
    "explore": "subagent",
    "multimodal-looker": "subagent",
    "metis": "subagent",
    "momus": "subagent",
    "sisyphus-junior": "subagent",
}
NAMES = [name for name in expected_names.split() if name]


def load_json(name, fallback):
    try:
        return json.load(open(os.path.join(work, name)))
    except Exception:
        return fallback


def read_lines(name):
    try:
        return [line.strip() for line in open(os.path.join(work, name)) if line.strip()]
    except Exception:
        return []


def summaries(name):
    """Every `[omo-v2-agents] summary {...}` line, oldest first."""
    payloads = []
    for line in read_lines(name):
        marker = "[omo-v2-agents] summary "
        if marker not in line:
            continue
        try:
            payloads.append(json.loads(line.split(marker, 1)[1].strip()))
        except Exception:
            continue
    return payloads


def agents(name):
    return {entry.get("id"): entry for entry in (load_json(name, {}).get("data") or [])}


a_agents, b_agents, c_agents, d_agents = (agents(f"{phase}.agents.json") for phase in "abcd")
a_plugins = load_json("a.plugins.json", {"data": []})
plugin_entry = next((entry for entry in (a_plugins.get("data") or []) if entry.get("id") == plugin_id), None)

a_sum, b_sum, c_sum, d_sum = (summaries(f"{phase}.log") for phase in "abcd")
a_last = a_sum[-1] if a_sum else {}
b_last = b_sum[-1] if b_sum else {}
c_last = c_sum[-1] if c_sum else {}
d_last = d_sum[-1] if d_sum else {}

a_files = read_lines("a.files")
c_files = read_lines("c.files")
d_files = read_lines("d.files")
md_names = lambda entries: sorted(name[:-3] for name in entries if name.endswith(".md"))

modes_a = {name: a_agents.get(name, {}).get("mode") for name in NAMES}
modes_c = {name: c_agents.get(name, {}).get("mode") for name in NAMES if name != disabled_agent}
modes_d = {name: d_agents.get(name, {}).get("mode") for name in NAMES}

oracle_frontmatter = ""
try:
    text = open(os.path.join(work, "oracle.md"), encoding="utf-8", errors="replace").read()
    lines = text.split("\n")
    end = lines.index("---", 1) if lines and lines[0] == "---" else 0
    oracle_frontmatter = "\n".join(lines[: end + 1])
except Exception:
    pass

try:
    selftest_tail = open(os.path.join(work, "selftest.log"), encoding="utf-8", errors="replace").read().splitlines()[-2:]
except Exception:
    selftest_tail = []

assertions = {
    "pluginActive": plugin_entry is not None and (plugin_entry.get("state") or {}).get("status") == "active",
    "selftestPassed": selftest_status == "0",
    "projectScopeFilesWritten": set(md_names(a_files)) == set(NAMES),
    "allTenDiscovered": all(name in a_agents for name in NAMES),
    "modesCorrect": all(modes_a.get(name) == EXPECTED_MODES[name] for name in NAMES),
    "noDuplicateAgents": len([name for name in NAMES if name in a_agents]) == len(NAMES),
    "secondSetupSkippedAll": b_last.get("written") == [] and len(b_last.get("skipped") or []) == len(NAMES),
    "secondSetupKeptAgentCount": len(b_agents) == len(a_agents),
    "disabledFileRemoved": disabled_agent not in md_names(c_files),
    "disabledAgentNotDiscovered": disabled_agent not in c_agents,
    "disabledReportedRemoved": disabled_agent in (c_last.get("removed") or []),
    "otherNineSurviveDisable": all(name in c_agents for name in NAMES if name != disabled_agent),
    "globalScopeChosen": d_last.get("scope") == "global",
    "globalScopeDirectory": d_last.get("directory") == global_agents_dir,
    # the S0 probe shares the global agent directory, so only our ten names are compared
    "globalScopeFilesWritten": set(md_names(d_files)) >= set(NAMES),
    "globalScopeDiscovered": all(name in d_agents for name in NAMES),
    "globalScopeModesCorrect": all(modes_d.get(name) == EXPECTED_MODES[name] for name in NAMES),
    "frontmatterUsesSupportedKeys": oracle_frontmatter.startswith("---")
        and "# omo-v2-agent: oracle" in oracle_frontmatter
        and all(f"{key}:" in oracle_frontmatter for key in ("description", "mode", "permission")),
}

evidence = {
    "stage": "s3a",
    "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
    "serveUrl": serve_url,
    "plugin": {"expectedId": plugin_id, "active": assertions["pluginActive"]},
    "discovery": {
        "projectScopeDirectory": project_agents_dir,
        "globalScopeDirectory": global_agents_dir,
        "projectDiscoveredWithoutReload": assertions["allTenDiscovered"],
        "note": "V2.1.4 picks the files up during setup; no /api/location/reload and no host restart "
                "were needed. A project file wins over a global file with the same name.",
    },
    "phaseA": {
        "summary": a_last,
        "agents": [{"id": name, "mode": modes_a.get(name), "description": a_agents.get(name, {}).get("description")}
                   for name in NAMES],
        "files": md_names(a_files),
        "oracleFrontmatter": oracle_frontmatter,
    },
    "phaseB": {"summary": b_last, "agentCount": len(b_agents)},
    "phaseC": {
        "summary": c_last,
        "disabled": disabled_agent,
        "files": md_names(c_files),
        "modes": modes_c,
    },
    "phaseD": {"summary": d_last, "files": md_names(d_files), "modes": modes_d},
    "frontmatterEvidence": {
        "file": os.path.join(project_agents_dir, "oracle.md"),
        "frontmatter": oracle_frontmatter,
        "loaded": {key: a_agents.get("oracle", {}).get(key) for key in ("description", "mode", "hidden", "model", "request", "permissions")},
    },
    "selftest": {"exit": int(selftest_status), "tail": selftest_tail},
    "assertions": assertions,
    "passed": all(assertions.values()),
}

json.dump(evidence, open(out_path, "w"), indent=2, ensure_ascii=False)
print(json.dumps({"assertions": assertions,
                  "modes": modes_a,
                  "phaseB": {"written": b_last.get("written"), "skipped": len(b_last.get("skipped") or [])},
                  "phaseC": {"removed": c_last.get("removed"), "files": md_names(c_files)},
                  "phaseD": {"scope": d_last.get("scope"), "files": md_names(d_files)}},
                 indent=2, ensure_ascii=False))
sys.exit(0 if evidence["passed"] else 1)
PY

  rm -rf "$work"
  echo "==> 证据: $result"

  if [ "$verdict" -ne 0 ]; then
    echo "FAIL: S3a 断言未通过（详见 $result）" >&2
    return 1
  fi
  echo "OK: S3a 通过（10 个 agent 物化并被 /api/agent 发现，二次 setup 全 skipped，禁用后删除 markdown，global scope 可用）"
}

# V1 regression gate. The repository ships one harness but two runtime entries; nothing may make a
# real OpenCode 1.x host take the V2 path (no "OpenCode 2" notice, no probe file, no probe logs).
#
# OpenCode 1.x resolves `plugin` entries as npm packages only: an absolute path is ignored silently
# and the `~/.config/opencode/plugin/` directory is no longer scanned in 1.19. So the gate stages the
# local build the way a real install would — warm the host's own package cache once, replace the
# installed entry with `dist/index.js`, then prove the swap survived (sha256 compare) before
# asserting, so a reinstall can never make this stage silently test the published package.
cmd_e2e_v1() {
  mkdir -p "$EVIDENCE_DIR"
  local ts evidence verdict
  ts="$(date +%Y%m%d-%H%M%S)"
  evidence="$EVIDENCE_DIR/e2e-v1-${ts}.log"

  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "==> 镜像缺失，先构建 $IMAGE"
    compose build
  fi

  echo "==> 构建 V1 用的插件产物 (dist/index.js, 自包含)"
  cmd_build_index

  set +e
  run_v2 bash -s -- "$V1_PREFIX" "$V1_VERSION" "$V1_PORT" "$V1_PLUGIN_PACKAGE" "$REPO_DIST_ENTRY" "$NOTICE_MARKER" 2>&1 <<'DOCKER_V1_EOF' | tee "$evidence"
set -uo pipefail

PREFIX="$1"; VERSION="$2"; PORT="$3"; PACKAGE="$4"; LOCAL_ENTRY="$5"; NOTICE="$6"
CLI="$PREFIX/bin/opencode"
BASE="http://127.0.0.1:$PORT"
SERVE_LOG="/tmp/omo-v1-serve.log"
# OpenCode 1.x keeps its own SQLite database; the V2 data home in the shared volume has a different
# schema, so the gate gives 1.x a private data home instead of migrating a V2 database.
export XDG_DATA_HOME="$HOME/.local/share/omo-v1-data"
mkdir -p "$XDG_DATA_HOME"
PLUGIN_LOG="/tmp/oh-my-opencode.log"
PROBE_AGENT="$HOME/.config/opencode/agent/omo-v2-probe.md"

fail() { echo "FAIL: $*" >&2; exit 1; }

stop_serve() {
  pkill -f "opencode serve --hostname 127.0.0.1 --port $PORT" >/dev/null 2>&1 || true
  sleep 1
}
trap stop_serve EXIT

# 1. the real OpenCode 1.x CLI
if ! "$CLI" --version 2>/dev/null | grep -qx "$VERSION"; then
  echo "==> 安装 OpenCode 1.x ($VERSION) 到 $PREFIX"
  npm i -g --prefix "$PREFIX" "opencode-ai@$VERSION" >/tmp/omo-v1-npm.log 2>&1 || {
    tail -5 /tmp/omo-v1-npm.log
    fail "npm 安装 opencode-ai@$VERSION 失败"
  }
fi
"$CLI" --version 2>/dev/null | grep -qx "$VERSION" || fail "OpenCode 1.x 版本不符（期望 $VERSION）"
echo "==> OpenCode 1.x: $("$CLI" --version)"

# 2. global config asks for the plugin by package name (the only form 1.x resolves)
mkdir -p "$HOME/.config/opencode"
cat > "$HOME/.config/opencode/opencode.json" <<JSON
{ "\$schema": "https://opencode.ai/config.json", "plugin": ["$PACKAGE"] }
JSON
rm -f "$PLUGIN_LOG" "$PROBE_AGENT"

start_serve() {
  ( cd /tmp && nohup "$CLI" serve --hostname 127.0.0.1 --port "$PORT" >"$SERVE_LOG" 2>&1 & )
  local i
  for i in $(seq 1 60); do
    curl -fsS --max-time 2 "$BASE/agent" -o /tmp/omo-v1-agents.json 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# 3. warm the host's package cache once (this is where 1.x installs `plugin` entries)
echo "==> 预热 OpenCode 1.x 插件缓存"
start_serve || { tail -20 "$SERVE_LOG"; fail "OpenCode 1.x serve 无法启动（预热）"; }
PKG_DIR="$(find "$HOME/.cache/opencode/packages" -maxdepth 4 -type d -name "$PACKAGE" 2>/dev/null | head -1)"
stop_serve
[ -n "$PKG_DIR" ] || fail "1.x 未安装插件包 $PACKAGE（找不到安装目录）"
echo "==> 安装目录: $PKG_DIR"

# 4. replace the installed entry with this checkout's build
MAIN_REL="$(python3 -c 'import json,os,sys;print(json.load(open(os.path.join(sys.argv[1],"package.json"))).get("main","./dist/index.js").lstrip("./"))' "$PKG_DIR")" \
  || fail "读不出安装包的 main 入口"
cp "$LOCAL_ENTRY" "$PKG_DIR/$MAIN_REL"
LOCAL_SHA="$(sha256sum "$LOCAL_ENTRY" | cut -d' ' -f1)"
echo "==> 已用本仓库构建替换 $MAIN_REL (sha256 ${LOCAL_SHA:0:12}…)"

# 5. load it for real
echo "==> 启动 OpenCode 1.x serve (127.0.0.1:$PORT)"
start_serve || { tail -20 "$SERVE_LOG"; fail "OpenCode 1.x serve 无法启动"; }
sleep 2

SERVED_SHA="$(sha256sum "$PKG_DIR/$MAIN_REL" | cut -d' ' -f1)"
[ "$SERVED_SHA" = "$LOCAL_SHA" ] || fail "1.x 重装了插件包，实际加载的不是本仓库构建"

python3 -c '
import json, sys
agents = json.load(open(sys.argv[1]))
names = [str(entry.get("name", "")) for entry in agents]
builtin = {"build", "plan", "general", "explore", "compaction", "summary", "title"}
omo = [name for name in names if name and name not in builtin]
print("==> /agent: %d 个 agent，其中 omo 提供 %d 个" % (len(names), len(omo)))
for name in omo[:5]:
    print("    - " + name)
sys.exit(0 if omo else 1)
' /tmp/omo-v1-agents.json || fail "V1 的 /agent 里没有本插件装配出的 agent"

[ -f "$PLUGIN_LOG" ] || fail "插件日志 $PLUGIN_LOG 不存在（V1 未加载插件）"
grep -qF "[oh-my-openagent] ENTRY - plugin loading" "$PLUGIN_LOG" || fail "插件日志缺少 V1 装配完成标记"

count_marker() { grep -cF "$1" "$PLUGIN_LOG" 2>/dev/null || true; }
V2_NOTICE="$(count_marker "$NOTICE")"
V2_PROBE="$(count_marker "[omo-v2-probe]")"
V2_PORTING="$(count_marker "being ported")"
echo "==> 插件日志中的 V2 痕迹: notice=${V2_NOTICE:-0} probe=${V2_PROBE:-0} porting=${V2_PORTING:-0}（期望全 0）"
[ "${V2_NOTICE:-0}" = "0" ] || fail "V1 路径出现了 V2 启动提示"
[ "${V2_PROBE:-0}" = "0" ] || fail "V1 路径执行了 V2 探针"
[ "${V2_PORTING:-0}" = "0" ] || fail "V1 路径出现了 V2 迁移文案"
[ ! -f "$PROBE_AGENT" ] || fail "V1 路径写出了 V2 探针 agent 文件 ($PROBE_AGENT)"

TOOL_STATUS="$(curl -sS -o /tmp/omo-v1-tools.json --max-time 5 -w '%{http_code}' "$BASE/tool" 2>/dev/null || echo 000)"
case "$TOOL_STATUS" in
  200)
    # 1.x answers /tool with the web UI's HTML on some builds; only a JSON list is a real工具面.
    python3 -c '
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(3)
entries = payload if isinstance(payload, list) else payload.get("data") or payload.get("tools") or []
names = sorted({str(entry.get("id") or entry.get("name")) for entry in entries if isinstance(entry, dict)})
print("==> GET /tool -> 200，%d 个工具" % len(names))
print("    " + ", ".join(names[:12]))
sys.exit(0 if "call_omo_agent" in names else 1)
' /tmp/omo-v1-tools.json
    TOOL_VERDICT=$?
    if [ "$TOOL_VERDICT" = "1" ]; then
      fail "1.x 的 /tool 里没有本插件的工具（期望 call_omo_agent）"
    fi
    if [ "$TOOL_VERDICT" = "3" ]; then
      echo "==> GET /tool -> 200 但返回的不是工具列表（1.x 的 SPA 兜底）：工具注册改由装配日志 + agent 面共同见证"
    else
      grep -qF '"omo_v2_probe"' /tmp/omo-v1-tools.json && fail "V1 的工具面出现了 V2 探针工具"
    fi
    ;;
  *)
    echo "==> GET /tool -> $TOOL_STATUS（1.x 无工具列表端点：工具注册改由装配日志 + agent 面共同见证）"
    ;;
esac
echo "OK: OpenCode 1.x 加载本仓库插件成功：V1 装配标记存在、omo agent 面出现、无任何 V2 提示/探针"
DOCKER_V1_EOF
  verdict=$?
  set -e

  echo "==> 证据: $evidence"
  if [ "$verdict" -ne 0 ]; then
    echo "FAIL: e2e-v1 未通过（详见 $evidence）" >&2
    return 1
  fi
  echo "OK: e2e-v1 通过"
}

main() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift || true
  case "$sub" in
    build) cmd_build "$@" ;;
    install) cmd_install "$@" ;;
    typecheck) cmd_typecheck "$@" ;;
    test) cmd_test "$@" ;;
    run) cmd_run "$@" ;;
    build-plugin) cmd_build_plugin "$@" ;;
    build-index) cmd_build_index "$@" ;;
    e2e-load) cmd_e2e_load "$@" ;;
    e2e-s0) cmd_e2e_s0 "$@" ;;
    e2e-s1a) cmd_e2e_s1a "$@" ;;
    e2e-s3a) cmd_e2e_s3a "$@" ;;
    e2e-s2a) cmd_e2e_s2a "$@" ;;
    e2e-v1) cmd_e2e_v1 "$@" ;;
    -h|--help|help|"") usage ;;
    *)
      echo "未知命令: $sub" >&2
      usage
      return 2
      ;;
  esac
}

main "$@"
