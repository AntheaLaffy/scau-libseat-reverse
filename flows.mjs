// 组合流程：批量抓样本、求解器探针。doctor CLI 与 MCP 工具共用。
import { api } from './api.mjs';
import { CaptchaUnavailable, appendManifest, fetchCaptcha, solveCaptcha, storeCaptchaSample } from './captcha.mjs';
import { config } from './config.mjs';
import { cookieJarClear } from './http.mjs';
import { trackCaptcha } from './session.mjs';

/** 连抓 N 张验证码，各自独立会话，落盘 + 记 manifest */
export async function captureSamples({ count = 1, user, track = true } = {}) {
  const out = [];
  for (let i = 1; i <= count; i += 1) {
    cookieJarClear();
    const sample = await fetchCaptcha();
    const { file, record } = storeCaptchaSample(sample, { kind: 'capture', seq: i, user: user ?? config.user ?? null });
    out.push({ file, record });
    // 最后一张留在“待解码”状态：人工/模型读完码可以直接交给 libseat_login
    if (track) trackCaptcha(sample, file, user ?? config.user ?? null);
  }
  return out;
}

export function classifyLoginResponse(res) {
  if (res?.isOk === true) return 'login_ok';
  const message = res?.message ?? '';
  if (message.includes('验证码')) return 'captcha_rejected';
  return 'captcha_accepted';
}

/**
 * 求解器探针：每轮“抓图 → 求解 → 用探针账号试登一次”。
 * captcha_rejected = 求解结果不被服务端接受；captcha_accepted = 验证码通过了，
 * 报错已经落到账号/密码那一层 —— 这是判断求解器是否稳定的确定性信号，
 * 不需要真实可用账号。
 */
export async function probeSolver({ rounds = 5, user, password, save = true } = {}) {
  const probeUser = user ?? config.probeUser ?? config.user;
  const probePass = password ?? config.probePass ?? config.pass;
  if (!probeUser || !probePass) {
    throw new Error('探针需要一个账号（LIBSEAT_PROBE_USER/LIBSEAT_PROBE_PASS，或直接用你的账号）：只用来判断验证码是否被接受');
  }

  const results = [];
  for (let i = 1; i <= rounds; i += 1) {
    cookieJarClear();
    const sample = await fetchCaptcha();
    const stored = save ? storeCaptchaSample(sample, { kind: 'probe', userName: probeUser }) : { file: null, record: null };
    const entry = { round: i, captchaFile: stored.file, sha256: sample.sha256 };
    try {
      const guess = await solveCaptcha(sample.buffer, stored.file, sample);
      entry.guess = guess;
      const res = await api.login({ userName: probeUser, password: probePass, captcha: guess });
      entry.verdict = classifyLoginResponse(res);
      entry.message = res?.message ?? '';
      if (save && stored.file) {
        appendManifest({ ts: sample.ts, file: stored.file, sha256: sample.sha256, kind: 'probe-result', guess, verdict: entry.verdict, message: entry.message });
      }
    } catch (err) {
      entry.verdict = err instanceof CaptchaUnavailable ? 'solver_unavailable' : 'error';
      entry.message = err.message;
    }
    results.push(entry);
  }

  const accepted = results.filter((r) => r.verdict !== 'captcha_rejected' && r.verdict !== 'solver_unavailable' && r.verdict !== 'error').length;
  const solved = results.filter((r) => r.guess).length;
  return {
    rounds,
    solved,
    accepted,
    accuracy: solved ? Number((accepted / solved).toFixed(3)) : null,
    results,
    note: 'accepted 计的是“验证码被服务端接受”的次数（报错已落到账号层），这是求解器的真·命中率',
  };
}
