import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

export const name = 'agent-symphony-observer';
export const inject = ['sessions'];

const defaults = {
  label: 'dsh', version: '0.1.6-alpha.2', flushIntervalMs: 100,
  heartbeatMs: 5000, discoveryIntervalMs: 1000, maxQueueEvents: 2000,
  batchSize: 100, maxEventBytes: 131072, maxBatchBytes: 524288,
  maxRetries: 3, requestTimeoutMs: 1000, retryDelayMs: 250,
  backfill: true, maxBackfillEvents: 1000, backfillWaitMs: 5000,
};

function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected observer config');
  const config = { ...defaults, ...input };
  const url = new URL(config.endpoint);
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== '/api/ingest') {
    throw new Error('endpoint must be a local http://127.0.0.1:PORT/api/ingest URL');
  }
  if (typeof config.tokenFile !== 'string' || !isAbsolute(config.tokenFile)) throw new Error('tokenFile must be an absolute path');
  if (typeof config.instanceId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(config.instanceId)) {
    throw new Error('instanceId must be a stable identifier (1–128 letters, digits, dot, dash or underscore)');
  }
  for (const [key, value] of Object.entries(defaults)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(config[key]) || config[key] < (key === 'maxRetries' ? 0 : 1))) {
      throw new Error(`${key} must be a ${key === 'maxRetries' ? 'non-negative' : 'positive'} integer`);
    }
  }
  if (config.batchSize > config.maxQueueEvents) throw new Error('batchSize must not exceed maxQueueEvents');
  if (config.maxBatchBytes < config.maxEventBytes + 8192) throw new Error('maxBatchBytes must allow maxEventBytes plus 8192 bytes');
  if (typeof config.backfill !== 'boolean') throw new Error('backfill must be boolean');
  for (const key of ['label', 'version']) {
    if (typeof config[key] !== 'string' || config[key].length > 200) throw new Error(`${key} must be a short string`);
  }
  return config;
}

// Cordis accepts Standard Schema directly; no plugin-local dependency install is required.
export const Config = {
  '~standard': {
    version: 1, vendor: 'agent-symphony',
    validate(input) {
      try { return { value: validateConfig(input) }; }
      catch (error) { return { issues: [{ message: error.message }] }; }
    },
  },
};

