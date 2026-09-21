import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createEventContext, normalizeEvent, summarizeSession } from '../src/events.mjs';
import { getCatalog } from '../src/catalog.mjs';
import { createDemoBatch, createLiveDemoFrames } from '../src/demo.mjs';

const event = (type, seq, data, extra = {}) => ({ type, seq, time: 1_000 + seq * 10, data, ...extra });
const context = { sessionKey: 'installation/session', sessionId: 'session', sourceId: 'installation', sourceKind: 'import', historical: true };
const call = (seq, id, name, args, turn = 1, step = 1) => event('tool/call', seq, { turn, step, callId: id, name, arguments: JSON.stringify(args) });
const result = (seq, callEvent, isError = false) => event('tool/result', seq, {
  turn: callEvent.data.turn, step: callEvent.data.step,
  message: { id: `msg-${seq}`, role: 'user', source: { kind: 'tool', callId: callEvent.data.callId }, content: [{ type: 'tool-result', toolCallId: callEvent.data.callId, content: [{ type: 'text', text: 'result' }], isError }] },
}, { surfaceOp: 'append', sourceEventSeqs: [callEvent.seq] });
const normalizeAll = events => events.map(value => normalizeEvent(value, { ...context, events }));

test('catalog exactly covers the pinned 58 persisted dsh types and keeps unknown types', async () => {
  const snapshot = JSON.parse(await readFile(new URL('../docs/research/catalogs/dsh.json', import.meta.url), 'utf8'));
  const catalog = getCatalog(['future/record', 'tool/call', '__proto__']);
  assert.deepEqual(catalog.events.filter(item => item.known).map(item => item.type), [...snapshot.session_events].sort());
  assert.equal(catalog.events.filter(item => item.known).length, 58);
  assert.equal(catalog.events.find(item => item.type === 'future/record').category, 'other');
  assert.equal(catalog.events.find(item => item.type === '__proto__').known, false);
  assert.equal(catalog.hooks.find(item => item.point === 'PreToolUse').nativePoint, 'tools/pre-execute');
  assert.equal(catalog.hooks.find(item => item.point === 'SessionStart').coverage, 'detached-no-handler-audit');
});

test('real nested tool result derives callId and outcome, never reads a flat invented name', () => {
  const start = call(0, 'call-1', 'mcp__docs__search', { query: 'docs' });
  const end = result(1, start);
  const [a, b] = normalizeAll([start, end]);
  assert.equal(b.callId, 'call-1');
  assert.equal(b.toolName, 'mcp__docs__search');
  assert.equal(b.outcome, 'success');
  assert.equal(b.correlationKey, a.correlationKey);
  assert.equal(b.raw, end);
  assert.equal(normalizeEvent(end, context).toolName, null);
  assert.equal(normalizeEvent(end, { ...context, calls: new Map([['call-1', start]]) }).toolName, 'mcp__docs__search');
  assert.equal(normalizeEvent(end, { ...context, eventsBySeq: new Map([[0, start]]) }).toolName, 'mcp__docs__search');
  const optionalError = structuredClone(end);
  delete optionalError.data.message.content[0].isError;
  assert.equal(normalizeEvent(optionalError).outcome, 'success');
  const mismatch = structuredClone(end);
  mismatch.data.message.source.callId = 'wrong-id';
  assert.equal(normalizeEvent(mismatch, { ...context, events: [start] }).callId, null);
  assert.equal(normalizeEvent(mismatch).outcome, 'unknown');
});

test('out-of-order parallel completions and reused call IDs use native turn/step identity', () => {
  const first = call(0, 'same', 'read', { path: 'a' }, 1, 1);
  const other = call(1, 'other', 'bash', { command: 'test' }, 1, 1);
  const events = [first, other, result(2, other, true), result(3, first), call(4, 'same', 'write', { path: 'b' }, 2, 1)];
  events.push(result(5, events[4]));
  const normalized = normalizeAll(events);
  assert.equal(normalized[2].toolName, 'bash');
  assert.equal(normalized[2].outcome, 'failure');
  assert.equal(normalized[3].toolName, 'read');
  assert.equal(normalized[5].toolName, 'write');
  assert.notEqual(normalized[0].correlationKey, normalized[4].correlationKey);
});

