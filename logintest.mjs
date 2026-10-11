#!/usr/bin/env node
// 判定三件事（都需要真实账号）：
//   T1 登录本身能不能过（验证码 -> 账号）
//   T2 **登录成功后，同一条会话再次登录还需不需要图形验证码** —— 决定能不能固化成脚本
//   T5 会话能活多久（决定是不是根本不用反复登录）
//
// 用法：
//   node logintest.mjs                       # 抓一张验证码并保存会话（人工读图模式）
//   node logintest.mjs --captcha AB3D        # 用人工读出的码继续跑完整套
//   node logintest.mjs --multi 4             # 一次抓 4 张（各自会话），给读图留试错余地
//   node logintest.mjs --codes AB3D K479 ... # 按顺序试，第一个登进去的会话跑完整套
//   node logintest.mjs --auto                # 求解器可用时一次跑完，不需要人工
//   node logintest.mjs --captcha AB3D --watch 60   # 追加会话寿命观测（最多 60 分钟）
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { api } from './api.mjs';
import { CaptchaUnavailable, fetchCaptcha, solveCaptcha, storeCaptchaSample } from './captcha.mjs';
import { config } from './config.mjs';
import { SessionExpired, cookieJarClear, cookieJarRestore, cookieJarSnapshot, request } from './http.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SESSION_FILE = path.join(DIR, 'logintest-session.json');
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const user = value('--user', config.user);
const pass = value('--password', config.pass);
if (!user || !pass) {
  console.error('缺少账号：先在 mcp/libseat/.env 配 LIBSEAT_USER / LIBSEAT_PASS，或用 --user/--password 传入');
  process.exit(2);
}

const mask = (u) => (u.length <= 3 ? `${u[0]}**` : `${u.slice(0, 2)}***${u.slice(-2)}`);
const steps = [];
const record = (name, verdict, detail) => {
  steps.push({ step: name, verdict, detail });
  console.log(`- ${name}: ${verdict}${detail ? `  (${detail})` : ''}`);
};

// ---- 阶段一：拿到一个“已绑定会话”的验证码，并提交 ----

let code = value('--captcha', null);
let saved = null;
let t1Result = null;

const multi = Number(value('--multi', 0)) || 0;
const codesArg = (() => {
  const i = argv.indexOf('--codes');
  return i < 0 ? [] : argv.slice(i + 1).filter((a) => !a.startsWith('--'));
})();

if (multi > 0) {
  const list = [];
  for (let i = 1; i <= multi; i += 1) {
    cookieJarClear();
    const sample = await fetchCaptcha();
    const { file } = storeCaptchaSample(sample, { kind: 'logintest', seq: i });
    list.push({ seq: i, cookies: cookieJarSnapshot(), captchaFile: file });
  }
  writeFileSync(SESSION_FILE, `${JSON.stringify(list, null, 2)}\n`);
  console.log(`抓了 ${multi} 张（各自会话）：`);
  for (const e of list) console.log(`  #${e.seq} ${e.captchaFile}`);
  console.log(`\n放大读图：magick "<file>" -colorspace Gray -normalize -filter Lanczos -resize 700% /tmp/cap.png`);
  console.log(`读完按顺序提交：node logintest.mjs --codes AAAA BBBB CCCC DDDD`);
  process.exit(0);
}

if (codesArg.length) {
  const list = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  if (!Array.isArray(list)) {
    console.error('--codes 需要配合 --multi 抓出的会话清单');
    process.exit(2);
  }
  const authFailures = [];
  for (const [i, entry] of list.entries()) {
    const guess = codesArg[i];
    if (!guess) break;
    cookieJarRestore(entry.cookies);
    const res = await request('POST', '/web/user/login', { body: { userName: user, password: pass, captcha: guess } });
    const ok = res?.isOk === true;
    if (ok) {
      console.log(`  #${entry.seq} ${guess} -> 登录成功`);
      saved = entry;
      code = guess;
      break;
    }
    const captchaOk = !(res?.message ?? '').includes('验证码');
    console.log(`  #${entry.seq} ${guess} -> ${captchaOk ? `验证码通过，但登录失败：${res.message}` : '验证码错误'}`);
    if (captchaOk) authFailures.push({ entry, guess, message: res.message });
  }
  if (!saved) {
    if (authFailures.length) {
      const pick = authFailures.at(-1);
      console.log(`\n验证码读对了（${authFailures.length} 个），但账号那一层没过：${pick.message}`);
      console.log('账号/密码问题要你先解决，跟读图无关。会话已保留，可直接测“免验证码再登录”：');
      console.log(`  node logintest.mjs --reuse ${pick.entry.seq} --code ${pick.guess}`);
      process.exit(3);
    }
    console.log('\n这一轮的码都没读对，换一批重来：node logintest.mjs --multi 4');
    process.exit(1);
  }
}