/** Bounded, non-blocking transport. All JSON work, file I/O and HTTP happen on a timer. */
export function createCollector(input, { warn = () => {} } = {}) {
  const config = validateConfig(input);
  const source = { instanceId: config.instanceId, version: config.version, label: config.label, kind: 'live' };
  const queue = [];
  const gaps = new Map();
  let pending = null;
  let closed = false;
  let running = false;
  let abort = null;
  let lastSent = 0;
  let retryAt = 0;
  let dropped = 0;
  let unreportedGaps = 0;
  let lastWarning = 0;

  function warning(message) {
    try { warn(message); } catch { /* A diagnostic must not enter the agent's error path. */ }
  }

  function gap(header, reason, count = 1) {
    if (closed || count < 1) return;
    const key = `${header.id}\0${reason}`;
    const existing = gaps.get(key);
    if (existing) existing.count += count;
    else if (gaps.size < 256) gaps.set(key, { sessionId: header.id, reason, count, at: Date.now(), header });
    else unreportedGaps += count;
  }

  function enqueue(header, event = null, historical = false) {
    if (closed) return false;
    if (queue.length >= config.maxQueueEvents) {
      if (event) { dropped++; gap(header, 'queue-overflow'); }
      return false;
    }
    // Session core supplies immutable, detached event/header values. Do not mutate or clone on append.
    queue.push({ header, event, historical });
    return true;
  }

  function prepareBatch() {
    const sessions = new Map();
    const events = [];
    const sessionJSON = [];
    const eventJSON = [];
    const gapJSON = [];
    const notices = [];
    let bytes = Buffer.byteLength(JSON.stringify({ source, sessions: [], events: [], gaps: [] }));
    let examined = 0;
    function headerPart(header) {
      return sessions.has(header.id) ? '' : JSON.stringify(header);
    }
    function headerBytes(encoded) {
      return encoded ? Buffer.byteLength(encoded) + (sessions.size ? 1 : 0) : 0;
    }
    function addHeader(header, encoded) {
      if (!encoded) return;
      sessions.set(header.id, header);
      sessionJSON.push(encoded);
    }
    while (queue.length && examined++ < config.batchSize) {
      const item = queue[0];
      let encoded, encodedHeader;
      try {
        encoded = item.event ? JSON.stringify({ sessionId: item.header.id, event: item.event, historical: item.historical }) : '';
        encodedHeader = headerPart(item.header);
      }
      catch {
        queue.shift();
        if (item.event) { dropped++; gap(item.header, 'unserializable-event'); }
        continue;
      }
      const size = Buffer.byteLength(encoded);
      if (size > config.maxEventBytes) {
        queue.shift();
        if (item.event) { dropped++; gap(item.header, 'event-too-large'); }
        continue;
      }
      const added = size + (encoded && events.length ? 1 : 0) + headerBytes(encodedHeader);
      if (bytes + added > config.maxBatchBytes) {
        if (sessions.size) break;
        queue.shift();
        if (item.event) dropped++;
        warning(`Session metadata exceeds batch capacity; ${item.event ? 'one event' : 'metadata'} was not delivered.`);
        continue;
      }
      queue.shift();
      bytes += added;
      addHeader(item.header, encodedHeader);
      if (item.event) {
        events.push({ sessionId: item.header.id, event: item.event, historical: item.historical });
        eventJSON.push(encoded);
      }
    }
    for (const [key, notice] of gaps) {
      if (notices.length >= 64) break;
      let encodedHeader;
      try { encodedHeader = headerPart(notice.header); }
      catch { gaps.delete(key); warning(`${notice.count} lost events have unserializable session metadata.`); continue; }
      const { header, ...data } = notice;
      const encoded = JSON.stringify(data);
      const added = Buffer.byteLength(encoded) + (notices.length ? 1 : 0) + headerBytes(encodedHeader);
      if (bytes + added > config.maxBatchBytes) {
        if (sessions.size) break;
        gaps.delete(key);
        warning(`${notice.count} lost events have session metadata exceeding batch capacity.`);
        continue;
      }
      bytes += added;
      addHeader(header, encodedHeader);
      notices.push(notice);
      gapJSON.push(encoded);
      gaps.delete(key);
    }
    return {
      attempts: 0, events, notices, sessions,
      body: `{"source":${JSON.stringify(source)},"sessions":[${sessionJSON.join(',')}],"events":[${eventJSON.join(',')}],"gaps":[${gapJSON.join(',')}]}`,
    };
  }

  async function tick() {
    if (closed || running || Date.now() < retryAt) return;
    if (!pending && !queue.length && !gaps.size && Date.now() - lastSent < config.heartbeatMs) return;
    running = true;
    let timeout;
    try {
      pending ??= prepareBatch();
      pending.attempts++;
      abort = new AbortController();
      timeout = setTimeout(() => abort?.abort(), config.requestTimeoutMs);
      timeout.unref();
      const token = (await readFile(config.tokenFile, 'utf8')).trim();
      if (closed) return;
      if (!token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('Invalid token file');
      const response = await fetch(config.endpoint, {
        method: 'POST', redirect: 'error', signal: abort.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: pending.body,
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`Collector HTTP ${response.status}`);
      }
      const result = await response.json();
      if (Array.isArray(result.issues) && result.issues.length) {
        warning(`Collector reported ${result.issues.length} ingest issues; check Symphony's coverage details.`);
      }
      lastSent = Date.now();
      pending = null;
      retryAt = 0;
    } catch {
      if (closed) return;
      if (Date.now() - lastWarning > 10000) {
        warning('Collector unavailable; bounded retry is active. Agent execution continues.');
        lastWarning = Date.now();
      }
      if (pending && pending.attempts > config.maxRetries) {
        // Event retries stop here. Compact gap notices survive for a later heartbeat.
        for (const item of pending.events) {
          dropped++;
          const header = pending.sessions.get(item.sessionId);
          gap(header, 'retry-exhausted');
        }
        for (const notice of pending.notices) gap(notice.header, notice.reason, notice.count);
        pending = null;
      }
      retryAt = Date.now() + Math.min(5000, config.retryDelayMs * 2 ** Math.min(6, pending?.attempts ?? config.maxRetries));
    } finally {
      clearTimeout(timeout);
      abort = null;
      running = false;
      if (unreportedGaps) {
        warning(`Gap reporting capacity exceeded: ${unreportedGaps} additional lost events; per-session details unavailable.`);
        unreportedGaps = 0;
      }
    }
  }

  const timer = setInterval(() => { void tick(); }, config.flushIntervalMs);
  timer.unref();
  return {
    config, enqueue, gap,
    stats: () => ({ queued: queue.length, inFlight: pending?.events.length ?? 0, dropped, pendingGaps: gaps.size, closed }),
    dispose() {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      abort?.abort();
      const lost = queue.filter(item => item.event).length + (pending?.events.length ?? 0);
      if (lost || gaps.size) warning(`Observer unloaded: ${lost} undelivered events and ${gaps.size} pending gap notices. No shutdown network wait.`);
      queue.length = 0;
      gaps.clear();
      pending = null;
    },
  };
}

export function apply(ctx, input) {
  const collector = createCollector(input, { warn: message => ctx.logger.warn(`[symphony] ${message}`) });
  const { config } = collector;
  const seen = new WeakMap();
  const backfills = new Map();
  let disposed = false;
  let reading = false;
  const reads = new AbortController();

  function discover(session, cutoff = session.seq) {
    if (seen.has(session)) return;
    const state = { session, cutoff, deadline: Date.now() + config.backfillWaitMs };
    seen.set(session, state);
    collector.enqueue(session.header);
    if (!cutoff) return;
    if (!config.backfill) { collector.gap(session.header, 'history-not-requested', cutoff); return; }
    if (backfills.size >= 128) { collector.gap(session.header, 'backfill-capacity', cutoff); return; }
    backfills.set(session, state);
  }

  async function readBackfill() {
    if (disposed || reading || !backfills.size) return;
    const [session, state] = backfills.entries().next().value;
    const query = ctx.get('sessionQuery');
    if (!query) {
      if (Date.now() >= state.deadline) {
        collector.gap(session.header, 'history-query-unavailable', state.cutoff);
        backfills.delete(session);
      }
      return;
    }
    reading = true;
    let observation;
    try {
      // Only active sessions: cold query may synthesize interrupted-turn closers.
      if (ctx.sessions.get(session.id) !== session) throw new Error('Session no longer active');
      observation = await query.observeSession(session.id, { signal: reads.signal, projectionMode: 'none' });
      if (disposed) return;
      if (observation.source !== 'live') throw new Error('Not an active session observation');
      const events = observation.events;
      const start = Math.max(0, state.cutoff - config.maxBackfillEvents);
      if (start) collector.gap(session.header, 'backfill-limit', start);
      for (let index = start; index < state.cutoff; index++) {
        const event = events[index];
        if (event) collector.enqueue(observation.header, event, true);
        else collector.gap(session.header, 'history-missing');
      }
    } catch {
      if (!disposed) collector.gap(session.header, 'history-read-failed', state.cutoff);
    } finally {
      observation?.[Symbol.dispose]();
      backfills.delete(session);
      reading = false;
    }
  }

  const unsubscribe = ctx.on('session/event', (session, event) => {
    // Deliberately not async: append returns without reading files or waiting for HTTP.
    try {
      discover(session, event.seq);
      collector.enqueue(session.header, event, false);
    } catch {
      collector.gap(session.header, 'observer-error');
    }
  });
  const scan = () => {
    if (disposed) return;
    try {
      for (const session of ctx.sessions.list()) discover(session);
      void readBackfill().catch(() => {
        if (!disposed) ctx.logger.warn('[symphony] History query unavailable; live recording continues.');
      });
    } catch { /* Teardown/service transitions must not affect the host. */ }
  };
  const discovery = setInterval(scan, config.discoveryIntervalMs);
  discovery.unref();
  const initial = setTimeout(scan, 0);
  initial.unref();
  ctx.effect(() => () => {
    disposed = true;
    clearTimeout(initial);
    clearInterval(discovery);
    unsubscribe();
    reads.abort();
    backfills.clear();
    collector.dispose();
  }, 'symphony observer cleanup');
}

export default { name, inject, Config, apply };
