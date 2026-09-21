# Codex CLI：配置与可观察执行证据

采集日期：2026-09-21。只读研究公共源码与官方文档；没有读取用户私有配置、运行 agent、安装 hook 或改变宿主。

## 版本与证据边界

- 官方仓库：[openai/codex](https://github.com/openai/codex)。最新稳定发布为 [rust-v0.155.1](https://github.com/openai/codex/releases/tag/rust-v0.155.1)，发布时间 2026-09-18 20:03:04 UTC，标签提交 `be2951ea34f0d295ed0becf97079f92fa5f6950e`。
- 本次逐文件阅读的 main 快照为 [`d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818`](https://github.com/openai/codex/commit/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818)，提交日期 2026-09-21 02:02:41 UTC。下面源码链接均固定到它，不把未来 main 当固定协议。
- 对照稳定标签：`hooks/`、`core/src/skills.rs`、`rollout/src/policy.rs` 和 app-server 的 `v2/hook.rs` 在两者间无差异。exec 事件枚举名称无变化；main 给 WebSearch 增加了可选 `results`，这里不将其当稳定版保证。
- 文档存在滞后实例：官方 Hooks 页面只列四种 SessionStart source，但稳定标签与当前源码均已有 `fork`。这是已核实的差异，不能直接照抄文档列表。[源码枚举](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/events/session_start.rs#L23-L42)

## 1. 配置在哪里，怎样生效

普通配置优先级由高到低：CLI flags / `--config` → 已信任项目从仓库根至 cwd 的 `.codex/config.toml`（近者优先）→ `--profile name` 选中的 `~/.codex/name.config.toml` → 用户 `~/.codex/config.toml` → cloud-managed defaults → Unix `/etc/codex/config.toml` → 内置默认。企业 `requirements.toml` 另行施加约束。[官方 Config basics](https://developers.openai.com/codex/config-basic)

生命周期 hook 可写在每个活动配置层旁的 `hooks.json`，或该层 `config.toml` 的 `[hooks]` 表。常用四处为用户级两个文件和 `<repo>/.codex/` 下两个文件；插件可提供 `hooks/hooks.json` 或 manifest 指向的文件。**Hook 跨层相加，不服从普通标量配置的覆盖规则**；同一层两种表示也都会加载，并警告。未信任项目层被跳过。非托管 hook 按当前定义的 hash 审核信任，新增或变化后在审核前跳过；CLI `/hooks` 可查看来源及状态。`[features] hooks = false` 可关闭，旧 `codex_hooks` 是兼容别名。[官方 Hooks](https://developers.openai.com/codex/hooks)

app-server 的 `hooks/list` 提供按 cwd 的实际目录：每项含 `key`、`eventName`、handler、matcher、timeout、sourcePath/source、pluginId、displayOrder、enabled、isManaged、currentHash、trustStatus。它适合显示“这一宿主实际发现了哪些 hook”，比仅扫描一个文件可靠。[目录类型](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/app-server-protocol/src/protocol/v2/plugin.rs#L558-L604)

最小被动采集配置形状如下。`/absolute/path/symphony-collect` 是未来待实现的采集器占位符，**没有创建、安装或运行**：

```json
{
  "hooks": {
    "PostToolUse": [{
      "hooks": [{
        "type": "command",
        "command": "/absolute/path/symphony-collect --host codex",
        "async": true,
        "timeout": 1
      }]
    }]
  }
}
```

这是 `~/.codex/hooks.json` 的合法形状；省略 matcher 表示该事件的全部匹配。其他事件需要各自增加同形条目，并非用一个 `*` 事件名注册所有事件。采集器应读取 stdin JSON、短时投递后退出 0、stdout/stderr 留空，不返回决策或上下文。它监听的是 PostToolUse 生命周期，**不会因此观察到其他 PostToolUse handler 的运行结果**。

## 2. 原生 hook 全目录（12 个，按本次版本核实）

下表的通用输入为 `session_id`、`transcript_path`、`cwd`、`hook_event_name`；多数还含 `model`，但 `SessionEnd` 的实际 schema 没有 model。转次相关事件有 `turn_id`。子 agent 普通事件可含 `agent_id/agent_type`。没有统一的事件 UUID 或发生时间戳。[输入 schema](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/schema.rs#L265-L382)、[其余输入](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/schema.rs#L496-L638)、[完整事件枚举](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/app-server-protocol/src/protocol/v2/hook.rs#L18-L22)

| 原生名称 | matcher 对象 | 主要额外输入 / 语义 |
| --- | --- | --- |
| `SessionStart` | source | `startup/resume/clear/compact/fork`；不是每次 UI 焦点切换 |
| `SessionEnd` | reason | 当前 reason=`other`；主线程结束，非子 agent；强制同步 |
| `UserPromptSubmit` | 忽略 matcher | `turn_id/prompt` |
| `PreToolUse` | tool 名及别名 | `tool_use_id/tool_name/tool_input` |
| `PermissionRequest` | tool 名及别名 | `tool_name/tool_input`，**schema 没有 tool_use_id**；只在需要审批时出现 |
| `PostToolUse` | tool 名及别名 | `tool_use_id/tool_name/tool_input/tool_response`；Bash 非零退出也进入这里 |
| `PreCompact` | trigger | `manual/auto`，压缩前 |
| `PostCompact` | trigger | `manual/auto`，压缩后 |
| `SubagentStart` | agent_type | `turn_id/agent_id/agent_type` |
| `SubagentStop` | agent_type | 同上，加 `agent_transcript_path/stop_hook_active/last_assistant_message` |
| `Stop` | 忽略 matcher | `turn_id/stop_hook_active/last_assistant_message`；是回合停下，不等于 session 关闭 |
| `Interrupt` | 忽略 matcher | `turn_id/permission_mode`；只对主线程的活动 turn，中断空闲或子线程不发此事件 |

工具名存在适配：shell/unified `exec_command` 匹配 `Bash`；`apply_patch` 还匹配 `Edit/Write`，但 payload 保持 `apply_patch`；MCP 为 `mcp__<server>__<tool>`；其他本地 function tools 通常走相同路径，`spawn_agent` 还匹配 `Agent`。`write_stdin` 不重新触发 PreToolUse，原命令结束时其 poll 可以触发原调用的 PostToolUse。hosted `WebSearch` 不走本地工具 hook，一些特殊路径也可退出通用路径。因此“注册全部 hook”不等于“看到全部 agent 动作”。[官方工具覆盖说明](https://developers.openai.com/codex/hooks#tool-coverage)

本目录没有 `PostToolUseFailure`、`Notification`、`SkillStart`、`SkillEnd`。这些名称不能从其他宿主搬进 Codex 配置。旧 `notify` 仍只有 `agent-turn-complete`，JSON 追加在 argv 而非 stdin，不属于上面十二类事件。[legacy notify 源码](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/legacy_notify.rs#L13-L69)

## 3. “不会影响 agent”需要落实为采集契约

原生 hook 是执行扩展点，可以阻断、改写输入、批准权限、替换工具反馈、注入上下文甚至让 Stop 后继续执行，默认还同步等待。因此不能把“hook”直接视为纯通知。匹配的同步 command hooks 并发启动，但宿主等其结果；普通默认 timeout 达 600 秒。[执行器](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/engine/dispatcher.rs#L115-L187)

`async: true` 不阻断/审批/改写原操作，但仍可在安全点给模型发送 additionalContext、在 UI 发 systemMessage，因此被动采集器必须无输出。每 session 最多 8 个并发后台 hook，多余排队，完成可乱序；结束时取消未完成项。`SessionEnd` 即使写 async 也同步，默认 1 秒、上限 3 秒；Interrupt 同样短超时。**推导：需要有界本地投递、掉线直接退出、独立音频进程；不能在 hook 里等待声音播完，也不能承诺绝对零开销或零丢失。**[官方异步规则](https://developers.openai.com/codex/hooks#run-hooks-in-the-background)

handler 支持 `command` 与 `mcp_tool`；`prompt/agent` 配置会解析但跳过。MCP handler 必须使用已连上的 server，同步执行，可返回控制决策；不会再触发其他 hooks/approval，SessionEnd 不支持它。因此并不适合作为无阻塞音频出口。[官方 MCP hooks](https://developers.openai.com/codex/hooks#mcp-tool-hooks)

## 4. 三种数据出口不可混为一谈

### 4.1 新增采集 hook：能看到生命周期输入

有 session/turn/tool ID，适合关联实际工具开始与返回，也能监听所有十二种 native 事件。但无宿主精确时间戳，接收时间须明确标为 collector 时间；async 排队与乱序会影响时间精度。PermissionRequest 缺 call ID，关联若仅靠相邻事件应标为推断。

### 4.2 `codex exec --json`：简化的前台运行流

顶层类型完整列表是 `thread.started`、`turn.started`、`turn.completed`、`turn.failed`、`item.started`、`item.updated`、`item.completed`、`error`。item 类型完整列表是 `agent_message`、`reasoning`、`command_execution`、`file_change`、`mcp_tool_call`、`collab_tool_call`、`web_search`、`todo_list`、`error`。thread ID 从首个事件取得，item 有 id/status，但 turn.started 本身为空，且没有通用时间戳。[exec schema](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/exec/src/exec_events.rs#L8-L133)

关键限制：转换器**明确丢弃** `HookStarted/HookCompleted`。这条流不能用于声称“每一个已配置 hook 的脚本执行都看见了”。它是被启动的非交互任务输出，不是对任意已有 TUI 会话的监听协议。[丢弃分支](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L474-L476)

### 4.3 app-server：最丰富的公开运行协议

这是 Codex 客户端协议，JSON-RPC 2.0 风格，支持 stdio、WebSocket、Unix socket。丰富但不同于普通 CLI stdout。`thread/read` 只读已存数据且**不订阅**；`thread/start/resume/fork` 进入运行线程及订阅生命周期。不能为了“调查历史”随便 resume，更不能启动另一 server 就宣称接上原会话。连接已有共享服务的可行性与通知路由，需要接入原型实测。[官方 App Server](https://developers.openai.com/codex/app-server)

与本产品相关的公开通知（此处为相关子集，非整个账户/文件搜索/实时音视频协议总表）：

- session/thread：`thread/started`、`thread/status/changed`、`thread/archived`、`thread/deleted`、`thread/unarchived`、`thread/closed`、`thread/reverted`、`thread/name/updated`、`thread/tokenUsage/updated`、goal/settings 相关通知。
- turn/item：`turn/started`、`turn/completed`、`turn/diff/updated`、`turn/plan/updated`、`item/started`、`item/completed`、`item/agentMessage/delta`。
- handler 执行：`hook/started`、`hook/completed`。
- shell/文件：`item/commandExecution/outputDelta`、`item/commandExecution/terminalInteraction`、`item/fileChange/patchUpdated`；旧 `item/fileChange/outputDelta` 已标 deprecated。
- MCP：`item/mcpToolCall/progress`、`mcpServer/startupStatus/updated`、OAuth 完成；`mcpServer/event/stream/notification` 为实验性。
- 公开 reasoning：`item/reasoning/summaryTextDelta`、`item/reasoning/summaryPartAdded`、`item/reasoning/textDelta`；仅能展示宿主实际公开的内容，不保证私有思维链或完整内部状态。
- context/error：ContextCompaction item（旧 `thread/compacted` 已 deprecated）、`error`、`warning`、`configWarning`、model reroute 等。
- approval/输入：`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、`item/tool/requestUserInput`、`mcpServer/elicitation/request` 是**需响应的 server requests**，不是普通通知；只读观察者不得接管或自动回答。

名称均来自[通知枚举](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/app-server-protocol/src/protocol/common.rs#L1909-L1997)与[server requests](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/app-server-protocol/src/protocol/common.rs#L1752-L1791)。`rawResponseItem/completed`、`rawResponse/completed` 被源码标为 internal-only，不作为公开采集承诺。

`hook/started/completed` payload 有 `threadId/turnId?/run`；run 内有 `id/eventName/handlerType/executionMode/scope/sourcePath/source/displayOrder/status/statusMessage/startedAt/completedAt/durationMs/entries`。状态为 running/completed/failed/blocked/stopped。由此可以对同一事件下不同 handler 分别配声，并听到其失败。[hook 类型](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/app-server-protocol/src/protocol/v2/hook.rs#L71-L158)

身份与时间还有细节：run.id 基础格式是 event label + display order + source path，工具类另拼 tool_use_id；**不能把它直接当跨 turn 的每次发生唯一 ID**。startedAt/completedAt 是 Unix 秒，durationMs 是毫秒；item 生命周期的 startedAtMs/completedAtMs 则有毫秒时间戳。推导：collector 仍需 occurrence ID 和接收序号，保存原 ID 与单位。[ID 生成](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/engine/mod.rs#L158-L165)、[工具后缀](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/events/common.rs#L99-L109)、[时间生成](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/engine/dispatcher.rs#L78-L98)、[item 时间](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1329-L1339)

还有明确覆盖缺口：executor-scoped hooks 不产出 public hook summaries。所以 app-server 也不能无条件承诺“宿主内部所有 hook 全部可见”。[代码断言](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/hooks/src/engine/dispatcher.rs#L78-L81)

## 5. Session 历史与切换

默认持久化是 `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-….jsonl`，另有 `archived_sessions`，当前实现支持 `.jsonl.zst` 压缩和 history base / ordinal 组织。每行有 `timestamp`、可选 `ordinal`、具体类型 payload。SessionMeta 同时保存 root `session_id`、当前 thread `id`、`parent_thread_id`、`forked_from_id`、cwd、source、cli_version 等。不要用 cwd、标题或文件名作为唯一 session 身份。[路径](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/rollout/src/recorder.rs#L1695-L1735)、[行封套](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/history/src/lib.rs#L267-L278)、[SessionMeta](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/protocol/src/protocol.rs#L3117-L3153)

**rollout 不等于完整追踪**：持久化策略明确排除 HookStarted/HookCompleted、很多 begin/delta/审批瞬态事件。回放宿主旧历史时不能编造这些开始、耗时或 hook 音符。`history.jsonl` 更只是全局消息历史（session_id/ts/text），不能当执行日志。[持久化筛选](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/rollout/src/policy.rs#L92-L204)、[消息历史定义](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/message-history/src/lib.rs#L1-L9)

查询用 `thread/list`（有 cwd、sourceKinds、archived、search 等过滤）、`thread/read(includeTurns=true)`；当前载入的线程用 `thread/loaded/list`。CLI `resume` 是继续执行入口，不是观察入口。切换 UI 不等于 SessionEnd：关闭/归档/正常退出，或无客户端且无活动 30 分钟后才有相应结束。**推导：Symphony 的“切换查看/切换监听”应保存在自身，不能假装是宿主生命周期事件。**

## 6. Skill：目录与证据，不能推断完整因果链

官方目录：从 cwd 至 repo root 的 `.agents/skills`、用户 `~/.agents/skills`、admin `/etc/codex/skills`、系统 bundled，以及已启用插件。同名 skill 可同时出现，不能只用 name 唯一化。配置 `[[skills.config]] path=… enabled=false`，`agents/openai.yaml` 可设 `policy.allow_implicit_invocation`。显式调用由 `$` / `/skills` 选择，隐式调用依据 description，通常再读 SKILL.md。[官方 Skills](https://developers.openai.com/codex/skills)

可获得的证据等级：

1. `skills/list` 是当前目录与可用性；`skills/changed` 是目录变化，**不是 skill 开始执行**。
2. 结构化 `UserInput::Skill { name, path }` 是用户选择的确定证据；选中不证明后续每次工具由它导致。[输入结构](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/protocol/src/user_input.rs#L47-L56)
3. 原始工具参数中明确读取某个 SKILL.md、运行其 scripts 路径，能记录文档访问/脚本执行；其余相邻动作最多是候选关联。
4. core 内部确有显式/隐式 skill invocation telemetry 和 extension contributor callback；隐式识别也是解析已知文档读取与脚本执行路径，并按 turn 去重。它不是已公开的 HookEventName 或 app-server skill-invoked 通知，不宜当免修改宿主就能接到的公共接口。[内部调用](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/core/src/skills.rs#L38-L118)、[隐式识别](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/skills/src/invocation.rs#L12-L72)

因此调查某 skill 可先支持“精确身份（路径/插件来源）→ 显式选择、读取、脚本调用 → 展开上下文”，不能承诺 SkillStart/End span、内部推理归因，或自动把其后全部工具归到该 skill。

## 7. MCP 数据

原生配置 `[mcp_servers.<name>]` 与普通 config 同层；stdio 用 command/args/env，HTTP 用 url 等，支持 per-tool allow/deny、approval、timeout。插件 MCP 另有 plugin 来源。这里只研究配置结构，不读取认证值。[官方 MCP](https://developers.openai.com/codex/mcp)

工具 hook 中 MCP 名形如 `mcp__server__tool`，输入为参数，PostToolUse 输出为 MCP result。app-server `mcpToolCall` 直接拆分 `server/tool/arguments/status/result/error/durationMs`，还有可选 pluginId/appContext/readOnlyHint；更适合调查具体服务。MCP 的工具调用、server 启动、elicitation 与作为 hook handler 执行的 MCP tool，是四类不同活动，不应都压成一个“MCP”音符。[MCP item](https://github.com/openai/codex/blob/d1e3f9dfe3d5f6105b7e4c3958b9bf2ac6c32818/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L333-L352)

## 研究结论 / 待验证

已核实：Codex 已有完整的十二类 native hooks；原生事件、某个 handler 的执行、工具调用三者是不同对象；轻量 hook 入口有覆盖缺口；exec JSON 与 rollout 都不保留全部 hook 执行；公开协议支持较丰富的 session、MCP、子 agent 与 handler 证据；skill 因果链不完整。

下一阶段需要用固定版本和模拟收集器实测：共享 app-server 的只读监听/路由方案；同一 handler 重复发生及 async 乱序关联；原生 hooks 与 app-server 双通道去重；服务端断连、session 结束和异步队列丢失；shell → code-mode 嵌套工具与 hosted tools 的覆盖。以上尚未运行，不能列为已验证行为。
