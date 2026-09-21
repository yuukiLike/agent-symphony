# 可以听见哪些事件

资料核对日期：**2026-09-21**。这里是四个宿主的执行证据入口，公开源码或文档已核对。当前已实现 dsh 观察器与声音播放器，并完成隔离宿主联调；其他宿主仍处于研究阶段，用户生产会话尚未验证。实现范围见 [项目首页](../readme.md) 与 [验证记录](verification.md)，方向讨论见 [探索方向](exploration.md)。

配置位置、完整事件目录、版本快照和原始来源见各宿主备忘录；共性与差异见 [四宿主配置比较](research/agent-config-comparison.md)，由证据导出的方案见 [观察与声音配置设计](designs/observation-and-sound-config.md)。

## 先区分观察对象

工具调用、生命周期触发和回调脚本运行有各自的身份与时间，不能混成同一个事件：

| 对象 | 例子 | 一条记录能证明什么 |
| --- | --- | --- |
| 工具操作 | 一次 shell 或 MCP tool 调用 | 某次调用的输入、阶段或结果，取决于入口 |
| Hook 触发点 | `PreToolUse` | 宿主到达这个扩展点；不保证工具最后获准执行 |
| Handler 执行 | 某配置中的 `lint.sh` | 该回调开始、完成或失败；需要专门执行证据 |
| Handler group 汇总 | 一次触发匹配了三个回调，两个成功 | 这一组的结果；不能假装拥有每个脚本的独立起止 |
| Skill 证据 | 用户选择、宿主报告激活、读取文档、运行脚本 | 这些是不同强度的关联，不能统一当作完整 skill 调用区间 |

MCP tool 也是工具调用；MCP server 生命周期、用户补充信息请求、把 MCP tool 用作 hook handler，则是另外的对象。一个动作可能同时进入 hook、事件流和持久日志，应保留来源与关联 ID 后去重。具体映射以各宿主核实结果为准。

**“所有 hook 都能指定声音”是声音规则的表达能力，不是“所有 handler 的每次执行都已可见”。** 配置存在、运行时加载、触发点发生、handler 执行成功，需要分别呈现。

## 四个宿主的证据入口

| 宿主 | 本次核实的主要入口 | 对声音与调查的限制 |
| --- | --- | --- |
| [Codex CLI](research/platforms/codex.md) | 12 个 native hooks；app-server 的 thread/turn/item 与 hook 通知；exec JSON；rollout 历史 | exec JSON 与 rollout 都不保留完整 hook 执行；app-server 可报告本地 handler 的 sync/async 模式与结果，但 executor-scoped hooks 没有 public summaries。hosted WebSearch 不走本地 tool hook。 |
| [DeepSeek Harness / dsh](research/platforms/dsh.md) | 持久事件及提交后的 `session/event`；session query；Cordis 扩展点；Codex/Claude bridge 的部分 hook 审计 | profile 决定实际能力；bridge 分别只接受 5/7 个原生名称，不等于原宿主全量兼容。`hook/invoked/result` 在 SessionStart 和 detached 子 agent 生命周期存在缺口。 |
| [Claude Code](research/platforms/claude-code.md) | 33 个 native hooks；CLI/SDK hook 消息；OTel 的事件与汇总；transcript | `includeHookEvents` 也不保证全部 handler 成对起止；OTel hook 执行记录可能是 group 汇总。某些入口会改变执行，例如注册 WorktreeCreate 会接管创建流程，不能追加空回调冒充旁观。核心实现没有在公开仓库中完整开放。 |
| [Pi](research/platforms/pi.md) | 37 个 `pi.on` 扩展事件；另有 SDK/RPC/JSON 会话流；树形 session 文件 | 扩展事件与 SDK 事件名称、payload 不完全相同；handler 可改变输入/结果。`tool_execution_start` 早于可否决的 tool_call；原生没有统一 MCP 或子 agent 配置，取决于扩展。 |

数字描述此次固定版本的目录范围，不表示四者能力可按数量排序。JSON 完整目录见 [Codex](research/catalogs/codex.json)、[dsh](research/catalogs/dsh.json)、[Claude Code](research/catalogs/claude-code.json)、[Pi](research/catalogs/pi.json)。

## 广义事件地图

下列是调查分类，不是跨宿主通用的 API 名。只有实际采到的事实才能驱动声音：

| 类别 | 值得保留的事实 | 声音可以对应什么 |
| --- | --- | --- |
| Session 与回合 | 创建、恢复、fork、用户提交、回合结束、中断 | 边界与不同收音；保留 session 身份 |
| 模型交互 | 请求、响应、公开输出、使用量、明确重试 | 可观察的活动及返回；文本分块不等于思考步骤 |
| 工具与外部服务 | 调用、返回、进度、工具与 server 身份、错误 | 起音/回音、工具材质、明确错误的变化 |
| 等待与用户交互 | 权限请求、输入请求、elicitation | 请求音与返回音；等待期间允许安静 |
| 多 agent 与任务 | 分派、交接、消息、等待、返回、任务状态 | 声部进入、交错与退出 |
| 上下文与资源 | 指令/skill 的加载证据、记忆访问、压缩 | 只为已报告的变化发声 |
| Hook | 触发点、单 handler 的阶段、group 结果 | 三种对象各有配置入口，避免重复播放 |
| 环境与产物 | 配置变化、目录/模型切换、文件修改、产物记录 | 有证据的环境变化和结果落点 |
| 错误与恢复 | 明确失败、取消、重试与恢复 | 依据实际状态发声，不从相似命令推断重试 |

对 `Stop`、`agent_end`、工具返回和“用户任务完成”的含义应逐宿主判断。没有错误不等于业务正确，长时间没有新事件也不证明运行停止。

## 观察覆盖与被动性

- **绑定的范围清楚。** 声音规则保留 host、原生事件、来源、handler 或 group 身份。dsh 的 Codex bridge 事件仍属于 dsh，不能归进 Codex session。
- **时间与配对有证据。** 保存宿主时间与采集时间、原始 ID 与本地序号；缺少开始或关联 ID 时标明，不捏造耗时。不同通道须处理重复、乱序、迟到和断连。
- **回放说明缺口。** 宿主 transcript 是有限、版本化的历史，不一定包含实时 hook 生命周期。Symphony 自己的录制与补采记录要能区分。
- **切换查看不驱动 agent。** 改变 Symphony 的 session/skill 过滤范围，不应自动向宿主发 resume、start、fork 或审批响应。SDK/RPC 的托管执行入口也不等于能旁听已有进程。
- **观察器不返回控制结果。** Hook/extension 往往允许阻断、改写或注入上下文；适配器须按事件保持中立、快速投递，声音独立消费。有接管语义的入口须寻找其他证据通道，缺失就展示未覆盖。

dsh 已按这些契约完成隔离接入与故障验证，详见 [接入指南](dsh-setup.md)。其余宿主仍需逐一验证能收到哪些事件、谁的事件、来自哪次运行，以及采集器不可用时的宿主行为；目录存在不代表已经支持。
