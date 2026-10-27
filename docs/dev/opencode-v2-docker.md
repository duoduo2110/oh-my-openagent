# OpenCode V2 纯 Docker 构建/测试基座

本目录是 OMO（oh-my-openagent）移植到 OpenCode V2 的验证基座：**宿主机只跑 docker / git / curl**，
依赖、构建、测试全部在容器里完成，`node_modules` 落在 docker 命名卷，不进宿主仓库。

## 文件

| 路径 | 作用 |
| --- | --- |
| `docker/v2/Dockerfile` | 基础镜像：`oven/bun:1.4.4` + `@opencode/cli@2.1.4`（bin 同时提供 `opencode` / `opencode2`）+ curl/jq/git/nodejs/npm/编译工具链，build 阶段校验版本 |
| `docker/v2/compose.yaml` | `v2`（常驻工具容器）与 `serve`（`opencode2 serve`，宿主 14096 → 容器 4096） |
| `scripts/v2/docker.sh` | 唯一入口：`build` / `install` / `typecheck` / `test` / `build-index` / `build-plugin` / `e2e-load` |

## 快速开始

```bash
scripts/v2/docker.sh build          # 构建镜像（约 5-8 分钟，取决于网络）
scripts/v2/docker.sh install        # 容器内 bun install --frozen-lockfile --ignore-scripts
scripts/v2/docker.sh typecheck      # 容器内 bun run typecheck
scripts/v2/docker.sh test packages/utils/src/jsonc-parser.test.ts
scripts/v2/docker.sh build-index    # 只产出 V2 插件 bundle dist/index.js（秒级）
scripts/v2/docker.sh e2e-load       # 起 serve 并断言 V2 已加载插件
```

所有子命令都透传额外参数，例如：

```bash
BUN_REGISTRY=https://registry.npmmirror.com scripts/v2/docker.sh install
scripts/v2/docker.sh test packages/model-core --bail
```

## 卷与挂载

`/repo` 是宿主仓库的绑定挂载，其余全部是命名卷，宿主目录不会被写入依赖：

- `omo-v2-node-modules` → `/repo/node_modules`
- `omo-v2-opencode-config` → `/root/.config/opencode`（V2 配置与暂存的插件目录）
- `omo-v2-opencode-data` → `/root/.local/share/opencode`（会话库、日志）
- `omo-v2-cache` → `/root/.cache`（bun 缓存）
- `omo-v2-lsp-daemon-node-modules` / `omo-v2-lsp-daemon-dist` → `packages/lsp-daemon/{node_modules,dist}`
  （`test-setup.ts` 会用 `npm ci` 构建 vendored lsp-daemon，这两层把它挡在宿主之外）

## serve 与认证

`serve` 用固定密码启动，仅监听宿主 `127.0.0.1:14096`：

```bash
docker compose -f docker/v2/compose.yaml up -d serve
curl -u opencode:omov2-local http://127.0.0.1:14096/api/plugin | jq '.data[].id'
docker compose -f docker/v2/compose.yaml logs -f serve
```

认证是 HTTP Basic，用户名固定 `opencode`，密码取 `OPENCODE_PASSWORD`（默认 `omov2-local`，
可用 `OMO_V2_SERVER_PASSWORD` 覆盖）。

## 插件是怎么接进 V2 的

1. 上游 `package.json` 的 `exports["./server"]` 指向 `dist/index.js`，其默认导出带 OpenCode 2 的 `setup`。
2. `build-index` 用与根 `bun run build` 相同的 `index` 节点打包，但**不加 `--external zod`**，
   得到自包含 bundle —— 目录插件没有自己的 `node_modules`，外部依赖会导致
   `Cannot find package 'zod'` 加载失败。
3. `e2e-load` 把 bundle 复制到配置卷里的插件目录
   `/root/.config/opencode/omo-v2-plugin/`，并软链 `skills -> /repo/packages/shared-skills/skills`
   （bundle 会按自身目录读取 `skills/**/SKILL.md`），然后写 `opencode.json`：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{ "package": "/root/.config/opencode/omo-v2-plugin" }]
}
```

4. 断言两件事：`GET /api/plugin` 的 `data[]` 出现 `id = oh-my-openagent` 且 `state.status = active`；
   插件日志 `/tmp/oh-my-opencode.log` 出现 `[opencode-v2] loaded without the V1 runtime` 提示
   （当前基线只弹提示，agents/tools/hooks 不生效，属预期）。

证据写到 `.slim/v2-evidence/`：`e2e-load-<ts>.json`（含响应与插件条目）、`.serve.log`（容器日志）、
`.plugin.log`（插件启动日志）。

## 已知限制

- `install` 用 `--ignore-scripts`：根 `prepare` 会触发完整 `bun run build`，其中 materialize 步骤需要
  git submodule（浅克隆里为空）。构建请显式用 `build-index` / `build-plugin`。
- `build-plugin`（根 `bun run build`）会跑 codex/senpi/lsp 子构建里的 `npm ci`，可能把 `node_modules`
  和 `dist` 写进绑定挂载的宿主仓库；只做插件加载验证时用 `build-index`。
- 容器以 root 运行，绑定挂载里生成的产物（`dist/`）宿主侧属主是 root，必要时 `sudo chown -R $USER dist`。
- `registry.npmjs.org` 在本机较慢且偶发失败，可用 `BUN_REGISTRY=https://registry.npmmirror.com`。
- 镜像包含完整编译工具链 + 全局 CLI，体积偏大（约 2.8 GB），换取原生依赖与 e2e 一次成型。
- bun 的 workspace 链接会在 `packages/*/node_modules` 下留极小的符号链接桩（合计约 0.5 MB，
  已在 `.gitignore` 内）；1.3 GB 真实依赖只在命名卷里。
- `test` 目前**跑不起来**（不是镜像问题）：全局 preload `test-setup.ts` 要求存在
  `packages/lsp-daemon/dist`，缺失时会执行 `npm ci && npm run build`，而
  `packages/lsp-daemon/package-lock.json` 里有 `workspace:*` 依赖，npm 直接
  `EUNSUPPORTEDPROTOCOL`，bun 在子目录里也无法解析该 workspace 协议。
  需要先在有 workspace 上下文的根目录预构建出 `packages/lsp-daemon/dist`，`test` 才会进入用例。
