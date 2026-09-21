# Agent Symphony：观察与声音配置

日期：2026-09-21。状态：基于四宿主证据形成的实现前设计提案，保留跨平台目标；后续已实现的 dsh 范围见 [项目首页](../../readme.md) 与 [验证记录](../verification.md)。前置研究：[配置与能力比较](../research/agent-config-comparison.md)。延续 [直接执行发声](direct-execution-sound.md) 与 [Session 调查](session-investigation.md)。

## 1. 产品承诺

用户可以为每个原生 hook 指定声音，也可以缩小到某类工具、某个 MCP server，或来源能明确识别的具体 handler。声音、执行时间线与调查入口使用同一份记录。选择 session、skill、声音或回放，只改变 Symphony 的所见所听。

“所有 hook 可配声”是声音规则的能力；“本次 session 记录到了哪些 hook”是适配器的观测能力。两项分别展示。当前来源未暴露的 hook 允许预先配置和试听，但不能显示为已成功监听。

默认是一个本地小工具：session 列表、当前执行记录、按需展开的声音／证据面板。无需用一整页仪表盘解释宿主配置。

## 2. 用户如何给 Hook 指定声音

从事件行点开“声音”，或在设置中搜索宿主原生事件名。配置面板分清三个选择：

1. **听什么**：例如 Claude Code 的 `PreToolUse` 触发，或一个已经识别的 hook handler 完成。原生名称保留在主要标签中。
2. **缩小到什么对象**：所有工具、一个工具、一个 MCP server；有可靠身份时，可选具体 handler。只展示来源可提供的筛选字段。
3. **什么声音**：选择内置短音、选择本地音频、调音量、试听或静音。试听清楚标为预览，不混入执行记录。

每行还呈现当前效果：来自哪条规则、是否覆盖默认设置、这次接入是否能记录。用户从一个真实事件进入时，直接看到“为什么这次播放这个声音”。

例如 `PostToolUse` 下两个已发现 handler：

| 对象 | 声音规则 | 当前证据 |
| --- | --- | --- |
| PostToolUse 生命周期 | 短木音 | 当前来源可记录触发 |
| 项目 lint handler 完成 | 低音；明确失败时使用另一短音 | 仅当 handler 消息／审计能关联到该配置项时可用 |
| 插件 audit handler 完成 | 静音 | 保留记录，声音关闭 |

如果只收到“匹配两个 handler、一个失败”的汇总，只展示这一组；不能虚构表中两个 handler 的分别执行结果。配置文件中发现的项可以列出，但标为“发现配置；执行覆盖未知”。

## 3. 保留原生名字，共用少量声音默认值

事件身份至少包含宿主、接口、原生名称和版本。`codex / native-hook / Stop`、`claude-code / native-hook / Stop`、`dsh / claude-bridge / Stop` 是三项。

统一类别仅负责默认音色和搜索，例如会话、工具、上下文、模型、协作、交互、hook handler。映射后仍保留原生阶段与结果：Pi 的 preflight 不改名为已执行；Codex PostToolUse 不改名为成功。

规则处理保持确定：

- 用户精确规则是有序列表，从上到下首次匹配；设置面板显示顺序与被覆盖关系。
- 未命中精确规则，使用类别默认值；仍未知的事件使用用户选择的默认短音或静音。
- 静音也是一个明确匹配结果，不能被下层默认音重新打开。
- 默认每个逻辑对象的一个阶段只产生一次声音。需要叠加音色时，显式编辑一个音色组合，不靠多个规则偶然同时匹配。
- 新插件事件只要进入已接通的公开 feed，即可按原名配置，不要求升级整个分类表。无法确认语义时仅显示来源报告的名称与内容摘要；插件内部未公开的事件仍需对应桥接，不能自动捕获。

这里的匹配规则属于 Symphony，不复用四个宿主彼此不同的正则、matcher 或权限语法。

## 4. 声音配置示例

下面是 **Symphony 拟议 YAML 语法**，不是已有配置文件格式，也不是可粘贴给四个宿主的设置。音频文件与 handler ref 都是示意。

