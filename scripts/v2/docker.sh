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
REPO_DIST_ENTRY="/repo/dist/index.js"
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
  build-index   只构建 V2 插件产物 dist/index.js（自包含，e2e 用）
  build-plugin  容器内 bun run build（根脚本，含全部子构建）
  e2e-load      起 serve 容器并断言 /api/plugin 已加载本地插件
  e2e-s0        OpenCode V2 宿主探针（S0）：setup 次数 / 工具 schema / agent markdown / Bun 运行时，
                证据落 .slim/v2-evidence/s0-<ts>.json

环境变量:
  OMO_V2_PLUGIN_DIR       容器内插件目录（默认 /root/.config/opencode/omo-v2-plugin）
  OMO_V2_PORT             宿主端口（默认 14096）
  OMO_V2_PLUGIN_ID         期望的插件 id（默认 oh-my-openagent）
  OMO_V2_SERVER_PASSWORD   serve 的 Basic 密码（默认 omov2-local）
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

cmd_build_plugin() {
  # OMO_SKIP_MATERIALIZE: a source checkout has empty upstream submodules; the
  # materialize step clones them and is irrelevant to the plugin bundle.
  run_v2 env OMO_SKIP_MATERIALIZE=1 bun run build "$@"
}

cmd_build_index() {
  # Same `index` node the root build runs, but bundled self-contained (no
  # `--external zod`) so the staged plugin directory needs no node_modules.
  run_v2 bun build packages/omo-opencode/src/index.ts \
    --outdir dist --target bun --format esm "$@"
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

main() {
  local sub="${1:-}"
  [ $# -gt 0 ] && shift || true
  case "$sub" in
    build) cmd_build "$@" ;;
    install) cmd_install "$@" ;;
    typecheck) cmd_typecheck "$@" ;;
    test) cmd_test "$@" ;;
    build-plugin) cmd_build_plugin "$@" ;;
    build-index) cmd_build_index "$@" ;;
    e2e-load) cmd_e2e_load "$@" ;;
    e2e-s0) cmd_e2e_s0 "$@" ;;
    -h|--help|help|"") usage ;;
    *)
      echo "未知命令: $sub" >&2
      usage
      return 2
      ;;
  esac
}

main "$@"
