// Snapshot: deepseek-ai/deepseek-harness @ ddefc45fbc7f8e46dd73185e68295696d1297887.
// These are persisted SessionEvent types, not a count of Cordis extension points.
const definitions = {
  'agent-preset/selected': ['Agent 预设', 'session', '选择会话使用的 agent 预设。'],
  'agent/inbox/spliced': ['收件箱交付', 'collaboration', '一批待处理消息进入 agent。'],
  'approval/asked': ['请求许可', 'interaction', '宿主记录一次许可请求。'],
  'approval/decided': ['许可答复', 'interaction', '按原生请求 ID 记录许可结果。'],
  'approval/policy': ['许可策略', 'interaction', '许可策略配置发生变化。'],
  'assistant/attempt': ['模型尝试', 'model', '未提交消息的模型尝试；保留其原始流。'],
  'assistant/message': ['模型回复', 'model', '一个 step 的完整回复，或被中断的已交付片段。'],
  'command/done': ['命令结束', 'interaction', '宿主命令执行结束。'],
  'command/run': ['命令开始', 'interaction', '宿主命令开始执行。'],
  'compaction/end': ['压缩结束', 'context', '一次上下文压缩结束，可能失败。'],
  'compaction/prune': ['裁剪上下文', 'context', '无需模型的上下文裁剪记录。'],
  'compaction/start': ['开始压缩', 'context', '以 compactionId 标识的压缩开始。'],
  'compaction/summary': ['压缩摘要', 'context', '摘要内容与被替换的来源范围。'],
  'deliverables/presented': ['交付产物', 'artifact', '向用户呈现产物。'],
  'feedback/message-delete': ['删除反馈消息', 'interaction', '反馈中的消息被删除。'],
  'feedback/message-put': ['更新反馈消息', 'interaction', '反馈中的消息被写入。'],
  'feedback/record': ['反馈记录', 'interaction', '一条用户反馈记录。'],
  'goal/change': ['目标变更', 'interaction', '会话目标发生变化。'],
  'hook/invoked': ['Hook 开始', 'hook', '一个兼容 bridge handler 的实际调用。'],
  'hook/result': ['Hook 结果', 'hook', '该 handler 的决定、退出码与耗时。'],
  'image/offload': ['图像卸载', 'context', '图像从当前请求中卸载。'],
  'llm/retry': ['安排模型重试', 'model', '记录失败后的重试计划与等待时间。'],
  'llm/retry-started': ['模型重试开始', 'model', '同一 retryId 的等待结束，开始新尝试。'],
  'model/selection': ['模型选择', 'model', '模型路由选择。'],
  'permission/preset': ['权限预设', 'interaction', '选择权限预设。'],
  'plan/mode': ['计划模式', 'interaction', '计划模式发生变化。'],
  'request/context': ['请求上下文', 'context', '模型请求使用的路由与容量信息。'],
  'request/header': ['请求配置', 'model', '下一次请求的配置与工具声明。'],
  'sandbox/mode': ['沙箱模式', 'interaction', '沙箱模式配置。'],
  'schedule/change': ['调度变更', 'interaction', '计划任务配置变化。'],
  'session-log-deepseek/delivery-accepted': ['日志交付', 'session', '日志交付被接收。'],
  'session/end-seed': ['历史前缀结束', 'session', '历史继承边界；不表示会话结束或实时存活。'],
  'session/title': ['会话标题', 'session', '宿主保存的会话标题。'],
  'session/title-llm-request': ['生成会话标题', 'model', '标题生成使用的模型请求记录。'],
  'step/end': ['Step 结束', 'model', '一个模型调用及工具批次结束。'],
  'step/start': ['Step 开始', 'model', '一个模型调用及工具批次开始。'],
  'subagent/catalog': ['子 Agent 目录', 'collaboration', '可用子 agent 目录，不是执行开始。'],
  'subagent/descriptor': ['子 Agent 描述', 'collaboration', '子 agent 的持久描述。'],
  'subagent/model-selection-policy': ['子 Agent 模型策略', 'collaboration', '子 agent 的模型选择策略。'],
  'system/message': ['系统消息', 'context', '渲染后的系统提示或它的替换。'],
  'team/member': ['团队成员', 'collaboration', '一个团队成员的完整状态快照。'],
  'team/message/delivered': ['团队消息送达', 'collaboration', '目标会话确认记录了消息。'],
  'team/message/queued': ['团队消息入队', 'collaboration', '消息已进入持久邮箱。'],
  'team/task': ['团队任务', 'collaboration', '共享任务的完整状态快照。'],
  'todo/write': ['待办更新', 'artifact', '待办清单写入。'],
  'tool-workflow/agent-end': ['工作流成员结束', 'collaboration', '按 runId 与成员 seq 记录结果。'],
  'tool-workflow/agent-start': ['工作流成员开始', 'collaboration', '工作流发布了一个子会话。'],
  'tool-workflow/run-end': ['工作流结束', 'collaboration', '工作流运行结束。'],
  'tool-workflow/run-start': ['工作流开始', 'collaboration', '一个有原生 runId 的工作流开始。'],
  'tool/call': ['工具调用', 'tool', '模型请求调用工具；不保证已获准执行。'],
  'tool/ptc-dispatch': ['嵌套工具结果', 'tool', 'run_code 中以 subCallId 关联的工具结果。'],
  'tool/ptc-dispatch-start': ['嵌套工具开始', 'tool', 'run_code 中实际进入执行的子调用。'],
  'tool/result': ['工具结果', 'tool', '嵌套 tool-result block 中的返回与错误标记。'],
  'turn/end': ['回合结束', 'session', '宿主记录的回合终止原因。'],
  'turn/start': ['回合开始', 'session', '宿主打开了一个回合；不证明当前仍在运行。'],
  'user/message': ['用户或注入消息', 'interaction', '由 source 区分真实用户输入与插件注入。'],
  'web/deepseek-search-llm-request': ['搜索模型请求', 'model', '搜索工具中的模型请求记录。'],
  'workspace/changes': ['工作区变化', 'artifact', '工作区文件变化记录。'],
};