```yaml
version: 1

audio:
  scope: focused-session

sounds:
  call: { file: ./sounds/wood.wav, gain: 0.35 }
  context: { file: ./sounds/brush.wav, gain: 0.25 }
  settled: { file: ./sounds/bell.wav, gain: 0.3 }
  lint_failed: { file: ./sounds/low.wav, gain: 0.4 }

# 从上到下，首次匹配。
rules:
  - id: a-specific-lint-handler-failed
    match:
      host: claude-code
      subject: hook-handler
      handler_ref: project-lint
      phase: completed
      outcome: failure
    sound: lint_failed

  - id: claude-before-any-tool
    match:
      host: claude-code
      subject: hook-trigger
      native_event: PreToolUse
    sound: call

  - id: codex-before-compaction
    match:
      host: codex
      subject: hook-trigger
      native_event: PreCompact
    sound: context

  - id: dsh-hook-handler-invoked
    match:
      host: dsh
      subject: hook-handler
      native_event: hook/invoked
    sound: call

  - id: pi-no-automatic-work-pending
    match:
      host: pi
      subject: lifecycle
      interface: extension
      native_event: agent_settled
    sound: settled

fallback:
  unclassified: mute
```

`handler_ref` 是 Symphony 为用户选中配置项保留的引用，不假定原生 hook ID 跨运行稳定。适配器必须能证明运行记录与配置项对应，规则才可命中；关联未知就保留未匹配，而不是靠同名猜测。用户也能临时对一条已记录的 handler occurrence 配声或回听，不声称已配置未来所有运行。

每个原生 hook 都可生成独立规则；不要求用户为数十项逐个手写。先给默认音色，再用面板修改关心的几项。研究快照里的 12／33／37 不是产品写死的枚举上限；dsh 的事件与桥接目录也分别处理。

## 5. Session 切换与 Skill 调查

默认一个 session 获得声音焦点。列表标签包含宿主、任务简称、短 ID；同名会话仍可区分。选中 B 后，B 的标题、事件和实时声音一起生效；A 继续记录，A 的迟到事件仍归 A。旧音平滑收住，不把 B 的历史补采作为新动作补播。

Session、进程启动、子 agent run、Pi 当前 branch 是不同身份。恢复同一 session 后可以保留声音设置，记录中仍显示新的执行段与分支；不能用标题或一个可能复用的 ID 混合内容。Symphony 的“切换”不会调用宿主 resume / fork / tree 命令。

指定 skill 时，先选名称与来源，再定位可获得的证据：

- 明确激活／选择：显示平台实际提供的 activation 或 invocation 信息。
- 读取文件：显示读到了哪个 SKILL.md，不冒充完整执行。
- 后续关联：有原生关联证据才纳入明确结果；时间相邻的动作作为可展开的上下文。

用户可以只听明确关联事件，或选中一段时间连同上下文回听。没有 skill 结束事件时，不编造持续时间；同一行为可受多份 skill 影响。声音规则定义继续共用，调查筛选仅决定本次听到的记录范围。

历史查看不自动播放；显式进入回放后显示录制区间、覆盖与时间基准。现场仍记录但不混音，回到实时从当前接收点继续。只有导入 transcript 时，说明这是历史导入；有顺序但没有可靠时间的数据可用均匀间隔试听，必须标明“按事件顺序试听”，不能称为原速回放。

## 6. 每次播放都有可核对的依据

记录与音频之间增加一份很小的播放清单：本次发声对应哪些 observation、匹配了哪条规则、使用什么音色、何时播放。用户点事件能回听，点播放标记能回到事件。声音抑制、聚合或静音只改变播放清单，不删除已收集的事件。

同一个工具调用可能被 native hook、SDK stream 与 MCP 结果重复描述。关联 ID 足够时，整理为一个逻辑操作的不同证据，默认工具声只发一次。Hook handler 真正执行了脚本则是另一个对象，可以单独发声。证据不足的记录保持独立并标注关联未知，不能因为名称相同就合并。

Symphony 自己的采集 handler 可能也被宿主审计到。保留这份来源证据，但默认静音并标为采集器活动，避免把观察器的工作又听成 agent 业务动作。播放自身不生成新的宿主 hook。

