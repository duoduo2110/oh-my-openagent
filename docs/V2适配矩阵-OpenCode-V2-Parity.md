# V2 适配矩阵：oh-my-openagent on OpenCode 2

> 面向用户与评审者的 parity 清单。每一行只写**有证据**的结论：`✅ PASS` 必须有 e2e 断言或真实宿主日志，
> 否则写 `⚠️ 有降级` / `⛔ 未桥接` / `🚫 不支持`。本页不含推测。
>
> **本版取数**：2026-10-27（S1c 落地后）。全文 94 行结论：`✅` 56 / `⚠️` 28 / `⛔` 2 / `🚫` 8。

## 基线

| 项 | 值 |
| --- | --- |
| 仓库 | `oh-my-openagent`（本仓库），V2 适配分支 `dev`，提交 `bd9c5a8` + 未提交的 S1c 车道（本文按 2026-10-27 工作树取证） |
| 宿主 | OpenCode 2.1.4（`@opencode/cli` / `@opencode/plugin` / `@opencode/client` / `@opencode/theme` 同版本） |
| TUI 运行时 | `@opentui/core` `@opentui/solid` `@opentui/keymap` = `0.6.8`（与 V2 peer `>=0.6.8` 对齐） |
| Solid | `solid-js` = `1.9.12`（V2 peer `>=1.9.0`，也是 `@opentui/solid` 的 peer） |
| V1 基线 | OpenCode 1.x 路径完全保留：同一个包同时导出 V1 `server`/`tui` 与 V2 `setup` |

### 状态图例

| 标记 | 含义 |
| --- | --- |
| ✅ PASS | 真实宿主里可断言成立 |
| ⚠️ 有降级 | 已注册/已接线，但语义或体验与 V1 有差，或成功路径依赖当前环境不具备的外部条件（模型 provider / tmux / 运行中的 team）；日志里有可 grep 的说明 |
| ⛔ 未桥接 | 代码里没有该注册/投影，V2 用户拿不到该能力 |
| 🚫 不支持 | OpenCode 2.1.4 宿主没有对应能力（有明确日志，不伪造成功） |

### 证据索引（本文反复引用的文件）

| 简称 | 命令 | 证据文件（`.slim/v2-evidence/`） |
| --- | --- | --- |
| e2e-load | `scripts/v2/docker.sh e2e-load` | `e2e-load-*.json`、`e2e-load-*.plugin.log` |
| e2e-s0 | `e2e-s0` | `s0-*.json`（`setup#N`、工具 schema、agent 发现、Bun 运行时） |
| e2e-s1a | `e2e-s1a` | `s1a-20261027-152335.json`（`toolList.expected/missing`、`bridge.registered[]`） |
| e2e-s1b | `e2e-s1b` | `s1b-20261027-152353.json`（`listed`、`bridge.modes`、`deps`） |
| e2e-s1c | `e2e-s1c` | `s1c-20261027-161738.json` + `.plugin.log` + `.selftest.log`（`toolList.count=54`、`missingC=[]`、`bridge.groupC.built=20/skipped=[]`、`taskPolicy`、`tmux`、22 条 assertions、自测 93 checks） |
| e2e-s2a | `e2e-s2a` | `s2a-20261027-152411.json`（`runtime assembled hooks=13 tools=13 managers=6 agents=11`） |
| e2e-s2b1 | `e2e-s2b1` | `s2b1-20261027-152430.json`（`bridge.installed.bridged[]/degraded[]`、`toolOwnership`） |
| e2e-s3a | `e2e-s3a` | `s3a-20261027-152453.json`（10 agent 发现、modes、幂等、禁用删除） |
| e2e-s3b | `e2e-s3b` | `s3b-20261027-152548.json`（MCP/command/skill 投影、`unsupported[]`） |
| e2e-s4 | `e2e-s4` | `s4-20261027-152617.json`（shim 语义、5 个语义 hook、禁用名单） |
| e2e-tui | `e2e-tui` | `e2e-tui-20261027-152636.json` + `.screen.log`（终端截屏文本） |
| e2e-v1 | `e2e-v1` | `e2e-v1-20261027-152653.log`（V1 回归门禁） |

单元/集成证据（`bun test` 直接可跑）：

| 文件 | 覆盖 |
| --- | --- |
| `packages/omo-opencode/src/opencode-v2/__tests__/tool-bridge.selftest.ts` | 桥接收口：schema、结果归一、signal/abort、覆盖意图 |
| `packages/omo-opencode/src/opencode-v2/__tests__/s1b.selftest.ts` | B 组 10 工具的 75 项真实调用 |
| `packages/omo-opencode/src/opencode-v2/__tests__/s1c.selftest.ts` | C 组 20 工具 93 项：注册/覆盖策略、`background_output` 截止与 abort、monitor 关闭态、team 门禁与 task 闭环、委派 abort |
| `packages/omo-opencode/src/opencode-v2/__tests__/hooks.selftest.ts` | 52 项：按 location 单桥、泵、写回、禁用名单、释放 |
| `packages/omo-opencode/src/opencode-v2/__tests__/adapter.selftest.ts` | 35 项：分键单例、失败回收顺序、dispose 幂等 |
| `packages/omo-opencode/src/opencode-v2/__tests__/agents.selftest.ts` | 96 项：物化、scope、幂等、托管文件删除 |
| `packages/omo-opencode/src/opencode-v2/__tests__/config-domains.selftest.ts` | 域投影、幂等、unsupported 上报 |
| `packages/omo-opencode/src/opencode-v2/__tests__/s4.selftest.ts` | 33 项：messages/todo/status/config 语义 + 5 键写回 |
| `packages/omo-opencode/src/opencode-v2/__tests__/tui-v2.test.ts`、`tui-btw-v2.test.ts` | slot 声明、keymap 层、BTW 对话框流程、释放 |
| `packages/omo-opencode/src/index.v1-regression.test.ts` | V1 默认导出不触发 V2 路径 |

