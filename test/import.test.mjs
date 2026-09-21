import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import { parseImport } from '../src/import.mjs';

const header = { type: 'session', version: 3, id: 'native-session', createdAt: 100, isSeeded: false, delegationDepth: 0, cwd: '/project' };
const events = [{ type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } }, { type: 'turn/end', seq: 1, time: 200, data: { turn: 1, reason: { kind: 'completed' } } }];
const text = [header, ...events].map(v => JSON.stringify(v)).join('\n') + '\n';

test('official codec restores plain and concatenated zstd v3 logs without changing input', () => {
  const plain = parseImport(Buffer.from(text), 'session.v3.jsonl');
  const compressed = Buffer.concat([zstdCompressSync(Buffer.from(JSON.stringify(header) + '\n')), zstdCompressSync(Buffer.from(events.map(v => JSON.stringify(v)).join('\n') + '\n'))]);
  const restored = parseImport(compressed, 'session.v3.jsonl.zstd');
  assert.deepEqual(restored.events, plain.events);
  assert.equal(restored.source.kind, 'import');
  assert.ok(restored.events.every(e => e.historical));
  assert.equal(restored.sessions[0].id, 'native-session');
});

test('corrupt, future and incomplete compressed files are rejected', () => {
  assert.throws(() => parseImport(Buffer.from(text.replace('"version":3', '"version":9'))), /v3/);
  assert.throws(() => parseImport(Buffer.from(text + '{broken}\n')), /第 4 行/);
  const compressed = zstdCompressSync(Buffer.from(text));
  assert.throws(() => parseImport(compressed.subarray(0, compressed.length - 5)), /Zstandard/);
});

test('Symphony exports import as history and retain sequence and source identity', () => {
  const batch = parseImport({ format: 'agent-symphony', version: 1, source: { instanceId: 'source-a', kind: 'live' }, session: header, events, gaps: [] });
  assert.equal(batch.source.instanceId, 'import:source-a');
  assert.equal(batch.events[1].event.seq, 1);
  assert.equal(batch.events[0].historical, true);
});