const categories = [
  ['session', '会话'], ['model', '模型'], ['tool', '工具'], ['hook', 'Hook'],
  ['context', '上下文'], ['interaction', '交互'], ['collaboration', '协作'],
  ['artifact', '产物'], ['other', '其他'],
];

// point is the exact hook/invoked.data.point. The native interception point is
// distinct and does not itself emit a durable handler audit.
const hooks = [
  ['SessionStart', ['codex', 'claude-code'], 'detached-no-handler-audit', 'agent/created'],
  ['UserPromptSubmit', ['codex', 'claude-code'], 'turn-handler-audit', 'agent/pre-step'],
  ['PreToolUse', ['codex', 'claude-code'], 'turn-handler-audit', 'tools/pre-execute'],
  ['PostToolUse', ['codex', 'claude-code'], 'turn-handler-audit', 'tools/post-execute'],
  ['Stop', ['codex', 'claude-code'], 'turn-handler-audit', 'agent/turn-stopping'],
  ['SubagentStart', ['claude-code'], 'detached-no-handler-audit', 'subagent/start'],
  ['SubagentStop', ['claude-code'], 'detached-no-handler-audit', 'subagent/end'],
];

export function getCatalog(extraTypes = []) {
  const types = new Set([...Object.keys(definitions), ...extraTypes.filter(type => typeof type === 'string' && type)]);
  return {
    events: [...types].sort().map(type => {
      const definition = Object.hasOwn(definitions, type) ? definitions[type] : null;
      return {
        type, label: definition?.[0] ?? type, category: definition?.[1] ?? 'other',
        description: definition?.[2] ?? '尚未识别的原生事件；原始记录已保留，不推断语义。',
        known: definition !== null,
      };
    }),
    hooks: hooks.map(([point, dialects, coverage, nativePoint]) => ({ point, dialects: [...dialects], coverage, nativePoint })),
    categories: categories.map(([id, label]) => ({ id, label })),
  };
}
