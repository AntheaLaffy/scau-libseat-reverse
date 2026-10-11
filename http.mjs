// 会话与请求层。
//
// 站点鉴权完全靠 JSESSIONID（fetch credentials:"include"、没有任何 Authorization
// 头），所以“不用 cookie”落在这里的语义是：**不持久化、不导出任何 cookie**，
// 只在进程内存里维持当前这条会话；401 就丢掉重登。cookie 本身是协议的一部分，
// 无法绕过。
import { API_PREFIX, config } from './config.mjs';

const jar = new Map();

export class SessionExpired extends Error {
  constructor(message = '登录已过期') {
    super(message);
    this.name = 'SessionExpired';
  }
}

export class HttpError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

export function cookieJarClear() {
  jar.clear();
  idempotentToken = null;
}

export function cookieJarSnapshot() {
  return Object.fromEntries(jar);
}

/** 还原一份 cookie 快照（人工读图链路要用：图和解码必须是同一条会话） */
export function cookieJarRestore(snapshot = {}) {
  jar.clear();
  idempotentToken = null;
  for (const [k, v] of Object.entries(snapshot)) jar.set(k, v);
}

function absorbSetCookie(res) {
  const list = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const pair = raw.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function buildUrl(apiPath, query, absolute) {
  const base = absolute ? '' : config.baseUrl + API_PREFIX;
  const url = new URL(base + apiPath);
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null) continue;
    url.searchParams.set(k, String(v));
  }
  return url;
}

/**
 * 带共享 cookie jar 的裸请求（CAS 那些非 /api 的地址要用它）。
 * 只吸收 Set-Cookie，不改动响应体。
 */
export async function fetchWithJar(url, { method = 'GET', headers = {}, body, timeoutMs = config.timeoutMs, redirect = 'follow' } = {}) {
  const finalHeaders = { ...headers };
  const cookie = cookieHeader();
  if (cookie) finalHeaders.cookie = cookie;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method, headers: finalHeaders, body, redirect, signal: ac.signal });
    absorbSetCookie(res);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// /op/* 需要一次性幂等令牌（前端在请求前先取一次，失败则退化继续）
const IDEMPOTENT_PATHS = ['/op/user/info/post', '/op/area/seats/post', '/op/seats/type/post', '/op/ad/a/post'];
let idempotentToken = null;

async function idempotentHeaderFor(apiPath) {
  if (!IDEMPOTENT_PATHS.some((p) => apiPath.startsWith(p))) return null;
  if (idempotentToken) return idempotentToken;
  try {
    const res = await request('GET', '/op/idempotent/token', { auth: false });
    if (res?.code === 200 && res.data?.token) idempotentToken = res.data.token;
  } catch {
    // 前端的行为就是“拿不到也继续”
  }
  return idempotentToken;
}

/**
 * @param {'GET'|'POST'|'PUT'|'DELETE'} method
 * @param {string} apiPath 以 / 开头的路径，如 /web/user/duelist
 * @param {{body?:object, query?:object, headers?:object, auth?:boolean, binary?:boolean, absolute?:boolean, timeoutMs?:number}} opts
 */
export async function request(method, apiPath, opts = {}) {
  const { body, query, headers = {}, auth = false, binary = false, absolute = false, timeoutMs = config.timeoutMs } = opts;
  const url = buildUrl(apiPath, query, absolute);

  const finalHeaders = {
    accept: binary ? 'image/*,*/*' : 'application/json, text/plain, */*',
    ...headers,
  };
  if (body !== undefined) finalHeaders['content-type'] = 'application/json;charset=utf-8';
  const cookie = cookieHeader();
  if (cookie) finalHeaders.cookie = cookie;
  const idem = await idempotentHeaderFor(apiPath);
  if (idem) finalHeaders['Idempotent-Token'] = idem;

  const ac = new AbortController();
  let res;
  try {
    res = await fetchWithJar(url, { method, headers: finalHeaders, body: body === undefined ? undefined : JSON.stringify(body), timeoutMs });
  } catch (err) {
    throw new HttpError(`请求 ${method} ${apiPath} 失败: ${err.message}`);
  }

  if (binary) {
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get('content-type') ?? '', status: res.status, apiPath };
  }

  const text = await res.text();
  if (res.status === 204 || res.status === 201 || text.length === 0) {
    return { isOk: res.ok, status: res.status, data: null, message: '' };
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new HttpError(`响应不是 JSON（${apiPath}）`, { status: res.status, body: text.slice(0, 200) });
  }
  if (!res.ok && json.code === undefined && json.isOk === undefined) {
    throw new HttpError(`HTTP ${res.status}（${apiPath}）`, { status: res.status, body: json });
  }
  // 站点的未登录约定：{code:401} / {msg:"请登录访问"}
  if (json.code === 401 && auth) throw new SessionExpired(json.msg ?? json.message ?? '请登录访问');
  return json;
}

/** 带会话自动重建的调用：401 时重登一次再试 */
export async function withSession(fn, relogin) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof SessionExpired)) throw err;
    await relogin();
    return fn();
  }
}
