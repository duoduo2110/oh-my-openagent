[English](README.md) | [简体中文](README.zh-cn.md)

# oh-my-openagent

一个 [OpenCode](https://opencode.ai/docs) 插件：多模型编排、后台 agent、LSP 与 AST 工具，以及一套技能库。

- **OpenCode 1.x**：完整支持。
- **OpenCode 2**：正在移植。插件可以加载，但 agent、工具与 hook 在 V2 上暂不生效。

## 安装

```bash
bunx oh-my-opencode install
```

安装器会把插件写入 `~/.config/opencode/opencode.json`，生成用于模型分配的 `~/.omo/omo.jsonc`，链接 TUI 插件，并安装插件自带的 `ast-grep`。非交互安装需要显式传入 `--claude`、`--gemini`、`--copilot`：

```bash
bunx oh-my-opencode install --no-tui --claude=max20 --openai=yes --gemini=yes --copilot=no
```

然后在项目里运行 `opencode`，先让它做一件小事。

## 检查安装

```bash
bunx oh-my-opencode doctor
```

`doctor` 会报告 OpenCode 版本、插件与 TUI 条目、各 agent 的模型解析结果、内置工具与遥测状态。`--status` 输出紧凑面板，`--json` 输出机器可读结果。

## 插件提供什么

- **Agents**：Sisyphus 等角色，包含编排者与专职的评审、调研、实现 agent。
- **后台任务**：在会话继续时并行执行的工作。
- **工具**：LSP 跳转与诊断、AST-grep 搜索与改写、hashline 编辑、注释检查。
- **技能与命令**：`ulw` / `ultrawork` 的规划与执行循环、评审流程、项目级覆盖。
- **配置**：`~/.omo/omo.jsonc`，按 agent 指定模型、分类与功能开关。Schema：[`assets/omo.schema.json`](assets/omo.schema.json)。

## 文档

- [安装](docs/guide/installation.md)
- [CLI 参考](docs/reference/cli.md)
- [配置](docs/reference/omo-json.md)
- [编排](docs/guide/orchestration.md)
- [遥测与隐私](docs/legal/privacy-policy.md)

## 开发

所有构建与测试都在 Docker 里运行，宿主机不安装依赖：

```bash
scripts/v2/docker.sh install
scripts/v2/docker.sh typecheck
scripts/v2/docker.sh build-plugin
scripts/v2/docker.sh e2e-load
```

## 许可证

[SUL-1.0](LICENSE.md)
