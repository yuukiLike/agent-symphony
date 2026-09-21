// Synthetic records using dsh v3 payloads. No agent, shell or MCP call is made.
const VERSION = '0.1.6-alpha.2';
const text = value => ({ type: 'text', text: value });
const toolBlock = (id, name, args) => ({ type: 'tool-call', id, name, arguments: JSON.stringify(args) });

function sessionBuilder(id, createdAt, extraHeader = {}) {
  const header = { id, version: 3, createdAt, cwd: '/demo/agent-symphony', isSeeded: false, ...extraHeader };
  const events = [];
  let clock = createdAt;
  const add = (type, data, extra = {}, at = null) => {
    clock = Math.max(clock + 350, at ?? 0);
    const event = { type, seq: events.length, time: clock, data, ...extra };
    events.push(event);
    return event;
  };
  const user = (value, source = { kind: 'user' }, extra = {}) => add('user/message', {
    id: `${id}:message:${events.length}`, role: 'user', content: [text(value)], source,
  }, { surfaceOp: 'append', ...extra });
  const system = (turn = 1, step = 1) => add('system/message', {
    turn, step, message: { id: `${id}:system`, role: 'system', content: [text('This is a synthetic demonstration, not a running agent.')], source: { kind: 'plugin', plugin: 'system-prompt' } },
  }, { surfaceOp: 'append' });
  const assistant = (content, turn = 1, step = 1) => {
    const time = clock + 350;
    const stream = content.flatMap((block, index) => [
      { type: 'chunk', time, chunk: { type: 'block-start', index, blockType: block.type } },
      block.type === 'text'
        ? { type: 'text-chunks', time0: time, index, dt: [], texts: [block.text] }
        : { type: 'tool-call-chunks', time0: time, index, dt: [], id: block.id, name: block.name, args: [block.arguments] },
      { type: 'chunk', time, chunk: { type: 'block-end', index, block } },
    ]);
    stream.push({ type: 'chunk', time, chunk: { type: 'finish', reason: { kind: content.some(block => block.type === 'tool-call') ? 'tool-calls' : 'stop' } } });
    return add('assistant/message', {
      turn, step, message: { id: `${id}:message:${events.length}`, role: 'assistant', content, source: { kind: 'model', provider: 'demo', model: 'synthetic-model' } }, stream,
    }, { surfaceOp: 'append' });
  };
  const call = (block, turn = 1, step = 1) => add('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments });
  const result = (callEvent, value, isError = false) => add('tool/result', {
    turn: callEvent.data.turn, step: callEvent.data.step,
    message: {
      id: `${id}:message:${events.length}`, role: 'user', source: { kind: 'tool', callId: callEvent.data.callId },
      content: [{ type: 'tool-result', toolCallId: callEvent.data.callId, content: [text(value)], isError }],
    },
    ...(isError ? { error: { name: 'DemoToolError', code: 'DEMO_FAILURE', reason: value } } : {}),
  }, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] });
  const open = (prompt, turn = 1) => {
    add('turn/start', { turn });
    add('step/start', { turn, step: 1 });
    system(turn);
    return user(prompt);
  };
  const close = (turn = 1, step = 1, kind = 'completed') => {
    add('step/end', { turn, step });
    return add('turn/end', { turn, reason: { kind } });
  };
  return { header, events, add, user, assistant, call, result, open, close, get time() { return clock; } };
}

