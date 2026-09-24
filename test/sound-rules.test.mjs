import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeEvent } from '../src/events.mjs';
import { matchSound } from '../public/sound-rules.js';

const raw = (type, data) => ({ type, seq: 0, time: 100, data });
const call = (name, args) => normalizeEvent(raw('tool/call', { turn: 1, step: 1, callId: 'call-1', name, arguments: args }));
const rule = (match, extra = {}) => ({ id: 'watch', enabled: true, match, sound: 'dissonance', volume: 0.4, ...extra });
const settings = (...rules) => ({ rules, categorySounds: { tool: 'wood', interaction: 'bell' } });
const keyword = settings(rule({ callContains: 'gstack' }));

test('exact names keep case-sensitive identity and distinguish tool names from skill names', () => {
  const exact = settings(rule({ skillName: 'review', type: 'tool/call' }));
  assert.equal(matchSound(call('skill', '{"name":"review"}'), exact).ruleId, 'watch');
  for (const event of [call('skill', { name: 'gstack-review' }), call('skill', { name: 'Review' }), call('review', {})]) {
    assert.equal(matchSound(event, exact).ruleId, null);
  }
  assert.equal(matchSound(call('review', {}), settings(rule({ toolName: 'review' }))).ruleId, 'watch');
});

test('name containment is case-insensitive, literal and limited to the selected field', () => {
  const contains = settings(rule({ toolName: { contains: 'gstack' } }));
  const match = matchSound(call('mcp__GSTACK__browse', {}), contains);
  assert.equal(match.sound, 'dissonance');
  assert.deepEqual(match.evidence, [{ field: 'toolName', operator: 'contains', expected: 'gstack', value: 'mcp__GSTACK__browse' }]);
  assert.equal(matchSound(call('skill', { name: 'gstack-review' }), contains).ruleId, null);
  assert.equal(matchSound(call('skill', { name: 'GSTACK-review' }), settings(rule({ skillName: { contains: 'gstack' } }))).ruleId, 'watch');
  assert.equal(matchSound(call('gstack-review', {}), settings(rule({ toolName: { contains: 'gstack.*' } }))).ruleId, null);
  assert.equal(matchSound(call('gstack.*', {}), settings(rule({ toolName: { contains: 'gstack.*' } }))).ruleId, 'watch');
});

test('keyword checks full invocation arguments, including paths, commands and JSON escapes', () => {
  const path = `/skills/${'long-prefix/'.repeat(40)}gstack/review/SKILL.md`;
  for (const args of [{ path }, JSON.stringify({ path }), '{"path":"/skills/\\u0067stack/review/SKILL.md"}', '{"path":"/skills/gstack/unfinished']) {
    const event = call('read', args);
    const match = matchSound(event, keyword);
    assert.equal(match.ruleId, 'watch');
    assert.equal(match.evidence[0].field, 'arguments');
    assert.match(match.evidence[0].value, /gstack/);
    assert.equal(event.skillName, null); // Reading instructions is not proof of activation.
  }
  assert.equal(call('read', { path }).summary.includes('gstack'), false);
  assert.equal(matchSound(call('bash', { command: '/skills/GSTACK/bin/browse snapshot' }), keyword).ruleId, 'watch');
  assert.equal(matchSound(call('read', { path: '/skills/build/SKILL.md' }), keyword).ruleId, null);
});

test('keyword catches native tool, skill and nested calls and explicit skill injection', () => {
  for (const event of [call('mcp__gstack__browse', {}), call('skill', { name: 'gstack:review' }),
    normalizeEvent(raw('tool/ptc-dispatch-start', { name: 'bash', arguments: { command: '/gstack/bin/browse' } })),
    normalizeEvent(raw('user/message', { content: [], source: { kind: 'skill-invocation', name: 'gstack-review' } }))]) {
    assert.equal(matchSound(event, keyword).ruleId, 'watch');
  }
});

test('mentions in conversation, returned content, unknown events and approvals are not invocation keywords', () => {
  const events = [
    normalizeEvent(raw('user/message', { content: [{ type: 'text', text: 'Do not use gstack' }], source: { kind: 'user' } })),
    normalizeEvent(raw('assistant/message', { message: { content: [{ type: 'text', text: 'gstack' }] } })),
    normalizeEvent(raw('hook/invoked', { point: 'PreToolUse', handlerId: 'gstack' })),
    normalizeEvent(raw('plugin/custom', { name: 'gstack', arguments: { path: '/gstack' } })),
    normalizeEvent(raw('approval/asked', { toolName: 'gstack', id: 'pending' })),
    normalizeEvent(raw('tool/ptc-dispatch', { name: 'gstack', arguments: {}, content: [{ type: 'text', text: 'gstack' }] })),
    { ...call('gstack', { name: 'gstack-review' }), type: 'tool/result', phase: 'end' },
  ];
  for (const event of events) assert.equal(matchSound(event, keyword).ruleId, null, event.type);
});

test('conditions combine with AND; ordered, disabled and mute rules preserve existing behavior', () => {
  const event = call('gstack-review', {});
  assert.equal(matchSound(event, settings(rule({ toolName: { contains: 'gstack' }, outcome: 'failure' }))).ruleId, null);
  const ordered = settings(rule({ toolName: 'gstack-review' }, { id: 'ignored', enabled: false }),
    rule({ toolName: { contains: 'gstack' } }, { id: 'quiet', sound: 'mute' }), rule({ callContains: 'gstack' }));
  assert.equal(matchSound(event, ordered).ruleId, 'quiet');
  assert.equal(matchSound(event, ordered).sound, 'mute');
  assert.equal(matchSound(event, settings(rule({ callContains: '   ' }))).ruleId, null);
  assert.equal(matchSound(event, settings(rule({ toolName: { contains: '' } }))).ruleId, null);
  assert.equal(matchSound(event, settings(rule({ unknownField: 'gstack' }))).ruleId, null);
});
