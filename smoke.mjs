#!/usr/bin/env node
// 烟雾测试：以 MCP 协议（stdio）真实握手，打 tools/list，再调用给定工具。
//   node smoke.mjs                        # 握手 + 列工具
//   node smoke.mjs libseat_rooms '{"query":"研讨间"}'
//   node smoke.mjs libseat_status '{}'
//
// 用 spawnSync 一次性投递 JSON-RPC 批次：某些受限沙箱里嵌套 spawn 的异步管道会
// 丢数据，批量投递在沙箱内外都稳定；真实客户端（Codex）走的是常开管道，服务端
// 对这两种模式都实测可用。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const tool = process.argv[2] ?? null;
const toolArgs = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const batch = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'libseat-smoke', version: '0.1.0' } } },
  { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
  { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
];
if (tool) batch.push({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: tool, arguments: toolArgs } });

const proc = spawnSync(process.execPath, [path.join(DIR, 'server.mjs')], {
  input: `${batch.map((m) => JSON.stringify(m)).join('\n')}\n`,
  encoding: 'utf8',
  timeout: 60_000,
});

const replies = proc.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
const init = replies.find((m) => m.id === 1);
const list = replies.find((m) => m.id === 2);
const call = replies.find((m) => m.id === 3);

console.log(`initialize -> ${init?.result?.serverInfo?.name} ${init?.result?.serverInfo?.version} (protocol ${init?.result?.protocolVersion})`);
const tools = list?.result?.tools ?? [];
console.log(`tools/list -> ${tools.length} 个工具`);
for (const t of tools) console.log(`  - ${t.name}: ${t.description?.slice(0, 60)}…`);

if (call) {
  const text = call.result?.content?.find((c) => c.type === 'text')?.text ?? JSON.stringify(call.result);
  console.log(`\ntools/call ${tool} ->\n${text.slice(0, 1200)}`);
}

if (proc.stderr?.trim()) console.log(`\n[server stderr] ${proc.stderr.trim()}`);
process.exitCode = init && list && (!tool || call) ? 0 : 1;
