# 可以听见哪些事件

Agent 的活动、活动的接入方式，以及声音表达，是三个不同层次。这里整理可研究的事件来源，不代表 Agent Symphony 已支持这些平台或事件。

资料核对日期：2026-09-16。平台能力会随版本变化，实现适配器时需要再次核对文档与真实事件。返回 [项目首页](../readme.md)，或查看 [探索方向](exploration.md)。

## Tools、MCP 与 hooks 的关系

- Tool 是 Agent 发起的一次操作，例如执行命令、修改文件或搜索。
- MCP 是连接外部能力的协议。MCP tool 调用也是工具调用的一种，不能因为同时带有 “tool” 和 “MCP” 标签就重复计数。MCP 还涉及 resources、prompts 等能力，不只 tools。参见 [MCP 架构说明](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture)。
- Hook 是宿主在某个生命周期节点提供的回调入口，例如工具调用前后、等待授权或子 Agent 启停。不是所有 Agent 行为都由 hook 发起，也不是所有行为都有对应 hook。

同一操作可能同时出现在 hook、事件流与日志中。接入时要保留来源与关联标识，区分同一操作的多个阶段和多个重复记录。Hook 本身的执行也可以成为观察对象，但它与触发它的工具操作不是同一件事。

## 候选事件地图

以下是待探索的类别与声音表达，不是通用标准事件名，也不保证每个平台都提供。

| 类别 | 可寻找的事实 | 可能的听觉表达 |
| --- | --- | --- |
| 会话与回合 | 会话开始、用户提交、回合开始与结束、中断 | 开场、分句、不同的收束 |
| 模型输出 | 请求与响应状态、公开输出流、可用的使用量信息 | 一段持续活动的纹理 |
| 工具执行 | 开始、结束、工具类别、明确返回状态、耗时 | 音符或短乐句，开始与结束的呼应 |
| 等待与交互 | 等待授权、请求用户输入、MCP elicitation（请求用户补充信息） | 留白或可辨认的等待音型 |
| 多 Agent 协作 | 创建、交接、等待、返回、子 Agent 结束 | 声部进入、交替与退出 |
| 上下文整理 | 压缩开始与结束 | 短暂过渡音型 |
| Hook 执行 | Hook 开始、完成、失败或阻止继续 | 与工具声部区分的辅助音型 |
| 错误与恢复 | 明确错误、取消，以及来源明确报告的重试 | 音色变化，重试时乐句再现 |

是否表现模型输出和使用量仍需试验。按每个文本分块发声可能主要反映传输节奏；不能把它当作完整的思考过程。

## 已查阅的接入方向

### Codex hooks

官方文档列出了会话、工具、授权、上下文压缩、子 Agent、停止与中断等生命周期入口。例如 `PreToolUse`、`PostToolUse`、`PermissionRequest`、`PreCompact`、`PostCompact`、`SubagentStart`、`SubagentStop`、`Stop` 与 `Interrupt`。

适合研究明确生命周期节点的接入，但不能假定覆盖全部活动：官方文档明确指出，托管的 `WebSearch` 不走本地函数工具 hook 路径；对已有命令的 `write_stdin` 轮询也不会重新触发 `PreToolUse`。

命令非零退出也可出现在 `PostToolUse` 中，需要查看结果字段，而不是只凭事件名判断成功。参见 [Codex hooks 官方文档](https://learn.chatgpt.com/docs/hooks)。

### Codex App Server

官方事件流包含 `turn/started`、`turn/completed`、`item/started`、`item/completed` 等通知。Item 可描述命令执行、文件修改、MCP 调用、协作调用、搜索与上下文压缩；回合结束还需读取其实际状态。

线程状态可报告 `waitingOnApproval`。`hook/started` 与 `hook/completed` 描述同步 hook，文档注明不为异步 hook 发出这些通知。

这是研究更细执行结构的一个方向，不意味着可以无条件旁听任意已运行会话。需先明确客户端连接、订阅和实际能收到的事件。参见 [Codex App Server 官方文档](https://learn.chatgpt.com/docs/app-server#events)。

### Claude Code hooks

官方 hook 生命周期涵盖工具、授权、子 Agent、会话和上下文压缩等阶段，也有 `PostToolUseFailure` 与 `StopFailure` 等错误相关入口。

不能直接把这些名称和语义套用到其他 Agent。尤其要区分工具执行失败、回合因 API 错误结束，以及正常停止响应。参见 [Claude Code hooks 官方文档](https://code.claude.com/docs/en/hooks#hook-lifecycle)。

### MCP 事件与结果

除调用的开始和返回外，可以研究来源实际提供的进度通知与交互请求。进度不一定存在；调用后保持安静，不能据此判断远端已经停止。

还要区分协议层错误与工具报告的业务执行错误。MCP tools 规范使用 `isError: true` 表达后一类情况，不应只检查传输是否成功。参见 [MCP 工具错误处理](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#error-handling)。

## 接入时先回答的问题

1. 这是来源直接报告的事件，还是根据日志推测的状态？
2. 能否识别任务、Agent、操作及其父子关系？开始与结束能否配对？
3. 时间是事件发生时间还是采集时间？跨进程时间是否可比较？
4. 同一操作是否被多个入口重复记录？是否会丢失、乱序或重放？
5. “完成”具体指工具返回、回合结束，还是业务任务经过验证？
6. 哪些字段真的需要保存，哪些可能含有提示词、凭据或用户数据？

先弄清这些问题，再设计声音。采集不到的状态应保留为未知，不用持续背景音乐假装 Agent 仍在正常执行。
