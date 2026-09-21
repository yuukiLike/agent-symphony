# Pi：配置、扩展事件与会话证据

研究日期：2026-09-21（Asia/Shanghai）。仅阅读官方公开资料与源码；没有读取用户的 Pi 配置、安装依赖、运行 Pi 或修改任何真实 agent 配置。本文的示例尚未在 Pi 中执行。

## 核验基线

- **事实**：原 `badlogic/pi-mono` GitHub 地址现重定向到 [`earendil-works/pi`](https://github.com/earendil-works/pi)。当前包名为 `@earendil-works/pi-coding-agent`。
- **事实**：本次固定到官方 [v0.86.1 release](https://github.com/earendil-works/pi/releases/tag/v0.86.1)，GitHub 发布时间为 **2026-09-20 11:19:20 UTC**；tag 对应 commit **`13cbf77df2396303013a41646bcfa77b4271ae56`**，commit 时间为 **2026-09-20 13:04:11 +02:00**。以下文件链接均固定到此 commit。[包清单][package]
- 检索时的 `main` HEAD 为 `890f920884f6d21fc7617d236ef9e1cc5d7a0ef8`，本文没有把该未发布 HEAD 当作 release 契约。
- **事实**：该版本有 **37 个 `ExtensionAPI.on` 原生事件名**。旧文档中的 `session_directory`、`session_switch`、`session_fork` 不在本版订阅接口中；切换与 fork 使用 `session_shutdown` → `session_start(reason)` 生命周期。[事件类型][types]

## 配置入口、作用域与加载顺序

| 入口 | 作用与已核验边界 |
|---|---|
| `~/.pi/agent/settings.json` | 全局 JSON 设置。`PI_CODING_AGENT_DIR` 可替换默认 agent 配置目录。 |
| `<cwd>/.pi/settings.json` | 当前项目设置；普通设置覆盖全局，嵌套对象递归合并。须通过项目 trust 才加载。 |
| `~/.pi/agent/extensions/*.ts`、`extensions/*/index.ts` | 全局自动发现扩展；源码同样接受 `.js`、`index.js`，以及子目录 `package.json` 中的 `pi.extensions`。 |
| `<cwd>/.pi/extensions/` | 项目自动发现扩展，须通过项目 trust。没有文档依据把所有祖先 `.pi/extensions/` 都当作自动加载目录。 |
| settings 的 `extensions`、`packages` | 加载额外本地扩展、npm/git 包；支持过滤、排除。全局相对路径基于 agent 目录，项目相对路径基于 `<cwd>/.pi/`。 |
| `pi -e ./observer.ts` | 显式 CLI 扩展；可重复。`--no-extensions -e ...` 关闭自动发现，只加载显式指定扩展。 |
| `/reload` | 重载扩展和资源；旧实例收到 shutdown，新实例收到 start。不能把每次 reload 听成一个新任务。 |

依据：[设置文档][settings]、[扩展位置与加载][extensions]、[CLI 与环境变量][readme]、[资源加载器][resources]、[扩展加载器][loader]。

**资源不能只套用“项目数组替换全局数组”的结论。** 当前资源解析器单独读取 global/project 原始设置：先收集项目包、再全局包；同一包身份项目优先去重；本地资源两边均参与，项目条目先处理；CLI 显式路径先于解析结果合并，路径去重。自动目录随后参与。扩展同名工具/命令等的冲突仍取决于具体注册与加载顺序；不能据普通 JSON 合并规则断言一个扩展完全覆盖另一个。[包资源解析器][packages]、[资源加载器][resources]

**项目信任是安装位置能否生效的前提。** 交互模式可能询问信任项目；决定保存在 `~/.pi/agent/trust.json`。非交互 `-p`、JSON、RPC 不显示该提示：无适用已保存决定时，全局 `defaultProjectTrust: "ask"` 或 `"never"` 忽略项目资源，`"always"` 才加载。`--approve/-a` 与 `--no-approve/-na` 可覆盖本次运行。这里描述配置契约，不建议为声音功能改变用户信任策略。[设置文档][settings]

最小加载示例，二选一；这是 Pi 的真实配置语法，不是 Symphony 的声音映射配置：

```json
{
  "extensions": ["/absolute/path/to/symphony-observer.ts"]
}
```

```sh
pi --no-extensions -e /absolute/path/to/symphony-observer.ts
```

也可把文件置于已适用的 `extensions/` 自动目录；无需另建 `hooks` JSON。Pi 的原生机制是 **TypeScript/JavaScript 扩展中的 `pi.on(event, handler)`**，不是“事件 → shell command”的配置字典。扩展可以自行执行进程，但那是扩展实现。[扩展文档][extensions]

## 全部 37 个原生扩展事件

以下每个 `event.type` 都能作为独立的声音绑定键。表中“可干预”表示 Pi 允许此类 handler 改变行为；声音观察器应只取元数据并正常返回。除 `project_trust` 外，handler 获得 `ExtensionContext`，可只读取得 session ID/file、当前 leaf、cwd、model。多数事件本身不带 session ID 或时间戳，不能假定有统一 envelope。[事件与返回类型][types]

| 事件名 | 主要 payload / 标识 | 原生返回或可变语义 |
|---|---|---|
| `project_trust` | `cwd`；ctx 仅有 cwd/mode/hasUI/有限 UI | **必须**返回 `trusted: yes/no/undecided`，可 `remember`；纯观察应 `undecided`。 |
| `resources_discover` | `cwd`, `reason: startup/reload` | 可返回 `skillPaths/promptPaths/themePaths`。不是某项资源成功加载事件。 |
| `session_start` | `reason: startup/reload/new/resume/fork`, `previousSessionFile?` | 通知。当前会话从 ctx 读取。 |
| `session_info_changed` | `name`（可 undefined） | 通知；改名/清空名字。 |
| `session_before_switch` | `reason: new/resume`, `targetSessionFile?` | 可 `cancel`。 |
| `session_before_fork` | `entryId`, `position: before/at` | 可 `cancel`；`skipConversationRestore` 当前文档标为保留。 |
| `session_before_compact` | `preparation`, `branchEntries`, `customInstructions?`, `reason: manual/threshold/overflow`, `willRetry`, `signal` | 可取消或返回自定义 `compaction`。 |
| `session_compact` | `compactionEntry`, `fromExtension`, `reason`, `willRetry` | 压缩成功通知。 |
| `session_compact_failed` | `reason`, `errorMessage?`, `aborted`, `willRetry`, `fromExtension` | 压缩失败或取消通知。 |
| `session_shutdown` | `reason: quit/reload/new/resume/fork`, `targetSessionFile?` | 旧 runtime 拆除通知；不等于程序退出。 |
| `session_before_tree` | `preparation` 内含 `targetId/oldLeafId/commonAncestorId/entriesToSummarize/userWantsSummary`；`signal` | 可取消、替换摘要、修改摘要指令/label。 |
| `session_tree` | `newLeafId`, `oldLeafId`, `summaryEntry?`, `fromExtension?` | 同一会话树导航通知。 |
| `context` | `messages` 深拷贝 | 可返回替换 messages；每次 LLM 调用前。 |
| `cache_warming_decision` | `warmCost`, `missCost`, `continuationProbability`, `action` | 可返回 `action: warm/stop`；这是 cache 维护，不是用户任务进度。 |
| `before_provider_request` | `payload` | 可返回替换 provider payload。 |
| `before_provider_headers` | `headers` | 原位修改有效，返回值忽略；不要采集鉴权头。 |
| `after_provider_response` | `status`, `headers` | response 到达、消费 stream 之前；不是完整回答结束。 |
| `before_agent_start` | 展开后的 `prompt`, `images?`, `systemPrompt`, 可变 `systemPromptOptions` | 可注入 message、替换 prompt；可变集合也会影响行为。 |
| `agent_start` | 无额外字段 | 一次底层 agent run 开始。 |
| `agent_end` | `messages` | 一次底层 run 结束；**可能随后自动 retry、compact 或 follow-up**。 |
| `agent_settled` | 无额外字段 | 没有上述自动继续剩余；仍不表示结果语义正确。 |
| `ui_prompt_start` | `reason: ui_prompt`, `kind: select/confirm/input/editor/custom`, `title?` | 阻塞式扩展 UI 开始等待用户；不是通用权限事件。 |
| `ui_prompt_end` | 同上 | 该阻塞式扩展 UI 等待结束。 |
| `turn_start` | `turnIndex`, `timestamp` | 一次 turn 开始；index 不是全局 UUID。 |
| `turn_end` | `turnIndex`, `message`, `toolResults` | 一次 turn 结束。 |
| `message_start` | `message` | 消息开始；依 role 区分用户/助手/工具等。 |
| `message_update` | `message`, `assistantMessageEvent` | 流式更新，可能高频。 |
| `message_end` | `message` | **可以返回替换 message**，须保留原 role；并非强制只读事件。 |
| `tool_execution_start` | `toolCallId`, `toolName`, `args` | preflight 中发出，早于 `tool_call`；不能证明实际执行已经发生。 |
| `tool_execution_update` | `toolCallId`, `toolName`, `args`, `partialResult` | 工具增量进度；并发时相互穿插。 |
| `tool_execution_end` | `toolCallId`, `toolName`, `result`, `isError` | 工具最终处理结束；用 `isError` 分成功/错误。 |
| `model_select` | `model`, `previousModel`, `source: set/cycle/restore` | 模型改变通知。 |
| `thinking_level_select` | `level`, `previousLevel` | 配置的 thinking level 改变；不是模型开始推理。 |
| `tool_call` | `toolCallId`, `toolName`, 可变 `input` | 可 `block/reason/terminate`；原位改参数直接生效且不重新校验。 |
| `tool_result` | `toolCallId`, `toolName`, `input`, `content`, `details`, `isError`, `usage?` | 可 patch content/details/isError/usage；在 execution_end 之前。 |
| `user_bash` | `command`, `excludeFromContext`, `cwd` | 用户 `!`/`!!`；可替换 operations 或整个 result。 |
| `input` | `text`, `images?`, `source: interactive/rpc/extension`, `streamingBehavior?: steer/followUp` | `continue/transform/handled`；在 skill/template 展开前。 |

`cache_warming_decision` 的定义另见 [cache-warmer.ts][cache]；其他事件、返回类型和 37 个 `on` 重载见 [types.ts][types]，时序见 [extensions.md][extensions]。

`message_update.assistantMessageEvent.type` 还能进一步区分 `start`、`text_start/delta/end`、`thinking_start/delta/end`、`toolcall_start/delta/end`、`done`、`error`。这些是流的**子事件**，不是额外的 12 个 `pi.on` 名称；是否有 thinking 内容取决于 provider。`contentIndex` 标识同一消息内的 block，`toolcall_end.toolCall.id/name` 关联工具调用。[pi-ai 流事件类型][ai-types]

## 时序、等待与观察器副作用

工具调用的真实顺序为：

```text
tool_execution_start → tool_call（可阻止/改参数）
  → 实际执行与 tool_execution_update*
  → tool_result（可改结果）→ tool_execution_end
  → 最终 toolResult message 事件
```

默认并行模式下，同一助手消息内的工具按源顺序进行 preflight，然后并发执行；update 可交错，`tool_result` / execution_end 按完成顺序，而最终 toolResult 消息仍按源顺序发出。因此，事后消息排列不能直接充当真实工具时间线。[工具事件文档][extensions]

**事实**：扩展 runner 按扩展/handler 顺序 `await handler(...)`。音频播放、网络请求或文件 I/O 若在 handler 内被 await，可能延迟事件处理，某些事件直接阻塞执行路径。普通事件异常通常报告后继续；`tool_call` 的异常会传播到工具前置检查，使工具失败/被阻止。声音观察器必须自行捕获错误、迅速返回；不得返回 `block/cancel/message/systemPrompt` 等控制对象，不得修改 event 内的参数或 headers。[runner 实现][runner]、[agent-session 事件转发][agent-session]

**推断**：为每个 hook 配声音可行，但“播放结束后才让 hook 结束”会改变 agent 的时间表现。应先拷贝少量标量，交给独立有界队列；过量流式事件的丢弃/合并是桥接层策略，不是 Pi 的保证。

下面是**只读观察的最小扩展示例**：它只生成少量元数据，异步写入用户显式指定的独立文件；不写 stdout、不改 session、不改 agent 控制返回。演示 6 个通知事件，完整接入可按上表逐项订阅。它不是交付实现，未运行/编译验证；生产版本还需要队列上限、退出 flush 与错误诊断。

```ts
import { appendFile } from "node:fs/promises";
import type {
  ExtensionAPI, ExtensionContext, ExtensionEvent,
} from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const output = process.env.SYMPHONY_PI_EVENTS; // 父目录应预先存在
  let pending = Promise.resolve();

  const observe = (event: ExtensionEvent, ctx: ExtensionContext): void => {
    if (!output) return;
    try {
      const line = JSON.stringify({
        platform: "pi",
        event: event.type,
        observedAt: Date.now(),
        sessionId: ctx.sessionManager.getSessionId(),
        leafId: ctx.sessionManager.getLeafId(),
        toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
        toolName: "toolName" in event ? event.toolName : undefined,
        isError: "isError" in event ? event.isError : undefined,
      }) + "\n";
      // 不 return pending，不 await；失败不抛回 Pi handler。
      pending = pending
        .then(() => appendFile(output, line, { mode: 0o600 }))
        .catch(() => {});
    } catch {}
  };

  pi.on("session_start", observe);
  pi.on("agent_start", observe);
  pi.on("tool_execution_start", observe);
  pi.on("tool_execution_end", observe);
  pi.on("agent_settled", observe);
  pi.on("session_shutdown", observe);
}
```

如果订阅 `project_trust`，它没有普通 session context，且必须返回 `{ trusted: "undecided" }` 才保持中立。不能把同一个“无返回值、读取 ctx.sessionManager”的 handler 盲目装到全部 37 个事件上。[信任事件类型][types]

## SDK / RPC / JSON 是不同事件面

**事实**：SDK 可对自己创建/管理的 `AgentSession` 使用 `session.subscribe(listener)`，返回 unsubscribe 函数；这不表示能附着到任意已经运行的 Pi 进程。SDK listener 签名返回 `void`，`_emit` 同步调用 listener，没有 await 或 catch；观察器同步异常仍须自行捕获。[SDK][sdk]、[实现][agent-session]

除了 agent/turn/message/tool 基础事件，`AgentSessionEvent` 还包括：

| 事件 | 关键 payload |
|---|---|
| `agent_end` | 比扩展同名事件多 `willRetry`。 |
| `agent_settled` | 无自动继续剩余。 |
| `queue_update` | 完整待处理 `steering[]`、`followUp[]`。 |
| `compaction_start` / `compaction_end` | `reason`；end 有 `result/aborted/willRetry/errorMessage?`。 |
| `auto_retry_start` / `auto_retry_end` | start: `attempt/maxAttempts/delayMs/errorMessage`；end: `success/attempt/finalError?`。 |
| `summarization_retry_scheduled` | `attempt/maxAttempts/delayMs/errorMessage`。 |
| `summarization_retry_attempt_start` / `summarization_retry_finished` | start: `source: branchSummary/compaction`，compaction 有 `reason`。 |
| `entry_appended` | `entry`。不要据名称假定每种持久化 append 都保证广播；须以相应调用点为准。 |
| `session_info_changed` | `name`。 |
| `thinking_level_changed` | `level`；名称不同于扩展 `thinking_level_select`。 |
| `bash_execution_update` | `id?`、`delta`；用于直接执行用户/RPC shell 命令。 |

此表以 [`AgentSessionEvent` 联合类型][agent-session] 为准。**扩展 `pi.on` 没有 `auto_retry_start/end`，不能把 SDK 事件名直接写成原生扩展订阅。** 若要精确听到自动 retry 延迟，要采用相应会话流接口，或承认扩展观察器的缺口。

- `pi --mode rpc`：stdin 接 JSONL 命令，stdout 输出 JSONL 响应和事件；命令可带 `id`，但多数事件没有对应的通用命令 ID。RPC 还报告 `extension_error`，以及带独立 request ID 的 `extension_ui_request/response`。对话型 UI request 会等待客户端回答，通知类 UI request 不等待。RPC 是托管子进程协议，不是旁听现有 TUI。[RPC 文档][rpc]
- `pi --mode json "prompt"`：第一条为 session header，随后为会话事件；`message_update` 是 delta-only，删去了累计 `message` 和 `partial`；top-level `usage` 是当前累计 usage，`toolcall_start` 补 `id/toolName`。最终 `message_end.message` 才是权威完整消息。不要把它和 SDK/扩展 payload 当成完全相同。[JSON 文档][json]
- **事实**：Pi 原生没有 MCP 客户端配置契约；官方建议用扩展加入 MCP。也没有原生 sub-agent 系统；可由扩展/第三方包启动子 agent。MCP server 名称、子 agent 父子关系等是否可见，取决于具体扩展的工具名称、details、进程协议，不能由 Pi 基础事件统一保证。[官方定位][readme]

## 会话存储、关联 ID 与回放边界

**事实**：默认 JSONL 路径为 `~/.pi/agent/sessions/--<encoded-cwd>--/<timestamp>_<session-id>.jsonl`。当前格式 version 3；头部含 session `id`、`timestamp`、`cwd`，可有 `parentSession`。普通 entry 另有自己的 `id`、`parentId`、ISO `timestamp`，组成树；entry ID 通常为 8 位 hex，必要时可回退 UUID。session ID 默认 UUID，SDK/`--session-id` 可指定。[格式][session]

- `ctx.sessionManager.getSessionId()/getSessionFile()/getLeafId()/getHeader()/getBranch()` 提供只读关联视角；不要混淆 session ID、entry ID 和 `toolCallId`。[ReadonlySessionManager][session-manager]
- `/tree` 在同文件内移动 leaf；`/fork` 与 `/clone` 建立新 session/file，并记录 `parentSession`。`/fork` 选中消息之前继续，`/clone` 在当前位置复制；扩展 start reason 同为 `fork`，前置事件用 `position` 区分。[会话格式][session]、[扩展生命周期][extensions]
- `--session-dir` 可覆盖保存目录；`--no-session` 不保存。环境目录也可变更，不能只硬编码 home 路径。[CLI][readme]
- **事实**：通常等出现第一条 assistant message 后才把新会话首次写到磁盘。单纯监视文件无法实时获知所有启动/输入/等待事件。[`_persist` 实现][session-manager]
- **事实**：无摘要的 `branch()` 仅移动内存 leaf，下一次 append 才形成新树枝。文件不能保证记录每次 tree 导航动作。[branch 实现][session-manager]
- **推断**：JSONL 适合恢复消息、调用/结果、分支和压缩史；无法精确重建所有流式 block 起止、真实工具并行时间、UI 等待、retry backoff 和没有 append 的导航。要保留真实演奏节奏，需另存实时事件时间线。
- **推断**：桥接层应自行添加接收时间、进程/连接 ID、run 序号。`sessionId + toolCallId` 可关联工具事件；`turnIndex` 需结合本次 run。`message_end` 先进入扩展再持久化，所以当时的 ctx leaf 不能当成该消息已分配的 entry ID。[事件转发与持久化顺序][agent-session]

## Skill 的证据层级与缺口

**事实**：全局发现 `~/.pi/agent/skills/` 与 `~/.agents/skills/`；项目 trust 后发现 `.pi/skills/`，以及从 cwd 到 git 根（无 repo 则到文件系统根）的祖先 `.agents/skills/`；另有包、settings `skills`、CLI `--skill`。`--no-skills` 不取消显式 `--skill`。重名保留先发现者并给诊断。[Skills][skills]

可观察证据必须分层：

| 要判断的事 | 证据 | 可以说到哪里 |
|---|---|---|
| Skill 在可用目录中 | 资源加载结果 / prompt options 中 skills | “被发现、可用”；不是已使用。`resources_discover` 只是贡献路径机会。 |
| 用户显式 `/skill:name` | `input.text` 在展开前；后续展开后的 `<skill name="…" location="…">` 消息 | 可判“用户请求该 skill”；结合成功展开内容，判“skill 内容已注入”。未知名字/读文件失败可原样继续，不能只靠前缀宣布加载成功。 |
| agent 自主加载 skill | `read` 指向已知 SKILL.md，或 `bash` 读取它；检查结果是否成功 | 可判“文件成功读取”；不是可靠的“遵循了 skill”或“完成 skill”。 |
| skill 执行结束 | 当前 37 个原生事件没有 `skill_start/skill_end` | **未知/无原生证据**；需要 skill/扩展主动发自定义事件或外部约定。 |

官方明确说明模型按需用 `read`，无 read 时可用 bash 读取完整说明，且模型未必真的加载；`/skill:name` 由 harness 直接读文件展开，不一定产生 read 工具事件。输入 handler 又可能提前 `handled/transform`；扩展自定义命令检查先于 input，可能完全绕过 input。[Skills 机制][skills]、[skill 展开与输入实现][agent-session]、[事件生命周期][extensions]

`thinking_*` 只证明 provider 提供了相应流，不证明发生了某种认知步骤；`agent_settled` 只证明停止自动继续，不证明代码正确；Pi 无统一原生权限系统，`ui_prompt_*` 也不能穷尽全部外部 approval。以上边界应保留在平台适配证据里。

## 结论与待验事项

1. **事实**：37 个原生扩展事件可逐项订阅，足以为每个原生 hook 设置独立声音；声音映射配置需由本工具维护，Pi 没有原生声音字段。
2. **事实**：实时扩展、SDK/RPC/JSON、持久化 session 是三个不同观测面，事件名、payload、时序保证均不完全相同。
3. **事实**：应区分 `agent_end` / `agent_settled`、tool preflight / actual execution、session shutdown / process quit。
4. **未知**：未实跑验证 observer 在四种模式、reload、fork、并行工具及异常时的完整覆盖；未验证第三方 MCP/sub-agent 扩展的事件约定。
5. **下一步验证材料**：固定 v0.86.1 的合成事件 fixture + 最小隔离 Pi 会话，验证 handler 不等待音频、工具被阻止仍有 start、并行完成排序、settled 晚于自动 retry、fork 重建实例、显式 skill 不产生 read。这些是建议验收项，本次尚未执行。

[package]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/package.json
[settings]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/settings.md
[extensions]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/extensions.md
[types]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/extensions/types.ts#L522
[runner]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/extensions/runner.ts#L889
[readme]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/README.md
[resources]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/resource-loader.ts#L428
[loader]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/extensions/loader.ts#L665
[packages]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/package-manager.ts#L912
[cache]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/cache-warmer.ts#L90
[agent-session]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/agent-session.ts
[ai-types]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/ai/src/types.ts#L652
[sdk]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/sdk.md
[rpc]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/rpc.md
[json]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/json.md
[session]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/session-format.md
[session-manager]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/src/core/session-manager.ts
[skills]: https://github.com/earendil-works/pi/blob/13cbf77df2396303013a41646bcfa77b4271ae56/packages/coding-agent/docs/skills.md
