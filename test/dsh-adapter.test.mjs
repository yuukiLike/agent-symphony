import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createCollector, Config } from '../adapters/dsh.mjs';

async function until(predicate, label, timeout = 2500) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < end, label);
    await delay(10);
  }
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'symphony-collector-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'test-only-token', { mode: 0o600 });
  const received = [];
  const warnings = [];
  let status = 200;
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-only-token');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    received.push({ status, bytes: bytes.length, body: JSON.parse(bytes) });
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: 1, duplicates: 0, issues: [] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = {
    endpoint: `http://127.0.0.1:${server.address().port}/api/ingest`, tokenFile,
    instanceId: 'test-installation', flushIntervalMs: 10, heartbeatMs: 50,
    retryDelayMs: 10, requestTimeoutMs: 100, maxRetries: 1, ...options,
  };
  const collector = createCollector(config, { warn: message => warnings.push(message) });
  t.after(async () => {
    collector.dispose();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  return { collector, received, warnings, config, setStatus: value => { status = value; } };
}

const header = Object.freeze({ id: 's1', version: 3, createdAt: 1, cwd: '/test', isSeeded: false });
const event = seq => Object.freeze({ type: 'turn/start', seq, time: 1, data: Object.freeze({ turn: seq + 1 }) });

test('only explicit loopback collectors receive the token', () => {
  for (const endpoint of ['https://remote.test/api/ingest', 'http://127.0.0.1:4317/else', 'http://u:p@localhost/api/ingest']) {
    assert.ok(Config['~standard'].validate({ endpoint, tokenFile: '/tmp/token', instanceId: 'test' }).issues);
  }
});

test('preserves raw identity and historical marking without mutating input', async t => {
  const { collector, received } = await fixture(t);
  collector.enqueue(header, event(0), true);
  collector.enqueue(header, event(1), false);
  await until(() => received.some(r => r.body.events.length === 2), 'two events delivered');
  const batch = received.find(r => r.body.events.length === 2).body;
  assert.equal(batch.source.instanceId, 'test-installation');
  assert.equal(batch.source.kind, 'live');
  assert.deepEqual(batch.events.map(e => e.historical), [true, false]);
  assert.deepEqual(batch.events.map(e => e.event), [event(0), event(1)]);
  assert.deepEqual(batch.sessions, [header]);
});

test('bounded queue and oversized events produce explicit gap notices', async t => {
  const { collector, received } = await fixture(t, { maxQueueEvents: 2, batchSize: 2, maxEventBytes: 256 });
  collector.enqueue(header, { ...event(0), data: { text: 'x'.repeat(500) } });
  collector.enqueue(header, event(1));
  assert.equal(collector.enqueue(header, event(2)), false);
  assert.equal(collector.stats().queued, 2);
  await until(() => received.some(r => r.body.gaps.length === 2), 'losses delivered');
  const notices = received.flatMap(r => r.body.gaps);
  assert.ok(notices.some(g => g.reason === 'queue-overflow' && g.count === 1));
  assert.ok(notices.some(g => g.reason === 'event-too-large' && g.count === 1));
  assert.equal(collector.stats().dropped, 2);
});

test('event retries are bounded; recovered transport reports loss and accepts new events', async t => {
  const { collector, received, setStatus, warnings } = await fixture(t);
  setStatus(503);
  collector.enqueue(header, event(0));
  await until(() => collector.stats().dropped === 1, 'retry exhausted');
  assert.equal(received.filter(r => r.body.events.some(e => e.event.seq === 0)).length, 2);
  setStatus(200);
  collector.enqueue(header, event(1));
  await until(() => received.some(r => r.status === 200 && r.body.events.some(e => e.event.seq === 1)), 'new event after outage');
  await until(() => received.some(r => r.status === 200 && r.body.gaps.some(g => g.reason === 'retry-exhausted')), 'gap after outage');
  assert.ok(warnings.length);
});

test('batch byte limit includes session metadata and gap notices', async t => {
  const { collector, received } = await fixture(t, { maxEventBytes: 256, maxBatchBytes: 8448 });
  for (let index = 0; index < 12; index++) {
    const session = { ...header, id: `session-${index}`, cwd: `/${'long-path/'.repeat(140)}` };
    collector.enqueue(session, event(0));
    collector.gap(session, 'history-missing', 1);
  }
  await until(() => received.flatMap(r => r.body.events).length === 12
    && received.flatMap(r => r.body.gaps).length === 12, 'all metadata and gaps delivered');
  assert.ok(received.every(r => r.bytes <= 8448), 'entire HTTP body stays below the configured cap');
  assert.ok(received.length > 1);
});

test('unload stops heartbeats and rejects subsequent enqueue', async t => {
  const { collector, received, warnings } = await fixture(t);
  collector.enqueue(header, event(0));
  collector.dispose();
  assert.equal(collector.enqueue(header, event(1)), false);
  await delay(100);
  assert.equal(received.length, 0);
  assert.ok(warnings.some(w => w.includes('1 undelivered')));
});