// 复用测试：在一条“验证码已被接受过”的会话上继续提交，看还需不需要验证码
const reuseSeq = value('--reuse', null);
if (reuseSeq !== null) {
  const list = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
  const entry = Array.isArray(list) ? list.find((e) => String(e.seq) === String(reuseSeq)) : list;
  if (!entry) {
    console.error(`没有 #${reuseSeq} 这条会话`);
    process.exit(2);
  }
  console.log(`\n在 #${entry.seq}（${entry.captchaFile}）这条会话上连续试探，全程不再抓新验证码：`);
  for (const [name, body] of [
    ['不带验证码（captcha 留空）', { userName: user, password: pass, captcha: '' }],
    ['复用刚才那个已被接受的码', { userName: user, password: pass, captcha: value('--code', code ?? '') }],
    ['故意给个乱码（对照）', { userName: user, password: pass, captcha: 'ZZZZ' }],
    ['不带验证码再说一次', { userName: user, password: pass, captcha: '' }],
  ]) {
    cookieJarRestore(entry.cookies);
    const res = await request('POST', '/web/user/login', { body });
    const msg = res?.isOk === true ? '登录成功' : res?.message ?? '失败';
    const verdict = !msg.includes('验证码') ? '不需要验证码' : '仍然需要验证码';
    console.log(`  - ${name}: ${msg}  → ${verdict}`);
  }
  console.log('\n判读：只要“不带验证码”被拒绝，就说明每次登录都要新的一张图；');
  console.log('      如果“不带验证码”也能过（报错落到账号层），则这条会话已经免验证码。');
  process.exit(0);
}

if (!code) {
  if (flag('--auto')) {
    // 求解器命中率不会 100%，所以这里按“换新图重试”的语义转到第一张被接受的图为止；
    // 验证码没读对的那些尝试不会碰到密码校验，不消耗账号的失败次数。
    const tries = Number(value('--tries', config.loginRetries)) || 5;
    for (let i = 1; i <= tries && !t1Result; i += 1) {
      cookieJarClear();
      const sample = await fetchCaptcha();
      const { file } = storeCaptchaSample(sample, { kind: 'logintest', attempt: i });
      saved = { cookies: cookieJarSnapshot(), captchaFile: file, seq: i };
      let guess;
      try {
        guess = await solveCaptcha(sample.buffer, file, sample);
      } catch (err) {
        console.log(`  第 ${i} 张：求解失败（${err instanceof CaptchaUnavailable ? err.message : String(err)}）`);
        continue;
      }
      const res = await request('POST', '/web/user/login', { body: { userName: user, password: pass, captcha: guess } });
      const accepted = res?.isOk === true || !(res?.message ?? '').includes('验证码');
      console.log(`  第 ${i} 张 ${guess} -> ${res?.isOk === true ? '登录成功' : res?.message ?? '失败'}`);
      if (accepted) {
        code = guess;
        t1Result = res;
      }
    }
    if (!t1Result) {
      console.log(`\n${tries} 张都没解对，求解器命中率不够，调大 --tries 或先调求解器（node doctor.mjs --probe 20）。`);
      process.exit(1);
    }
    writeFileSync(SESSION_FILE, `${JSON.stringify([saved], null, 2)}\n`);
  } else {
    cookieJarClear();
    const sample = await fetchCaptcha();
    const { file } = storeCaptchaSample(sample, { kind: 'logintest' });
    writeFileSync(SESSION_FILE, `${JSON.stringify({ cookies: cookieJarSnapshot(), captchaFile: file }, null, 2)}\n`);
    console.log(`验证码已抓（会话已存）：${file}`);
    console.log('放大读图：magick "<file>" -colorspace Gray -normalize -filter Lanczos -resize 600% /tmp/cap.png');
    console.log('读出 4 位后运行：node logintest.mjs --captcha XXXX');
    process.exit(0);
  }
} else {
  saved = JSON.parse(readFileSync(SESSION_FILE, 'utf8'));
}

const alreadyIn = argv.includes('--codes') || Boolean(t1Result);

