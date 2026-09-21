# DeepSeek Harness（dsh）配置与观测核查

核查：2026-09-21。官方项目为 `deepseek-ai/deepseek-harness`，MIT；固定源码提交 `ddefc45fbc7f8e46dd73185e68295696d1297887`（2026-09-17），其中 `@deepseek-ai/dsh` 为 `0.1.6-alpha.2`。没有把 GitHub latest-release 的 404 当作没有版本；版本取自 [apps/cli/package.json](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/apps/cli/package.json)。本节研究阶段未运行 agent、安装插件或修改用户配置；后续实现与隔离宿主联调见 [验证记录](../../verification.md)。

## 配置事实

- 默认 home 为 `~/.dsh`，可由 `DSH_HOME` 指定；profile 位于 `$DSH_HOME/profiles/<name>`，组合 bundle 与 `cordis.patch.yml`。包含 web、headless、acp、sdk、sdk-minimal 等不同组成，不能假设每种 profile 拥有相同能力。
- 组合顺序是 bundle 层、profile patch、home patch；后者覆盖前者。按 id 修改插件的 `config` 是整体替换，不是深层合并。
- profile 的插件组成决定 HMR；web 模板启用不意味着其他 profile 也热更新。`.env` 不是插件事件配置，启动变量也不能随意从项目 `.env` 改写。
- `cordis.yml` 中插件条目是 `name` 加 `config`。以下是官方插件条目的形状示例，不是给现有 profile 自动安装的脚本：

```yaml
- name: '@deepseek-ai/dsh-hooks-codex'
  config:
    configPath: ./.codex/hooks.json
    model: deepseek-v4
```

