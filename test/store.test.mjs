import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, sessionKey, redact, validateSettings, DEFAULT_SETTINGS } from '../src/store.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-store-'));
  const store = new Store(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, dir };
}
const source = { instanceId: 'local-one', kind: 'live', version: '0.1.6-alpha.2' };
function batch(events, sessions = [{ id: 'one', version: 3, createdAt: 100 }]) {
  return { source, sessions, events: events.map(event => ({ sessionId: 'one', event })) };
}
const start = { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } };

test('retry deduplicates, conflicts preserve first evidence and record a gap', t => {
  const { store } = fixture(t);
  assert.equal(store.ingest(batch([start])).accepted, 1);
  assert.equal(store.ingest(batch([{ data: { turn: 1 }, time: 100, seq: 0, type: 'turn/start' }])).duplicates, 1);
  const conflict = store.ingest(batch([{ ...start, data: { turn: 2 } }]));
  assert.equal(conflict.issues[0].reason, 'sequence-conflict');
  assert.equal(store.getEvents(sessionKey(source.instanceId, 'one'))[0].raw.data.turn, 1);
  assert.equal(store.getSessions()[0].gaps[0].reason, 'sequence-conflict');
});

test('same native session ID in different installations remains separate', t => {
  const { store } = fixture(t);
  store.ingest(batch([start]));
  store.ingest({ ...batch([start]), source: { ...source, instanceId: 'local-two' } });
  assert.equal(store.getSessions().length, 2);
  assert.notEqual(store.getSessions()[0].key, store.getSessions()[1].key);
});

test('invalid batches are atomic, and missing seq coverage heals after backfill', t => {
  const { store } = fixture(t);
  assert.throws(() => store.ingest(batch([start, { ...start, seq: -1 }])), /seq/);
  assert.deepEqual(store.counts(), { sessions: 0, events: 0 });
  store.ingest(batch([{ ...start, seq: 2 }]));
  assert.equal(store.getSessions()[0].gaps[0].count, 2);
  store.ingest(batch([start, { type: 'step/start', seq: 1, time: 110, data: { turn: 1, step: 1 } }]));
  assert.equal(store.getSessions()[0].gaps.length, 0);
});

test('unknown required event stays visible without reconstructing agent state', t => {
  const { store } = fixture(t);
  store.ingest(batch([{ type: 'my-plugin/custom', seq: 0, time: 100, data: { value: 'preserved' } }]));
  const e = store.getEvents(sessionKey(source.instanceId, 'one'))[0];
  assert.equal(e.category, 'other');
  assert.equal(e.raw.data.value, 'preserved');
  assert.ok(store.getTypes().includes('my-plugin/custom'));
});

test('plugin JSON scalar and array payloads do not reject adjacent events', t => {
  const { store } = fixture(t);
  const pluginEvents = [null, 42, ['extension', 'value']].map((data, seq) => ({ type: 'plugin/raw', seq, time: 100 + seq, data }));
  assert.equal(store.ingest(batch(pluginEvents)).accepted, 3);
  assert.deepEqual(store.exportSession(sessionKey(source.instanceId, 'one')).events.map(e => e.data), [null, 42, ['extension', 'value']]);
  assert.equal(store.getSessions()[0].eventCount, 3);
});

test('CLI writes through a second connection invalidate server event and export caches', t => {
  const { store, dir } = fixture(t);
  store.ingest(batch([start]));
  const key = sessionKey(source.instanceId, 'one');
  assert.equal(store.getEvents(key).length, 1);
  const writer = new Store(dir);
  try { writer.ingest(batch([{ type: 'turn/end', seq: 1, time: 200, data: { turn: 1, reason: { kind: 'completed' } } }])); }
  finally { writer.close(); }
  assert.equal(store.getEvents(key).length, 2);
  assert.equal(store.exportSession(key).events.length, 2);
  assert.equal(store.getSessions()[0].status, 'completed');
});

test('credential fields are redacted before persistence and exports', t => {
  const { store } = fixture(t);
  store.ingest(batch([{ ...start, data: { turn: 1, apiKey: 'secret', headers: { Authorization: 'Bearer hidden' }, arguments: '{"password":"private","path":"a.txt"}' } }]));
  const record = store.exportSession(sessionKey(source.instanceId, 'one'));
  const data = record.events[0].data;
  assert.equal(data.apiKey, '[REDACTED]');
  assert.equal(data.headers.Authorization, '[REDACTED]');
  assert.equal(JSON.parse(data.arguments).password, '[REDACTED]');
  assert.equal(JSON.parse(data.arguments).path, 'a.txt');
  assert.equal(redact({ usage: { outputTokens: 12 } }).usage.outputTokens, 12);
});

test('settings reject invalid assets, volume and duplicate rules, and persist order', t => {
  const { store } = fixture(t);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.rules = [{ id: 'first', enabled: true, match: { type: 'tool/call' }, sound: 'mute' }, { id: 'second', enabled: true, match: { category: 'tool' }, sound: 'wood' }];
  store.saveSettings(settings);
  assert.deepEqual(store.getSettings(), settings);
  assert.throws(() => validateSettings({ ...settings, audio: { enabled: true, volume: 2 } }), /音量/);
  assert.throws(() => validateSettings({ ...settings, rules: [settings.rules[0], settings.rules[0]] }), /唯一/);
  assert.throws(() => validateSettings({ ...settings, rules: [{ ...settings.rules[0], sound: 'asset:missing' }] }), /音色/);
});

test('journal and settings survive process store reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'symphony-reopen-'));
  let store = new Store(dir);
  try {
    store.ingest(batch([start]));
    store.saveSettings({ ...structuredClone(DEFAULT_SETTINGS), audio: { enabled: true, volume: 0.6 } });
    store.close();
    store = new Store(dir);
    assert.equal(store.counts().events, 1);
    assert.equal(store.getSettings().audio.volume, 0.6);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