if (t1Result) {
  record(`T1 登录（${mask(user)} + ${code}）`, t1Result.isOk === true ? '成功' : '失败', t1Result.message ?? '');
  if (t1Result.isOk !== true) {
    console.log('\n验证码读对了，但账号那一层没过 —— 这是凭据问题，跟读图无关。');
    console.log('换一个候选密码再跑：node logintest.mjs --auto --tries 6 --password <候选>');
    console.log('下面的 T2（登录成功后还要不要验证码）需要有一次成功登录才能测。');
    process.exit(3);
  }
} else if (!alreadyIn) {
  // T0 基线：全新会话 + 乱码验证码
  cookieJarClear();
  const t0 = await request('POST', '/web/user/login', { body: { userName: user, password: pass, captcha: 'ZZZZ' } });
  record('T0 全新会话+乱码验证码', t0.message === '验证码错误' ? '验证码仍然必填' : '异常', t0.message);

  // T1 真登录：用保存的那条会话 + 人工/求解器给出的码
  cookieJarRestore(saved.cookies);
  const t1 = await request('POST', '/web/user/login', { body: { userName: user, password: pass, captcha: code } });
  const t1ok = t1?.isOk === true;
  record(`T1 登录（${mask(user)} + ${code}）`, t1ok ? '成功' : '失败', t1.message ?? '');
  if (!t1ok) {
    console.log('\n登录没成功，后面的判定没有意义。码可能读错了（换一张重来），也可能是账号/规则问题。');
    process.exit(1);
  }
} else {
  record(`T1 登录（${mask(user)} + ${code}）`, '成功', '（--codes 已登入，跳过重复提交）');
}

// T2 关键：同一条会话，不再抓图、不带验证码，再登录一次
const t2 = await request('POST', '/web/user/login', { body: { userName: user, password: pass, captcha: '' } });
const t2verdict = t2?.isOk === true ? '不需要验证码' : t2.message?.includes('验证码') ? '仍然需要验证码' : `其它：${t2.message ?? ''}`;
record('T2 同会话、不带验证码再登录', t2verdict, t2.message ?? '');

// T3 同一条会话，复用刚才那个已经用过的码
const t3 = await request('POST', '/web/user/login', { body: { userName: user, password: pass, captcha: code } });
record('T3 同会话、复用旧码', t3?.isOk === true ? '旧码可复用' : t3.message?.includes('验证码') ? '旧码已作废' : `其它：${t3.message ?? ''}`, t3.message ?? '');

// T4 会话是否仍然有效
let alive = null;
cookieJarRestore(saved.cookies);
try {
  const me = await api.me();
  alive = me?.isOk === true || me?.code !== 401;
} catch (err) {
  alive = !(err instanceof SessionExpired);
}
record('T4 登录后 /web/pc/user', alive ? '会话有效' : '会话已失效', '');

// T5 会话寿命（可选）
const watchMin = Number(value('--watch', 0)) || 0;
if (watchMin > 0) {
  const started = Date.now();
  let lastOk = 0;
  console.log(`\n观测会话寿命（每 60s 打一次 /web/pc/user，最多 ${watchMin} 分钟）…`);
  while ((Date.now() - started) / 60000 < watchMin) {
    await new Promise((r) => setTimeout(r, 60_000));
    try {
      await api.me();
      lastOk = (Date.now() - started) / 60000;
      console.log(`  +${lastOk.toFixed(1)}min 仍然有效`);
    } catch (err) {
      console.log(`  +${((Date.now() - started) / 60000).toFixed(1)}min 失效（${err.name}）`);
      break;
    }
  }
  record('T5 会话寿命', `≥ ${lastOk.toFixed(0)} 分钟`, '（到点未失效就是下界）');
}

console.log('\n=== 结论 ===');
if (t2?.isOk === true) {
  console.log('登录成功后，同一条会话再登录**不需要**图形验证码 —— 可以固化成脚本：');
  console.log('一次人工/OCR 登录拿到会话，之后在这条会话里重登免验证码（会话一失效就要重新解一张图）。');
} else {
  console.log('每次登录都**要**图形验证码 —— 想完全脱离 agent，就得让求解器顶住（见 docs/LIBSEAT_MCP.md 的扩展方向）。');
}
console.log('另外：会话只要没失效就根本不用重登，寿命决定要不要反复登录（T4/T5）。');
console.log(JSON.stringify({ at: new Date().toISOString(), user: mask(user), steps }, null, 2));
writeFileSync(path.join(DIR, 'captcha-samples', 'logintest-result.json'), `${JSON.stringify({ at: new Date().toISOString(), steps }, null, 2)}\n`);
