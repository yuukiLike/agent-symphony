import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { normalizeEvent, summarizeSession, createEventContext } from './events.mjs';
import { SOUND_PRESETS, validMatchCondition } from '../public/sound-rules.js';

export const DEFAULT_SETTINGS = {
  audio: { enabled: false, volume: 0.35 },
  rules: [
    { id: 'default-failure', enabled: true, match: { outcome: 'failure' }, sound: 'low', volume: 0.5 },
    { id: 'default-tool-return', enabled: true, match: { type: 'tool/result' }, sound: 'glass', volume: 0.4 },
    { id: 'default-hook-return', enabled: true, match: { type: 'hook/result' }, sound: 'wood', volume: 0.35 },
  ],
  categorySounds: { session: 'bell', model: 'brush', tool: 'wood', hook: 'click', context: 'glass', interaction: 'bell', collaboration: 'glass', artifact: 'wood', other: 'mute' },
};

export function sessionKey(sourceId, id) {
  return createHash('sha256').update(JSON.stringify([sourceId, id])).digest('hex').slice(0, 32);
}

function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function string(value, max = 1000) { return typeof value === 'string' && value.length > 0 && value.length <= max; }
function integer(value) { return Number.isSafeInteger(value) && value >= 0; }

export function validateBatch(batch) {
  if (!object(batch) || !object(batch.source) || !string(batch.source.instanceId)) throw new Error('缺少有效的 source.instanceId');
  if (!['live', 'import', 'demo'].includes(batch.source.kind)) throw new Error('source.kind 必须是 live、import 或 demo');
  for (const key of ['sessions', 'events', 'gaps']) {
    if (batch[key] !== undefined && !Array.isArray(batch[key])) throw new Error(`${key} 必须是数组`);
  }
  if ((batch.events?.length ?? 0) > 100000 || (batch.sessions?.length ?? 0) > 1000) throw new Error('单批记录过多，请分批导入');
  for (const h of batch.sessions ?? []) {
    if (!object(h) || !string(h.id) || !integer(h.createdAt)) throw new Error('Session header 需要 id 和毫秒 createdAt');
    if (h.version !== undefined && h.version !== 3) throw new Error('当前仅支持 dsh session v3');
    if (h.cwd !== undefined && typeof h.cwd !== 'string') throw new Error('cwd 必须是字符串');
  }
  for (const row of batch.events ?? []) {
    const e = row?.event;
    if (!string(row?.sessionId) || !object(e) || !string(e.type, 300) || !integer(e.seq) || !integer(e.time) || !Object.hasOwn(e, 'data')) {
      throw new Error('事件需要 sessionId、type、非负整数 seq / time 和 JSON data');
    }
  }
  for (const gap of batch.gaps ?? []) {
    if (!object(gap) || !string(gap.sessionId) || !string(gap.reason) || !integer(gap.count ?? 0)) throw new Error('无效的采集缺口');
  }
  return batch;
}

// Preserve evidence while keeping common credential fields out of the local journal.
// Free-form text is not guaranteed secret-free; this is reported in the UI/docs.
export function redact(value, key = '', depth = 0) {
  if (depth > 100) throw new Error('事件嵌套超过 100 层');
  if (/^(authorization|proxy-authorization|cookie|set-cookie|api[-_]?key|access[-_]?token|refresh[-_]?token|password|secret|client[-_]?secret)$/i.test(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map(item => redact(item, '', depth + 1));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k, depth + 1)]));
  if (typeof value === 'string' && /^(arguments|args)$/i.test(key)) {
    try { return JSON.stringify(redact(JSON.parse(value), '', depth + 1)); } catch { return value; }
  }
  return value;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function validateSettings(value, soundIds = []) {
  if (!object(value) || !object(value.audio) || typeof value.audio.enabled !== 'boolean') throw new Error('无效的声音设置');
  const gain = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (!gain(value.audio.volume) || !Array.isArray(value.rules) || value.rules.length > 1000 || !object(value.categorySounds)) throw new Error('音量须为 0–1，声音规则最多 1000 条');
  const sounds = new Set([...SOUND_PRESETS.map(sound => sound.id), ...soundIds]);
  const ids = new Set();
  for (const r of value.rules) {
    if (!object(r) || !string(r.id, 200) || ids.has(r.id) || typeof r.enabled !== 'boolean' || !object(r.match) || !sounds.has(r.sound)) throw new Error('规则 ID 必须唯一，且需要有效的匹配条件和音色');
    ids.add(r.id);
    if (r.volume !== undefined && !gain(r.volume)) throw new Error('规则音量须为 0–1');
    for (const [k, v] of Object.entries(r.match)) if (!validMatchCondition(k, v)) throw new Error(`无效的规则条件：${k}`);
  }
  for (const [key, sound] of Object.entries(value.categorySounds)) {
    if (!Object.hasOwn(DEFAULT_SETTINGS.categorySounds, key) || !sounds.has(sound)) throw new Error('无效的默认音色');
  }
  return { audio: value.audio, rules: value.rules.map(r => ({ id: r.id, enabled: r.enabled, match: r.match, sound: r.sound, ...(r.volume !== undefined ? { volume: r.volume } : {}) })), categorySounds: { ...DEFAULT_SETTINGS.categorySounds, ...value.categorySounds } };
}

