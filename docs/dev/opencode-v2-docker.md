# OpenCode V2 纯 Docker 构建/测试基座

本目录是 OMO（oh-my-openagent）移植到 OpenCode V2 的验证基座：**宿主机只跑 docker / git / curl**，
依赖、构建、测试全部在容器里完成，`node_modules` 落在 docker 命名卷，不进宿主仓库。

## 文件

| 路径 | 作用 |
| --- | --- |
| `docker/v2/Dockerfile` | 基础镜像：`oven/bun:1.4.4` + `@opencode/cli@2.1.4`（bin 同时提供 `opencode` / `opencode2`）+ curl/jq/git/nodejs/npm/编译工具链，build 阶段校验版本 |
| `docker/v2/compose.yaml` | `v2`（常驻工具容器）与 `serve`（`opencode2 serve`，宿主 14096 → 容器 4096） |
| `scripts/v2/docker.sh` | 唯一入口：`build` / `install` / `typecheck` / `test` / `run` / `build-index` / `build-plugin` / `e2e-load` / `e2e-s0` / `e2e-v1` / `e2e-pack` |

## 快速开始

```bash
scripts/v2/docker.sh build          # 构建镜像（约 5-8 分钟，取决于网络）
scripts/v2/docker.sh install        # 容器内 bun install --frozen-lockfile --ignore-scripts
scripts/v2/docker.sh typecheck      # 容器内 bun run typecheck
scripts/v2/docker.sh test packages/utils/src/jsonc-parser.test.ts
scripts/v2/docker.sh run bun run build:omo-schema   # 容器内跑任意脚本（schema 重生成等）
scripts/v2/docker.sh build-index    # 只产出目录插件用的自包含 bundle .slim/v2-bundle/index.js（秒级，不动 dist/index.js）
scripts/v2/docker.sh e2e-load       # 起 serve 并断言 V2 已加载插件
scripts/v2/docker.sh e2e-s0         # V2 宿主探针：setup 次数 / 工具 schema / agent 发现 / Bun 运行时
scripts/v2/docker.sh e2e-v1         # V1 回归门禁：真实 OpenCode 1.x 加载本仓库插件
scripts/v2/docker.sh e2e-pack       # 发布产物门禁：npm pack → 隔离 HOME 安装 → serve + TUI 断言（需先 build-plugin）
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
   `Cannot find package 'zod'` 加载失败。产物落在 `.slim/v2-bundle/index.js`（不进 `dist/`、不参与发布）。
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

### 两种形态，别混着验

| 形态 | 入口 | 依赖从哪来 | 用哪个门禁 |
| --- | --- | --- | --- |
| **目录插件** | `plugins: [{ "package": "<目录>" }]`（目录里的 `package.json` 有 `exports["./server"]`） | 目录里没有 `node_modules`，bundle 必须自包含 | `build-index` + `e2e-load` / `e2e-s*` |
| **npm 安装** | `plugins: [{ "package": "file:<已安装包目录>" }]`（生产是 `"oh-my-openagent@<version>"`） | 宿主按 npm spec 解析；`zod` 由包自己的 `dependencies` 提供 | `build-plugin` + `e2e-pack` |

发布态 `dist/index.js` 保留 `--external zod`：`zod` 在 `dependencies` 里，npm 安装后一定可解析
（e2e-pack 断言 `zod-resolvable-from-plugin`）。目录插件形态没有 `node_modules`，所以 `build-index`
必须去掉 `--external zod` 打成自包含 bundle —— 两个产物的差异是**故意的**，`build-index` 只写
`.slim/v2-bundle/`，不覆盖 `dist/index.js`。

`@opentui/solid@0.6.8` + `solid-js` 会随 `dependencies` 装进插件自己的 `node_modules`，与宿主二进制里
内置的那份并存（e2e-pack 记录 `solidCopiesInInstall=1`）。实测**不影响 TUI**：真实 TUI 进程仍
`stage=setup plugin=oh-my-openagent:tui`、`[tui-sidebar] V2 view rendered`、屏幕出现侧栏 `Models`，
因此两者继续留在 `dependencies`，没有改成 optional peer。

### V2 的配置键：`plugins` vs `plugin`

容器内实测（最小插件 + 隔离 HOME）：

| 配置 | 结果 |
| --- | --- |
| `opencode.json` `plugins: [{ package: "<目录>" }]`（V2 键） | 加载：`source.type=local`、`state.status=active` |
| `opencode.json` `plugin: ["<目录>"]`（V1 键） | **也能加载**：`source.type=local`、`state.status=active` |
| `opencode.json` `plugin: ["file:<目录>"]` | 加载失败并明确列出：`state.status=failed` + `Cannot find package 'zod'`（目录里没有依赖） |
| `opencode.json` `plugins: [{ package: "file:<已安装包>" }]` | 加载：`source.type=package`、`features.tui=true`、`state.status=active` |

结论：V2 容忍 V1 的 `plugin` 键，但**TUI 只读 `cli.json`**。所以安装器在 2.x 宿主上写 V2 原生形态：
`opencode.json` 写 `plugins: [{ package }]`（同时把本插件的条目从 V1 `plugin` 键移走，避免双加载），
并额外写/合并 `cli.json` 的 `plugins`；1.x 宿主仍写 `plugin` + `tui.json`，行为不变。

## 每阶段验收命令

每个阶段收口前，按下面的顺序在容器里跑一遍；宿主只负责 `docker` / `git` / `curl`，不跑 bun、不装依赖。
除了 `lint:ratchet`（走 `run`）以外都是一等子命令，失败即非零退出。

| 阶段 | 命令 | 覆盖什么 |
| --- | --- | --- |
| 类型 | `scripts/v2/docker.sh typecheck` | 根 `tsc` + 全部 `packages/*` 投影（注意：`*.test.ts` 不在 typecheck 范围内，测试的正确性只有 `test` 能证） |
| 单元/集成 | `scripts/v2/docker.sh test packages/omo-opencode` | 插件本体全量用例（`bun test --timeout 20000`），必须 0 fail |
| 静态门禁 | `scripts/v2/docker.sh run bun run lint:ratchet` | 复杂度/规模棘轮，baseline 之外不得新增（改结构后先 `run bun run lint:ratchet:update` 再确认 exit 0） |
| 构建 | `scripts/v2/docker.sh build-plugin` | 根 `bun run build`：lsp 子包 `npm ci`、`dist/index.js` + shim、schema 生成全部要过 |
| 快速产物 | `scripts/v2/docker.sh build-index` | 只出自包含 `.slim/v2-bundle/index.js`（目录插件 e2e 用）+ `dist/tui.js`；**不覆盖**发布态 `dist/index.js` |
| V2 加载 | `scripts/v2/docker.sh e2e-load` | `opencode2 serve` 里插件 id 出现且 `state.status = active`，启动提示落到插件日志 |
| **发布产物** | `scripts/v2/docker.sh e2e-pack` | 真 `npm pack` → tarball 装进隔离 HOME 的临时插件目录 → 插件 `active`、`tool.list ≥ 50`、`zod` 从安装树可解析、真实 TUI 进程加载 `./tui` 并画出侧栏 |
| V2 探针 | `scripts/v2/docker.sh e2e-s0` | `setup` 恰好一次、工具 schema 被宿主接受、agent markdown 被发现、Bun 运行时可见 |
| V1 回归 | `scripts/v2/docker.sh e2e-v1` | 真实 OpenCode 1.x（默认 1.19.4）加载本仓库插件：V1 装配标记存在、omo agent 面出现、日志里无任何 V2 提示/探针 |

几条实践约定：

- **顺序**：`typecheck` → `test` → `lint:ratchet` → `build-plugin` → `e2e-load` / `e2e-s0` / `e2e-v1`。
  `build-plugin` 会重写 `dist/index.js`（带 node-require-shim），`build-index` 只写 `.slim/v2-bundle/`，
  两者互不覆盖；`dist` 相关用例（`shared/dist-bundle-*.test.ts`）只有跑过 `build-plugin` 之后才为绿。
- **单车道**：一次只起一个容器，各 `e2e-*` 会互相清理 `serve` 容器与端口。
- **证据**：`e2e-*` 的产物统一落 `.slim/v2-evidence/`（`e2e-v1-<ts>.log`、`s0-<ts>.json` 等），
  汇报时贴证据文件名而不是整段日志。

## 已知限制

- `install` 用 `--ignore-scripts`：根 `prepare` 会触发完整 `bun run build`，其中 materialize 步骤需要
  git submodule（浅克隆里为空）。构建请显式用 `build-index` / `build-plugin`。
- `build-plugin`（根 `bun run build`）会跑 `packages/lsp-*` 子构建里的 `npm ci`，可能把 `node_modules`
  和 `dist` 写进绑定挂载的宿主仓库；只做插件加载验证时用 `build-index`。
- 容器以 root 运行，绑定挂载里生成的产物（`dist/`）宿主侧属主是 root，必要时 `sudo chown -R $USER dist`。
- `registry.npmjs.org` 在本机较慢且偶发失败，可用 `BUN_REGISTRY=https://registry.npmmirror.com`。
- 镜像包含完整编译工具链 + 全局 CLI，体积偏大（约 2.8 GB），换取原生依赖与 e2e 一次成型。
- bun 的 workspace 链接会在 `packages/*/node_modules` 下留极小的符号链接桩（合计约 0.5 MB，
  已在 `.gitignore` 内）；1.3 GB 真实依赖只在命名卷里。
- `test` 的全局 preload `test-setup.ts` 要求存在 `packages/lsp-daemon/dist`；缺失时它会执行
  `npm ci && npm run build`。两个 vendored 包的 lock 现在都只引用 `file:../lsp-core` /
  `file:../mcp-stdio-core`（不再有 npm 不认的 `workspace:*`），所以这一步可以直接跑通；
  首次跑 `test` 仍会比后续慢一个 `npm ci` 的时间。
- `e2e-v1` 需要网络装 OpenCode 1.x（`opencode-ai@1.19.x`）。1.x 只把 `plugin` 当 npm 包名解析
  （绝对路径与 `~/.config/opencode/plugin/` 目录在 1.19 已不生效），所以门禁先让 1.x 装一遍包，
  再把安装目录里的入口替换成本仓库 `dist/index.js`，并用 sha256 证明替换没被重装覆盖。
  1.x 另有自己的 SQLite schema，门禁给它单独的 `XDG_DATA_HOME`，不碰 V2 的会话库。
