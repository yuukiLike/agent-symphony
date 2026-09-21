# 四种 Agent 宿主：配置、事件与调查能力比较

核查日期：2026-09-21。本文是实现前的研究快照，先记录公开文档／源码事实，再给出设计推论。研究阶段没有运行四种 agent、读取用户私有配置或修改真实设置；示例是配置形态。后续已实现 dsh 采集器并完成隔离联调，当前范围见 [项目首页](../../readme.md) 与 [验证记录](../verification.md)。其他三种宿主尚未实现适配。

用户要求：Agent Symphony 是小型的旁观工具；清楚记录每次 session、切换 session、调查指定 skill；所有 hook 都能指定声音。设计承接见 [观察与声音配置](../designs/observation-and-sound-config.md)。

## 1. 固定研究对象

| 宿主 | 本次基线 | 证据边界 | 完整备忘录与目录 |
| --- | --- | --- | --- |
| Codex CLI | `rust-v0.155.1`，`be2951ea34f0d295ed0becf97079f92fa5f6950e`；另对照 9 月 21 日 main | 官方文档与开源实现；关键 hooks / skills / rollout 文件核对稳定版一致 | [备忘录](platforms/codex.md) · [JSON](catalogs/codex.json) |
| DeepSeek Harness / dsh | `0.1.6-alpha.2`，`ddefc45fbc7f8e46dd73185e68295696d1297887` | `deepseek-ai/deepseek-harness` 开源实现；profile 决定组件能力 | [备忘录](platforms/dsh.md) · [JSON](catalogs/dsh.json) |
| Claude Code | `v2.1.278`，官方文档当日快照 | 官方文档、SDK 类型与公开仓库；公开仓库不是完整 CLI 核心开源实现 | [备忘录](platforms/claude-code.md) · [JSON](catalogs/claude-code.json) |
| Pi | `v0.86.1`，`13cbf77df2396303013a41646bcfa77b4271ae56` | 官方 `earendil-works/pi` 源码；旧 `badlogic/pi-mono` 已重定向 | [备忘录](platforms/pi.md) · [JSON](catalogs/pi.json) |

目录是研究快照，各自保留平台结构；不是 Symphony 已实现的统一 schema。以下数字量纲不同，不能用于比较“谁支持更多 hook”。

## 2. 配置入口与组合方式

| 维度 | Codex | dsh | Claude Code | Pi |
| --- | --- | --- | --- | --- |
| 主要配置 | 用户／项目 `.codex/config.toml`，另有系统、托管、profile 层 | `$DSH_HOME`，默认 `~/.dsh`；profile、bundle、`cordis.patch.yml` | 用户 `~/.claude/settings.json`；项目 `.claude/settings.json`、`.local.json`；另有托管与 CLI 层 | `~/.pi/agent/settings.json`、项目 `.pi/settings.json`；`PI_CODING_AGENT_DIR` 可移位 |
| Hook / 扩展配置 | 活动层旁 `hooks.json` 或 TOML `[hooks]`；插件可供 hooks | Cordis 插件 `name/config`；Codex / Claude hooks bridge 是可选插件 | `settings.json` 的 `hooks`；插件 `hooks/hooks.json`；skill / subagent frontmatter | TS / JS 扩展 `pi.on(event, handler)`；目录发现、`extensions/packages`、CLI `-e` |
| 组合规则 | Hook 跨层相加；普通标量覆盖规则不能代替 hook 合并 | bundle → profile patch → home patch；插件 config 整体替换 | Hook 跨层合并；不能只读取优先级最高文件 | 普通 settings 合并；资源路径与 package 有单独发现／去重逻辑 |
| 生效条件 | 项目信任、hook 定义 hash 信任、功能开关、管理策略 | 选中 profile 已挂载插件；不同 profile 不保证相同能力或 HMR | managed 策略、项目配置、插件与技能生命周期等 | 项目 trust、资源过滤、实际扩展加载状态 |
| MCP 配置形态 | `[mcp_servers.<name>]`，另有插件来源 | 每个 server 一条 `@deepseek-ai/dsh-mcp-client` 插件配置 | 原生 `mcpServers`；项目 `.mcp.json`，User / Local 位于 `~/.claude.json` 的不同层级 | 原生不提供 MCP 客户端配置契约；由扩展提供 |