---

## 1. 插件加载与生命周期

| 能力 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| V2 插件加载（`exports["./server"]` → `setup`） | ✅ | e2e-load（目录插件形态）与 e2e-pack（npm 安装形态）都是 `id=oh-my-openagent`、`state.status=active` | 两种形态依赖不同：**目录插件形态需自包含 bundle**（无 `node_modules`，`--external zod` 会 `Cannot find package 'zod'`）；**npm 安装形态依赖 zod**（`dependencies` 兜底，e2e-pack 已证）；`@opentui/solid` 双份布局以 e2e-pack 为准 |
| npm 安装形态（`npm pack` → 装包 → `plugins[{package:"file:<dir>"}]`） | ✅ | e2e-pack：tarball 装进隔离 HOME，`/api/plugin` `state.status=active`、`features.tui=true`、插件日志 `tool.list count=54`、TUI 侧栏渲染 `Models` | 宿主把 `package` 当 npm spec 解析；本地安装树必须带自己的 `node_modules`（zod 由 `dependencies` 提供，hoist 到安装根即可） |
| TUI 可达性（`cli.json` 的 `plugins`） | ✅ | e2e-tui / e2e-pack：宿主日志 `stage=setup plugin=oh-my-openagent:tui`、插件日志 `[tui-sidebar] V2 view rendered` | V2 的 server 读 `opencode.json` 的 `plugins`，TUI 只读 `cli.json` 的 `plugins`；安装器对 2.x 宿主两个都写，V1 仍写 `plugin` + `tui.json` |
| `setup` 每 location 一次、状态按目录分键 | ✅ | e2e-s0 `[omo-v2-probe] setup#1 location=/repo`；`adapter.selftest.ts`（分键 + in-flight 去重） | 多 location 并发只在 selftest 证过，真实宿主未同时开两个 worktree |
| 装配失败回收顺序 + `dispose` 幂等 | ✅ | `adapter.selftest.ts`：`PASS tools failure releases what was built, in order, once`；e2e-s2a assertions 全绿 | 失败只会少能力，宿主仍启动（`setup` 不抛） |
| V1 路径不受影响（1.x 不会走 V2） | ✅ | `index.v1-regression.test.ts`（5 例）+ e2e-v1：V1 装配标记存在、V2 提示/探针计数 0、无 `omo-v2-probe.md` | 无 |

## 2. 事件泵

| 能力 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| `ctx.event.subscribe` 泵 → V1 `event` handler | ✅ | e2e-s2b1 `pumpStarted=true`；`hooks.selftest.ts` 52/52（`PASS pumps are per location`） | V2 envelope `{id,type,data}` 由泵转成 V1 `{type,properties}`；未知事件原样透传 |
| cleanup 停泵、计数冻结、按引用释放 | ✅ | `hooks.selftest.ts`：`PASS counters frozen after cleanup`、`PASS one of two references released keeps A installed`；`server-entry.ts` 先 `releaseHooks` 再 `runtime.dispose` | TUI 进程退出不 await 异步清理，故 TUI 侧全部同步释放 |

## 3. 工具

V1 工具注册表共 **38 个键**（`packages/omo-opencode/src/plugin/tool-registry.ts` 的五个 record 合并结果）。
V2 侧已桥接 **A 组 7 + B 组 10 + C 组 20 = 37 个**（`edit` 为开关项；`task` 默认按策略跳过）。
真实宿主 `ctx.tool.list()` 从 **21** 涨到 **54**（`s1c-20261027-161738.json` 的 `toolList.count` / `bridge.delta`）。
逐名如下。

### 3.1 A 组：纯本地（7 + 1 可选）

| 工具 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| `grep` | ✅ | e2e-s1a `bridge.registered[]`：`{name:"grep",mode:"zod",replacedBuiltin:true}`；e2e-s2b1 `toolOwnership.grepCount=1`、描述为 V1 文案 | 显式覆盖宿主内置 `grep`（V2 同名 `add` = 静默覆盖，故桥接层记录 `replacedBuiltin`） |
| `glob` | ✅ | e2e-s1a `{name:"glob",replacedBuiltin:true}` | 同上（覆盖内置 `glob`） |
| `task_get` | ✅ | e2e-s1a `toolList.expected` 含 `task_get`、`missing=[]` | 不沿用 `experimental.task_system` 开关，只能靠 `disabled_tools` 屏蔽 |
| `task_list` | ✅ | 同上 | 同上 |
| `create_goal` | ✅ | e2e-s1a `toolList.expected` 含 `create_goal` | 依赖 `goal.enabled` 配置；关闭即不注册 |
| `update_goal` | ✅ | 同上 | 同上 |
| `get_goal` | ✅ | 同上 | 同上 |
| `edit`（hashline） | ⚠️ 有降级 | `packages/omo-opencode/src/opencode-v2/tools.ts`（`V2_OPTIONAL_EDIT_TOOL_NAME` + `OMO_V2_ENABLE_EDIT`）；`tool-bridge.selftest.ts` 覆盖同名不覆盖策略 | 默认不注册：与宿主内置 `edit` 同名，需 `OMO_V2_ENABLE_EDIT=1`（或 `hashline_edit` 配置）显式开启 |

