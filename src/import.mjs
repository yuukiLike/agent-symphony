import { createHash } from 'node:crypto';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import { decodeZstdLog } from './zstd.mjs';

const MAX_DECODED = 32 * 1024 * 1024;

export function parseImport(input, filename = 'recording') {
  if (Buffer.isBuffer(input)) {
    let bytes = input;
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0xfd2fb528) {
      try { bytes = decodeZstdLog(bytes, MAX_DECODED); }
      catch { throw new Error('Zstandard 文件不完整、已损坏或解压后超过 32 MB。请导出完整 session 后重试。'); }
    }
    if (bytes.length > MAX_DECODED) throw new Error('导入记录不得超过 32 MB');
    const text = bytes.toString('utf8').replace(/^\uFEFF/, '');
    let json;
    try { json = JSON.parse(text); } catch { /* A physical JSONL log has multiple JSON records. */ }
    if (json?.format === 'agent-symphony' || json?.format === 'dsh-jsonl') return parseImport(json, filename);
    return parseJsonl(text, filename);
  }
  if (input?.format === 'dsh-jsonl' && typeof input.text === 'string') return parseJsonl(input.text, filename, input.sourceId);
  if (input?.format !== 'agent-symphony' || input.version !== 1 || !input.session || !Array.isArray(input.events)) throw new Error('请选择 Symphony 导出文件或 dsh v3 JSONL / zstd 日志');
  const origin = input.source?.instanceId ?? 'unknown';
  return {
    source: { instanceId: input.source?.kind === 'import' ? origin : `import:${origin}`, kind: 'import', label: input.source?.label ?? filename, version: input.source?.version, originalSource: input.source?.originalSource ?? input.source },
    sessions: [input.session],
    events: input.events.map(event => ({ sessionId: input.session.id, event, historical: true })),
    gaps: (input.gaps ?? []).map(g => ({ ...g, sessionId: input.session.id })),
  };
}

function parseJsonl(text, filename, sourceId) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length || !lines[0]) throw new Error('文件为空');
  let header;
  try { header = JSON.parse(lines[0]); } catch { throw new Error('第 1 行不是有效的 dsh session header'); }
  if (header.type !== 'session' || header.version !== 3) throw new Error('当前文件导入只接受 dsh v3 session 日志；旧版本请先通过 dsh 官方只读导出迁移');
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'transformed' });
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { restore.decodeRow(JSON.parse(lines[i])); }
    catch (error) { throw new Error(`第 ${i + 1} 行无效：${error.message}`); }
  }
  const artifact = restore.finish();
  const stableSource = sourceId || `dsh-file:${createHash('sha256').update(header.cwd ?? '_no-cwd').digest('hex').slice(0, 16)}`;
  return {
    source: { instanceId: stableSource, kind: 'import', label: filename, version: 'v3' },
    sessions: [artifact.header],
    events: artifact.events.map(event => ({ sessionId: artifact.header.id, event, historical: true })),
    gaps: [],
  };
}
