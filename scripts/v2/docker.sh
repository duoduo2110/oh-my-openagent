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
    -h|--help|help|"") usage ;;
    *)
      echo "未知命令: $sub" >&2
      usage
      return 2
      ;;
  esac
}

main "$@"