test('skill evidence records requests, results, and explicit injection without temporal attribution', () => {
  const skill = call(0, 'skill-call', 'skill', { name: 'review' });
  const unrelated = call(2, 'read-call', 'read', { path: 'src/main.ts' });
  const events = [skill, result(1, skill), unrelated, result(3, unrelated),
    event('user/message', 4, { id: 'u1', role: 'user', content: [{ type: 'text', text: 'instructions' }], source: { kind: 'skill-invocation', name: 'audit', form: 'instructions' } }, { surfaceOp: 'append' }),
    event('user/message', 5, { id: 'u2', role: 'user', content: [{ type: 'text', text: '/made-up-skill' }], source: { kind: 'user' } }, { surfaceOp: 'append' }),
    call(6, 'read-skill', 'read', { path: '/skills/review/SKILL.md' }),
  ];
  const normalized = normalizeAll(events);
  assert.equal(normalized[0].skillEvidence, 'tool-request');
  assert.equal(normalized[1].skillEvidence, 'tool-result-success');
  for (const index of [2, 3, 5, 6]) assert.equal(normalized[index].skillName, null);
  assert.equal(normalized[4].skillEvidence, 'explicit-invocation');
  assert.deepEqual(summarizeSession(events).skills, [
    { name: 'review', evidence: 'tool-request', count: 1 },
    { name: 'review', evidence: 'tool-result-success', count: 1 },
    { name: 'audit', evidence: 'explicit-invocation', count: 1 },
  ]);
});

test('failed skill loading and malformed model arguments never become successful activation', () => {
  const skill = call(0, 'load', 'skill', { name: 'review' });
  const failure = result(1, skill, true);
  const malformed = { ...call(2, 'broken', 'skill', {}), data: { turn: 1, step: 1, callId: 'broken', name: 'skill', arguments: '{"name":' } };
  assert.equal(normalizeEvent(failure, { events: [skill] }).skillEvidence, 'tool-result-failure');
  assert.equal(normalizeEvent(malformed).skillName, null);
});

test('each repeated handler invocation pairs to its own start even within the same turn', () => {
  const hook = (type, seq, extra = {}) => event(type, seq, { turn: 1, point: 'PreToolUse', handlerId: 'reused', ...extra });
  const events = [hook('hook/invoked', 0, { dialect: 'codex' }), hook('hook/result', 1, { decision: 'pass', exitCode: 0 }),
    hook('hook/invoked', 2, { dialect: 'codex' }), hook('hook/result', 3, { decision: 'pass', exitCode: 1 })];
  const normalized = normalizeAll(events);
  assert.equal(normalized[0].hookPoint, 'PreToolUse');
  assert.equal(normalized[0].correlationKey, normalized[1].correlationKey);
  assert.equal(normalized[2].correlationKey, normalized[3].correlationKey);
  assert.notEqual(normalized[0].correlationKey, normalized[2].correlationKey);
  assert.equal(normalized[3].outcome, 'failure');
  const ambiguous = normalizeAll([hook('hook/invoked', 0), hook('hook/invoked', 1), hook('hook/result', 2), hook('hook/result', 3)]);
  assert.equal(ambiguous[2].correlationKey, null);
  assert.equal(ambiguous[3].correlationKey, null);
  assert.equal(normalizeEvent(hook('hook/result', 9)).correlationKey, null);
});

