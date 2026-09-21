import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { Store } from './store.mjs';
import { parseImport } from './import.mjs';
import { getCatalog } from './catalog.mjs';
import { createDemoBatch, createLiveDemoFrames } from './demo.mjs';
import { dshConnection } from './dsh-config.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = '0.1.0';
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

export function ensureToken(dataDir) {
  const path = join(dataDir, 'ingest.token');
  if (!existsSync(path)) {
    try { writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const token = readFileSync(path, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error(`采集令牌文件无效：${path}`);
  return { token, path };
}

function json(res, status, value, extra = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...extra });
  res.end(body);
}
function fail(message, status = 400) { const e = new Error(message); e.status = status; return e; }
async function body(req, max = 4 * 1024 * 1024) {
  if (Number(req.headers['content-length']) > max) throw fail(`请求超过 ${Math.round(max / 1024 / 1024)} MB 限制`, 413);
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > max) throw fail('请求内容过大', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function jsonBody(req, max) {
  try { return JSON.parse((await body(req, max)).toString('utf8')); }
  catch (error) { if (error.status) throw error; throw fail('请求不是有效 JSON'); }
}
function tokenMatches(actual, expected) {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(`Bearer ${expected}`);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function startServer({ port = 4317, dataDir, demo = false } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  dataDir = resolve(dataDir);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(join(dataDir, 'sounds'), { recursive: true, mode: 0o700 });
  const store = new Store(dataDir);
  const { token, path: tokenFile } = ensureToken(dataDir);
  const startedAt = Date.now();
  const subscribers = new Set();
  let demoTimers = [];
  let origin;
  let connection;
  let closed = false;

  function status() {
    const lastSeen = store.lastSeen();
    return {
      version: VERSION, startedAt, dataDir, counts: store.counts(),
      collector: { lastSeen, connected: lastSeen !== null && Date.now() - lastSeen < 30000 },
      connection,
      coverage: { mode: 'dsh-post-commit', nativeVersion: '0.1.6-alpha.2', knownEvents: 58, hookAudit: 'open-turn-only', limitations: ['SessionStart 和 detached subagent hook 缺少逐 handler 审计。', '持久事件记录不等于实时 token 流；历史导入不代表完整现场录音。', '未收到事件不能证明 agent 空闲或卡住。'] },
    };
  }
  function broadcast(event, data) {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of subscribers) {
      // Slow viewers reconnect and fetch the persisted journal instead of growing memory.
      if (res.writableLength > 1024 * 1024) { subscribers.delete(res); res.destroy(); continue; }
      res.write(frame);
    }
  }
  function ingest(batch) {
    const result = store.ingest(batch);
    if (result.sessionKeys.length) broadcast('update', { sessionKeys: result.sessionKeys, events: result.events, historical: result.events.every(e => e.historical) });
    broadcast('status', status());
    const { events, ...response } = result;
    return response;
  }
  function loadDemo() {
    if (store.getSessions().some(s => s.sourceId === 'symphony-demo-v1')) return { accepted: 0, duplicates: 0, issues: [], sessionKeys: [] };
    const batch = createDemoBatch(Date.now());
    batch.events = batch.events.map(row => ({ ...row, historical: true }));
    return ingest(batch);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const host = req.headers.host;
      const portNow = server.address()?.port;
      if (host !== `127.0.0.1:${portNow}` && host !== `localhost:${portNow}`) throw fail('仅接受本机访问', 403);
      const url = new URL(req.url, origin);
      const path = decodeURIComponent(url.pathname);
      const write = ['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method);
      if (path === '/api/ingest') {
        if (req.method !== 'POST') throw fail('Method not allowed', 405);
        if (!tokenMatches(req.headers.authorization, token)) throw fail('采集令牌无效', 401);
        return json(res, 200, ingest(await jsonBody(req)));
      }
      if (write) {
        const allowedOrigins = new Set([origin, `http://localhost:${portNow}`]);
        if (req.headers['x-symphony-local'] !== '1' || (req.headers.origin && !allowedOrigins.has(req.headers.origin)) || req.headers['sec-fetch-site'] === 'cross-site') throw fail('仅允许同源界面修改本地记录器', 403);
      }
      if (req.method === 'GET' && path === '/api/status') return json(res, 200, status());
      if (req.method === 'GET' && path === '/api/sessions') return json(res, 200, { sessions: store.getSessions() });
      if (req.method === 'GET' && path === '/api/catalog') return json(res, 200, getCatalog(store.getTypes()));
      if (req.method === 'GET' && path === '/api/settings') return json(res, 200, store.getSettings());
      if (req.method === 'PUT' && path === '/api/settings') return json(res, 200, store.saveSettings(await jsonBody(req)));
      if (req.method === 'GET' && path === '/api/sounds') return json(res, 200, { sounds: store.getSounds() });
      if (req.method === 'POST' && path === '/api/sounds') {
        const mime = (req.headers['content-type'] ?? '').split(';')[0];
        if (!['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/webm', 'audio/mp4', 'audio/flac', 'audio/aac'].includes(mime)) throw fail('请选择 WAV、MP3、OGG、WebM、M4A、FLAC 或 AAC 音频');
        const bytes = await body(req, 5 * 1024 * 1024);
        if (!bytes.length) throw fail('音频文件为空');
        const id = createHash('sha256').update(bytes).digest('hex');
        const name = basename(decodeURIComponent(req.headers['x-filename'] ?? 'sound')).replace(/[\u0000-\u001f]/g, '').slice(0, 180);
        const soundPath = join(dataDir, 'sounds', id);
        try { await writeFile(soundPath, bytes, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
        return json(res, 201, store.addSound(id, name || 'sound', mime, bytes.length));
      }
      const soundMatch = /^\/api\/sounds\/([a-f0-9]{64})$/.exec(path);
      if (req.method === 'GET' && soundMatch) {
        const sound = store.getSounds().find(s => s.id === soundMatch[1]);
        if (!sound) throw fail('找不到音频', 404);
        const bytes = await readFile(join(dataDir, 'sounds', sound.id));
        res.writeHead(200, { 'Content-Type': sound.mime, 'Content-Length': bytes.length, 'Cache-Control': 'private, max-age=86400' });
        return res.end(bytes);
      }
      const match = /^\/api\/sessions\/([a-f0-9]{32})\/(events|export)$/.exec(path);
      if (req.method === 'GET' && match) {
        const key = match[1];
        if (!store.getSessionRow(key)) throw fail('找不到这个 session', 404);
        if (match[2] === 'export') return json(res, 200, store.exportSession(key), { 'Content-Disposition': `attachment; filename="session-${key.slice(0, 8)}.symphony.json"` });
        const after = Number(url.searchParams.get('after') ?? -1);
        const limit = Number(url.searchParams.get('limit') ?? 1000);
        if (!Number.isSafeInteger(after) || after < -1 || !Number.isInteger(limit) || limit < 1 || limit > 5000) throw fail('无效的分页参数');
        const all = store.getEvents(key).filter(e => e.seq > after);
        const events = all.slice(0, limit);
        return json(res, 200, { events, nextAfter: events.at(-1)?.seq ?? after, hasMore: all.length > limit });
      }
      if (req.method === 'POST' && path === '/api/import') {
        const input = (req.headers['content-type'] ?? '').includes('application/json') ? await jsonBody(req, 32 * 1024 * 1024) : await body(req, 32 * 1024 * 1024);
        const filename = decodeURIComponent(req.headers['x-filename'] ?? '导入记录');
        return json(res, 200, ingest(parseImport(input, filename)));
      }
      if (req.method === 'POST' && path === '/api/demo') return json(res, 200, loadDemo());
      if (req.method === 'POST' && path === '/api/demo/live') {
        demoTimers.forEach(clearTimeout);
        demoTimers = createLiveDemoFrames(Date.now()).map(frame => setTimeout(() => {
          try { ingest(frame.batch); } catch (error) { broadcast('error', { message: `演示记录失败：${error.message}` }); }
        }, frame.delayMs));
        return json(res, 200, { started: true });
      }
      if (req.method === 'GET' && path === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write(`retry: 2000\nevent: status\ndata: ${JSON.stringify(status())}\n\n`);
        subscribers.add(res);
        req.on('close', () => subscribers.delete(res));
        return;
      }
      if (path.startsWith('/api/')) throw fail('找不到这个接口', 404);
      if (req.method !== 'GET' && req.method !== 'HEAD') throw fail('Method not allowed', 405);
      const file = path === '/' ? 'index.html' : path.slice(1);
      if (!/^[a-zA-Z0-9_./-]+$/.test(file) || file.split('/').includes('..') || !MIME[extname(file)]) throw fail('找不到文件', 404);
      let bytes;
      try { bytes = await readFile(join(ROOT, 'public', file)); } catch { throw fail('找不到文件', 404); }
      res.writeHead(200, { 'Content-Type': MIME[extname(file)], 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) {
      if (res.headersSent) return res.end();
      json(res, error.status ?? 400, { error: error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  await new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolveListen);
  }).catch(error => { store.close(); throw error; });
  origin = `http://127.0.0.1:${server.address().port}`;
  connection = dshConnection(dataDir, `${origin}/api/ingest`);
  try { await writeFile(connection.patchPath, connection.patch, { mode: 0o600 }); }
  catch (error) { server.close(); store.close(); throw error; }
  const heartbeat = setInterval(() => {
    for (const res of subscribers) res.write(': heartbeat\n\n');
    broadcast('status', status());
  }, 10000);
  heartbeat.unref();
  if (demo) loadDemo();
  return {
    url: origin, store, tokenFile, ingest, status,
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      demoTimers.forEach(clearTimeout);
      subscribers.forEach(res => res.end());
      await new Promise(done => server.close(done));
      store.close();
    },
  };
}
