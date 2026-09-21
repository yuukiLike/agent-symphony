import { getCatalog } from './catalog.mjs';

// Payload contracts: dsh core/session/types, llm/message, llm/types and
// hooks/hook-protocol at ddefc45fbc7f8e46dd73185e68295696d1297887.
const catalog = new Map(getCatalog().events.map(event => [event.type, event]));
const starts = new Set(['turn/start', 'step/start', 'tool/call', 'tool/ptc-dispatch-start', 'hook/invoked', 'compaction/start', 'approval/asked', 'command/run', 'tool-workflow/run-start', 'tool-workflow/agent-start']);
const ends = new Set(['turn/end', 'step/end', 'tool/result', 'tool/ptc-dispatch', 'hook/result', 'compaction/end', 'approval/decided', 'command/done', 'tool-workflow/run-end', 'tool-workflow/agent-end']);
const rawEvent = event => event?.raw ?? event;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' && value.length ? value : null;
const number = value => Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0) ? value : null;
const short = (value, max = 180) => typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
const identity = (...parts) => JSON.stringify(parts);
const lookup = (values, key, fallback = 'unknown') => Object.hasOwn(values, key) ? values[key] : fallback;

function textContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join(' ');
}

function argumentsObject(value) {
  if (record(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return record(parsed) ? parsed : null;
  } catch {
    return null; // Raw, possibly malformed model arguments remain in raw.data.
  }
}

function resultBlock(data) {
  const message = data.message;
  if (!record(message) || message.role !== 'user' || message.source?.kind !== 'tool') return null;
  const block = Array.isArray(message.content) && message.content.length === 1 ? message.content[0] : null;
  if (block?.type !== 'tool-result' || typeof block.toolCallId !== 'string') return null;
  if (message.source.callId !== block.toolCallId) return null;
  return block;
}

// Store reads are already seq-ordered: constructing all native-ID indexes is O(N).
// Other callers may provide shuffled records; only that path sorts a copied list.
export function createEventContext(rawEvents) {
  const events = rawEvents.map(rawEvent);
  if (events.some((event, index) => index > 0 && event.seq < events[index - 1].seq)) events.sort((a, b) => a.seq - b.seq);
  const calls = new Map();
  const eventsBySeq = new Map();
  const hookStartSeqBySeq = new Map();
  const hooks = new Map();
  for (const event of events) {
    eventsBySeq.set(event.seq, event);
    const data = record(event.data) ? event.data : {};
    if (event.type === 'tool/call' && string(data.callId)) {
      const matches = calls.get(data.callId) ?? [];
      matches.push(event);
      calls.set(data.callId, matches);
    }
    if (event.type !== 'hook/invoked' && event.type !== 'hook/result') continue;
    if (!record(event.data)) {
      hookStartSeqBySeq.set(event.seq, null);
      continue;
    }
    const key = identity(data.turn, data.point, data.handlerId);
    const group = hooks.get(key) ?? { openCount: 0, startSeq: null };
    if (event.type === 'hook/invoked') {
      group.startSeq = group.openCount === 0 ? event.seq : null;
      group.openCount += 1;
      hookStartSeqBySeq.set(event.seq, event.seq);
    } else {
      hookStartSeqBySeq.set(event.seq, group.openCount === 1 ? group.startSeq : null);
      if (group.openCount > 0) group.openCount -= 1;
      if (group.openCount === 0) group.startSeq = null;
    }
    hooks.set(key, group);
  }
  return { events, calls, eventsBySeq, hookStartSeqBySeq };
}

function matchingCall(event, context, callId) {
  if (callId === null) return null;
  const data = event.data;
  const matches = candidate => {
    const raw = rawEvent(candidate);
    return raw?.type === 'tool/call' && raw.seq < event.seq && raw.data?.callId === callId
      && raw.data.turn === data.turn && raw.data.step === data.step;
  };
  const events = Array.isArray(context.events) ? context.events : [];
  const cached = context.calls instanceof Map ? context.calls.get(callId) : undefined;
  const pool = cached === undefined ? events : Array.isArray(cached) ? cached : [cached];
  const sources = Array.isArray(event.sourceEventSeqs) ? new Set(event.sourceEventSeqs) : null;
  if (sources) {
    const referenced = context.eventsBySeq instanceof Map
      ? [...sources].map(seq => context.eventsBySeq.get(seq)).filter(Boolean)
      : pool.filter(candidate => sources.has(rawEvent(candidate)?.seq));
    const candidates = referenced.filter(matches);
    if (candidates.length === 1) return rawEvent(candidates[0]);
    if (candidates.length > 1) return null;
  }
  const candidates = pool.filter(matches);
  return candidates.length === 1 ? rawEvent(candidates[0]) : null;
}

// A handlerId is an invocation pairing ID, not a durable configuration ID.
// Reused, overlapping IDs cannot be disambiguated by timestamp proximity.
function hookStartSeq(event, context) {
  if (event.type === 'hook/invoked') return event.seq;
  if (!record(event.data)) return null;
  if (context.hookStartSeqBySeq instanceof Map && context.hookStartSeqBySeq.has(event.seq)) return context.hookStartSeqBySeq.get(event.seq);
  const { turn, point, handlerId } = event.data;
  let openCount = 0;
  let startSeq = null;
  const events = (context.events ?? []).map(rawEvent).filter(candidate => candidate?.seq < event.seq
    && (candidate.type === 'hook/invoked' || candidate.type === 'hook/result')
    && candidate.data?.turn === turn && candidate.data?.point === point && candidate.data?.handlerId === handlerId)
    .sort((a, b) => a.seq - b.seq);
  for (const candidate of events) {
    if (candidate.type === 'hook/invoked') {
      startSeq = openCount === 0 ? candidate.seq : null;
      openCount += 1;
    } else if (openCount > 0) {
      openCount -= 1;
      if (openCount === 0) startSeq = null;
    }
  }
  return openCount === 1 ? startSeq : null;
}

function terminalOutcome(reason) {
  return lookup({ completed: 'success', failed: 'failure', error: 'failure', blocked: 'blocked', aborted: 'cancelled', cancelled: 'cancelled' }, reason);
}

export function normalizeEvent(event, context = {}) {
  if (!record(event) || !string(event.type) || number(event.seq) === null || number(event.time) === null || !Object.hasOwn(event, 'data')) {
    throw new TypeError('Expected a dsh event with type, non-negative safe-integer seq/time, and data');
  }
  const data = record(event.data) ? event.data : {};
  const definition = catalog.get(event.type);
  const sourceId = string(context.sourceId);
  const sessionId = string(context.sessionId);
  const scope = string(context.sessionKey) ?? identity(sourceId, sessionId);
  const normalized = {
    id: identity(scope, event.seq), sessionKey: string(context.sessionKey), sessionId, sourceId,
    sourceKind: string(context.sourceKind), seq: event.seq, type: event.type, time: event.time,
    receivedAt: number(context.receivedAt), historical: context.historical === true,
    category: definition?.category ?? 'other', label: definition?.label ?? event.type,
    summary: definition?.label ?? event.type, outcome: 'unknown',
    phase: starts.has(event.type) ? 'start' : ends.has(event.type) ? 'end' : 'instant',
    turn: number(data.turn), step: number(data.step), callId: null, toolName: null,
    hookPoint: null, handlerId: null, skillName: null, skillEvidence: null,
    correlationKey: null, raw: event,
  };
  if (!definition) return normalized;

  if (event.type === 'tool/call' || event.type === 'tool/result') {
    const block = event.type === 'tool/result' ? resultBlock(data) : null;
    normalized.callId = event.type === 'tool/call' ? string(data.callId) : string(block?.toolCallId);
    const call = event.type === 'tool/call' ? event : matchingCall(event, context, normalized.callId);
    normalized.toolName = string(call?.data?.name);
    if (normalized.callId !== null && normalized.turn !== null && normalized.step !== null) {
      normalized.correlationKey = identity(scope, 'tool', normalized.turn, normalized.step, normalized.callId);
    }
    if (event.type === 'tool/result' && block && (block.isError === undefined || typeof block.isError === 'boolean')) {
      normalized.outcome = block.isError ? 'failure' : 'success';
    }
    const args = argumentsObject(call?.data?.arguments);
    if (normalized.toolName === 'skill' && string(args?.name)) {
      normalized.skillName = args.name;
      normalized.skillEvidence = event.type === 'tool/call' ? 'tool-request'
        : normalized.outcome === 'success' ? 'tool-result-success'
          : normalized.outcome === 'failure' ? 'tool-result-failure' : null;
    }
    const detail = event.type === 'tool/result' ? textContent(block?.content)
      : args?.path ?? args?.command ?? args?.name ?? '';
    normalized.summary = short(`${normalized.toolName ?? normalized.callId ?? normalized.label}${detail ? ` · ${detail}` : ''}`);
  } else if (event.type === 'tool/ptc-dispatch-start' || event.type === 'tool/ptc-dispatch') {
    normalized.callId = string(data.subCallId);
    normalized.toolName = string(data.name);
    if (normalized.callId && string(data.rootCallId) && string(data.parentCallId)) {
      normalized.correlationKey = identity(scope, 'ptc', data.rootCallId, data.parentCallId, normalized.callId);
    }
    if (event.type === 'tool/ptc-dispatch' && typeof data.isError === 'boolean') normalized.outcome = data.isError ? 'failure' : 'success';
    if (normalized.toolName === 'skill' && string(argumentsObject(data.arguments)?.name)) {
      normalized.skillName = argumentsObject(data.arguments).name;
      normalized.skillEvidence = event.type === 'tool/ptc-dispatch-start' ? 'tool-request'
        : normalized.outcome === 'success' ? 'tool-result-success' : normalized.outcome === 'failure' ? 'tool-result-failure' : null;
    }
    normalized.summary = short(`${normalized.toolName ?? '嵌套工具'} · ${data.subCallId ?? ''}`);
  } else if (event.type === 'hook/invoked' || event.type === 'hook/result') {
    normalized.hookPoint = string(data.point); // Do not translate bridge points to Cordis names.
    normalized.handlerId = string(data.handlerId);
    const startSeq = hookStartSeq(event, context);
    if (normalized.turn !== null && normalized.hookPoint && normalized.handlerId && startSeq !== null) {
      normalized.correlationKey = identity(scope, 'hook', normalized.turn, normalized.hookPoint, normalized.handlerId, startSeq);
    }
    if (event.type === 'hook/result') {
      normalized.outcome = ['deny', 'block'].includes(data.decision) ? 'blocked'
        : data.decision === 'stop' ? 'cancelled'
          : Number.isInteger(data.exitCode) ? data.exitCode === 0 ? 'success' : 'failure' : 'unknown';
    }
    normalized.summary = short(`${data.point ?? 'Hook'} · ${data.handlerId ?? '未知 handler'}${event.type === 'hook/result' ? ` · ${data.decision ?? '未知决定'}${Number.isInteger(data.exitCode) ? ` / exit ${data.exitCode}` : ''}` : ''}`);
  } else if (event.type === 'user/message') {
    normalized.summary = short(textContent(data.content)) || normalized.label;
    if (data.source?.kind === 'skill-invocation' && string(data.source.name)) {
      normalized.skillName = data.source.name;
      normalized.skillEvidence = 'explicit-invocation';
      normalized.summary = `显式加载 skill · ${short(data.source.name)}`;
    }
  } else if (event.type === 'assistant/message') {
    normalized.summary = short(textContent(data.message?.content)) || '模型回复（无公开文字）';
    if (data.interrupted === true) normalized.outcome = 'cancelled';
  } else if (event.type === 'turn/start' || event.type === 'turn/end') {
    if (normalized.turn !== null) normalized.correlationKey = identity(scope, 'turn', normalized.turn);
    normalized.summary = `Turn ${normalized.turn ?? '?'}${event.type === 'turn/end' ? ` · ${data.reason?.kind ?? '未知结束原因'}` : ' · 已记录开始'}`;
    if (event.type === 'turn/end') normalized.outcome = terminalOutcome(data.reason?.kind);
  } else if (event.type === 'step/start' || event.type === 'step/end') {
    if (normalized.turn !== null && normalized.step !== null) normalized.correlationKey = identity(scope, 'step', normalized.turn, normalized.step);
    normalized.summary = `Turn ${normalized.turn ?? '?'} · Step ${normalized.step ?? '?'}`;
  } else if (event.type === 'approval/asked' || event.type === 'approval/decided') {
    if (string(data.id)) normalized.correlationKey = identity(scope, 'approval', data.id);
    normalized.callId = string(data.callId);
    normalized.toolName = string(data.toolName);
    normalized.outcome = lookup({ 'allowed-once': 'success', rejected: 'blocked', cancelled: 'cancelled', unavailable: 'blocked' }, data.outcome);
    normalized.summary = short(event.type === 'approval/asked' ? `${data.toolName ?? '工具'} · ${data.reason ?? '请求许可'}` : `${data.id ?? '许可'} · ${data.outcome ?? '未知答复'}`);
  } else if (event.type.startsWith('compaction/')) {
    if (string(data.compactionId)) normalized.correlationKey = identity(scope, 'compaction', data.compactionId);
    if (event.type === 'compaction/end') normalized.outcome = typeof data.error === 'string' ? 'failure' : 'success';
    normalized.summary = short(`${normalized.label}${data.compactionId ? ` · ${data.compactionId}` : ''}${data.error ? ` · ${data.error}` : ''}`);
  } else if (event.type === 'llm/retry' || event.type === 'llm/retry-started') {
    if (string(data.retryId)) normalized.correlationKey = identity(scope, 'retry', data.retryId);
    normalized.summary = short(`模型重试 ${data.retry ?? '?'}${number(data.delayMs) !== null ? ` · 等待 ${data.delayMs} ms` : ' · 等待结束'}`);
  } else if (event.type === 'command/run' || event.type === 'command/done') {
    if (string(data.commandId)) normalized.correlationKey = identity(scope, 'command', data.commandId);
    if (event.type === 'command/done') normalized.outcome = lookup({ success: 'success', error: 'failure' }, data.kind);
    normalized.summary = short(event.type === 'command/run' ? `${data.name ?? '命令'}${data.args ? ` · ${data.args}` : ''}`
      : `${data.commandId ?? '命令'} · ${data.kind ?? '未知结果'}${data.text ? ` · ${data.text}` : ''}`);
  } else if (event.type.startsWith('tool-workflow/')) {
    if (string(data.runId)) normalized.correlationKey = event.type.includes('/agent-')
      ? number(data.seq) !== null ? identity(scope, 'workflow-member', data.runId, data.seq) : null
      : identity(scope, 'workflow', data.runId);
    normalized.outcome = terminalOutcome(data.outcome ?? data.stopReason);
    normalized.summary = short(`${data.label ?? data.name ?? data.runId ?? normalized.label}${data.childId ? ` · ${data.childId}` : ''}${data.outcome ?? data.stopReason ? ` · ${data.outcome ?? data.stopReason}` : ''}`);
  } else if (event.type === 'session/title') {
    normalized.summary = short(data.title) || normalized.label;
  }
  return normalized;
}

export function summarizeSession(events, header = {}) {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  const context = sorted.every(event => event.raw) ? null : createEventContext(sorted);
  const normalized = sorted.map(event => event.raw ? event : normalizeEvent(event, context));
  let title = null;
  let prompt = null;
  let status = 'unknown';
  let errorCount = 0;
  const skills = new Map();
  for (const event of normalized) {
    const data = record(event.raw.data) ? event.raw.data : {};
    if (event.type === 'session/title' && short(data.title)) title = short(data.title, 120);
    if (!prompt && event.type === 'user/message' && data.source?.kind === 'user') prompt = short(textContent(data.content), 120) || null;
    if (event.type === 'turn/start') status = 'observed-active';
    if (event.type === 'turn/end') status = lookup({ completed: 'completed', blocked: 'blocked', aborted: 'cancelled', error: 'failed', interrupted: 'interrupted', 'max-tokens': 'limited' }, data.reason?.kind);
    if (event.outcome === 'failure') errorCount += 1;
    if (event.skillName && event.skillEvidence) {
      const key = identity(event.skillName, event.skillEvidence);
      const previous = skills.get(key);
      skills.set(key, { name: event.skillName, evidence: event.skillEvidence, count: (previous?.count ?? 0) + 1 });
    }
  }
  return { title: title ?? prompt ?? `Session ${short(header.id ?? '未命名', 36)}`, status, skills: [...skills.values()], errorCount };
}