test('precomputed native-ID indexes preserve hook ambiguity and avoid scanning the event history', () => {
  const hook = (type, seq, handlerId = 'reused', turn = 1) => event(type, seq, { turn, point: 'PreToolUse', handlerId });
  const tool = call(0, 'load', 'skill', { name: 'review' });
  const events = [tool, result(1, tool), hook('hook/result', 2),
    hook('hook/invoked', 3), hook('hook/result', 4),
    hook('hook/invoked', 5), hook('hook/invoked', 6), hook('hook/result', 7), hook('hook/result', 8),
    hook('hook/invoked', 9), hook('hook/result', 10),
    hook('hook/invoked', 11, 'reused', 2), hook('hook/result', 12, 'reused', 2),
    hook('hook/invoked', 13, 'left'), hook('hook/invoked', 14, 'right'), hook('hook/result', 15, 'right'), hook('hook/result', 16, 'left')];
  const indexed = createEventContext(events);
  assert.equal(indexed.eventsBySeq.get(0), tool);
  assert.deepEqual(indexed.calls.get('load'), [tool]);
  assert.equal(indexed.hookStartSeqBySeq.get(2), null);
  assert.equal(indexed.hookStartSeqBySeq.get(4), 3);
  assert.equal(indexed.hookStartSeqBySeq.get(7), null);
  assert.equal(indexed.hookStartSeqBySeq.get(8), null);
  assert.equal(indexed.hookStartSeqBySeq.get(10), 9);
  assert.equal(indexed.hookStartSeqBySeq.get(12), 11);
  assert.equal(indexed.hookStartSeqBySeq.get(15), 14);
  assert.equal(indexed.hookStartSeqBySeq.get(16), 13);
  assert.deepEqual(createEventContext([...events].reverse()).hookStartSeqBySeq, indexed.hookStartSeqBySeq);
  const expected = normalizeAll(events);
  // Any accidental fallback to a full-history map/filter throws deterministically.
  const noScan = new Proxy([], { get() { throw new Error('Event history was scanned'); } });
  const actual = events.map(value => normalizeEvent(value, { ...context, ...indexed, events: noScan }));
  assert.deepEqual(actual, expected);
});

test('hook decisions, PTC subcalls, approval and compaction retain native identities', () => {
  const blocked = normalizeEvent(event('hook/result', 1, { turn: 1, point: 'Stop', handlerId: 'x', decision: 'deny', exitCode: 0 }));
  assert.equal(blocked.outcome, 'blocked');
  const a = normalizeEvent(event('tool/ptc-dispatch-start', 2, { rootCallId: 'root', parentCallId: 'parent', subCallId: 'sub', name: 'read', arguments: { path: 'x' } }), context);
  const b = normalizeEvent(event('tool/ptc-dispatch', 3, { rootCallId: 'root', parentCallId: 'parent', subCallId: 'sub', name: 'read', arguments: { path: 'x' }, content: [], isError: true }), context);
  assert.equal(a.correlationKey, b.correlationKey);
  assert.equal(b.outcome, 'failure');
  assert.equal(normalizeEvent(event('approval/decided', 4, { id: 'ask-1', outcome: 'unavailable' })).outcome, 'blocked');
  assert.equal(normalizeEvent(event('compaction/end', 5, { compactionId: 'c', turn: null, error: 'failed' })).outcome, 'failure');
  const command = normalizeEvent(event('command/run', 6, { commandId: 'command-1', name: 'compact', source: { kind: 'user' } }), context);
  const done = normalizeEvent(event('command/done', 7, { commandId: 'command-1', kind: 'error', text: 'Unavailable' }), context);
  assert.equal(command.correlationKey, done.correlationKey);
  assert.equal(done.outcome, 'failure');
});

test('summary trusts real user sources and turn boundaries, never lack of a tool return as liveness', () => {
  const events = [event('user/message', 0, { id: 'plugin', role: 'user', content: [{ type: 'text', text: 'not the title' }], source: { kind: 'plugin', plugin: 'injector' } }),
    event('turn/start', 1, { turn: 1 }),
    event('user/message', 2, { id: 'human', role: 'user', content: [{ type: 'text', text: 'Actual user task' }], source: { kind: 'user' } }),
    call(3, 'unreturned', 'bash', { command: 'long task' })];
  assert.equal(summarizeSession(events).title, 'Actual user task');
  assert.equal(summarizeSession(events).status, 'observed-active');
  events.push(event('turn/end', 4, { turn: 1, reason: { kind: 'completed' } }));
  events.push(event('compaction/end', 5, { compactionId: 'later', turn: null }));
  assert.equal(summarizeSession(events).status, 'completed');
  events.push(event('session/title', 6, { title: 'Saved title', messageSeqs: [2], source: { kind: 'fallback' } }));
  assert.equal(summarizeSession(events).title, 'Saved title');
  assert.equal(summarizeSession([call(0, 'x', 'read', {})]).status, 'unknown');
  assert.equal(summarizeSession([event('turn/end', 0, { turn: 1, reason: { kind: 'interrupted' } })]).status, 'interrupted');
});

