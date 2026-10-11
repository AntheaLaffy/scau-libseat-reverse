// 会话状态机：账号密码 → （新会话 + 新验证码）→ 登录 → 内存会话；401 自动重登。
import { api } from './api.mjs';
import { casLogin } from './cas.mjs';
import { CaptchaUnavailable, fetchCaptcha, solveCaptcha, storeCaptchaSample } from './captcha.mjs';
import { config } from './config.mjs';
import { SessionExpired, cookieJarClear, cookieJarRestore, cookieJarSnapshot } from './http.mjs';

const state = {
  user: null,
  loginAt: null,
  attempts: [],
  lastCaptchaFile: null,
};

// 人工读图链路：图和它的 JSESSIONID 必须成对保留，否则第二次调用会换图，
// 提交的码必然对不上（验证码与会话绑定）。
let pending = null;

export function pendingCaptcha() {
  return pending ? { file: pending.file, sha256: pending.sha256, ts: pending.ts, user: pending.user } : null;
}

export function clearPendingCaptcha() {
  pending = null;
}

function rememberPending(sample, file, user) {
  pending = { file, sha256: sample.sha256, ts: sample.ts, cookies: cookieJarSnapshot(), user: user ?? null };
}

/** 供抓图工具挂钩：抓完图把“图 + 会话”留成待解码状态 */
export function trackCaptcha(sample, file, user) {
  rememberPending(sample, file, user);
}

export class LoginFailed extends Error {
  constructor(message, attempts) {
    super(message);
    this.name = 'LoginFailed';
    this.attempts = attempts;
  }
}

export function sessionStatus() {
  return {
    loggedIn: Boolean(state.user),
    loginAt: state.loginAt,
    loginMode: config.loginMode,
    user: state.user
      ? {
          id: state.user.id ?? state.user.userid ?? null,
          name: state.user.userName ?? state.user.name ?? state.user.nickname ?? null,
          phone: state.user.phone ?? null,
          email: state.user.email ?? null,
        }
      : null,
    lastCaptchaFile: state.lastCaptchaFile,
    attempts: state.attempts.slice(-10),
  };
}

export function forgetSession() {
  state.user = null;
  state.loginAt = null;
  pending = null;
  cookieJarClear();
}

function isCaptchaError(message = '') {
  return message.includes('验证码');
}

/**
 * 登录。默认走 .env 里的账号；也可显式传 user/password/captcha。
 * captcha 显式传入时只尝试一次（人工/外部流水线已解好的码）。
 */
export async function login({ user, password, captcha, keepAttempts = false } = {}) {
  const userName = user ?? config.user;
  const userPass = password ?? config.pass;
  if (!userName || !userPass) {
    throw new LoginFailed('缺少账号或密码：请在 mcp/libseat/.env 里配置 LIBSEAT_USER / LIBSEAT_PASS', []);
  }

  if (!keepAttempts) state.attempts = [];

  // 统一身份认证：没有图形验证码，一次请求换 ticket，跳回业务系统即完成登录
  if (config.loginMode === 'cas') {
    state.user = null;
    state.loginAt = null;
    clearPendingCaptcha();
    const res = await casLogin({ user: userName, password: userPass });
    const me = await api.me();
    if (me?.isOk !== true) {
      throw new LoginFailed(`CAS 走的通，但业务系统会话没建立（${me?.msg ?? me?.message ?? '未知'}）`, state.attempts.slice());
    }
    state.user = me.data?.user ?? {};
    state.loginAt = new Date().toISOString();
    state.attempts.push({ mode: 'cas', ticket: res.ticket, isOk: true, message: 'ok' });
    return { user: state.user, attempts: state.attempts, captchaFile: null };
  }

  // 有人工/外部流程解出的码 → 用“那张图绑定的会话”原样提交一次（换会话提交必然对不上）
  if (captcha) {
    if (!pending) {
      throw new LoginFailed('没有待提交的验证码会话：先调用一次不带 captcha 的 libseat_login 拿图，再带码提交', state.attempts.slice());
    }
    cookieJarRestore(pending.cookies);
    const res = await api.login({ userName, password: userPass, captcha });
    state.attempts.push({ attempt: 0, captchaFile: pending.file, captcha, isOk: res?.isOk === true, message: res?.message ?? '' });
    state.lastCaptchaFile = pending.file;
    clearPendingCaptcha();
    if (res?.isOk === true) {
      state.user = res.data ?? {};
      state.loginAt = new Date().toISOString();
      return { user: state.user, attempts: state.attempts, captchaFile: state.lastCaptchaFile };
    }
    // 码不对：这张图作废，不直接失败，转入“新图重试”；manual 模式下会把下一张图交回调用方
    captcha = undefined; // 用掉的码不能套在新图上再提交一次
  }

  state.user = null;
  state.loginAt = null;
  const tries = Math.max(1, config.loginRetries);

  for (let i = 1; i <= tries; i += 1) {
    // 每次尝试都用全新会话：验证码与 JSESSIONID 绑定，且提交后即失效
    cookieJarClear();
    const sample = await fetchCaptcha();
    const { file } = storeCaptchaSample(sample, { attempt: i, userName });
    state.lastCaptchaFile = file;

    let code = captcha;
    if (!code) {
      try {
        code = await solveCaptcha(sample.buffer, file, sample);
      } catch (err) {
        if (err instanceof CaptchaUnavailable) {
          // 留着这条会话，等下一次调用把人工读出的码提交上来
          rememberPending(sample, file, userName);
          state.attempts.push({ attempt: i, captchaFile: file, error: err.message });
          err.file = file;
          throw err;
        }
        throw err;
      }
    }

    const res = await api.login({ userName, password: userPass, captcha: code });
    state.attempts.push({ attempt: i, captchaFile: file, captcha: code, isOk: res?.isOk === true, message: res?.message ?? '' });

    if (res?.isOk === true) {
      state.user = res.data ?? {};
      state.loginAt = new Date().toISOString();
      clearPendingCaptcha();
      return { user: state.user, attempts: state.attempts, captchaFile: file };
    }
    if (isCaptchaError(res?.message ?? '')) continue; // 换图重试
    throw new LoginFailed(res?.message || '登录失败', state.attempts.slice());
  }

  throw new LoginFailed(`连续 ${tries} 次验证码未通过（求解器命中率不足或图片风格变化）`, state.attempts.slice());
}

/** 已登录则直接返回，否则登录（供各工具调用） */
export async function ensureLogin() {
  if (state.user) return state.user;
  await login();
  return state.user;
}

export async function relogin() {
  forgetSession();
  await login();
}

export { SessionExpired };
