import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startServer } from '../src/server.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'symphony-http-'));
  const app = await startServer({ port: 0, dataDir: dir });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  return { ...app, token: (await readFile(app.tokenFile, 'utf8')).trim() };
}
const batch = { source: { instanceId: 'test-dsh', kind: 'live' }, sessions: [{ id: 'a', version: 3, createdAt: 100 }], events: [{ sessionId: 'a', event: { type: 'turn/start', seq: 0, time: 100, data: { turn: 1 } } }] };

test('HTTP auth and same-origin write restrictions protect local ingest/settings', async t => {
  const app = await fixture(t);
  const denied = await fetch(`${app.url}/api/ingest`, { method: 'POST', body: JSON.stringify(batch) });
  assert.equal(denied.status, 401);
  const accepted = await fetch(`${app.url}/api/ingest`, { method: 'POST', headers: { Authorization: `Bearer ${app.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(batch) });
  assert.equal((await accepted.json()).accepted, 1);
  const crossSite = await fetch(`${app.url}/api/demo`, { method: 'POST', headers: { 'X-Symphony-Local': '1', Origin: 'https://unrelated.example' } });
  assert.equal(crossSite.status, 403);
  const noHeader = await fetch(`${app.url}/api/demo`, { method: 'POST' });
  assert.equal(noHeader.status, 403);
  const status = await (await fetch(`${app.url}/api/status`)).json();
  assert.equal(status.collector.connected, true);
  assert.equal(JSON.stringify(status).includes(app.token), false);
});

test('events paginate, export, replay-import silently, and missing session is 404', async t => {
  const app = await fixture(t);
  app.ingest({ ...batch, events: [...batch.events, { sessionId: 'a', event: { type: 'turn/end', seq: 1, time: 200, data: { turn: 1, reason: { kind: 'completed' } } } }] });
  const { sessions } = await (await fetch(`${app.url}/api/sessions`)).json();
  const url = `${app.url}/api/sessions/${sessions[0].key}`;
  const first = await (await fetch(`${url}/events?limit=1`)).json();
  assert.equal(first.hasMore, true);
  const second = await (await fetch(`${url}/events?after=${first.nextAfter}&limit=1`)).json();
  assert.equal(second.events[0].seq, 1);
  assert.equal(second.hasMore, false);
  const record = await (await fetch(`${url}/export`)).json();
  const result = await fetch(`${app.url}/api/import`, { method: 'POST', headers: { 'X-Symphony-Local': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(record) });
  assert.equal(result.status, 200);
  const imported = app.store.getSessions().find(s => s.sourceKind === 'import');
  assert.ok(app.store.getEvents(imported.key).every(e => e.historical));
  assert.equal((await fetch(`${app.url}/api/sessions/${'0'.repeat(32)}/events`)).status, 404);
});

test('demo is idempotent and custom audio round-trips with strict MIME', async t => {
  const app = await fixture(t);
  const post = path => fetch(`${app.url}${path}`, { method: 'POST', headers: { 'X-Symphony-Local': '1' } });
  const first = await (await post('/api/demo')).json();
  assert.ok(first.accepted > 0);
  const second = await (await post('/api/demo')).json();
  assert.equal(second.accepted, 0);
  assert.ok(app.store.getSessions().every(s => s.sourceKind === 'demo'));
  const bytes = Buffer.from('RIFFtest-audio');
  const uploaded = await fetch(`${app.url}/api/sounds`, { method: 'POST', headers: { 'X-Symphony-Local': '1', 'Content-Type': 'audio/wav', 'X-Filename': encodeURIComponent('小木音.wav') }, body: bytes });
  assert.equal(uploaded.status, 201);
  const sound = await uploaded.json();
  assert.equal(sound.name, '小木音.wav');
  assert.deepEqual(Buffer.from(await (await fetch(`${app.url}${sound.url}`)).arrayBuffer()), bytes);
  const invalid = await fetch(`${app.url}/api/sounds`, { method: 'POST', headers: { 'X-Symphony-Local': '1', 'Content-Type': 'text/html' }, body: '<script>bad</script>' });
  assert.equal(invalid.status, 400);
});

test('SSE only broadcasts newly accepted events and streams no historical replay as live', async t => {
  const app = await fixture(t);
  const abort = new AbortController();
  const response = await fetch(`${app.url}/api/stream`, { signal: abort.signal });
  const reader = response.body.getReader();
  await reader.read(); // Initial status frame.
  app.ingest({ ...batch, events: batch.events.map(e => ({ ...e, historical: true })) });
  const chunk = new TextDecoder().decode((await reader.read()).value);
  assert.match(chunk, /event: update/);
  assert.match(chunk, /"historical":true/);
  abort.abort();
  await reader.cancel().catch(() => {});
});
