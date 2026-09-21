# Claude Code：执行观测与声音配置证据

核查日期：2026-09-21。范围：公开官方文档、官方发布元数据、公开仓库；未读取用户私有配置、安装或运行 Claude、修改任何宿主设置。

**版本快照**：GitHub 最新发布为 [v2.1.278，2026-09-19](https://github.com/anthropics/claude-code/releases/tag/v2.1.278)；公开仓库 HEAD 为 [`7974a70773fa229e4cc65aa1b356cc21f5c216c4`](https://github.com/anthropics/claude-code/tree/7974a70773fa229e4cc65aa1b356cc21f5c216c4)，提交时间 2026-09-20。以下“事实”主要是该日文档契约，不代表已对本机版本做运行验证。文档会滚动更新。

**源码边界**：`anthropics/claude-code` 公开仓库提供 README、CHANGELOG、示例、插件等；本次检查的根目录没有完整 CLI 核心实现。其 [LICENSE](https://github.com/anthropics/claude-code/blob/7974a70773fa229e4cc65aa1b356cc21f5c216c4/LICENSE.md) 保留权利并指向商业条款，不能因为仓库公开就把 Claude Code 核心称为开源、或声称已源码验证事件分发。SDK 类型文档公开不等于整个 CLI 实现开源。

## 1. 配置入口与身份

**事实**：普通设置优先级为 managed → CLI `--settings` / flags → `.claude/settings.local.json` → `.claude/settings.json` → `~/.claude/settings.json`。Hooks 跨层追加合并，不能套用普通标量“高层覆盖全部”规则。`CLAUDE_CONFIG_DIR` 可移动用户目录；`~/.claude.json` 还存有身份、MCP 和项目状态，并非应整体导入 Symphony 的配置文件。插件使用 `hooks/hooks.json`，skill 和 subagent 可在 YAML frontmatter 声明 hooks。[设置与优先级](https://code.claude.com/docs/en/settings#settings-precedence)、[Hook 位置](https://code.claude.com/docs/en/hooks#hook-locations)

**事实**：个人 skill 通常位于 `~/.claude/skills/<name>/SKILL.md`，项目为 `.claude/skills/<name>/SKILL.md`；另有 managed、nested、额外目录、插件和账户同步来源。插件名有命名空间，不能只按 basename 合并。Skill 内容进入上下文后可跨轮保留；被加载、被调用、某次工具执行与它相关，是不同事实。[Skills](https://code.claude.com/docs/en/skills#where-skills-live)

**推论**：声效配置应记录宿主、事件名称、配置来源和 matcher；不要把相同脚本路径或相同 skill 名当成全局唯一身份。静态配置盘点也不能证明运行时真的加载或触发。

### MCP 配置入口：原生 `mcpServers`

**事实（同日官方文档核查）**：Claude Code 原生加载 MCP server 定义，常规 JSON 键为 `mcpServers`。它不是简单放进 `.claude/settings.json` 的普通设置项，MCP 的 local scope 也不等于 settings.local.json。[MCP 作用域](https://code.claude.com/docs/en/mcp#mcp-installation-scopes)

| 来源 / 作用域 | 实际配置入口 |
|---|---|
| Local：当前项目、当前用户 | `~/.claude.json` 的 `projects[项目绝对路径].mcpServers` |
| Project：项目共享 | 项目根 `.mcp.json` 的 `mcpServers` |
| User：该用户的全部项目 | `~/.claude.json` 顶层 `mcpServers` |
| Plugin | 插件根 `.mcp.json`，或 plugin.json 中内联定义 |
| 单次启动 / SDK | `--mcp-config` 文件或 JSON；SDK `mcpServers` 选项 |
| 组织配置 | 独立 `managed-mcp.json` 的 `mcpServers`；或 managed settings 的 `managedMcpServers` |

**事实**：普通重复 server 按 Local → Project → User → Plugin → claude.ai connectors 选整条定义，不按字段合并；前三者按名称去重，插件/connector 还按 endpoint 去重。组织的 `managedMcpServers` 定义优先级更高（相关行为自 v2.1.259）。Settings 另外控制项目 server 批准、启用和 allow/deny 策略，不能把“已配置”直接视为“已连接”。[MCP 优先级](https://code.claude.com/docs/en/mcp#scope-hierarchy-and-precedence)

**事实**：独立 managed 文件路径为 macOS `/Library/Application Support/ClaudeCode/managed-mcp.json`、Linux/WSL `/etc/claude-code/managed-mcp.json`、Windows `C:\Program Files\ClaudeCode\managed-mcp.json`。它会限制其他 server 来源；通过 managed settings 提供的 servers 与 embedding host 的 in-process servers 有专门例外，所以不能概括成单一普通优先级链。[Managed MCP](https://code.claude.com/docs/en/managed-mcp#deploy-managed-mcpjson)

本节只记录公开的配置结构，没有读取上述本机文件或调用会连接 server 的盘点命令。后续调查应优先记录有效 server 身份、来源、连接状态和工具名；`~/.claude.json` 还混有其他私密状态，不能整文件采集。

## 2. 原生 Hook 事件完整目录

截至本次核查共 **33 个原生 hook event**。以下按调查用途整理；这是事件目录，不是每个回调脚本的执行阶段。[官方完整目录与 schema](https://code.claude.com/docs/en/hooks#hook-events)

| 调查范围 | 原生事件 | matcher 的对象 |
|---|---|---|
| 会话 | `SessionStart`, `SessionEnd`, `Setup` | 分别为启动来源、结束原因、初始化 trigger |
| 输入与显示 | `UserPromptSubmit`, `UserPromptExpansion`, `MessageDisplay` | 仅 Expansion 匹配命令名 |
| 工具 | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PostToolBatch` | 前三个匹配工具名；Batch 无 matcher |
| 权限 | `PermissionRequest`, `PermissionDenied` | 工具名 |
| Agent | `SubagentStart`, `SubagentStop`, `TeammateIdle` | 前两者匹配 agent type；Idle 无 matcher |
| 任务 | `TaskCreated`, `TaskCompleted` | 无 matcher |
| 回合 | `Stop`, `StopFailure` | Failure 匹配错误类型；Stop 无 matcher |
| 上下文 | `InstructionsLoaded`, `PreCompact`, `PostCompact` | 指令加载原因、压缩 trigger |
| 模型 | `PreModelSwitch`, `PostModelSwitch` | 目标模型的规范名称 |
| 环境 | `ConfigChange`, `CwdChanged`, `DirectoryAdded`, `FileChanged` | 配置来源、无、目录添加来源、文件名 |
| 工作树 | `WorktreeCreate`, `WorktreeRemove` | 无 matcher |
| MCP 用户交互 | `Elicitation`, `ElicitationResult` | MCP server 名 |
| 通知 | `Notification` | 通知类型 |

**事实**：`"*"`、空值或省略通常表示全匹配；简单字符组成的值是精确名称或 `|` / `,` 列表；其他模式按 JavaScript 非锚定正则处理。精确匹配应理解版本差异：逗号列表自 v2.1.191，连字符作为精确字符自 v2.1.195。`FileChanged` 建立 watch list 时按字面文件名拆分，不能当通用 glob；它和 `StopFailure` 的精确字符集又更窄。无 matcher 支持的事件会忽略该字段。Handler 的可选 `if` 用权限规则语法进一步匹配工具输入。[Matcher](https://code.claude.com/docs/en/hooks#matcher-patterns)

**事实**：MCP 调用走普通 tool hooks，名称为 `mcp__<server>__<tool>`；插件服务器形成 `mcp__plugin_<plugin>_<server>__<tool>`。MCP elicitation 是另一类事件；`type: "mcp_tool"` 又是“用 MCP 工具执行 hook handler”，三者不能合成一种活动。[MCP hook 匹配](https://code.claude.com/docs/en/hooks#match-mcp-tools)

## 3. 可获得的关联证据

| 层次 | 可直接保留的字段或数据 | 不能据此声称什么 |
|---|---|---|
| Hook 公共输入 | `session_id`, `hook_event_name`, `cwd`, `transcript_path`；按事件/版本可能有 `prompt_id`, `permission_mode`, `agent_id`, `agent_type` | 没有保证每次触发都带全局 event ID、时间戳、父 span |
| 工具调用 | `tool_use_id`, `tool_name`, `tool_input`；成功/失败有对应结果或错误 | `PreToolUse` 表示将要执行，不保证最终获准或真正启动 |
| PermissionRequest | `tool_name`, `tool_input`, 可选 permission_suggestions | 该 hook **没有 tool_use_id**，不能仅凭 hook payload 强行与某个并行调用精确配对 |
| SessionStart | `source` 包括 startup/resume/clear/compact/fork | 每次 SessionStart 都是新会话 |
| 子 agent | `agent_id`, `agent_type`；Stop 有 `agent_transcript_path` | 每次 Start 都是新 agent：恢复会复用 ID |
| 指令加载 | `file_path`, `memory_type`, `load_reason`，部分带触发/父文件路径 | 这是 CLAUDE.md/rules 加载，不能替代通用 skill 调用事件 |
| MCP 用户请求 | `mcp_server_name`，请求/响应专用字段 | 每次 elicitation 都能直接得到所属 tool 的完整父链 |

来源：[公共输入](https://code.claude.com/docs/en/hooks#common-input-fields)、[SubagentStop](https://code.claude.com/docs/en/hooks#subagentstop)、[InstructionsLoaded](https://code.claude.com/docs/en/hooks#instructionsloaded)。`prompt_id` 自 v2.1.196 起可与 OTel `prompt.id` 对齐。Transcript 异步写入，hook 触发时可能还没有最新条目；Stop 的 `last_assistant_message` 更及时，但新版使用 SubagentHandback 的子 agent，其真正交付报告在该工具输入中，不能把结束前文字一律当报告。

## 4. “所有 hook 都能指定声音”的实际边界

需要分开三种对象：**事件触发**（例如 PreToolUse）、**某个配置 handler 的执行**（例如 lint.sh 开始/输出/返回）、**一组匹配 handler 的汇总**。它们有不同证据通道。

| 通道 | 能观察什么 | 限制 |
|---|---|---|
| 加一个 command hook recorder | 原生事件的 stdin payload | 观察到的是触发；不是其他 handlers 的开始/完成 |
| CLI stream-json / Agent SDK | `hook_started`, `hook_progress`, `hook_response`；带 `hook_id`, `hook_name`, `hook_event`, `session_id`, `uuid`，返回带 outcome / exit_code | 需 `--include-hook-events` 或 `includeHookEvents`；并不覆盖每类事件的完整生命周期 |
| OTel logs/events | `hook_registered`, `hook_execution_start`, `hook_execution_complete` | 执行事件聚合该 event 的多个匹配 handlers，以 num_hooks 和结果计数报告 |
| OTel detailed tracing | `claude_code.hook` span | 也是聚合；另有 beta、endpoint、交互模式组织白名单门槛 |
| debug log | 匹配与输出诊断 | 文本格式不是承诺稳定的结构化事件 API |

**事实**：CLI / SDK 的 `SessionStart`、`Setup` hook 生命周期默认输出。`Notification`、`SessionEnd`、`PreCompact`、`PostCompact` 等不产生 `hook_started`；这些事件只有长于一秒且有输出的 command hook 才产生 progress，只有后台 hook 完成才有 response。不能据 `includeHookEvents=true` 承诺“全部 handler 均有成对开始/结束”。[CLI flags](https://code.claude.com/docs/en/cli-reference)、[SDK Options](https://code.claude.com/docs/en/agent-sdk/typescript#options)、[SDK hook messages](https://code.claude.com/docs/en/agent-sdk/typescript#sdkhookstartedmessage)

**推论**：每个已知事件和每个可识别 handler 都可保留独立声音规则；但界面必须显示该规则的实际观测能力。缺少 start 时不能捏造时长，只有汇总时不能冒充某一脚本完成。`hook_id` 可用于运行配对，但公开 schema 没保证它等同某个跨 session 稳定配置 ID；配置来源绑定仍待验证。

## 5. 被动记录：配置示例与不得改变的行为

这是合法配置形态示例，**未安装**；`/absolute/path/agent-symphony-ingest` 是待实现的 recorder 路径，不能直接视为已有命令。示例只展示工具前后/失败事件，正式适配器应按版本生成更完整配置。

```json
{
  "hooks": {
    "PreToolUse": [{"hooks": [{"type": "command", "command": "/absolute/path/agent-symphony-ingest", "args": [], "async": true}]}],
    "PostToolUse": [{"hooks": [{"type": "command", "command": "/absolute/path/agent-symphony-ingest", "args": [], "async": true}]}],
    "PostToolUseFailure": [{"hooks": [{"type": "command", "command": "/absolute/path/agent-symphony-ingest", "args": [], "async": true}]}]
  }
}
```

`args: []` 有明确 schema 依据且有作用：**字段存在就选择 exec form**，直接启动 `command` 指定的可执行文件，不经过 shell；省略才用 shell form。官方也提供空数组实例，因此这里保留。该路径必须指向真正可执行文件；Windows 的 `.cmd` / `.bat` shim 不能直接套用这种形式。[Command hook fields / exec form](https://code.claude.com/docs/en/hooks#command-hook-fields)

**事实**：command、http、mcp_tool、prompt、agent 是五种 handler 类型，不是五个事件。默认同步等待；只有 command 支持 `async: true`。Async 避免等待完成，但仍能通过输出注入上下文；`asyncRewake` 还可能唤醒 Claude。退出 0 也不保证无干预：普通 stdout 在部分事件会进入模型上下文，JSON 可带控制字段。退出 2 对若干事件阻断；其他错误/超时也有逐事件例外。[Hook 输出](https://code.claude.com/docs/en/hooks#exit-code-output)、[Async hooks](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)

**实施约束（推论）**：recorder 必须静默 stdout/stderr、返回 0，不输出 permissionDecision / additionalContext / continue 等字段，不写 CLAUDE_ENV_FILE，不用 asyncRewake；只尽快把数据送本地队列，声音在独立消费者播放。进程启动仍有开销，不能承诺物理上的“零影响”。Async 完成后不受普通 timeout 控制，`-p` teardown 还会取消尚未结束的 async hook，因此完整性需要缺口标记和补采。

**决定性例外（事实）**：注册 `WorktreeCreate` 会接管默认 worktree 创建流程，而且必须返回新目录。因此纯观察工具不能通过给它追加空 recorder 来“全量订阅”。应优先消费现有 stream / telemetry 证据，没有证据就报告未覆盖。`PreModelSwitch` 的超时会阻止模型切换；也不应把其同步 recorder 默认为无害。[WorktreeCreate](https://code.claude.com/docs/en/hooks#worktreecreate)、[PreModelSwitch](https://code.claude.com/docs/en/hooks#premodelswitch)

## 6. OTel 能力与门槛

**事实**：logs/events 基础配置是 `CLAUDE_CODE_ENABLE_TELEMETRY=1`、`OTEL_LOGS_EXPORTER=otlp` 和本地 OTLP endpoint/protocol。它暴露 API、工具、权限、skill 激活、hook 盘点/汇总、压缩等，比 hook 事件目录更宽。默认批次导出周期是 5 秒，不能直接等同即时声音时钟。[Monitoring](https://code.claude.com/docs/en/monitoring-usage#quick-start)

**事实**：span tracing 另需 `CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1` 与 `OTEL_TRACES_EXPORTER`。`claude_code.hook` span 进一步要求 `ENABLE_BETA_TRACING_DETAILED=1`、`BETA_TRACING_ENDPOINT`；交互 CLI 还要求组织被 allowlist，SDK / `-p` 无此 allowlist 条件。Detailed 配置会改变 logs/traces 目的地，不能为了声音覆盖用户已有 exporter。普通 hook start/complete OTel 日志不等于这个受限 span。[Tracing](https://code.claude.com/docs/en/monitoring-usage#traces-beta)

**事实**：`session.id`、`prompt.id`、`tool_use_id` 可跨日志、hook、span 做证据关联；`event.sequence` 是进程级计数，跨 `/clear` 延续，换进程 resume 后可重复或变小。需要时间戳、来源运行身份和序号一起排序。[Correlation](https://code.claude.com/docs/en/monitoring-usage#event-correlation-attributes)

## 7. 指定 skill 调查

| 证据 | 可作何种判断 |
|---|---|
| `PreToolUse` / `PostToolUse` 匹配 `Skill` | Claude 通过 Skill 工具调用；不能覆盖用户直接输入 `/skill` |
| `UserPromptExpansion` | 用户命令展开，含 command_name/source/args；expansion_type 区分 slash_command 和 mcp_prompt |
| OTel `claude_code.skill_activated` | 直接报告调用，trigger 为 user-slash / claude-proactive / nested-skill，另有 skill.source |
| OTel request/usage 上的 skill 属性 | 宿主报告的当前 skill 归属，可显示为“宿主归属” |
| skill 文件被读取或名字出现在回复 | 仅是加载/提及线索，不能升级成调用或因果关系 |

来源：[UserPromptExpansion](https://code.claude.com/docs/en/hooks#userpromptexpansion)、[Skill activated](https://code.claude.com/docs/en/monitoring-usage#skill-activated-event)、[Skill lifecycle](https://code.claude.com/docs/en/skills#skill-content-lifecycle)。激活事件的自定义/第三方名称默认可能为 `custom_skill`，开启 `OTEL_LOG_TOOL_DETAILS=1` 才更完整；该开关同时开放其他工具参数，并非仅开放 skill 名。不同 telemetry 指标的名称脱敏规则也不同，不能用一个统一假设替代。

**推论**：调查可以精确落到某次 activation 与有证据关联的执行；暂不能把 skill 影响画成必定闭合的单一 start/end 区间。Skill frontmatter hooks 在调用后可能持续到 session 结束；这也不证明期间所有操作都属于该 skill。嵌套调用、forked skill、复用已加载内容应分别保留证据。

## 8. Session、回放与覆盖缺口

**事实**：CLI transcript 默认 `~/.claude/projects/<project>/<session-id>.jsonl`，内部条目格式会变，官方不保证它是稳定 API；可关闭写入，默认保留期限 30 天。Resume 通常沿用 session ID，fork 新 ID，`/clear` 新 ID；`SessionStart source=compact` 是同 session 内上下文重建。CLI、Desktop、Web、VS Code 历史不能简单视为同一个本地目录。[Sessions](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)、[CLI](https://code.claude.com/docs/en/cli-reference)

**事实**：子 agent transcript 位于 `<sessionId>/subagents/agent-<agentId>.jsonl`，独立于主会话压缩。恢复子 agent 可重用 ID、开始新 run。Stream-json 的 `--forward-subagent-text` / SDK 对应选项可提供 parent_tool_use_id；这属于 programmatic 路径，不能声称已无缝附着现有交互 CLI。[Subagents](https://code.claude.com/docs/en/sub-agents#resume-subagents)、[Programmatic usage](https://code.claude.com/docs/en/headless#stream-responses)

**推论**：Symphony 自己切换查看 session，应只是换过滤范围；不是向 Claude 发 `/resume`。采集键至少区分 installation/host、session、agent、run；名字只用于展示。回放以自身已录事件为准，transcript 用作版本化补采，标识迟到、脱敏、未采集、中断和不完整配对。

**仍待验证**：本机版本实际支持的事件集合；具体异步事件的投递丢失率与低延迟成本；各 handler 类型是否都能映射到稳定配置实例；在不启动新 agent、不改变原会话的情况下能获得何种实时 stream；是否能在某用户组织启用 detailed tracing。本研究没有把文档保证推成已完成的运行验证。
