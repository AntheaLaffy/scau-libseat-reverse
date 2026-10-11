#!/usr/bin/env node
// 「读图 → 提交 → 判定」自测（给人工或模型测自己的验证码识别能力）。
// 抓图与提交分成两步，中间由人/模型看图 —— 每张图绑定自己的会话，存在 readcheck-pending.json。
//
//   node readcheck.mjs capture 5         # 抓 5 张，各自独立会话
//   node readcheck.mjs submit FYRV 3A48  # 按顺序提交读到的码，输出判定表
//   node readcheck.mjs retest 2 ALCH 3   # 在第 2 张的会话上把 ALCH 再提交 3 次（测验证码能否复用）
//
// 判定：login_ok（码对且有账号）/ captcha_accepted（码被接受，报错落到账号层）/
//       captcha_rejected（码错）。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { fetchCaptcha, storeCaptchaSample } from './captcha.mjs';
import { config } from './config.mjs';
import { classifyLoginResponse } from './flows.mjs';
import { cookieJarClear, cookieJarRestore, cookieJarSnapshot, request } from './http.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const PENDING = path.join(DIR, 'readcheck-pending.json');
const mode = process.argv[2];
const probeUser = config.probeUser || config.user || 'test0000';
const probePass = config.probePass || config.pass || 'test0000';

if (mode === 'capture') {
  const count = Number(process.argv[3] ?? 5) || 5;
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    cookieJarClear();
    const sample = await fetchCaptcha();
    const { file } = storeCaptchaSample(sample, { kind: 'readcheck', seq: i });
    out.push({ seq: i, file, sha256: sample.sha256, cookies: cookieJarSnapshot() });
  }
  writeFileSync(PENDING, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`抓了 ${count} 张（每张独立会话），待读清单：${PENDING}`);
  for (const o of out) console.log(`  #${o.seq} ${o.file}`);
  console.log(`\n放大读图：magick <file> -colorspace Gray -normalize -filter Lanczos -resize 500% /tmp/cap.png`);
} else if (mode === 'submit') {
  const codes = process.argv.slice(3);
  const pending = JSON.parse(readFileSync(PENDING, 'utf8'));
  if (codes.length !== pending.length) {
    console.error(`需要 ${pending.length} 个码（按 capture 的顺序），收到 ${codes.length} 个`);
    process.exit(2);
  }
  const rows = [];
  for (const [i, entry] of pending.entries()) {
    const code = codes[i];
    cookieJarRestore(entry.cookies);
    const res = await request('POST', '/web/user/login', { body: { userName: probeUser, password: probePass, captcha: code } });
    rows.push({ seq: entry.seq, myRead: code, verdict: classifyLoginResponse(res), message: res?.message ?? '' });
  }
  const hit = rows.filter((r) => r.verdict !== 'captcha_rejected').length;
  console.log(JSON.stringify({ rows, hit, total: rows.length, accuracy: Number((hit / rows.length).toFixed(2)) }, null, 2));
  writeFileSync(path.join(DIR, 'captcha-samples', 'readcheck-result.json'), `${JSON.stringify({ at: new Date().toISOString(), rows }, null, 2)}\n`);
} else if (mode === 'retest') {
  const seq = Number(process.argv[3]);
  const code = process.argv[4];
  const times = Number(process.argv[5] ?? 1) || 1;
  const pending = JSON.parse(readFileSync(PENDING, 'utf8'));
  const entry = pending.find((p) => p.seq === seq);
  if (!entry) {
    console.error(`pending 里没有 #${seq}（先 capture）`);
    process.exit(2);
  }
  const rows = [];
  for (let i = 1; i <= times; i += 1) {
    cookieJarRestore(entry.cookies);
    const t0 = Date.now();
    const res = await request('POST', '/web/user/login', { body: { userName: probeUser, password: probePass, captcha: code } });
    rows.push({ round: i, code, verdict: classifyLoginResponse(res), message: res?.message ?? '', ms: Date.now() - t0 });
  }
  console.log(JSON.stringify({ session: entry.file, rows }, null, 2));
} else {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(1);
}
