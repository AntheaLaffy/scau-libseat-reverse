#!/usr/bin/env node
// 把只读子命令全部跑一遍，用来快速确认「整站功能都还通」（改版时先跑这个）。
//
//   node scripts/run-all.mjs            # 只读命令（需要登录的会自动 CAS 登录一次）
//   node scripts/run-all.mjs --write    # 再跑一遍写入类命令，但都带 dry-run / 只读参数
//
// 输出：每个命令一行 ✓/✗ 与耗时；最后给汇总。任何一个失败，退出码为 1。
import { commands, run } from '../cli.mjs';

const readOnly = [
  ['status', []],
  ['rooms', ['--query', '一楼']],
  ['availability', ['--limit', '3']],
  ['timespans', ['--type', '2']],
  ['seats', ['--room', '一楼思政', '--date', today(), '--start', '09:00']],
  ['room-detail', ['--room', '一楼思政', '--date', today(), '--start', '09:00']],
  ['room-map', ['--room', '一楼思政']],
  ['mine', ['--size', '3']],
  ['today', []],
  ['me', []],
  ['home', []],
  ['districts', []],
  ['announcements', ['--size', '3']],
  ['faq', []],
  ['holidays', []],
  ['violations', ['--size', '3']],
  ['smart-plan', ['--date', tomorrow(), '--hours', '2', '--start', '09:00']],
];

// 写入类：只跑不会真的改动数据的形态（dry-run / --help）
const dryRuns = [
  ['reserve', ['--room', '一楼思政', '--first-free', '--date', tomorrow(), '--start', '09:00', '--hours', '2', '--dry-run']],
  ['members', ['--action', 'list', '--id', '0']],
];

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function tomorrow() {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function tryOne([name, argv]) {
  const t0 = Date.now();
  const realLog = console.log;
  let printed = '';
  console.log = (...a) => {
    printed += a.join(' ');
  };
  try {
    await run(name, argv);
  } finally {
    console.log = realLog;
  }
  const ms = Date.now() - t0;
  const bad = process.exitCode === 1;
  process.exitCode = 0;
  const summary = printed.replace(/\s+/g, ' ').slice(0, 90);
  console.log(`${bad ? '✗' : '✓'} ${name.padEnd(14)} ${String(ms).padStart(5)}ms  ${summary}${printed.length > 90 ? '…' : ''}`);
  return !bad;
}

const suite = process.argv.includes('--write') ? [...readOnly, ...dryRuns] : readOnly;
const unknown = suite.filter(([n]) => !commands[n]);
if (unknown.length) {
  console.error(`未知命令: ${unknown.map(([n]) => n).join(', ')}`);
  process.exit(2);
}

console.log(`跑 ${suite.length} 个命令（${process.argv.includes('--write') ? '含 dry-run 写入' : '只读'}）…\n`);
let ok = 0;
for (const item of suite) {
  if (await tryOne(item)) ok += 1;
}
console.log(`\n${ok}/${suite.length} 通过`);
process.exit(ok === suite.length ? 0 : 1);