### 3.2 B 组：需要 session / 上下文（10）

| 工具 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| `session_list` | ✅ | e2e-s1b `listed` 含 `session_list`、`bridge.modes.session_list="zod"` | 会话历史经 `session.context()` 重建，`parts` 是近似形状（见 §7） |
| `session_read` | ✅ | e2e-s1b 同上；`s1b.selftest.ts` 75 项含跨会话隔离 | `include_todos` 读的是插件侧 todo store（与 `task_*` 同源） |
| `session_search` | ✅ | e2e-s1b 同上 | 搜索范围是 shim 能看到的会话（本 location） |
| `session_info` | ✅ | e2e-s1b 同上 | 状态字段来自事件注册表 + `active()`/`list()`，非恒定 `idle` |
| `skill` | ✅ | e2e-s1b `{name:"skill",replacedBuiltin:true}` | 显式覆盖宿主内置 `skill`；`nativeSkills` 在 V2 为空，列表来自 V1 loader（31 个） |
| `skill_mcp` | ✅ | e2e-s1b `mode="zod"`；`deps.skills=31` | MCP 依赖 `ctx.mcp.list()`，投影期间可能为空（已记录，不报错） |
| `look_at` | ✅ | e2e-s1b `look_at` 注册成功；`s1b.selftest.ts` 真实子会话调用 | `multimodal-looker` 被 `disabled_agents` 禁用时跳过该工具并记录原因 |
| `task_create` | ✅ | e2e-s1b `mode="zod"`；`s1b.selftest.ts` todo 写入 `ctx.storage` | 未沿用 `experimental.task_system` 开关（仅 `disabled_tools` 可屏蔽） |
| `task_update` | ✅ | 同上 | 同上 |
| `interactive_bash` | ⚠️ 有降级 | e2e-s1b 注册成功；`tools/index.ts` 记录 `INTERACTIVE_BASH_REQUIREMENT` | 无 `tmux` 时返回**错误字符串**（不抛异常），模型可见但不可用 |

### 3.3 C 组：需要 client / manager（20，S1c 已桥接）

评定规则：`✅` = 注册进 `ctx.tool.list()` 且**至少一次真实调用返回 V1 语义下的正常结果**；
`⚠️` = 注册成功，但**可走通的成功路径依赖本环境不具备的外部条件**（模型 provider / tmux / 一个已存在的运行中 team），
当前证据只到门禁、边界或错误成功路径。分布：**✅ 6 / ⚠️ 14 / ⛔ 0**。所有行共享同一条注册证据：
`.slim/v2-evidence/s1c-20261027-161738.plugin.log` 的 `[omo-v2] tool group c {"built":[20 个],"skipped":[]}`、
逐名 `tool registered <name> {"mode":"zod","group":"c"}`，以及自测 `93 checks, 0 failure(s)` 里的 `group C built <name>`。

