import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';

// These are real published host packages, isolated from the user's dsh home and credentials.
const runtime = resolve(process.env.SYMPHONY_DSH_RUNTIME || '/tmp/agent-symphony-dsh-runtime');
const requireRuntime = createRequire(join(runtime, 'package.json'));
const load = packageName => import(pathToFileURL(requireRuntime.resolve(packageName)).href);
let Context, SessionStore, Query, Loader, dshRequire;
try {
  ({ Context } = await load('@deepseek-ai/cordis'));
  ({ default: SessionStore } = await load('@deepseek-ai/dsh-session'));
  ({ default: Query } = await load('@deepseek-ai/dsh-session-query-sqlite'));
  dshRequire = createRequire(requireRuntime.resolve('@deepseek-ai/dsh/package.json'));
  ({ default: Loader } = await import(pathToFileURL(dshRequire.resolve('@deepseek-ai/cordis-plugin-loader')).href));
} catch (error) {
  console.error(`Published dsh test runtime unavailable at ${runtime}. See docs/dsh-setup.md. ${error.code || error.message}`);
  process.exitCode = 1;
}

if (Context) {
  const directory = await mkdtemp(join(tmpdir(), 'symphony-real-dsh-'));
  const tokenFile = join(directory, 'token');
  await writeFile(tokenFile, 'isolated-integration-token', { mode: 0o600 });
  const received = [];
  let transportStatus = 200;
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/api/ingest');
    assert.equal(req.headers.authorization, 'Bearer isolated-integration-token');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ status: transportStatus, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(transportStatus, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ accepted: 1, duplicates: 0, issues: [] }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const ctx = new Context();
  async function until(predicate, label) {
    const end = Date.now() + 5000;
    while (!predicate()) {
      assert.ok(Date.now() < end, label);
      await delay(10);
    }
  }
  const successfulEvents = () => received.filter(r => r.status === 200).flatMap(r => r.body.events);
  try {
    await ctx.plugin(SessionStore);
    await ctx.plugin(Query, { path: ':memory:', openAt: 'never' });
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(`${directory}/`).href });
    const early = ctx.sessions.create('already-active', { meta: { cwd: directory } });
    const oldStart = early.append('turn/start', { turn: 1 });
    const oldEnd = early.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
    const adapterPath = fileURLToPath(new URL('../adapters/dsh.mjs', import.meta.url));
    const pluginId = await ctx.loader.create({
      name: pathToFileURL(adapterPath).href,
      config: {
        endpoint: `http://127.0.0.1:${server.address().port}/api/ingest`, tokenFile,
        instanceId: 'isolated-real-dsh', flushIntervalMs: 10, heartbeatMs: 50,
        discoveryIntervalMs: 20, retryDelayMs: 10, requestTimeoutMs: 100,
        maxRetries: 1, maxQueueEvents: 20, batchSize: 10,
      },
    });
    await ctx.loader.await();
    await until(() => successfulEvents().filter(e => e.sessionId === early.id && e.historical).length === 2, 'active-session backfill');
    assert.deepEqual(successfulEvents().filter(e => e.sessionId === early.id).map(e => e.event), [oldStart, oldEnd]);
    assert.equal(ctx.sessions.get(early.id), early, 'backfill must retain the same live session');
    assert.equal(early.seq, 2, 'backfill must not append to the host');

    const live = ctx.sessions.create('live-now', { meta: { cwd: directory, parentSession: early.id } });
    const expected = [live.append('turn/start', { turn: 1 })];
    expected.push(live.append('hook/invoked', { turn: 1, point: 'PreToolUse', dialect: 'codex', handlerId: 'codex:PreToolUse:1' }));
    expected.push(live.append('hook/result', { turn: 1, point: 'PreToolUse', handlerId: 'codex:PreToolUse:1', decision: 'pass', exitCode: 1, durationMs: 7 }));
    expected.push(live.append('turn/end', { turn: 1, reason: { kind: 'completed' } }));
    await until(() => successfulEvents().filter(e => e.sessionId === live.id).length === expected.length, 'live host append feed');
    assert.deepEqual(successfulEvents().filter(e => e.sessionId === live.id).map(e => e.event), expected);
    assert.ok(successfulEvents().filter(e => e.sessionId === live.id).every(e => e.historical === false));
    assert.ok(received.flatMap(r => r.body.sessions).some(s => s.id === live.id && s.parentSession === early.id));

    transportStatus = 503;
    const committed = live.append('turn/start', { turn: 2 });
    assert.equal(committed.seq, 4, 'append commits synchronously while collector fails');
    assert.equal(live.seq, 5);
    await until(() => received.filter(r => r.status === 503 && r.body.events.some(e => e.sessionId === live.id && e.event.seq === 4)).length === 2, 'bounded retry attempts');
    await delay(40);
    transportStatus = 200;
    live.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
    await until(() => received.some(r => r.status === 200 && r.body.gaps.some(g => g.sessionId === live.id && g.reason === 'retry-exhausted')), 'outage gap visible after recovery');
    await until(() => successfulEvents().some(e => e.sessionId === live.id && e.event.seq === 5), 'live feed recovers');

    await ctx.loader.remove(pluginId);
    const afterUnload = received.length;
    live.append('turn/start', { turn: 3 });
    live.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    await delay(120);
    assert.equal(received.length, afterUnload, 'unloaded plugin must not send events or heartbeat');

    // A genuine agent-loop turn: only the provider response is scripted.
    // Agent creation, inbox, assembly, stream, tool dispatch and events are the published runtime.
    const loadHost = packageName => import(pathToFileURL(dshRequire.resolve(packageName)).href);
    const { default: Llm, LlmAdapter } = await loadHost('@deepseek-ai/dsh-llm');
    for (const packageName of ['@deepseek-ai/dsh-system-prompt', '@deepseek-ai/dsh-tools',
      '@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session-projection']) {
      const { default: Plugin } = await loadHost(packageName);
      await ctx.plugin(Plugin, {});
    }
    await ctx.plugin(Llm);
    const { default: AgentLoop } = await loadHost('@deepseek-ai/dsh-agent-loop');
    await ctx.plugin(AgentLoop, { agents: [] });
    let providerCalls = 0;
    let toolCalls = 0;
    class ScriptedProvider extends LlmAdapter {
      async *stream(options) {
        assert.equal(options.signal?.aborted ?? false, false);
        providerCalls++;
        assert.ok(providerCalls <= 2, 'agent must terminate after the scripted response');
        if (providerCalls === 1) {
          yield { type: 'block-start', index: 0, blockType: 'tool-call' };
          yield { type: 'tool-call-delta', index: 0, id: 'local-probe-call', name: 'symphony_probe', argumentsDelta: '{}' };
          yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'local-probe-call', name: 'symphony_probe', arguments: '{}' } };
          yield { type: 'finish', reason: { kind: 'tool-calls' } };
        } else {
          yield { type: 'block-start', index: 0, blockType: 'text' };
          yield { type: 'text-delta', index: 0, text: 'Probe completed.' };
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Probe completed.' } };
          yield { type: 'finish', reason: { kind: 'stop' } };
        }
      }
    }
    ctx.llm.registerAdapter(['symphony-test'], new ScriptedProvider());
    ctx.tools.register({
      name: 'symphony_probe', description: 'Return a local deterministic test result.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { toolCalls++; return 'probe-ok'; },
    });
    const { default: Subprocess } = await loadHost('@deepseek-ai/dsh-subprocess-local');
    const { default: Bash } = await loadHost('@deepseek-ai/dsh-bash-local');
    const Hooks = await loadHost('@deepseek-ai/dsh-hooks-codex');
    await ctx.plugin(Subprocess, {});
    await ctx.plugin(Bash, { cwd: directory });
    const hookConfig = join(directory, 'test-hooks.json');
    await writeFile(hookConfig, JSON.stringify({ hooks: { PreToolUse: [
      { matcher: 'symphony_probe', hooks: [{ type: 'command', command: "printf '{}'" }] },
    ] } }));
    await ctx.plugin(Hooks, { configPath: hookConfig });
    const { startServer } = await import('../src/server.mjs');
    const symphony = await startServer({ port: 0, dataDir: join(directory, 'symphony') });
    let agentHandle;
    try {
      await ctx.loader.create({ name: pathToFileURL(adapterPath).href, config: {
        endpoint: `${symphony.url}/api/ingest`, tokenFile: symphony.tokenFile,
        instanceId: 'real-agent-loop', label: 'dsh 实测 · 本地 scripted provider', flushIntervalMs: 10, backfill: false,
      } });
      await ctx.loader.await();
      agentHandle = await ctx.agents.create({ sessionId: 'actual-agent-turn',
        agentOptions: { provider: 'symphony-test', model: 'scripted-local', cwd: directory } });
      agentHandle.agent.followup({ content: [{ type: 'text', text: 'Run the local probe.' }], source: { kind: 'user' } });
      await agentHandle.agent.whenIdle();
      assert.equal(providerCalls, 2, 'real agent must request the model again after executing the tool');
      assert.equal(toolCalls, 1, 'real tool pipeline must execute the tool once');
      await until(() => {
        const session = symphony.store.getSessions().find(s => s.id === 'actual-agent-turn');
        return session && symphony.store.getEvents(session.key).some(e => e.type === 'turn/end');
      }, 'actual turn delivered to project server');
      const session = symphony.store.getSessions().find(s => s.id === 'actual-agent-turn');
      const recorded = symphony.store.getEvents(session.key);
      const types = recorded.map(e => e.type);
      for (const type of ['turn/start', 'request/header', 'assistant/message', 'tool/call', 'tool/result', 'hook/invoked', 'hook/result', 'turn/end']) {
        assert.ok(types.includes(type), `actual agent generated ${type}`);
      }
      assert.deepEqual(recorded.find(e => e.type === 'turn/end').raw.data.reason, { kind: 'completed' });
      const hookResult = recorded.find(e => e.type === 'hook/result');
      assert.equal(hookResult.raw.data.exitCode, 0, 'the real bridge must run the local hook command');
      if (process.env.SYMPHONY_DSH_EVIDENCE) {
        await writeFile(resolve(process.env.SYMPHONY_DSH_EVIDENCE), JSON.stringify(symphony.store.exportSession(session.key), null, 2), { mode: 0o600 });
      }
      console.log(JSON.stringify({ actualAgentTurn: 'PASS', provider: 'local scripted LlmAdapter',
        toolCalls, providerCalls, recordedEvents: recorded.length, types: [...new Set(types)],
        collector: 'project src/server.mjs /api/ingest', terminalReason: { kind: 'completed' } }, null, 2));
    } finally {
      await agentHandle?.dispose();
      await symphony.close();
    }
    const sessionPackage = JSON.parse(await readFile(requireRuntime.resolve('@deepseek-ai/dsh-session/package.json'), 'utf8'));
    assert.equal(sessionPackage.version, '0.1.6-alpha.2', 'integration version must match the evidence baseline');
    console.log(JSON.stringify({
      result: 'PASS', dshSessionVersion: sessionPackage.version, cordisLoader: 'real published package',
      checks: ['ESM plugin load through Cordis Loader', 'existing live session read-only backfill',
        'post-commit raw session events', 'hook audit payload pass-through', 'session lineage',
        'bounded outage retry and gap reporting', 'append continues during outage', 'unload removes listener and timers'],
      limitation: 'A local scripted provider drove the real agent loop, tool and Codex bridge hook command; no external model, production profile or private session was run.',
    }, null, 2));
  } finally {
    await ctx.fiber.dispose();
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    await rm(directory, { recursive: true, force: true });
  }
}