各单元格的具体来源、层次细节和合法配置片段见四份平台备忘录。不能拿一个宿主的 JSON matcher 或 `async` 字段直接移植到另一个宿主。dsh bridge 接受相似文件，并不表示执行语义完整兼容。

**共同点：配置文件存在、宿主发现配置、配置实际生效、事件实际发生，是四件事。** Symphony 应展示配置来源与已知生效状态；仅扫描文件时标为“发现配置”，不能冒充宿主有效配置目录。

## 3. 原生事件与可观察接口

| 宿主 | 已核查目录 | 优先研究的观察入口 | 对 Symphony 的实际限制 |
| --- | --- | --- | --- |
| Codex | 12 个原生 hook event | 生命周期采集 hook；已有 app-server 集成内的 notifications 与 `hooks/list`；rollout 补采 | `exec --json` 和 rollout 都不保留 HookStarted / HookCompleted；executor-scoped hook 不提供 public summaries；未证实任意 TUI 的只读 attach |
| dsh | bridge：Codex 5 个、Claude 7 个；另有 58 个仓库已知持久 SessionEvent | post-commit `session/event`；现有 session query / trace / snapshot | 58 个不是全部 Cordis hook；原生扩展点中存在控制接口；open turn 外部分 hook 没有 `hook/invoked/result` 审计对 |
| Claude Code | 33 个原生 hook event | 生命周期采集 hook；已有 SDK / stream-json hook messages；可用 OTel events | SDK handler 消息并非所有事件都有完整起止；OTel hook execution 是匹配 handler 组汇总；部分 trace 能力有额外条件 |
| Pi | 37 个 `pi.on` 原生扩展事件；另列 23 个 session stream 类型、12 个 assistant 子事件 | 最小 observer extension；已有 SDK `AgentSession.subscribe` | `pi.on` 与 SDK / RPC 目录不同；多数 extension handler 在宿主路径中被 await；不能把扩展机制当天然只读总线 |

目录之外的事件保持可扩展：dsh 外部插件、Pi 扩展及各宿主未来版本都可能增加内容。先保留原名与来源，允许用户指定声音，再补充语义解释；不因无法归入固定类别而扔掉原始观察。

## 4. “Hook”至少有三种观察对象

| 观察对象 | 一个具体例子 | 可以证明什么 |
| --- | --- | --- |
| 生命周期触发点 | 收到 `PostToolUse` 的 hook 输入 | 该来源报告了工具返回这一节点 |
| 某个 handler 的一次执行 | 某配置下的 `lint.sh` 开始，随后退出 1 | 这个 handler 的起止／结果，前提是来源确实提供 |
| 一组匹配 handlers 的汇总 | OTel 报告匹配 3 个，完成 2 个、失败 1 个 | 这一组的结果，不能拆出没有提供的三个独立起止 |

新增一个 `PostToolUse` 采集器，只能接收自己的输入，不能因此知道相邻 lint hook 是否成功。Codex app-server、Claude hook messages、dsh hook audit 能补充不同程度的 handler 证据；Pi 通用 `pi.on` 回调不能据此审计其他扩展所有 handler。

声音绑定必须让这三种对象可区分。原始 hook 名称只在宿主和接口命名空间内有意义：dsh bridge 的 `PreToolUse` 不属于一个 Codex session。

## 5. 名称相近，时序与结果仍不同

| 易误读的情况 | 核实事实 | 设计后果 |
| --- | --- | --- |
| “PostToolUse 就是成功” | Codex 命令非零退出也走 PostToolUse；Claude 另有 PostToolUseFailure | 结果来自各自 payload / 状态，不能统一凭事件名判成功 |
| “工具 start 已经开始执行” | Pi `tool_execution_start` 在 `tool_call` 的阻断机会之前 | 显示“准备调用”；不能从这个点计算确认的实际执行时长 |
| “结束就是空闲” | Pi `agent_end` 后仍可自动继续；`agent_settled` 才无待续自动活动 | 配置中保留两种收束音；两者也都不证明任务正确 |
| “session_shutdown 就是退出进程” | Pi reload / new / resume / fork 也有相应 transition | 根据 reason 描述，不把全部 shutdown 播成退出音 |
| “给全部 hooks 加 recorder 就能旁观” | Claude WorktreeCreate 注册即替代默认创建；Pi project_trust 有特殊中性返回 | 按事件选择观察路径，不能批量生成无差别 observer |
| “async 一定无影响” | Codex / Claude async 仍可通过输出影响上下文；dsh bridge 不完整支持原 async 语义 | 回调中只做极短的有界投递；音频独立运行；逐接口验证返回行为 |