| 工具 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| `task`（delegate） | ⚠️ 有降级 | e2e-s1c `bridge.groupC.built` 含 `task`，但 `bridge.taskPolicy.policy="skip"`、`toolList.listed` 里**没有** `task`（断言 `taskSkippedByDefault`、`taskNotAddedToHost`）；日志 `tool not registered task (skip unless enabled; no host tool owns the name)`；自测 `task is skipped by default even without a same-named builtin` + `exactly nineteen C tools were registered`；`OMO_V2_TASK_TOOL=override` 时 `OMO_V2_TASK_TOOL=override registers the V1 task tool`、`the override replaced the builtin task`、`the override carries the V1 delegate description`；abort 通路 `task honours v2ctx.signal` | 默认不注册（宿主自带 `subagent` 已是 spawner，见 §3.4）；真实派发要模型 provider，容器内只验证到 override 注册 + abort 应答 |
| `call_omo_agent` | ⚠️ 有降级 | 日志 `tool registered call_omo_agent {"mode":"zod","replacedBuiltin":false,"group":"c"}`；e2e-s1c `missingC=[]`；自测 `call_omo_agent answers a readable error without a provider`（`Invalid agent type "not-a-real-agent"`） | 真实派发需模型 provider（日志 `tool requires a model provider task,call_omo_agent`）；本环境证据只到 schema + 可读错误串 |
| `background_output` | ⚠️ 有降级 | 注册 + zod schema；自测 `background_output explains an unknown id`、`background_output with block:true still answers an unknown id at once`；V2 新增截止：`block:true,timeout:1000` → `a blocked poll is released in <5s (took 4002ms)`、abort → `an aborted wait answers at once (took 102ms)`（含 `did not answer within` / `was aborted` 文案） | 真实长轮询要等一个**运行中**的后台任务，容器内无 provider 造不出该任务；截止与 abort 用 stub 压测 |
| `background_cancel` | ⚠️ 有降级 | 注册 + 自测 `background_cancel answers with nothing to cancel`（V1 文案 `No running or pending background tasks to cancel.`） | 真实取消同样需要运行中任务；空态之外的路径未验 |
| `monitor_start` | ⚠️ 有降级 | 注册；日志 `tool requires monitor.enabled monitor_start`（"registered even when monitor.enabled is false; monitor_start fails closed"）；自测 `monitor_start fails closed when the feature is off`、`monitor_start names the V1 reason`（`[ERROR] monitor_start denied: monitor feature disabled`） | 需 `monitor.enabled=true` **且** tmux 才能真起一个 monitor；关闭时只回错误串（不抛） |
| `monitor_stop` | ⚠️ 有降级 | 注册 + 自测 `monitor_stop answers already-stopped`（未知 id → `{"status":"already-stopped"}`） | 同 `monitor_start`：没有可停止的 monitor，停止真实 monitor 未验 |
| `monitor_list` | ⚠️ 有降级 | 注册 + 自测 `monitor_list returns { monitors: [] }`、`monitor_list is empty for a fresh session` | 只到空态；非空列表需 monitor 开启 + tmux |
| `monitor_output` | ⚠️ 有降级 | 注册 + 自测 `monitor_output answers not_found`（未知 id → `{"error":"not_found"}`） | 同上；真实 monitor 的留存输出未验 |
| `team_create` | ⚠️ 有降级 | 四条门禁全部成立：`team_create refuses while team_mode is disabled`（`… is unavailable: team_mode is disabled`）、`team_create reports a missing spec as content`、`team_create answers for a JSON-string inline_spec` + `an invalid inline spec is reported as content`、`team_create refuses tmux_visualization without tmux`（`cannot honour team_mode.tmux_visualization`）；`inline_spec` 预处理 `a JSON-string inline_spec becomes an object` | 正向创建一条新 run 需要 tmux（成员是 pane）；本环境只验证拒绝路径与错误串是 content 而非 throw |
| `team_delete` | ⚠️ 有降级 | 注册 + 自测 `team_delete reports an unknown run as content` | 只验证未知 run 错误串；删除一个真实 run 未验（需 tmux 起来的 team） |
| `team_shutdown_request` | ⚠️ 有降级 | 注册 + `team_shutdown_request reports an unknown run` | 同上 |
| `team_approve_shutdown` | ⚠️ 有降级 | 注册 + `team_approve_shutdown reports an unknown run` | 同上 |
| `team_reject_shutdown` | ⚠️ 有降级 | 注册 + `team_reject_shutdown reports an unknown run` | 同上 |
| `team_send_message` | ⚠️ 有降级 | 注册 + `team_send_message reports an unknown run` | 消息真实投递需要成员 pane，未验 |
| `team_task_create` | ✅ | 注册 + 自测 `team_task_create allocated task id 1`（临时 `team_mode.base_dir` 下真实写 team-core 文件） | 需显式 `teamRunId`；task 归属由调用成员决定 |
| `team_task_list` | ✅ | 注册 + 自测 `team_task_list returns the created task`（create → list = 1 条） | 同上 |
| `team_task_update` | ✅ | 注册 + 自测 `team_task_update moved the task to in_progress`、`team_task_update attributed the change to the calling team member`（`owner=lead`） | 同上 |
| `team_task_get` | ✅ | 注册 + 自测 `team_task_get reads the updated status back`（create→list→update→get 闭环） | 同上 |
| `team_status` | ✅ | 注册 + 自测 `team_status reports the run id`、`team_status reports the runtime status`（`active`）、`team_status lists both members` | 状态来自 team-core 状态文件，进程重启后按文件重建 |
| `team_list` | ✅ | 注册 + 自测 `team_list finds the project spec via ctx.location.directory`、`team_list counts the spec's members`、`team_list joins the active run` | 注册目录取自 `ctx.location.directory`（V1 用 `process.cwd()`），V2 下这是唯一正确来源 |

> C 组的共同降级：`errorMode:"content"` —— 拒绝一律变成可读的 `Error: <tool>: ...` 字符串（不抛异常、不返回空结果），
> 所以模型能看到"为什么不可用"，但工具本身不会成功。tmux 探测见日志
> `tool requires tmux team {"tmuxAvailable":false,...}`，无 tmux 时 `team_mode` 的**状态与任务**照常工作，只有 pane 布局不可用。

### 3.4 同名覆盖策略与 `task`

V2 的 `tool.transform` 里同名 `add` 是**静默覆盖**（`Map.set`，后注册者赢）。因此桥接层的规则是：

- `grep` / `glob` / `skill`：**显式覆盖**宿主内置（e2e-s1a `replacedBuiltin=true`，e2e-s2b1 `grepCount=1`、描述为 V1 文案，证明只有一份、且是我们的）。
- `task_get` / `task_list` / `session_*` / `skill_mcp` / `look_at` / `task_create` / `task_update` / `interactive_bash` / `create_goal` / `update_goal` / `get_goal`：宿主无同名，纯新增。
- `edit`：宿主有内置同名，**默认不覆盖**，必须显式开关。
- `task`：宿主没有 `task`，但有语义重叠的内置 `subagent`。S1c 的结论是**不静默抢占**：二十个 C 组名字里只有 `task` 保留 `skip`（`V2_TASK_TOOL_ENV = OMO_V2_TASK_TOOL`），其余 19 个用 `override`（宿主本来就没有同名工具）。

需要 V1 的委派语义（OMO 分类、技能注入、`run_in_background`）时显式开启：

```bash
OMO_V2_TASK_TOOL=override opencode   # 也接受 =1 / =true
```

开启后 V1 的 `task` 定义会**覆盖**宿主 `subagent`（自测 `the override replaced the builtin task`、`the override carries the V1 delegate description`），两个 spawner 不会同时存在。默认策略的日志是 `tool not registered task (skip unless enabled; no host tool owns the name)` + `task tool policy {"policy":"skip","env":"OMO_V2_TASK_TOOL",...}`。

