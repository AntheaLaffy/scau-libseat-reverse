// 统一身份认证（CAS / lyuapServer）登录 —— 完全免图形验证码。
//
// 逆向来源：https://cas.scau.edu.cn/lyuapServer/assets/js/app.<hash>.js
//   - module 7 里硬编码了 RSA 公钥（public_exponent / modulus）与 CAS 基址；
//   - 登录 POST 到 `{CAS}/v1/tickets`（form-urlencoded：username / password / service …），
//     响应是 {"tgt":"TGT-…","ticket":"ST-…"}；
//   - 拿到 ticket 后跳 `{service}?ticket=ST-…`，业务系统（libseat）校验后下发 webuser 会话。
//
// 密码不是 PKCS#1，而是前端那套「BigInt + Barrett 分块裸 RSA」：
//   chunkSize = 2 × 模数最高非零 16 位字（1024 位模数 → 126 字节）
//   明文按 charCodeAt 逐字节、**小端**打包成 16 位字 → powMod(block, e) → 每个 16 位字固定 4 位 hex
//   （高位零字省略），分块之间用空格连接。
// 实测：PKCS#1 会得到 PASSERROR，而这套算法直接拿到 ticket。
import { config } from './config.mjs';
import { cookieJarClear, fetchWithJar } from './http.mjs';

// 来自前端 module 7；学校换密钥时按同样位置重新提取即可。
export const CAS_BASE = 'https://cas.scau.edu.cn/lyuapServer';
const PUBLIC_EXPONENT = '010001';
const MODULUS =
  '00b5eeb166e069920e80bebd1fea4829d3d1f3216f2aabe79b6c47a3c18dcee5fd22c2e7ac519cab59198ece036dcf289' +
  'ea8201e2a0b9ded307f8fb704136eaeb670286f5ad44e691005ba9ea5af04ada5367cd724b5a26fdb5120cc95b6431604' +
  'bd219c6b7d83a6f8f24b43918ea988a76f93c333aa5a20991493d4eb1117e7b1';

// 与前端 m() 一致：从右往左每 4 个 hex 字符切一个 16 位字
function toDigits(hexText) {
  const out = [];
  let h = hexText;
  while (h.length) {
    out.push(Number.parseInt(h.slice(-4), 16));
    h = h.slice(0, -4);
  }
  return out;
}

function highIndex(digits) {
  let i = digits.length - 1;
  while (i > 0 && digits[i] === 0) i -= 1;
  return i;
}

export function chunkSizeOf(modulusHex = MODULUS) {
  return 2 * highIndex(toDigits(modulusHex));
}

/** 完全按前端 encryptedString() 的算法加密（返回可能带空格的多段密文） */
export function rsaEncrypt(text, modulusHex = MODULUS, exponentHex = PUBLIC_EXPONENT) {
  const m = BigInt(`0x${modulusHex}`);
  const e = BigInt(`0x${exponentHex}`);
  const chunkSize = chunkSizeOf(modulusHex);
  const data = [...text].map((c) => c.charCodeAt(0) & 0xff);
  while (data.length % chunkSize) data.push(0);

  const parts = [];
  for (let i = 0; i < data.length; i += chunkSize) {
    const block = data.slice(i, i + chunkSize);
    // 小端打包：block.digits[j] = a[k] + (a[k+1] << 8)
    let value = 0n;
    for (let j = block.length - 1; j >= 0; j -= 1) value = (value << 8n) | BigInt(block[j]);
    const crypt = powMod(value, e, m);
    let hex = crypt.toString(16);
    if (hex.length % 4) hex = '0'.repeat(4 - (hex.length % 4)) + hex;
    parts.push(hex);
  }
  return parts.join(' ');
}

function powMod(base, exp, mod) {
  let result = 1n;
  let b = base % mod;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % mod;
    b = (b * b) % mod;
    e >>= 1n;
  }
  return result;
}

export class CasLoginError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CasLoginError';
    this.code = code ?? null;
  }
}

const CAS_CODE_MESSAGES = {
  PASSERROR: '账号或密码错误',
  NOUSER: '账号不存在',
  USERLOCK: '账号已锁定',
  USERNOTONLY: '账号存在多个',
  CODEFALSE: '需要输入验证码（连续失败达到阈值后，CAS 会要求滑块验证码）',
  ISMODIFYPASS: '账号需要修改密码',
  NOREGISTER: '账号未注册到该应用',
  NOAUTHORIZATION: '账号未授权该应用',
};

/**
 * 走 CAS 登录，并把业务系统的会话落进共享 cookie jar（webuser JWT）。
 * @returns {{ticket:string, tgt:string|null}}
 */
export async function casLogin({ user, password, service, casBase = CAS_BASE } = {}) {
  const userName = user ?? config.user;
  const passWord = password ?? config.pass;
  if (!userName || !passWord) throw new CasLoginError('缺少账号或密码');
  const target = service ?? `${config.baseUrl}/sso/scau`;

  cookieJarClear();
  const form = new URLSearchParams({ username: userName, password: rsaEncrypt(passWord), service: target });
  const res = await fetchWithJar(`${casBase}/v1/tickets`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json, text/plain, */*',
      referer: `${casBase}/login?service=${encodeURIComponent(target)}`,
    },
    body: form.toString(),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new CasLoginError(`CAS 返回的不是 JSON（HTTP ${res.status}）: ${text.slice(0, 120)}`);
  }

  const code = json?.data?.code;
  if (code) throw new CasLoginError(CAS_CODE_MESSAGES[code] ?? `CAS 拒绝：${code}`, code);
  const ticket = json?.ticket ?? json?.data?.ticket;
  if (!ticket) throw new CasLoginError(`CAS 没给 ticket：${text.slice(0, 160)}`);

  // 拿 ticket 换业务系统会话（会 302 回首页，webuser 落在 jar 里）
  const cb = new URL(target);
  cb.searchParams.set('ticket', ticket);
  const ticketRes = await followRedirects(cb.toString());
  if (ticketRes.status >= 500) throw new CasLoginError(`业务系统校验 ticket 失败（HTTP ${ticketRes.status}）`);

  return { ticket, tgt: json?.tgt ?? null, finalUrl: ticketRes.url ?? cb.toString() };
}

/**
 * 手动跟跳转：Node 的 fetch 不会在重定向之间保留 Set-Cookie，
 * 而 libseat 的 webuser 正是挂在 302 上，必须自己一跳一跳收 cookie。
 */
async function followRedirects(url, maxHops = 6) {
  let current = url;
  let res;
  for (let hop = 0; hop < maxHops; hop += 1) {
    res = await fetchWithJar(current, { method: 'GET', headers: { accept: 'text/html,application/json,*/*' }, redirect: 'manual' });
    if (res.status < 300 || res.status >= 400) return res;
    const location = res.headers.get('location');
    if (!location) return res;
    current = new URL(location, current).toString();
  }
  throw new CasLoginError('ticket 校验跳转次数过多');
}

export function describeCas() {
  return { base: CAS_BASE, chunkSize: chunkSizeOf(), modulus: `${MODULUS.slice(0, 16)}…` };
}