以上由 [Codex](platforms/codex.md)、[Claude Code](platforms/claude-code.md)、[Pi](platforms/pi.md)、[dsh](platforms/dsh.md) 的固定版本证据支持，不能当作未来所有版本的常量。

## 6. Session、历史与时间

共同需要 session 身份、源记录标识、时序、父子关系；但没有一套原生字段能直接通用。

- **Codex**：root session、thread、parent、fork 分开保存。`thread/read` 不建立 live 订阅；resume / fork 是运行入口。Hook run ID 也不保证跨 turn 唯一，hook 时间与 item 时间存在秒／毫秒差异。
- **dsh**：事件有 session 内递增 seq 与毫秒 time；header 有 parentSession 等。查询能读取冷 session；查询投影里的 synthetic closer 是派生结果。默认 v3 zstd 日志，不为了方便接入而改用户的持久化格式。
- **Claude Code**：resume 可继续同一 session ID，clear / fork 新建 ID。遥测 sequence 是进程范围，跨进程恢复可重复；subagent ID 也可对应多次运行。
- **Pi**：session 文件是树，entry parentId 与当前 leaf 影响分支。`/tree` 切换不等于新 session；部分导航未必立刻写盘，消息落盘顺序也不能还原并行工具完成节奏。

**推论**：Symphony 切换 session 只切换本地观察视图。历史文件是补充证据，不是完整实时录制的替代品；接入前的执行不能保证事后补齐。需要保留源时间、接收时间、单位、来源进程／连接代次与缺失区间，不能只用文件行序播放“真实节奏”。

## 7. 指定 Skill 调查

| 宿主 | 可用证据 | 不应推断的内容 |
| --- | --- | --- |
| Codex | skill 目录与来源路径；显式 `UserInput::Skill`；工具读取文件／运行脚本 | 没有公开通用 SkillStart / SkillEnd；目录变化不等于激活 |
| dsh | 原生 `skill` 工具；显式 `/name` 的 `skill-invocation` source；文件／registry provider | skills/change 是目录变化；加载不自动给后续全部行动建立因果归属 |
| Claude Code | Skill tool；`UserPromptExpansion`；OTel `skill_activated` 可区分 user / proactive / nested | 名称可能脱敏；activation 不等于闭合的 skill span；frontmatter hook 持续存在不证明全部活动归它 |
| Pi | `/skill:name` 输入与展开路径；实际 SKILL.md 读取；已加载资源目录 | 显式展开未必出现 read；没有通用 skill_start / skill_end |

共同的调查入口应是“选一份可区分来源的 skill，定位证据，再查关联动作”。关系可以是明确激活、读取、显式选择或待核实线索；不要把这些都显示成“调用一次 skill”。

## 8. 从比较得出的设计决定

1. **共用记录、声音和调查界面，分别实现宿主适配器。** 配置语法、有效目录、事件获取与语义判断由适配器负责。
2. **每个原生 hook 都能单独配声，不把原名压成少量泛化类别。** 类别用于默认声音，精确设置可落到事件、匹配对象以及确实可识别的 handler。
3. **配置覆盖与采集覆盖分别显示。** 可以先给 WorktreeCreate 选声音；当前接口没有旁观证据时清楚显示“已配声，尚不能记录”，不通过接管其实现来伪造覆盖。
4. **声音服务于调查。** 每次实际播放指向产生它的事件或聚合组，可回到 session 与证据；暂停声音不暂停记录。
5. **小工具也需要准确的身份与时序。** 复杂的宿主细节留在适配器和按需详情里，日常只呈现 session、执行记录、声音设置。

这些是产品设计提案。接口存在不等于已经验证运行开销、实时延迟或全场景覆盖；下一步验证清单在 [观察与声音配置](../designs/observation-and-sound-config.md)。