## 4. hooks（V1 14 键）

V1 `src/plugin-interface.ts` 暴露 14 个键；V2 桥接后宿主日志为 `runtime assembled hooks=13 hookKeys=...`（13 = 14 去掉未注册的 `tool`）。逐键如下。

| V1 键 | 状态 | V2 落点 / 证据 | 已知降级 |
| --- | --- | --- | --- |
| `event` | ✅ | `ctx.event.subscribe` 泵；e2e-s2b1 `bridge.installed.bridged[]` 含 `event` | envelope 形状转换（见 §2） |
| `tool.execute.before` | ✅ | `ctx.tool.hook("execute.before")`；e2e-s2b1 bridged；`hooks.selftest.ts` `before rewrite: bash null bytes written back` | 只能原地改事件对象，无返回值通道 |
| `tool.execute.after` | ✅ | `ctx.tool.hook("execute.after")`；e2e-s2b1 bridged | 同上；`after` 抛错会变成宿主 defect，故桥接层吞异常并记录 |
| `tool.definition` | ✅ | `ctx.tool.transform(editor)`；`hooks.selftest.ts` `tool.definition writeback: todowrite description` | 每个工具逐条改，不能改名/删除 |
| `chat.message` | ✅ | `ctx.session.hook("prompt")`；e2e-s4 `promptWriteback` | V1 通过该键写 `model`/`variant` 的副作用在 V2 无处落地 |
| `chat.params` | ⚠️ 有降级 | `ctx.session.hook("context")` 的 `options`；e2e-s4 `paramsWriteback` | 2.1.4 `model.request` 没有 generation options，只能落 `options` 级；per-message variant 丢失 |
| `chat.headers` | ✅ | `ctx.session.hook("http.request")`；e2e-s4 `headersWriteback` | 仅请求头，不能改 body |
| `experimental.chat.system.transform` | ✅ | `ctx.session.hook("context")`；e2e-s4 `systemWriteback` | V1 的 `string` → V2 `SystemPart[]`，顺序按宿主约定 |
| `experimental.chat.messages.transform` | ⚠️ 有降级 | `ctx.session.hook("context")`；e2e-s4 `messagesWriteback` | parts 级手术是近似：V1 工具 output 不能回写 V2 tool-result；provider reasoning/cache part 无 V1 形状 |
| `experimental.session.compacting` | ⚠️ 有降级 | `ctx.session.hook("compaction")`；e2e-s2b1 `degraded[]` 记录原因 | 压缩事件没有 prompt-replacement 字段，V1 的 prompt 覆盖被丢弃 |
| `experimental.compaction.autocontinue` | ⚠️ 有降级 | 同上槽位；e2e-s2b1 两条 degraded 记录 | 事件缺 provider/message/overflow 字段（用占位符）；V2 压缩无 autocontinue 开关，只在压缩时刻运行一次 |
| `command.execute.before` | 🚫 不支持 | `CommandDomain` 只有 `list/reload/transform`，无 `hook()`；e2e-s2b1 `commandBeforeDegraded=true` | 命令执行前无法拦截（安全提示类逻辑失效，仅剩日志） |
| `config` | 🚫 不支持 | V2 无全局 config hook，改为按域投影（§6）；e2e-s3b | 无法整体改写宿主配置；provider/model/formatter/agent 四域直接不支持 |
| `tool`（整表注册） | ⛔ 有意不桥接 | `hooks.ts` 顶部说明：整表注册会静默覆盖 S1a 的桥接工具；e2e-s2b1 `toolCountUnchangedByBridge`、`hooksToolCount=13` 仅作对照 | 无（工具走 `./tools`，不是 hook） |

子 hook 启用面：默认禁用 2 个（`compaction-todo-preserver`、`todo-continuation-enforcer`），S4 释放 4 个（`claude-code-hooks`、`compaction-context-injector`、`preemptive-compaction`、`session-notification`）。证据：e2e-s4 `disabledHooks`（`[omo-v2] hooks disabled: compaction-todo-preserver,todo-continuation-enforcer`）+ `packages/omo-opencode/src/opencode-v2/hooks/disabled-hooks.ts`。覆盖方式：`OMO_V2_DISABLED_HOOKS` 追加、`-<name>` 反向开启、`*` 全关。

## 5. agent 物化

| 能力 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| 10 个内置 agent 物化为 markdown（`sisyphus`、`hephaestus`、`oracle`、`librarian`、`explore`、`multimodal-looker`、`metis`、`momus`、`atlas`、`sisyphus-junior`） | ✅ | e2e-s3a `allTenDiscovered=true`、`modesCorrect=true`（3 个 `primary` + 7 个 `subagent`） | V2 的 `agent.transform` 没有 `add()`，所以只能落文件；模型相关 prompt 尾段不写进文件，标记为运行期补 |
| 发现位置与优先级 | ✅ | e2e-s3a `discoveredWithoutReload=true`、`defaultScope=global`、project 覆盖 global | 需要可写 `~/.config/opencode/agent`；不可写时回落 project scope 并告警 |
| 幂等与禁用删除 | ✅ | e2e-s3a `secondSetupSkippedAll`、`disabledFileRemoved`、`disabledAgentNotDiscovered` | 只删带 `# omo-v2-agent:` 标记的托管文件，用户手写同名文件永不删 |
| frontmatter 支持面 | ✅ | e2e-s3a `frontmatterEvidence`；`packages/omo-opencode/src/opencode-v2/agents/agent-markdown.ts` | `model` 只在解析到模型时写；0 model 环境整段省略 |
| frontmatter 不支持面 | 🚫 不支持 | 同上（`onUnsupported` 上报） | `prompt`（正文即 prompt）、`reasoning`（V1 别名）、嵌套 `permission{bash:{"git *":"deny"}}`、模型耦合键在 0 model 环境被丢弃 |

