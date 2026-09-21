#!/usr/bin/env node
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { startServer, ensureToken, VERSION } from '../src/server.mjs';
import { dshConnection } from '../src/dsh-config.mjs';
import { Store } from '../src/store.mjs';
import { parseImport } from '../src/import.mjs';

const args = process.argv.slice(2).filter(a => a !== '--');
const commands = new Set(['serve', 'import', 'export', 'doctor', 'setup-dsh', 'help']);
const command = commands.has(args[0]) ? args.shift() : 'serve';
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`);
  args.splice(index, 2);
  return value;
}
const help = `Agent Symphony ${VERSION} · dsh execution recorder

  pnpm start                         启动本地记录器
  pnpm start --demo                  启动并加入示例记录
  pnpm start --port 4317             指定本地端口
  pnpm start import session.v3.jsonl  导入 dsh JSONL / zstd / Symphony 导出文件
  pnpm start export SESSION_KEY --out recording.json
  pnpm start doctor                  查看本地运行条件与接入状态
  pnpm start setup-dsh --out observer.patch.yml  生成 dsh 接入配置

  --data-dir PATH                    指定记录目录（默认 ~/.local/share/agent-symphony）

界面中的“接入”页提供 dsh 插件路径及配置；不改写你的 dsh 设置。
`;

try {
  const dataDir = resolve(option('--data-dir', join(homedir(), '.local/share/agent-symphony')));
  const port = Number(option('--port', '4317'));
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('端口必须为 0–65535');
  if (command === 'help' || args.includes('--help') || args.includes('-h')) {
    console.log(help);
  } else if (command === 'serve') {
    const demo = args.includes('--demo');
    if (args.some(a => a !== '--demo')) throw new Error(`不认识的参数：${args.join(' ')}`);
    const app = await startServer({ dataDir, port, demo });
    console.log(`Agent Symphony ${VERSION}\n界面：${app.url}\n记录：${dataDir}\n采集令牌：${app.tokenFile}\n按 Ctrl+C 停止记录器；不会停止 dsh。`);
    let stopping = false;
    const stop = async () => { if (stopping) return; stopping = true; await app.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } else if (command === 'import') {
    if (args.length !== 1) throw new Error('import 需要一个文件路径');
    const path = resolve(args[0]);
    const batch = parseImport(await readFile(path), path.split('/').at(-1));
    const store = new Store(dataDir);
    try { const { events, ...result } = store.ingest(batch); console.log(JSON.stringify(result, null, 2)); } finally { store.close(); }
  } else if (command === 'export') {
    const output = option('--out');
    if (args.length !== 1 || !output) throw new Error('export 需要 SESSION_KEY 和 --out 路径');
    const store = new Store(dataDir);
    try {
      const record = store.exportSession(args[0]);
      if (!record) throw new Error('找不到 session');
      await writeFile(resolve(output), JSON.stringify(record, null, 2), { flag: 'wx', mode: 0o600 });
      console.log(`已导出 ${record.events.length} 条记录到 ${resolve(output)}`);
    } finally { store.close(); }
  } else if (command === 'setup-dsh') {
    const output = option('--out');
    if (!output || args.length) throw new Error('setup-dsh 需要 --out 配置文件路径');
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    ensureToken(dataDir);
    const connection = dshConnection(dataDir, `http://127.0.0.1:${port}/api/ingest`);
    await writeFile(resolve(output), connection.patch, { flag: 'wx', mode: 0o600 });
    console.log(`已生成 ${resolve(output)}\n将 --patch 参数加入你的 dsh 启动命令。记录器端口：${port}\n未修改 dsh home 或已有 profile。`);
  } else if (command === 'doctor') {
    console.log(`Node ${process.version}\n数据目录：${dataDir}\n目标版本：dsh 0.1.6-alpha.2`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1500) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      console.log(`记录器：运行中\n已记录：${result.counts.sessions} sessions / ${result.counts.events} events\ndsh 采集器：${result.collector.connected ? '近期有连接' : '尚无近期连接'}`);
    } catch { console.log('记录器：未连接。运行 pnpm start 启动。'); process.exitCode = 1; }
  }
} catch (error) {
  console.error(`Agent Symphony：${error.message}`);
  process.exitCode = 1;
}