export function createDemoBatch(now = Date.now()) {
  const parent = sessionBuilder('demo-api-review', now - 60_000);
  const prompt = parent.open('/review 检查 API 重试与并发查询；这是可回放的演示数据。');
  parent.add('session/title', { title: '演示 · API 重试与并行查询', messageSeqs: [prompt.seq], source: { kind: 'fallback' } });
  parent.user('检查重试边界并记录有证据的失败。', { kind: 'skill-invocation', name: 'review', form: 'instructions' });
  const read = toolBlock('demo-read', 'read', { path: 'src/retry.ts' });
  const mcp = toolBlock('demo-mcp', 'mcp__docs__search', { query: 'retry idempotency' });
  parent.assistant([text('并行读取源码与文档。'), read, mcp]);
  const readCall = parent.call(read);
  const mcpCall = parent.call(mcp);
  parent.add('hook/invoked', { turn: 1, point: 'PreToolUse', dialect: 'claude-code', matcher: 'read', handlerId: 'claude:PreToolUse:1' });
  parent.add('hook/result', { turn: 1, point: 'PreToolUse', handlerId: 'claude:PreToolUse:1', decision: 'pass', exitCode: 0, durationMs: 8 });
  parent.result(mcpCall, '文档提到幂等键与重试上限。');
  parent.result(readCall, '当前实现对网络错误进行有限重试。');
  parent.add('step/end', { turn: 1, step: 1 });
  parent.add('step/start', { turn: 1, step: 2 });
  const workflow = toolBlock('demo-workflow', 'workflow', { code: 'agent({ label: "边界检查", prompt: "审查重试边界" })' });
  parent.assistant([workflow], 1, 2);
  const workflowCall = parent.call(workflow, 1, 2);
  parent.add('tool-workflow/run-start', { runId: 'demo-workflow-run', name: '边界检查' });
  const launch = parent.add('tool-workflow/agent-start', { runId: 'demo-workflow-run', seq: 1, label: '重试审查', childId: 'demo-audit-child' });

  const child = sessionBuilder('demo-audit-child', launch.time + 50, {
    parentSession: parent.header.id, origin: 'subagent', delegationDepth: 1,
  });
  child.open('审查父会话的 API 重试边界；演示子会话。');
  const skill = toolBlock('demo-skill', 'skill', { name: 'api-audit' });
  child.assistant([skill]);
  const skillCall = child.call(skill);
  child.result(skillCall, '审查超时、重试上限与幂等键。');
  child.add('step/end', { turn: 1, step: 1 });
  child.add('step/start', { turn: 1, step: 2 });
  child.assistant([text('已找到一次失败调用没有幂等键；此段为演示结论。')], 1, 2);
  child.close(1, 2);

  parent.add('tool-workflow/agent-end', { runId: 'demo-workflow-run', seq: 1, outcome: 'completed' }, {}, child.time + 100);
  parent.add('tool-workflow/run-end', { runId: 'demo-workflow-run', stopReason: 'completed' });
  parent.result(workflowCall, '子会话返回审查结果。');
  parent.add('step/end', { turn: 1, step: 2 });
  parent.add('step/start', { turn: 1, step: 3 });
  parent.assistant([text('检查完成。工具调用与 skill 的联系只来自明确调用证据。')], 1, 3);
  parent.close(1, 3);

  // Standalone compaction: all source seqs name existing earlier surface nodes.
  const shadowed = parent.events.filter(event => event.surfaceOp === 'append' && event.type !== 'system/message').map(event => event.seq);
  parent.add('compaction/start', { compactionId: 'demo-compact', turn: null });
  const summary = parent.add('compaction/summary', {
    compactionId: 'demo-compact', summary: [text('完成并行文档查询和子会话审查。')],
    shadowedRange: { start: shadowed[0], end: shadowed.at(-1) }, shadowedSeqs: shadowed, shadowedTokenCount: 1200,
    provider: 'demo', model: 'synthetic-model', rawOutput: [text('完成并行文档查询和子会话审查。')], llmStreamCall: true,
  });
  parent.user('完成并行文档查询和子会话审查。', { kind: 'plugin', plugin: 'compaction-basic', form: 'recall' }, {
    surfaceOp: { op: 'replace', startSeq: shadowed[0], endSeq: shadowed.at(-1) }, sourceEventSeqs: [...shadowed, summary.seq],
  });
  parent.add('compaction/end', { compactionId: 'demo-compact', turn: null });

  const partial = sessionBuilder('demo-missing-return', now - 20_000);
  partial.open('运行测试并观察 hook 返回；这份演示记录暂未包含回合结束。');
  const bash = toolBlock('demo-test', 'bash', { command: 'npm test' });
  partial.assistant([bash]);
  partial.call(bash);
  partial.add('hook/invoked', { turn: 1, point: 'PreToolUse', dialect: 'codex', matcher: 'bash', handlerId: 'codex:PreToolUse:1' });
  partial.add('hook/result', { turn: 1, point: 'PreToolUse', handlerId: 'codex:PreToolUse:1', decision: 'pass', exitCode: 1, stderrSummary: '演示：检查脚本异常退出', durationMs: 23 });
  partial.add('demo-plugin/diagnostic', { message: '未知插件事件也会保留。' }, { ignorable: true });

  const sessions = [parent, child, partial];
  return {
    source: { instanceId: 'symphony-demo-v1', version: VERSION, label: 'dsh 演示（模拟数据）', kind: 'demo' },
    sessions: sessions.map(session => session.header),
    events: sessions.flatMap(session => session.events.map(event => ({ sessionId: session.header.id, event, historical: true }))),
    gaps: [], // No return was observed; that alone is not proof of dropped events.
  };
}

export function createLiveDemoFrames(now = Date.now()) {
  const session = sessionBuilder('demo-live-session', now);
  session.open('演示事件流：读取一个文件，然后汇总。不会运行真实 agent。');
  const read = toolBlock('demo-live-read', 'read', { path: 'src/example.ts' });
  session.assistant([text('现在开始演示工具调用。'), read]);
  const call = session.call(read);
  session.add('hook/invoked', { turn: 1, point: 'PreToolUse', dialect: 'codex', handlerId: 'codex:PreToolUse:live-1' });
  session.add('hook/result', { turn: 1, point: 'PreToolUse', handlerId: 'codex:PreToolUse:live-1', decision: 'pass', exitCode: 0, durationMs: 12 });
  session.result(call, 'export const example = true;');
  session.add('step/end', { turn: 1, step: 1 });
  session.add('step/start', { turn: 1, step: 2 });
  session.assistant([text('演示结束。这里的声音来自模拟事件，未调用模型或工具。')], 1, 2);
  session.close(1, 2);
  const source = { instanceId: `symphony-demo-live-${now}`, version: VERSION, label: 'dsh 限时演示（模拟数据）', kind: 'demo' };
  return session.events.map((event, index) => ({
    delayMs: event.time - now,
    batch: { source, sessions: index === 0 ? [session.header] : [], events: [{ sessionId: session.header.id, event, historical: false }] },
  }));
}