支持的键（实测）：`description`、`mode`、`model`、`variant`、`temperature`/`top_p`/`maxTokens`、`reasoningEffort`/`textVerbosity`（→ `request.body`）、`permission{工具: allow|deny|ask}`、`tools{工具: bool}`（→ `permission[]`）、`hidden`、`color`。权限改名：`write|edit|apply_patch → edit`、`bash → shell`、`task → subagent`（e2e-s3b `renames=["bash->shell","task->subagent"]`）。

## 6. 配置域

| 域 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| MCP（context7 / grep_app / lsp / websearch） | ✅ | e2e-s3b `mcp.listed == expected`（4 个）、`mcpNoDuplicates` | `lsp` 在 V1 侧判定不可用时不会投影；投影期间 `ctx.mcp.list()` 为空属正常 |
| Command（6 个内置模板命令） | ✅ | e2e-s3b `command.added` = `goal`/`refactor`/`ulw-execute`/`stop-continuation`/`remove-ai-slops`/`hyperplan`；`commandsNotDuplicated` | V2 只有 `command.add{name,description,execute}`，命令体靠 `session.prompt` 渲染，不支持 V1 的全部字段 |
| Skill（随包 skills） | ✅ | e2e-s3b `skill.count=20`（18 随包 + 2 宿主内建）、`skillPathsAreRealFiles` | 3 个模板型 skill（playwright / security-review / security-research）无 `SKILL.md` 被跳过 |
| tools / permission → agent frontmatter | ✅ | e2e-s3b `frontmatterGrepDeny`、`apiShellDeny`、`apiSubagentDeny`、`overlayLogged` | 只能表达"每工具一个效果"，嵌套规则无法表达 |
| 投影幂等（replay-safe） | ✅ | e2e-s3b phaseB `added` 全为空（第二次 setup 0 写入） | 需要 `ctx.storage` 保存 payload hash；无 storage 时退化为"先 `get()` 再写" |
| provider | 🚫 不支持 | e2e-s3b `unsupported` 含 `provider`；日志 `[omo-v2] config domain unsupported: provider` | 自定义 provider 注入不可用（需用户写在 `opencode.json`） |
| model | 🚫 不支持 | 同上（`model`） | 模型别名/覆盖不可用；只能用宿主 config |
| formatter | 🚫 不支持 | 同上（`formatter`） | 格式化器配置不生效 |
| agent（宿主 agent 合并/修改既有 agent） | 🚫 不支持 | 同上（`agent`）；新增走 markdown（§5） | 无法修改宿主编译内置 agent，只能新建同名文件覆盖 |

## 7. client shim

V1 引擎通过 `PluginInput.client`（1.x SDK）调宿主；V2 换成按域对象，shim 负责形状转换。
证据集中在 e2e-s4（`bridge` + selftest 33/33）与 `packages/omo-opencode/src/opencode-v2/adapter/client-shim.ts`。

| 方法 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| `session.messages` | ✅（语义重建） | e2e-s4 `noSessionMessagesDegradation=true`、`selftest_messagesNonEmpty`、`selftest_partsLegal` | 由 `session.context()` 的扁平消息重建成 `{info, parts}`；parts 级改写是近似，工具 output 不能回写 |
| `session.todo` | ⚠️ 有降级 | e2e-s4 `selftest_todoRoundTrip`、`todoStoreLogged`；`adapter/todo-store.ts` | 宿主无 todo 生产者，todo 存在插件侧 `ctx.storage`，真实会话里通常为空 |
| `session.status` | ✅ | e2e-s4 `selftest_statusBusyAndIdle`（`active()` + `list()` + 事件注册表） | `active()` 不可用的宿主上只有注册表 + `list()`（有 mapped 日志） |
| `session.summarize` | ✅ | e2e-s4；`client-shim.ts` `compact()` 映射 + `providerState`/`native` 兼容 | 失败时返回错误信封（不返回假摘要） |
| `config.get` | ✅ | e2e-s4 `configSourceLogged`、`selftest_configNotEmpty`（含 model/provider/agent） | 只含宿主真实读取的键（`$schema`/`agent`/`model`/`plugins`/`provider`）+ 域投影 |
| `app.skills` | ⚠️ 有降级 | `client-shim.ts` `degraded("app.skills", ...)` | `skill.list()` 失败时返回空列表，V1 回落自己的 skill 来源 |
| `tui.showToast` | ⚠️ 有降级 | `degraded("tui.showToast", ...)`（serve 无 toast 面） | 只写日志；TUI 侧由插件自己的 toast 转达 |
| `experimental.session.list` | ⚠️ 有降级 | `degraded("experimental.session.list", "location scoped")` | 只看得到本 location 的会话 |
| 其余未映射方法 | 🚫 不支持 | `[omo-v2] client shim missing <method>` + 抛错（Proxy） | 调用即失败，不静默返回假数据 |

## 8. TUI

