// 图形验证码：稳定复现 + 可插拔求解。
//
// 逆向结论（libseat.scau.edu.cn）：
//   GET  /api/web/user/captcha?t=<毫秒时间戳>  -> image/jpeg 120x40 + Set-Cookie: JSESSIONID
//   POST /api/web/user/login {userName,password,captcha} 先校验验证码，错则 {"message":"验证码错误"}
//
// 因此“稳定复现”= 三件套绑定关系：一张字节确定的图 + 生成它的 JSESSIONID + 那次登录结果。
// 每次登录尝试都必须换一套（服务端消费/校验后该验证码不可复用），本模块把每次尝试
// 落盘成 manifest.jsonl，供求解器离线调参、回放、算准确率。
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { cookieJarSnapshot, request } from './http.mjs';

export class CaptchaUnavailable extends Error {
  constructor(message, { file } = {}) {
    super(message);
    this.name = 'CaptchaUnavailable';
    this.file = file;
  }
}

/** 抓一张验证码（同时把 JSESSIONID 收进当前会话） */
export async function fetchCaptcha() {
  const res = await request('GET', '/web/user/captcha', { query: { t: Date.now() }, binary: true });
  if (!res.buffer.length) throw new CaptchaUnavailable('验证码响应为空');
  return {
    buffer: res.buffer,
    ts: new Date().toISOString(),
    contentType: res.contentType,
    bytes: res.buffer.length,
    sha256: crypto.createHash('sha256').update(res.buffer).digest('hex'),
    jsessionid: cookieJarSnapshot().JSESSIONID ?? null,
  };
}

/** 落盘一张样本，并在 manifest.jsonl 追加一条可回放记录 */
export function storeCaptchaSample(sample, extra = {}) {
  mkdirSync(config.captchaDir, { recursive: true });
  const stamp = sample.ts.replace(/[:.]/g, '-');
  const file = path.join(config.captchaDir, `${stamp}-${sample.sha256.slice(0, 8)}.jpg`);
  writeFileSync(file, sample.buffer);
  const record = {
    ts: sample.ts,
    file,
    sha256: sample.sha256,
    bytes: sample.bytes,
    contentType: sample.contentType,
    jsessionid: sample.jsessionid,
    ...extra,
  };
  appendFileSync(path.join(config.captchaDir, 'manifest.jsonl'), `${JSON.stringify(record)}\n`);
  return { file, record };
}

/** 只追加一条记录（不重复写图），用于回填求解结果/登录判定 */
export function appendManifest(record) {
  mkdirSync(config.captchaDir, { recursive: true });
  appendFileSync(path.join(config.captchaDir, 'manifest.jsonl'), `${JSON.stringify(record)}\n`);
}

const CODE_RE = /[0-9A-Za-z]{4}/;

function pickCode(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const direct = text.replace(/[^0-9A-Za-z]/g, '');
  if (direct.length === 4) return direct;
  const hit = text.match(CODE_RE);
  return hit ? hit[0] : null;
}

function runCommand(cmd, file) {
  const hasPlaceholder = cmd.includes('{file}');
  const quoted = `'${file.replace(/'/g, `'\\''`)}'`;
  const line = hasPlaceholder ? cmd.replaceAll('{file}', quoted) : `${cmd} ${quoted}`;
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', line], { timeout: config.timeoutMs });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`求解命令退出码 ${code}: ${err.trim() || out.trim()}`));
    });
  });
}

async function runHttp(buffer, sample) {
  const headers = { 'content-type': 'application/json' };
  if (config.captchaHttpToken) headers.authorization = `Bearer ${config.captchaHttpToken}`;
  const res = await fetch(config.captchaHttpUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      image_base64: buffer.toString('base64'),
      image_sha256: sample.sha256,
      content_type: sample.contentType,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`求解服务 HTTP ${res.status}: ${text.slice(0, 200)}`);
  try {
    const json = JSON.parse(text);
    return json.code ?? json.captcha ?? json.result ?? json.text ?? text;
  } catch {
    return text;
  }
}

/**
 * 求解一张验证码。返回 4 位码；manual/none 模式抛 CaptchaUnavailable（附图片路径）。
 * 用户自定义方案只需满足这里的一种接口，无需改动其它代码。
 */
export async function solveCaptcha(buffer, file, sample = {}) {
  switch (config.captchaMode) {
    case 'command': {
      if (!config.captchaCmd) throw new CaptchaUnavailable('LIBSEAT_CAPTCHA_MODE=command 但未设置 LIBSEAT_CAPTCHA_CMD', { file });
      const code = pickCode(await runCommand(config.captchaCmd, file));
      if (!code) throw new CaptchaUnavailable(`求解命令未输出 4 位验证码（${config.captchaCmd}）`, { file });
      return code;
    }
    case 'http': {
      if (!config.captchaHttpUrl) throw new CaptchaUnavailable('LIBSEAT_CAPTCHA_MODE=http 但未设置 LIBSEAT_CAPTCHA_HTTP_URL', { file });
      const code = pickCode(await runHttp(buffer, sample));
      if (!code) throw new CaptchaUnavailable('求解服务未返回 4 位验证码', { file });
      return code;
    }
    case 'none':
    case 'manual':
    default:
      throw new CaptchaUnavailable('当前为人工/无求解模式，请读取图片后把验证码传给 libseat_login', { file });
  }
}

export function describeCaptchaMode() {
  return {
    mode: config.captchaMode,
    command: config.captchaCmd || null,
    httpUrl: config.captchaHttpUrl || null,
    sampleDir: config.captchaDir,
  };
}