来源：[profile 与层叠规则](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/boot/app-boot/README.md#profiles)、[原生配置说明](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/docs/user/develop/basic/config.md)、[Codex bridge](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/hooks/hooks-codex/README.md)。

## MCP 配置

每个 server 配一条 `@deepseek-ai/dsh-mcp-client` 插件，使用 `serverName`、`transport`（`stdio` 或 `streamable-http`），以及对应的 command / args 或 url。默认不启用 server；已发行 profile 挂载共享的 `mcp-resources`。工具名形如 `mcp__<serverName>__<tool>`，命名空间来自本地配置，不直接取远端 serverInfo.name。

本版支持工具、按需读取资源与 server instructions；不支持 MCP prompt templates 或 resource subscriptions。因此“支持 MCP”也不能当作所有 MCP 能力都有对应事件。来源：[固定版本 MCP client 配置与边界](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/mcp/mcp-client/README.md)。本次只读取公开结构，没有启动 server 或读取凭据。

## 三种不同的事件层

1. **Cordis 扩展点**：例如 `agent/pre-step`、`tools/pre-execute`、`tools/post-execute`，包含可以否决或改写结果的 waterfall。它们不是天然的旁观接口。
2. **Session 持久事件**：`session/event` 是 append 提交后的 feed，传入 session 和事件。源码明确对同步异常与 Promise rejection 做隔离；不等待返回值，不通过它改写 agent 决策。订阅回调仍应只做有界、短时工作，不能承诺 CPU／I/O 零开销。`session/created` 的同步异常却可以否决 session 发布，不能把相邻生命周期接口一概当只读。
3. **兼容 hook bridge**：把部分 Codex／Claude Code command hooks 翻译到 dsh 扩展点；既不是全量兼容，也不等同原宿主执行。

来源：[session feed 与错误隔离](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/session/src/index.ts#L37)、[tools 扩展点](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/tools/src/index.ts#L130)。

SessionEvent 提供 `type`、session 内递增的 `seq`、Unix 毫秒 `time`、`data`，以及按类型存在的 surface／source 关系。Header 有 id、createdAt、cwd、parentSession、isSeeded、origin、delegationDepth 等。仓库当前已知持久事件全集见 [dsh.json](../catalogs/dsh.json)，来自 [生成的 known-event-types.ts](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/session/src/known-event-types.ts)。它包含模型尝试、重试、审批、压缩、计划、产物、团队消息、workflow 等，不能缩成五个工具事件；外部插件仍可增加事件。未知的 required 持久事件不能静默丢弃后声称完整重建。

来源：[event envelope](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/core/session/src/types.ts#L470)。

## Hook 支持与执行审计

| Bridge | 当前接受的完整 hook 名单 |
| --- | --- |
| Codex | SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop |
| Claude Code | SessionStart、UserPromptSubmit、PreToolUse、PostToolUse、Stop、SubagentStart、SubagentStop |

这是 bridge 自己的全集，不是原宿主的全集。来源：[Codex parser](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/hooks/hooks-codex/src/config.ts#L11)、[Claude parser](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/hooks/hooks-claude-code/src/config.ts#L11)。

- command handlers 顺序执行；配置文件在启动时读一次。Codex bridge 跳过非 command 与 `async:true`；Claude bridge 不支持原宿主完整的 handler 类型、async、once 等语义。
- 工具匹配看真实 tool name；SessionStart 匹配 source。Claude subagent matcher 用固定 `general-purpose`。因此同一份 matcher 放进 bridge，不能保证和原宿主选择相同对象。
- 有 open turn 时，每个实际执行的 bridge handler 会记录 `hook/invoked` 和 `hook/result`，含 point、handlerId、turn，前者有 dialect/matcher，后者有 decision、exitCode、durationMs 和截短 stderr。handlerId 是运行时配对依据，不可假定是配置中长期稳定的用户 hook id。
- **SessionStart 和 detached 子 agent 生命周期省略这对审计事件。** 原事件有声音配置，不代表可以从持久日志证明每个 handler 确实执行过。
- payload 虽仿照原宿主，`transcript_path` 在 Codex bridge 恒为 null、Claude bridge 恒为空字符串；Codex 的 tool_input 主要映射 command，Claude tool_response 可能压成文本。这些不是原宿主的原样数据。

来源：[bridge 执行条件](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/hooks/hooks-claude-code/src/index.ts#L128)、[hook audit payload](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/hooks/hook-protocol/src/events.ts)、[兼容限制](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/hooks/hooks-claude-code/README.md#known-limitations-and-deferred-work)。

## Session 的被动读取

`ctx.sessionQuery` 提供 listSessions、readSession、readEvent、traceSession、traceEvent 等；readSession 可以读取完整校验过的记录而不把 session 变成 live。冷读可能在内存中添加中断收束的派生记录，不能把它当作历史上真实发生的新动作。Client 的 retain 也明确只维持本地数据、上下文和历史流，不保活 Host Agent。

持久化后端 root 必填，默认压缩为 zstd，当前格式为 v3。示例插件配置：

```yaml
- name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: /absolute/path/to/session-logs
    compression: zstd
```

物理路径形如 `<root>/--<normalized-cwd>--/<encoded-id>/session.v3.jsonl.zstd`。不能把它当普通 JSONL tail。`compression: none` 支持裸 JSONL，但同一 root 不支持混合编码，不能为了采集声音直接改用户现有 root。读取应走现有 backend/query 合约；历史代际读取和迁移也要保留来源版本。

来源：[Session query](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session-query/session-query/README.md)、[持久化格式](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-persistence-jsonl/README.md)、[Client retain](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/api/session-controller/README.md#client-session-lifetime)。

## Skills

默认文件发现优先级：项目 `.dsh/skills` → 项目 `.agents/skills` → customSkillDirs → 用户 dsh skills → 用户 agents skills。可关闭默认 roots。注册表还允许远端／插件 provider，不能只搜硬盘。

工具路径是明确的 `skill` 工具与 `{name}` 参数；显式用户 `/name` 则形成带 `source.kind: skill-invocation`、name、form 的注入。它们都比字符串提及强，但仍不构成所有后续调用的完整 skill span。`skills/change` 是目录变化，不是 skill 执行开始；已有 body 不带稳定版本，需保留当时证据。

来源：[filesystem roots](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/skill/skill-filesystem/README.md#roots-and-priority)、[skill tool 与显式调用源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/skill/tool-skill/src/index.ts#L129)。

## 对设计的结论（推导）

- 优先评估 session query＋post-commit session/event 的读取组合，不把控制型 waterfall 当统一录音接口。
- Sound matcher 必须保留 `host=dsh` 与 bridge dialect；`dsh` 中的 Codex-shaped `PreToolUse` 不能归到原生 Codex session。
- `hook/invoked/result` 支持一部分 handler 粒度声音，但生命周期缺口需明确显示。
- OTel 不能直接替代实时采集：本版 `session-telemetry-otel` 只接受 FEEDBACK_ONLY／DISABLED，FULL 被拒绝；它按反馈释放日志前缀。来源：[OTel modes](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/session/session-telemetry-otel/README.md#modes)。
- 公共源码证明接口和语义，不证明用户实际 profile 已挂载相关组件；首次接入必须报告现有能力与缺失项。