实时播放采用本地接收时钟，不等齐远端迟到事件而长期阻塞音频。可靠源时间用于时间线和回放；遥测批次迟到时标出延迟，避免一批旧事件突然被播放为当前高强度活动。默认历史补采和过期批次不触发实时声音。

直接执行发声保留真实间隔，不自动吸附节拍，不用渐强暗示进度。高频流事件允许静音或短窗口聚合；聚合标记能展开全部成员。配声能力覆盖事件目录，默认并不要求每个 token delta 都发声。

## 7. 小型实现的边界

```text
宿主已有通知／事件 feed／最小观察扩展／历史补采
                         ↓
                本地接收与事件记录
                         ↓
               关联证据 + 来源能力
                         ↓
            Session／Skill 筛选与声音规则
                    ↙            ↘
                执行视图       独立音频播放
```

宿主侧只做必要的短时有界投递。声音文件解码、设备初始化、播放、回放和 UI 都离开 agent 执行路径。采集失败不能返回审批、上下文或执行决策；队列满时记录可识别的缺口，避免等音频服务恢复。不同宿主的中性返回与异常处理单独实现，不能机械规定所有回调都 `return undefined`。

这不等于零运行开销。对没有被动入口的事件保留未覆盖；尤其不为观察 Claude WorktreeCreate 接管其创建实现，不替换用户 MCP 服务、不代理审批、不复写现有遥测出口。Symphony 自身配置保存在自己的位置，宿主配置接入另行按其真实机制处理。

记录的最小公共字段是来源宿主与版本、接口、原生事件、接收 occurrence ID／顺序、session 身份、接收时间和可用的源时间。其余字段按来源提供：turn、agent run、tool call、handler、branch、结果与关系证据。保留原始字段名／单位；可选值缺失不能用猜测填满。默认收集音频和调查所需的元数据，provider headers 等认证材料不进入声音记录。

来源能力与单条事件证据是两张不同表：来源表说明某类事件可实时观察、只能历史导入、或当前不可见；事件详情说明这一条是直接报告、计算派生还是关联线索。连接中断和队列丢失显示在对应区间。不能用“没有收到事件”推断宿主配置已禁用。

## 8. 适配顺序与需要验证的真实样本

第一轮原型建议先接 **dsh 的 session/event**，验证执行、持久记录、hook 审计与回放能否共用。理由是该接口有明确 post-commit 隔离语义、seq / time，以及只读查询路径；这是实现取舍，不是平台偏好。其次以 Pi observer 验证同一记录结构面对不同扩展事件与分支是否成立。Codex 和 Claude 用各自实际可接入的 hook / stream 通道验证，不以 wrapper 启动新 session 冒充附着到既有 session。

进入实现前，至少形成以下固定版本运行样本与覆盖报告：

| 样本 | 必须观察到的结果 |
| --- | --- |
| 四宿主各一条工具调用、明确失败、MCP 或相应扩展调用 | 原生名称、匹配字段、结果语义和配置来源可追溯；不重复统计 |
| 同事件下两个 hook handlers，其中一个失败 | 能区分生命周期、独立 handler、组汇总；无独立证据时不伪造 |
| Pi preflight 后被阻断、agent_end 后自动重试 | 不播放已实际执行或全部结束的错误含义 |
| Codex exec / rollout 与 hook stream 对照 | 明确展示缺失 hook 记录；重复 run ID 不合并不同发生 |
| dsh SessionStart 与 open-turn hook audit 对照 | 起始审计缺口清楚；snapshot / feed 衔接没有重复 |
| A 调用中切到 B，A 随后返回；同名 session；resume / fork / branch | 时间线、声音、筛选和关系不串线 |
| 显式 skill、隐式加载、重复使用、只有文件读取 | 调查依据正确，不生成虚假的完整 skill 区间 |
| 音频服务退出、采集端断开、队列满、程序结束 | agent 行为保持原有语义；损失与开销可测，不承诺未经测量的零丢失 |

当前完成的是公开证据与设计，以上运行验证未执行。已有 [session 交互草图](../../outputs/session-focus.html) 是模拟数据，仅验证查看流程；它不代表四平台存在统一的 skill invocation 或完整生命周期协议。
