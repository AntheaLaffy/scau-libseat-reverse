// 配置来源：进程环境变量 > .env 文件（同目录，gitignore）。
// 所有凭据只在本机读取，不写回、不落日志。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length > 1 && ((value[0] === '"' && value.at(-1) === '"') || (value[0] === "'" && value.at(-1) === "'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(process.env.LIBSEAT_ENV_FILE || path.join(ROOT, '.env'));

const str = (key, fallback = '') => (process.env[key] ?? fallback).trim();
const num = (key, fallback) => {
  const n = Number(str(key, String(fallback)));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export const config = {
  baseUrl: str('LIBSEAT_BASE_URL', 'https://libseat.scau.edu.cn').replace(/\/+$/, ''),
  user: str('LIBSEAT_USER'),
  pass: str('LIBSEAT_PASS'),

  // cas: 走统一身份认证（免验证码，推荐）; local: 走站点自带账号密码 + 图形验证码
  loginMode: str('LIBSEAT_LOGIN_MODE', 'cas').toLowerCase(),

  // command: 本地命令（{file} 占位图片路径）; http: 远端/本地服务; manual: 人工;
  // none: 只抓图不解码（供外部流程消费）
  captchaMode: str('LIBSEAT_CAPTCHA_MODE', 'manual').toLowerCase(),
  captchaCmd: str('LIBSEAT_CAPTCHA_CMD'),
  captchaHttpUrl: str('LIBSEAT_CAPTCHA_HTTP_URL'),
  captchaHttpToken: str('LIBSEAT_CAPTCHA_HTTP_TOKEN'),
  captchaDir: path.resolve(ROOT, str('LIBSEAT_CAPTCHA_DIR', 'captcha-samples')),

  // 每次重试都会换新会话 + 新验证码（验证码与 JSESSIONID 绑定）
  loginRetries: num('LIBSEAT_LOGIN_RETRIES', 5),
  // 探针账号：只用来判断“求解器给出的验证码是否被服务端接受”，可留空
  probeUser: str('LIBSEAT_PROBE_USER'),
  probePass: str('LIBSEAT_PROBE_PASS'),

  // 校区 id（/web/area/district 强制要 id；留空时自动用当前账号的 district_id）
  districtId: str('LIBSEAT_DISTRICT_ID'),

  timeoutMs: num('LIBSEAT_HTTP_TIMEOUT_MS', 20000),
};

export const API_PREFIX = '/api';

export function describeConfig() {
  return {
    baseUrl: config.baseUrl,
    apiPrefix: API_PREFIX,
    user: config.user ? maskUser(config.user) : null,
    password: config.pass ? '已设置' : null,
    loginMode: config.loginMode,
    captchaMode: config.captchaMode,
    captchaCmd: config.captchaCmd || null,
    captchaHttpUrl: config.captchaHttpUrl || null,
    captchaDir: config.captchaDir,
    loginRetries: config.loginRetries,
    probeUser: config.probeUser ? maskUser(config.probeUser) : null,
    timeoutMs: config.timeoutMs,
    envFile: path.join(ROOT, '.env'),
  };
}

function maskUser(user) {
  if (user.length <= 3) return `${user[0]}**`;
  return `${user.slice(0, 2)}***${user.slice(-2)}`;
}