export class Store {
  constructor(dataDir) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dataDir, 'symphony.sqlite'));
    chmodSync(join(dataDir, 'symphony.sqlite'), 0o600);
    this.cache = new Map();
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=3000;
      CREATE TABLE IF NOT EXISTS sources (id TEXT PRIMARY KEY, metadata TEXT NOT NULL, last_seen INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (key TEXT PRIMARY KEY, id TEXT NOT NULL, source_id TEXT NOT NULL REFERENCES sources(id), header TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (row_id INTEGER PRIMARY KEY, session_key TEXT NOT NULL REFERENCES sessions(key), seq INTEGER NOT NULL, type TEXT NOT NULL, time INTEGER NOT NULL, received_at INTEGER NOT NULL, historical INTEGER NOT NULL, raw TEXT NOT NULL, UNIQUE(session_key,seq));
      CREATE INDEX IF NOT EXISTS events_session_seq ON events(session_key,seq);
      CREATE TABLE IF NOT EXISTS gaps (id TEXT PRIMARY KEY, session_key TEXT NOT NULL REFERENCES sessions(key), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sounds (id TEXT PRIMARY KEY, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL);
    `);
    this.dataVersion = this.db.prepare('PRAGMA data_version').get().data_version;
  }

  ingest(input) {
    validateBatch(input);
    const batch = redact(input);
    const now = Date.now();
    const touched = new Set();
    const inserted = [];
    let duplicates = 0;
    const issues = [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.db.prepare('SELECT metadata FROM sources WHERE id=?').get(batch.source.instanceId);
      if (previous && JSON.parse(previous.metadata).kind !== batch.source.kind) throw new Error('来源 ID 已被另一种来源类型占用');
      this.db.prepare('INSERT INTO sources VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET metadata=excluded.metadata,last_seen=excluded.last_seen').run(batch.source.instanceId, JSON.stringify(batch.source), now);
      const headers = new Map((batch.sessions ?? []).map(h => [h.id, h]));
      for (const item of [...(batch.events ?? []), ...(batch.gaps ?? [])]) {
        if (!headers.has(item.sessionId)) {
          const key = sessionKey(batch.source.instanceId, item.sessionId);
          const existing = this.db.prepare('SELECT header FROM sessions WHERE key=?').get(key);
          headers.set(item.sessionId, existing ? JSON.parse(existing.header) : { id: item.sessionId, createdAt: item.event?.time ?? now, version: 3 });
        }
      }
      for (const h of headers.values()) {
        const key = sessionKey(batch.source.instanceId, h.id);
        this.db.prepare('INSERT INTO sessions VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET header=excluded.header,created_at=excluded.created_at').run(key, h.id, batch.source.instanceId, JSON.stringify(h), h.createdAt);
        touched.add(key);
      }
      const find = this.db.prepare('SELECT raw FROM events WHERE session_key=? AND seq=?');
      const insert = this.db.prepare('INSERT INTO events(session_key,seq,type,time,received_at,historical,raw) VALUES (?,?,?,?,?,?,?)');
      for (const row of batch.events ?? []) {
        const key = sessionKey(batch.source.instanceId, row.sessionId);
        const raw = stableJson(row.event);
        const existing = find.get(key, row.event.seq);
        if (existing) {
          if (existing.raw === raw) duplicates++;
          else {
            issues.push({ sessionKey: key, seq: row.event.seq, reason: 'sequence-conflict' });
            this.addGap(key, { sessionId: row.sessionId, reason: 'sequence-conflict', seq: row.event.seq, count: 1, at: now });
          }
          continue;
        }
        const historical = row.historical === true || batch.source.kind === 'import';
        insert.run(key, row.event.seq, row.event.type, row.event.time, now, historical ? 1 : 0, raw);
        inserted.push({ key, seq: row.event.seq });
      }
      for (const gap of batch.gaps ?? []) this.addGap(sessionKey(batch.source.instanceId, gap.sessionId), { ...gap, at: gap.at ?? now });
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    for (const key of touched) this.cache.delete(key);
    const byKey = new Map([...touched].map(key => [key, new Map(this.getEvents(key).map(e => [e.seq, e]))]));
    return { accepted: inserted.length, duplicates, issues, sessionKeys: [...touched], events: inserted.map(({ key, seq }) => byKey.get(key).get(seq)) };
  }

  addGap(key, gap) {
    const id = createHash('sha256').update(key + stableJson(gap)).digest('hex');
    this.db.prepare('INSERT OR IGNORE INTO gaps VALUES (?,?,?)').run(id, key, JSON.stringify(gap));
  }

  getSessionRow(key) {
    return this.db.prepare('SELECT s.*, o.metadata as source FROM sessions s JOIN sources o ON s.source_id=o.id WHERE s.key=?').get(key);
  }

  getEvents(key) {
    // CLI imports can commit through another SQLite connection while this server runs.
    const version = this.db.prepare('PRAGMA data_version').get().data_version;
    if (version !== this.dataVersion) { this.cache.clear(); this.dataVersion = version; }
    if (this.cache.has(key)) return this.cache.get(key);
    const session = this.getSessionRow(key);
    if (!session) return null;
    const source = JSON.parse(session.source);
    const rows = this.db.prepare('SELECT * FROM events WHERE session_key=? ORDER BY seq').all(key);
    const raw = rows.map(row => JSON.parse(row.raw));
    const context = createEventContext(raw);
    const events = rows.map((row, i) => normalizeEvent(raw[i], { ...context, sessionKey: key, sessionId: session.id, sourceId: session.source_id, sourceKind: source.kind, receivedAt: row.received_at, historical: Boolean(row.historical) }));
    const pending = new Map();
    for (const e of events) {
      if (!e.correlationKey) continue;
      if (e.phase === 'start') {
        const group = pending.get(e.correlationKey) ?? [];
        group.push(e);
        pending.set(e.correlationKey, group);
      } else if (e.phase === 'end') {
        const group = pending.get(e.correlationKey);
        if (!group || group.length !== 1) continue;
        const start = group.shift();
        start.relatedEventId = e.id;
        e.relatedEventId = start.id;
        if (e.time >= start.time) start.durationMs = e.durationMs = e.time - start.time;
      }
    }
    this.cache.set(key, events);
    return events;
  }

  getSessions() {
    return this.db.prepare('SELECT key FROM sessions ORDER BY created_at DESC').all().map(({ key }) => {
      const row = this.getSessionRow(key);
      const header = JSON.parse(row.header);
      const source = JSON.parse(row.source);
      const events = this.getEvents(key);
      const summary = summarizeSession(events, header);
      const gaps = this.db.prepare('SELECT data FROM gaps WHERE session_key=?').all(key).map(r => JSON.parse(r.data));
      let expected = 0;
      for (const e of events) {
        if (e.seq > expected) gaps.push({ reason: 'missing-sequence', fromSeq: expected, toSeq: e.seq - 1, count: e.seq - expected });
        expected = e.seq + 1;
      }
      return { ...header, ...summary, key, id: row.id, sourceId: row.source_id, sourceKind: source.kind, sourceLabel: source.label ?? source.instanceId, version: source.version, eventCount: events.length, lastEventAt: events.at(-1)?.time ?? header.createdAt, gaps, coverage: source.kind === 'live' ? 'post-commit-events' : 'recorded-history' };
    }).sort((a, b) => b.lastEventAt - a.lastEventAt);
  }

  exportSession(key) {
    const row = this.getSessionRow(key);
    if (!row) return null;
    return { format: 'agent-symphony', version: 1, exportedAt: Date.now(), redaction: 'common-credential-fields', source: JSON.parse(row.source), session: JSON.parse(row.header), events: this.getEvents(key).map(e => e.raw), gaps: this.db.prepare('SELECT data FROM gaps WHERE session_key=?').all(key).map(r => JSON.parse(r.data)) };
  }

  getSettings() {
    const row = this.db.prepare('SELECT data FROM settings WHERE id=1').get();
    return row ? JSON.parse(row.data) : structuredClone(DEFAULT_SETTINGS);
  }
  saveSettings(settings) {
    const valid = validateSettings(settings, this.getSounds().map(s => s.sound));
    this.db.prepare('INSERT INTO settings VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(valid));
    return valid;
  }
  getSounds() { return this.db.prepare('SELECT * FROM sounds ORDER BY name').all().map(s => ({ ...s, sound: `asset:${s.id}`, url: `/api/sounds/${s.id}` })); }
  addSound(id, name, mime, size) { this.db.prepare('INSERT OR IGNORE INTO sounds VALUES (?,?,?,?)').run(id, name, mime, size); return this.getSounds().find(s => s.id === id); }
  getTypes() { return this.db.prepare('SELECT DISTINCT type FROM events').all().map(r => r.type); }
  counts() { return { sessions: this.db.prepare('SELECT COUNT(*) n FROM sessions').get().n, events: this.db.prepare('SELECT COUNT(*) n FROM events').get().n }; }
  lastSeen() { return this.db.prepare("SELECT MAX(last_seen) t FROM sources WHERE json_extract(metadata,'$.kind')='live'").get().t ?? null; }
  close() { this.db.close(); }
}