V1 TUI 与 V2 TUI 共用同一套视图模型（`computeView`/`derive*`/`buildViewNodes`）与 BTW 控制器，只换宿主 API。
证据：e2e-tui 10 条断言全 PASS（`tui-entry-loaded`、`sidebar-slot-claimed`、`sidebar-slot-rendered`、`btw-controls`、`startup-toast-drawn`、`sidebar-visible`、`cleanup-ran`、`no-module-rejection`、`no-sidebar-failure`、`no-btw-failure`）+ `tui-v2.test.ts` / `tui-btw-v2.test.ts`。

| 能力 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| `./tui` 导出被宿主 setup | ✅ | e2e-tui `stage=setup plugin=oh-my-openagent:tui` | 无 `@opentui/solid` 时不声明 slot（日志 `tui degraded`），不崩 |
| 侧栏 slot（`sidebar.content`） | ✅ | e2e-tui `sidebar-slot-claimed`/`rendered`、屏幕文本含 `Models` | 一次声明 + Solid signal 重绘，替代 V1 的 `requestRender()` |
| keymap 层（`ctrl+/` 打开 BTW、`0x1f` 别名） | ✅ | `tui-btw-v2.test.ts`（`bind="ctrl+/"`、stdin `0x1f`）；e2e-tui `btw-controls` | 用 `keymap.layer` 取代 `keymap.registerLayer`；命令/别名与 V1 一致 |
| BTW 新建流程 | ⚠️ 有降级 | `tui-btw-v2.test.ts` `starts a new side conversation from a dialog prompt`；`tui-btw.ts` `syntheticPromptRef` | V2 无插件可见 composer，改为 `dialog.prompt` 取问题、`client.session.prompt` 提交 |
| 侧会话标签位置 | ⚠️ 有降级 | `tui-btw.ts`（`append: "prompt.footer.status"`） | V1 的 `session_prompt_right` 不存在，标签挪进 composer footer |
| `esc esc` 返回父会话 | ⚠️ 有降级 | `tui-btw.ts` `isDialogOpen: () => false`、`clearPending: () => undefined` | 对话框打开时手势看不到（宿主无 "dialog open" 查询），pending 序列缓冲也无 V2 对应 |
| `ctrl+c` 删除侧会话 | ⛔ 未绑定 | 仅出现在标签文案 `... · ctrl+c delete`，keymap 无对应命令 | 文案承诺的快捷键不存在 |
| 启动提示（toast） | ✅ | e2e-tui `startup-toast-drawn`（屏幕文本 `OpenCode 2 support is active`） | 15s 后自动消失；文案指向本矩阵 |

## 9. 存储策略

原则：**跨进程读者保留 fs，宿主生命周期内的状态用 `ctx.storage`**（决策见 `.slim/deepwork/opencode-v2-port.md` 架构裁决）。

| 项 | 状态 | 证据 | 已知降级 |
| --- | --- | --- | --- |
| 既有 `~/.omo` / XDG 文件存储 | ✅ 保留 | 62 处写点未改；`session_read`/CLI/tmux/TUI 仍直接读这些文件 | 仍是多写者模型，无宿主级事务 |
| todo 分区存储 | ✅ | `adapter/todo-store.ts`（`ctx.storage.get/set`，前缀分区）；e2e-s4 `todoStoreLogged` | 宿主无生产者时内容为空；`ctx.storage` 不可用则退化内存（重启即丢） |
| agent markdown 写入标记/hash | ✅ | `agents.ts`（hash 短路，二次 setup `written:[] skipped:[10]`）；e2e-s3a | 用户手改文件不会触发重写（hash 只看自己写的版本） |
| 配置域投影 hash / 快照 | ✅ | `config-domains/shared.ts`（payload hash + snapshot）；e2e-s3b phaseB 0 写入 | 每个宿主进程一份快照，跨进程不去重（靠 `get()` 兜底） |
| `ctx.storage` 缺失 | ⚠️ 有降级 | `todo-store.ts`：`ctx.storage is unavailable: todos live in process memory` | todo 与 domain hash 只在内存，重启丢失 |

---

## 已知差异与用户可感知损失