test('unknown event payloads are losslessly preserved and never gain inferred semantics', () => {
  for (const data of [{ skillName: 'fake', error: 'fake', callId: 'fake' }, null, ['custom'], 42]) {
    const raw = event('compaction/new-plugin-event', 0, data);
    const normalized = normalizeEvent(raw, context);
    assert.deepEqual(normalized.raw, raw);
    assert.equal(normalized.category, 'other');
    assert.equal(normalized.outcome, 'unknown');
    assert.equal(normalized.correlationKey, null);
    assert.equal(normalized.skillName, null);
  }
  assert.equal(normalizeEvent(event('turn/end', 0, { turn: 1, reason: { kind: '__proto__' } })).outcome, 'unknown');
  assert.equal(normalizeEvent(event('tool/call', 0, null)).toolName, null);
  assert.equal(summarizeSession([event('tool/call', 0, null)]).status, 'unknown');
  assert.throws(() => normalizeEvent(event('tool/call', -1, {})), /non-negative/);
});

test('indexes and session summaries preserve arbitrary JSON payloads without requiring objects', () => {
  const events = [null, ['custom'], 42, 'plugin payload', false].map((data, seq) => event('plugin/custom', seq, data));
  events.push(event('tool/call', events.length, null));
  events.push(event('hook/result', events.length, null));
  const indexed = createEventContext(events);
  const normalized = events.map(value => normalizeEvent(value, indexed));
  assert.equal(indexed.calls.size, 0);
  assert.equal(indexed.hookStartSeqBySeq.get(6), null);
  for (let i = 0; i < 5; i++) assert.deepEqual(normalized[i].raw.data, events[i].data);
  assert.deepEqual(summarizeSession(events), { title: 'Session 未命名', status: 'unknown', skills: [], errorCount: 0 });
  assert.deepEqual(summarizeSession(normalized), summarizeSession(events));
});

function verifyBatch(batch) {
  assert.equal(batch.source.kind, 'demo');
  for (const header of batch.sessions) {
    const records = batch.events.filter(item => item.sessionId === header.id).map(item => item.event);
    for (let index = 0; index < records.length; index += 1) {
      const value = records[index];
      assert.equal(value.seq, index);
      assert.ok(value.time >= header.createdAt);
      for (const seq of value.sourceEventSeqs ?? []) assert.ok(Number.isSafeInteger(seq) && seq >= 0 && seq < index && records[seq]);
      if (value.surfaceOp?.op === 'replace') {
        const sources = new Set(value.sourceEventSeqs);
        const replaced = records.filter(item => item.seq >= value.surfaceOp.startSeq && item.seq <= value.surfaceOp.endSeq && item.surfaceOp);
        for (const source of replaced) assert.ok(sources.has(source.seq));
      }
    }
    assert.doesNotThrow(() => normalizeAll(records));
  }
}

test('three-session demo has real payload shapes, parallel completion, child lineage and valid source seqs', () => {
  const batch = createDemoBatch(100_000);
  assert.equal(batch.sessions.length, 3);
  verifyBatch(batch);
  const parent = batch.sessions.find(session => !session.parentSession);
  assert.ok(batch.sessions.some(session => session.parentSession === parent.id && session.origin === 'subagent'));
  const records = batch.events.filter(item => item.sessionId === parent.id).map(item => item.event);
  const normalized = normalizeAll(records);
  assert.ok(normalized.some(value => value.toolName === 'mcp__docs__search'));
  assert.ok(normalized.some(value => value.type === 'compaction/end'));
  const partial = batch.events.filter(item => item.sessionId === 'demo-missing-return').map(item => item.event);
  assert.equal(summarizeSession(partial).status, 'observed-active');
  assert.equal(summarizeSession(partial).errorCount, 1);
  assert.ok(batch.events.every(item => item.historical === true));
});

test('live demo frames are finite, use their own demo source and finish with a turn boundary', () => {
  const frames = createLiveDemoFrames(100_000);
  assert.ok(frames.length > 5 && frames.length < 100);
  assert.ok(frames.at(-1).delayMs < 30_000);
  assert.ok(frames.every((frame, index) => frame.batch.source.kind === 'demo' && frame.batch.events.every(item => !item.historical)
    && (index === 0 || frame.delayMs > frames[index - 1].delayMs)));
  const batch = { source: frames[0].batch.source, sessions: frames.flatMap(frame => frame.batch.sessions), events: frames.flatMap(frame => frame.batch.events) };
  verifyBatch(batch);
  assert.equal(summarizeSession(batch.events.map(item => item.event)).status, 'completed');
});