1. **BTW 新建流程改为 dialog**：V1 在新侧会话的 composer 里预填问题再提交；V2 没有插件可见 composer，改成 `dialog.prompt` 取问题 + `client.session.prompt` 直接提交。交互少一步"可编辑的草稿"。
2. **侧会话标签位置变化**：从 composer 右侧（V1 `session_prompt_right`）挪到 composer footer（`prompt.footer.status`）。
3. **`esc esc` 判定失效**：对话框打开时宿主不暴露"是否开着 dialog"，插件只能假设为否；同时 V1 的 pending 序列缓冲无 V2 对应。因此"双击 Esc 返回父会话"在对话框场景下可能不触发。
4. **`ctrl+c` 未绑定**：标签文案里写了 `ctrl+c delete`，但 keymap 没有对应命令，按下去不会删除侧会话。
5. **todo 在真实宿主无生产者**：OpenCode 2.1.4 的宿主工具集里没有 `todowrite`/`todo`，插件侧的 todo store 只有在插件自己写入（如 `task_create`）时才有内容；`session.todo` 在普通会话里为空，依赖 todo 的展示/续跑会退化。
6. **provider / model 域不投影**：自定义 provider、模型别名与覆盖在 V2 上不生效，只能写进 `opencode.json`。`formatter`、宿主 agent 合并同样不支持（均有 `[omo-v2] config domain unsupported:` 日志）。
7. **C 组自建 manager 与 V1 runtime manager 相互独立**：C 组工具在 V2 里用 `createGroupCToolDeps` 自己造 background / tmux / team 三套 manager，不复用 V1 `runtime` 装配里的那一套。后果：经 C 组工具启动的后台任务**不进入** hook 侧（`event` 泵、`session-notification`、记账）的视野，反向也一样。由于 `task` 默认关闭，用户实际会碰到的组合主要是 `call_omo_agent` 的 `run_in_background` 后台任务——结果只能用 `background_output` 读，拿不到 hook 侧通知。
8. **`task` 默认不注册**：宿主已用 `subagent` 承担委派，默认不并列第二个 spawner（`bridge.taskPolicy.policy="skip"`）。`OMO_V2_TASK_TOOL=override` 显式开启后改为覆盖 `subagent`（§3.4）。不开时的能力差：没有 OMO 的 category / 技能注入与 `run_in_background` 语义。
9. **tmux 布局与可视化只验到拒绝路径**：本环境无 tmux（`tool requires tmux team {"tmuxAvailable":false}`）。team 的**状态与任务**走 team-core 文件照常工作（`team_task_*`/`team_status`/`team_list` 已闭环），但 `team_create` 在 `tmux_visualization=true` 时只能返回明确错误串，pane 布局、成员可视化、monitor 的真实拉起都没有本机证据。
10. **monitor 需 `monitor.enabled`**：关闭时 `monitor_start` fail-closed（`[ERROR] monitor_start denied: monitor feature disabled`），其余三个 monitor 工具仍应答空结果——有意的"明确不可用"，不是静默成功。
11. **`command.execute.before` 不可拦截**：V2 `CommandDomain` 没有 hook，命令执行前的安全检查/改写失效。
12. **压缩提示词覆盖丢失**：`experimental.session.compacting` 只能触发，不能替换 V2 的压缩 prompt。
13. **`tui.showToast` 落日志**：serve 端没有 toast 面，服务端想弹的提示只进日志。

## 如何验证

所有命令走 Docker（宿主只跑 `docker`/`git`/`curl`），并发访问 docker 时用 `flock /data/tmp/v2-docker.lock -c "..."` 串行化。

```bash
# 0) 一次性：镜像 + 依赖（node_modules 落命名卷，不写宿主仓库）
scripts/v2/docker.sh build
scripts/v2/docker.sh install

# 1) 类型 / 单元 / 静态门禁
scripts/v2/docker.sh typecheck
scripts/v2/docker.sh test packages/omo-opencode
scripts/v2/docker.sh run bun run lint:ratchet

# 2) 产物
scripts/v2/docker.sh build-index          # 只写 .slim/v2-bundle/index.js（自包含，目录插件 e2e 用）+ dist/tui.js
scripts/v2/docker.sh build-plugin         # 根 bun run build（含 lsp 子构建、schema）；发布态 dist/index.js 保留 --external zod

# 3) 加载 / 各能力 e2e（每个阶段一条命令，全部落 .slim/v2-evidence/）
scripts/v2/docker.sh e2e-load             # 插件 active + 启动提示进日志
scripts/v2/docker.sh e2e-s0               # setup 次数 / 工具 schema / agent 发现 / Bun 运行时
scripts/v2/docker.sh e2e-s1a              # A 组 7 工具进入 ctx.tool.list()，grep/glob 覆盖内置
scripts/v2/docker.sh e2e-s1b              # B 组 10 工具 + 覆盖内置 skill
scripts/v2/docker.sh e2e-s1c              # C 组 20 工具：注册/门禁/team task 闭环 + S1c 自测 93 checks
scripts/v2/docker.sh e2e-s2a              # V1 运行时装配（hooks=13/tools=13/managers=6/agents=11）
scripts/v2/docker.sh e2e-s2b1             # 机械 hook 桥接 + 事件泵 + 工具归属
scripts/v2/docker.sh e2e-s4               # client shim 语义 + 5 个语义 hook 写回
scripts/v2/docker.sh e2e-s3a              # 10 agent 物化（global 默认、modes、幂等、禁用）
scripts/v2/docker.sh e2e-s3b              # MCP/command/skill 投影 + unsupported 域日志
scripts/v2/docker.sh e2e-tui              # 伪终端启动真实 TUI：slot、BTW、启动提示、cleanup
scripts/v2/docker.sh e2e-v1               # V1 回归：1.x 加载本包，无任何 V2 提示/探针
scripts/v2/docker.sh e2e-pack             # 发布产物：npm pack → 隔离 HOME 安装 → active / tool.list ≥ 50 / TUI 侧栏

# 4) 任意单测
scripts/v2/docker.sh test packages/omo-opencode/src/opencode-v2
```

本轮（S1c）实际执行并通过的组合：`test packages/omo-opencode` → `build-index` → `e2e-load` → `e2e-s1c`（`93 checks, 0 failure(s)`，`missingC=[]`，`built=20/skipped=[]`）。
上一轮（P4）的组合：`typecheck` → `test packages/omo-opencode` → `run bun run lint:ratchet` → `build-index` → `e2e-load` → `e2e-tui` → `e2e-v1`。

e2e 证据统一落在 `.slim/v2-evidence/`（`*.json` 为断言结果，`*.plugin.log` 为插件日志，`*.screen.log` 为 TUI 终端文本）；汇报时贴文件名而不是整段日志。
