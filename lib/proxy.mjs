// dsh-remote 本机代理：loopback 权威改写反向代理（改造自 dsh-pocket，同套安全口径）
//
// 职责：
//   - 监听 0.0.0.0:<port>（默认 3081），把入站 Host/Origin 改写成
//     127.0.0.1:<dshPort> 转发给本机 dsh web —— DSH 的浏览器信任栅栏
//     永远看到 loopback，无需改 dsh 任何配置（官方禁用 0.0.0.0 绑定）。
//   - HTTP + WebSocket 全透传（含心跳保活）、大 JSON 流式压缩、
//     dsh 启动 token 自动握手。
//   - 除 loopback 外一律要求访问 PIN（App 用 /?token=<PIN> 换 cookie）。
//   - 内省端点（供中继探测/本机排障）：
//       GET /__dsh-remote/ping   任意来源，无需认证，200 {ok,node,ts}
//       GET /__dsh-remote/status 仅允许 loopback 来源，返回运行状态
//
// 入站路径有两条，安全模型一致：
//   ① 局域网：中继服务器直连 http://<本机LAN IP>:3081（Host 是公网域名 → 必须 PIN）
//   ② 隧道：插件自己对 127.0.0.1:3081 建 TCP（源 loopback，但 Host 仍是公网域名 → 必须 PIN）

import { createServer, request as httpRequest } from 'node:http';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'node:zlib';
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import { classifyHost, classifySource } from './netutil.mjs';
import { settingsPageHtml, SETTINGS_PAGE_PATH, SETTINGS_CONFIG_PATH } from './settings-page.mjs';

const DEFAULT_UPSTREAM = { host: '127.0.0.1', port: 3080 };
const TOKEN_COOKIE = 'dsh_remote_token';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const DSH_AUTH_COOKIE = 'dsh-auth-';
const LOGIN_PATH = '/remote-login';
export const PING_PATH = '/__dsh-remote/ping';
export const STATUS_PATH = '/__dsh-remote/status';
const SETTINGS_BODY_LIMIT = 1024 * 1024;

// ---------- 浏览器 polyfill（非安全上下文 / 旧 WebView 需要，原生 App 不受影响） ----------

const RANDOM_UUID_POLYFILL = `<script data-dsh-remote-polyfill="1">!function(){try{if(self.crypto&&!self.crypto.randomUUID){self.crypto.randomUUID=function(){var b=new Uint8Array(16);self.crypto.getRandomValues(b);b[6]=b[6]&15|64;b[8]=b[8]&63|128;var h="";for(var i=0;i<16;i++){var x=b[i].toString(16);h+=(x.length<2?"0":"")+x;if(i===3||i===5||i===7||i===9)h+="-";}return h;}}}catch(e){}}();
!function(){try{if(self.AbortSignal&&!self.AbortSignal.any){self.AbortSignal.any=function(signals){var controller=new AbortController();var list=Array.from(signals||[]);var done=false;var handlers=list.map(function(signal){return function(){abort(signal);};});function cleanup(){for(var i=0;i<list.length;i++){try{list[i].removeEventListener('abort',handlers[i]);}catch(e){}}}function abort(signal){if(done)return;done=true;cleanup();try{controller.abort(signal.reason);}catch(e){controller.abort();}}for(var j=0;j<list.length;j++){var sig=list[j];if(sig.aborted){abort(sig);break;}sig.addEventListener('abort',handlers[j],{once:true});}return controller.signal;};}}catch(e){}}();</script>`;

const TRANSPORT_API_CLIENT_SHIM = `<script data-dsh-remote-transport-shim="1">!function(){try{var K='__DSH_TRANSPORT__',cur=globalThis[K];function patch(t){try{if(t&&typeof t==='object'&&typeof t.createApiClient!=='function'){try{Object.defineProperty(t,'createApiClient',{value:function(){return null;},writable:true,configurable:true});}catch(e){try{t.createApiClient=function(){return null;};}catch(e2){}}}}catch(e){}return t;}if(cur)patch(cur);Object.defineProperty(globalThis,K,{configurable:true,enumerable:true,get:function(){return cur;},set:function(t){cur=patch(t);}});}catch(e){}}();</script>`;

export const DEFAULT_INJECT = RANDOM_UUID_POLYFILL + TRANSPORT_API_CLIENT_SHIM;
const INJECT_MARK = 'data-dsh-remote-polyfill="1"';

// ---------- 工具 ----------

function isCompressed(headers) {
  return /(^|,\s*)(gzip|br|deflate)(\s*,|$)/i.test(String(headers['content-encoding'] ?? ''));
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return out;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function cookieFor(token, sessionKey) {
  if (!sessionKey) return token;
  return createHash('sha256').update(`${token}:${sessionKey}`).digest('hex');
}

function isHtmlRequest(req) {
  if (String(req.headers.accept ?? '').includes('text/html')) return true;
  let pathname = String(req.url ?? '/');
  try { pathname = new URL(pathname, 'http://dsh.invalid').pathname; } catch { /* 原值 */ }
  return pathname === '/' || /\.html?$/i.test(pathname);
}

/**
 * 用不可伪造的 TCP 源地址给可伪造的 Host 声明设下限（只收紧不放松）。
 * 隧道回连源地址是 loopback、Host 是公网域名 → 按 Host（公网）处理，不放松。
 */
const HOST_CLASS_RANK = { loopback: 0, lan: 1, public: 2 };
export function policyHost(req, host) {
  const actual = classifySource(req?.socket?.remoteAddress);
  if (!actual) return host;
  const claimed = classifyHost(host);
  if (HOST_CLASS_RANK[actual] <= HOST_CLASS_RANK[claimed]) return host;
  let addr = String(req.socket.remoteAddress);
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7);
  return addr;
}

export function clientIp(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  if (classifySource(addr) === 'loopback') {
    const fwd = String(req.headers['x-real-ip'] ?? req.headers['cf-connecting-ip'] ?? '').trim();
    if (fwd) return fwd; // 经 nginx/中继 loopback 回连时信任网关注入的真实 IP
  }
  return addr || 'unknown';
}

// ---------- 限速 ----------

export const DEFAULT_RATE_LIMIT = {
  windowMs: 60_000,
  maxFailures: 5,
  lockMs: 60_000,
  globalMaxFailures: 50,
  globalLockMs: 30_000,
};

function createRateLimiter(cfg = {}) {
  const c = { ...DEFAULT_RATE_LIMIT, ...cfg };
  const failCounts = new Map();
  const ipLocks = new Map();
  const global = { count: 0, windowStart: 0, lockedUntil: 0 };
  return {
    status(ip) {
      const now = Date.now();
      if (global.lockedUntil > now) return { locked: true, retryAfter: Math.ceil((global.lockedUntil - now) / 1000) };
      const until = ipLocks.get(ip) ?? 0;
      if (until > now) return { locked: true, retryAfter: Math.ceil((until - now) / 1000) };
      return { locked: false, retryAfter: 0 };
    },
    record(ip) {
      const now = Date.now();
      let rec = failCounts.get(ip);
      if (!rec || now - rec.windowStart > c.windowMs) rec = { count: 0, windowStart: now };
      rec.count++;
      failCounts.set(ip, rec);
      if (now - global.windowStart > c.windowMs) { global.count = 0; global.windowStart = now; }
      global.count++;
      if (rec.count >= c.maxFailures) ipLocks.set(ip, now + c.lockMs);
      if (global.count >= c.globalMaxFailures) global.lockedUntil = now + c.globalLockMs;
      if (failCounts.size > 2000) {
        for (const [k, v] of failCounts) if (now - v.windowStart > c.windowMs) failCounts.delete(k);
      }
    },
    clear(ip) { failCounts.delete(ip); ipLocks.delete(ip); },
  };
}

// ---------- 页面 ----------

function loginPageHtml(error, retryAfter = 0) {
  const errMsg = error === 'locked'
    ? `尝试次数过多，请 ${retryAfter} 秒后再试`
    : error ? '访问密码错误，请重试' : '';
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote · 访问验证</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:28px 24px;max-width:320px;width:calc(100% - 48px);text-align:center}
h1{font-size:16px;margin:0 0 4px;color:#111827}
p{font-size:13px;color:#6b7280;margin:0 0 16px}
input{width:100%;box-sizing:border-box;padding:10px 12px;font-size:18px;letter-spacing:6px;text-align:center;border:1px solid #d1d5db;border-radius:8px;outline:none;margin-bottom:12px}
input:focus{border-color:#4f6ef7}
button{width:100%;padding:10px;font-size:15px;background:#4f6ef7;color:#fff;border:none;border-radius:8px;cursor:pointer}
.err{color:#dc2626;font-size:12px;margin-bottom:10px;min-height:16px}
</style></head><body><div class="card">
<h1>🔐 DSH Remote</h1>
<p>此地址受访问密码保护，请输入 PIN</p>
<div class="err">${errMsg}</div>
<form method="post" action="${LOGIN_PATH}">
<input name="token" type="password" autocomplete="current-password" autofocus required>
<button type="submit">进入</button>
</form>
</div></body></html>`;
}

function offlinePageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px;text-align:center;max-width:360px;color:#374151;font-size:14px;line-height:1.7}</style>
</head><body><div class="card">DSH Remote 代理正在运行，但上游 dsh web 未启动。<br>请先在本机启动 <code>dsh web</code>。</div></body></html>`;
}

// ---------- 认证 ----------

function hasQueryToken(req) {
  try {
    return new URL(req.url ?? '/', 'http://x').searchParams.get('token') != null;
  } catch { return false; }
}

function authCheck(req, token, sessionKey) {
  if (!token) return { ok: true, rawQueryToken: null };
  const cookies = parseCookies(req.headers.cookie);
  const cookieTok = cookies[TOKEN_COOKIE];
  if (cookieTok && safeEqual(cookieTok, cookieFor(token, sessionKey))) {
    return { ok: true, rawQueryToken: null };
  }
  const qTok = new URL(req.url ?? '/', 'http://x').searchParams.get('token');
  if (qTok && safeEqual(qTok, token)) return { ok: true, rawQueryToken: qTok };
  return { ok: false, rawQueryToken: null };
}

function maybeSeedAuthCookie(req, res, rawToken, sessionKey) {
  if (!rawToken || !sessionKey) return;
  if (parseCookies(req.headers.cookie)[TOKEN_COOKIE]) return;
  const expected = cookieFor(rawToken, sessionKey);
  const origWriteHead = res.writeHead.bind(res);
  res.writeHead = function (statusCode, headers) {
    const h = { ...(headers ?? {}) };
    const cookie = `${TOKEN_COOKIE}=${expected}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`;
    const prev = h['set-cookie'];
    if (Array.isArray(prev)) h['set-cookie'] = [...prev, cookie];
    else if (typeof prev === 'string') h['set-cookie'] = [prev, cookie];
    else h['set-cookie'] = cookie;
    return origWriteHead(statusCode, h);
  };
}

// ---------- Host/Origin 改写 ----------

function loopbackAuthority(headers, upstream) {
  const authority = `${upstream.host}:${upstream.port}`;
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'referer' || lk === 'sec-fetch-site') continue;
    out[lk] = v;
  }
  out.host = authority;
  out.origin = `http://${authority}`;
  const referer = headers.referer ?? headers.Referer;
  if (referer) {
    try {
      const ref = new URL(referer);
      ref.protocol = 'http:';
      ref.host = authority;
      out.referer = ref.toString();
    } catch {
      out.referer = `http://${authority}/`;
    }
  }
  out['sec-fetch-site'] = 'same-origin';
  return out;
}

// ---------- dsh 启动 token 握手 ----------

export function stripDesktopMarkers(reqUrl) {
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  const doomed = [...u.searchParams.keys()].filter((k) => k.startsWith('dsh-desktop-'));
  if (doomed.length === 0) return reqUrl;
  for (const key of doomed) u.searchParams.delete(key);
  return `${u.pathname}${u.search}`;
}

export function upstreamPathWithLaunchToken(reqUrl, method, cookieHeader, launchToken) {
  if (method !== 'GET') return reqUrl;
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (u.pathname !== '/') return reqUrl;
  const force = u.searchParams.has('dsh-remote-auth') || u.searchParams.has('dsh-pocket-auth');
  if (!force && String(cookieHeader ?? '').includes(DSH_AUTH_COOKIE)) return reqUrl;
  if (!launchToken) return reqUrl;
  u.searchParams.set('token', launchToken);
  return `${u.pathname}${u.search}`;
}

const HANDSHAKE_RETRY_PARAM = 'dsh-remote-retry';
const DEFAULT_HANDSHAKE_LIMIT = 3;
const HANDSHAKE_WINDOW_MS = 60_000;

export function stripQueryParam(reqUrl, name) {
  let u;
  try { u = new URL(reqUrl ?? '/', 'http://dsh.invalid'); } catch { return reqUrl; }
  if (!u.searchParams.has(name)) return reqUrl;
  u.searchParams.delete(name);
  return `${u.pathname}${u.search}`;
}

export function createHandshakeTracker({ max = DEFAULT_HANDSHAKE_LIMIT, windowMs = HANDSHAKE_WINDOW_MS } = {}) {
  const hits = new Map();
  return {
    record(ip, now = Date.now()) {
      let rec = hits.get(ip);
      if (!rec || now - rec.start > windowMs) { hits.set(ip, rec = { count: 0, start: now }); }
      rec.count++;
      return rec.count;
    },
    clear(ip) { hits.delete(ip); },
    exhausted(ip) { const r = hits.get(ip); return !!r && r.count >= max; },
  };
}

function handshakePageHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="0; url=/">
<title>DSH Remote · 正在进入</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
p{font-size:13px;color:#6b7280;margin:0}</style></head><body><p>正在进入…</p></body></html>`;
}

// ---------- WebSocket 心跳 ----------

const WS_PING_FRAME = Buffer.from([0x89, 0x00]);
function attachWebSocketHeartbeat(socket, { intervalMs = 30_000, missLimit = 2 } = {}) {
  let misses = 0;
  let stopped = false;
  const onInbound = () => { misses = 0; };
  const timer = setInterval(() => {
    if (stopped) return;
    misses += 1;
    if (misses >= missLimit) { socket.destroy(); return; }
    if (!socket.destroyed) { try { socket.write(WS_PING_FRAME); } catch { /* 忽略 */ } }
  }, intervalMs);
  timer.unref?.();
  socket.on('data', onInbound);
  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off('data', onInbound);
    socket.off('close', cleanup);
    socket.off('error', cleanup);
  };
  socket.on('close', cleanup);
  socket.on('error', cleanup);
}

/** 读取请求体（有上限，防止超长密码/滥用打爆内存） */
function readBody(req, limit = SETTINGS_BODY_LIMIT) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(body);
}

/** 设置页路由：返回 true 表示已处理。 */
async function handleSettings(req, res, hooks) {
  let pathname;
  try { pathname = new URL(req.url ?? '/', 'http://dsh.invalid').pathname; } catch { return false; }
  const isPage = pathname === SETTINGS_PAGE_PATH || pathname === SETTINGS_PAGE_PATH.replace(/\/$/, '');
  const isConfig = pathname === SETTINGS_CONFIG_PATH;
  if (!isPage && !isConfig) return false;

  // 跨源：配置面板嵌在 dsh web（:3080）页面里，浏览器从 location.hostname:3081 拉数据，
  // 会带 Origin；这里放行 loopback/LAN 跨源，并处理预检。
  const origin = req.headers && req.headers.origin;
  if (origin) {
    res.setHeader('access-control-allow-origin', origin);
    res.setHeader('access-control-allow-credentials', 'true');
    res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
    res.setHeader('access-control-allow-headers', 'content-type');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    if (isPage) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { sendJson(res, 405, { error: 'method not allowed' }); return true; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(settingsPageHtml());
      return true;
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      sendJson(res, 200, await hooks.get());
      return true;
    }
    if (req.method === 'POST') {
      const raw = await readBody(req);
      let patch;
      try { patch = JSON.parse(raw || '{}'); } catch { sendJson(res, 400, { error: 'invalid JSON' }); return true; }
      if (!patch || typeof patch !== 'object') { sendJson(res, 400, { error: 'invalid payload' }); return true; }
      sendJson(res, 200, await hooks.post(patch));
      return true;
    }
    sendJson(res, 405, { error: 'method not allowed' });
    return true;
  } catch (err) {
    sendJson(res, 400, { error: err?.message || 'settings error' });
    return true;
  }
}

/**
 * 启动 dsh-remote 本机代理。
 * @param {object} opts
 * @param {number} [opts.port=3081]
 * @param {string} [opts.host='0.0.0.0']
 * @param {{host:string,port:number}} [opts.upstream]
 * @param {string} [opts.injectHtml]
 * @param {{getPin:()=>string, sessionKey:string}} [opts.auth] 访问 PIN 认证；null 关闭
 * @param {object|false} [opts.rateLimit]
 * @param {object|false} [opts.heartbeat]
 * @param {() => string} [opts.launchToken] dsh web 浏览器会话启动 token
 * @param {() => object} [opts.status] 状态快照（挂到 /__dsh-remote/status）
 * @param {string}   [opts.node] 节点名（ping 响应里返回）
 * @param {{get:()=>object, post:(patch:object)=>Promise<object>}} [opts.settings] 设置页读写钩子
 * @param {(...args:any[])=>void} [opts.log]
 */
export function createRemoteProxy({
  port = 3081,
  host = '0.0.0.0',
  upstream = DEFAULT_UPSTREAM,
  injectHtml = DEFAULT_INJECT,
  auth = null,
  rateLimit = null,
  heartbeat = {},
  launchToken = () => '',
  status = () => ({}),
  node = 'node',
  settings = null,
  log = null,
} = {}) {
  const limiter = auth ? createRateLimiter(rateLimit ?? {}) : null;
  const handshake = createHandshakeTracker();

  /** 内省端点（认证之前处理） */
  function handleIntrospect(req, res) {
    const u = new URL(req.url ?? '/', 'http://dsh.invalid');
    if (u.pathname === PING_PATH) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'dsh-remote', node, ts: Date.now() }));
      return true;
    }
    if (u.pathname === STATUS_PATH) {
      // status 只允许本机 loopback（隧道/局域网都拿不到运行细节）
      if (classifySource(req.socket?.remoteAddress) !== 'loopback') {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"forbidden"}');
        return true;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'dsh-remote', node, ts: Date.now(), ...status() }));
      return true;
    }
    return false;
  }

  /** PIN 认证；返回 true 表示已放行，false 表示已响应拒绝。 */
  function enforceAuth(req, res) {    if (!auth) return true;
    const pin = auth.getPin();
    if (!pin) return true;
    const ip = clientIp(req);
    // 表单登录
    if (req.method === 'POST' && req.url?.startsWith(LOGIN_PATH)) {
      const rl = limiter.status(ip);
      if (rl.locked) {
        res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(rl.retryAfter) });
        res.end(loginPageHtml('locked', rl.retryAfter));
        return false;
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1024) req.destroy(); });
      req.on('end', () => {
        const finalRl = limiter.status(ip);
        if (finalRl.locked) {
          res.writeHead(429, { 'content-type': 'text/html; charset=utf-8', 'retry-after': String(finalRl.retryAfter) });
          res.end(loginPageHtml('locked', finalRl.retryAfter));
          return;
        }
        const submitted = String(new URLSearchParams(body).get('token') ?? '');
        if (safeEqual(submitted, pin)) {
          limiter.clear(ip);
          res.writeHead(302, {
            location: '/?dsh-remote-auth=1',
            'set-cookie': `${TOKEN_COOKIE}=${cookieFor(pin, auth.sessionKey)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
            'cache-control': 'no-store',
          });
          res.end();
        } else {
          limiter.record(ip);
          log?.(`login failed from ${ip}`);
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(loginPageHtml(true));
        }
      });
      return false;
    }
    const isGuess = hasQueryToken(req);
    if (isGuess) {
      const rl = limiter.status(ip);
      if (rl.locked) {
        if (isHtmlRequest(req)) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(loginPageHtml('locked', rl.retryAfter)); }
        else { res.writeHead(429, { 'content-type': 'application/json', 'retry-after': String(rl.retryAfter) }); res.end('{"error":"too-many-attempts"}'); }
        return false;
      }
    }
    const result = authCheck(req, pin, auth.sessionKey);
    if (!result.ok) {
      if (isGuess) { limiter.record(ip); log?.(`bad ?token= from ${ip}`); }
      if (isHtmlRequest(req)) {
        const rl = limiter.status(ip);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(loginPageHtml(rl.locked ? 'locked' : false, rl.retryAfter));
      } else {
        res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end('{"error":"unauthorized"}');
      }
      return false;
    }
    if (result.rawQueryToken) {
      limiter.clear(ip);
      maybeSeedAuthCookie(req, res, result.rawQueryToken, auth.sessionKey);
    }
    return true;
  }

  const server = createServer(async (req, res) => {
    if (handleIntrospect(req, res)) return;
    const host = policyHost(req, String(req.headers.host ?? ''));
    // loopback 访问免 PIN（本机进程 / 隧道回连时 Host 是公网域名，仍会要求 PIN：
    // 判定看 Host 不看源地址，fail-closed）
    const needsAuth = auth && classifyHost(host) !== 'loopback';
    if (needsAuth && !enforceAuth(req, res)) return;

    // 设置页面 / 配置读写接口（认证之后；settings 钩子由 index.js 提供）
    // handleSettings 是 async，必须 await：直接 if 一个 Promise 永远为真，
    // 会把所有普通请求误判成「已处理」然后挂死。
    if (settings && (await handleSettings(req, res, settings))) return;

    // 清掉历史遗留参数 + 重试参数
    const handshakeIp = clientIp(req);
    let cleanPath = stripDesktopMarkers(req.url);
    if (cleanPath.includes(HANDSHAKE_RETRY_PARAM)) {
      handshake.clear(handshakeIp);
      cleanPath = stripQueryParam(cleanPath, HANDSHAKE_RETRY_PARAM);
    }
    const launchTok = (typeof launchToken === 'function' ? launchToken() : '') || '';
    const handshakeOver = launchTok !== '' && handshake.exhausted(handshakeIp);
    const upstreamPath = handshakeOver ? cleanPath : upstreamPathWithLaunchToken(cleanPath, req.method, req.headers.cookie, launchTok);
    const didInjectToken = upstreamPath !== cleanPath;
    if (didInjectToken) { handshake.record(handshakeIp); }
    if (!didInjectToken && String(req.headers.cookie ?? '').includes(DSH_AUTH_COOKIE)) handshake.clear(handshakeIp);

    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest(
      { host: upstream.host, port: upstream.port, method: req.method, path: upstreamPath, headers, agent: false },
      (proxyRes) => {
        const contentType = String(proxyRes.headers['content-type'] ?? '');
        // 启动 token 握手：上游 303 → 200 过渡页（Safari 在 http://IP 源上丢 3xx cookie）
        if (didInjectToken && proxyRes.statusCode === 303 && isHtmlRequest(req)) {
          const out = { ...proxyRes.headers };
          delete out['content-length']; delete out['transfer-encoding']; delete out.location;
          const page = Buffer.from(handshakePageHtml(), 'utf8');
          out['content-type'] = 'text/html; charset=utf-8';
          out['content-length'] = String(page.length);
          out['cache-control'] = 'no-store';
          proxyRes.resume();
          res.writeHead(200, out);
          res.end(page);
          return;
        }
        // HTML 注入 polyfill
        if (injectHtml && contentType.includes('text/html') && !isCompressed(proxyRes.headers)) {
          const chunks = [];
          proxyRes.on('data', (c) => chunks.push(c));
          proxyRes.on('end', () => {
            let html = Buffer.concat(chunks).toString('utf8');
            if (!html.includes(INJECT_MARK)) {
              html = html.replace(/<head[^>]*>/i, (m) => `${m}${injectHtml}`);
            }
            const out = Buffer.from(html, 'utf8');
            const outHeaders = { ...proxyRes.headers };
            delete outHeaders['content-length']; delete outHeaders['transfer-encoding'];
            outHeaders['content-length'] = String(out.length);
            outHeaders['cache-control'] = 'no-store';
            delete outHeaders.etag; delete outHeaders['last-modified']; delete outHeaders.expires;
            res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
            res.end(out);
          });
          proxyRes.on('error', () => res.destroy());
          return;
        }
        // 流式压缩大 JSON/text
        const acceptEncoding = String(req.headers['accept-encoding'] ?? '');
        const canGzip = /\bgzip\b/.test(acceptEncoding);
        const canBr = /\bbr\b/.test(acceptEncoding);
        const isEventStream = contentType.includes('text/event-stream');
        const knownLen = Number(proxyRes.headers['content-length'] || 0);
        const shouldCompress = (canGzip || canBr)
          && !isCompressed(proxyRes.headers)
          && !isEventStream
          && (contentType.includes('application/json') || contentType.startsWith('text/'))
          && (knownLen === 0 || knownLen >= 1024);
        if (shouldCompress) {
          const enc = canBr ? 'br' : 'gzip';
          const outHeaders = { ...proxyRes.headers };
          delete outHeaders['content-length']; delete outHeaders['transfer-encoding'];
          outHeaders['content-encoding'] = enc;
          res.writeHead(proxyRes.statusCode ?? 200, outHeaders);
          const z = enc === 'br'
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } })
            : createGzip();
          proxyRes.pipe(z).pipe(res);
          res.on('close', () => { proxyRes.destroy(); z.destroy(); });
          proxyRes.on('error', () => { z.destroy(); res.destroy(); });
          proxyRes.on('aborted', () => { z.destroy(); res.destroy(); });
          z.on('error', () => res.destroy());
          return;
        }
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
        res.on('close', () => proxyRes.destroy());
        proxyRes.on('error', () => res.destroy());
        proxyRes.on('close', () => { if (!res.writableEnded) res.destroy(); });
      },
    );
    proxyReq.on('error', (err) => {
      log?.(`upstream error: ${err.message}`);
      if (!res.headersSent) {
        if (isHtmlRequest(req)) {
          res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          res.end(offlinePageHtml());
        } else {
          res.writeHead(502, { 'content-type': 'application/json', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ error: 'dsh-remote: upstream dsh web unavailable', detail: err.message }));
        }
      }
    });
    req.pipe(proxyReq);
  });

  // WebSocket upgrade 透传
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://dsh.invalid').pathname.startsWith('/__dsh-remote/')) {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const host = policyHost(req, String(req.headers.host ?? ''));
    if (auth && classifyHost(host) !== 'loopback') {
      const pin = auth.getPin();
      const ip = clientIp(req);
      const guess = hasQueryToken(req);
      if (guess) {
        const rl = limiter.status(ip);
        if (rl.locked) { socket.write(`HTTP/1.1 429 Too Many Requests\r\nRetry-After: ${rl.retryAfter}\r\nConnection: close\r\n\r\n`); socket.destroy(); return; }
      }
      const result = authCheck(req, pin, auth.sessionKey);
      if (!result.ok) {
        if (guess) limiter.record(ip);
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      if (guess) limiter.clear(ip);
    }
    const headers = loopbackAuthority({ ...req.headers }, upstream);
    const proxyReq = httpRequest({
      host: upstream.host, port: upstream.port, method: req.method,
      path: stripDesktopMarkers(req.url), headers, agent: false,
    });
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      socket.pipe(proxySocket, { end: false });
      proxySocket.pipe(socket, { end: false });
      if (heartbeat !== false) attachWebSocketHeartbeat(socket, heartbeat ?? {});
      const teardown = () => {
        try { proxySocket.resetAndDestroy?.() ?? proxySocket.destroy(); } catch { try { proxySocket.destroy(); } catch { /* 忽略 */ } }
        try { socket.destroy(); } catch { /* 忽略 */ }
      };
      proxySocket.on('error', () => { try { socket.destroy(); } catch { /* 忽略 */ } });
      proxySocket.on('close', teardown);
      socket.on('close', teardown);
      socket.on('end', teardown);
      proxySocket.on('end', teardown);
    });
    proxyReq.on('response', (proxyRes) => {
      if (proxyRes.statusCode === 101) return;
      try {
        const raw = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        socket.end(raw.join('\r\n') + '\r\n\r\n');
        proxyRes.resume();
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', () => socket.destroy());
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
    socket.on('error', () => socket.destroy());
  });

  const clientSockets = new Set();
  server.on('connection', (sock) => {
    // 局域网访问闸门：LAN 关闭时，非 loopback 的新连接直接拒绝（隧道回连/本机
    // 浏览器都是 loopback，不受影响）。同步读取，保证在任何数据交换前生效。
    const lanAllowed = settings?.access ? settings.access().lan !== false : true;
    if (!lanAllowed && classifySource(sock.remoteAddress) !== 'loopback') {
      sock.destroy();
      return;
    }
    clientSockets.add(sock);
    sock.on('close', () => clientSockets.delete(sock));
    sock.on('error', () => {});
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        server,
        port: server.address().port,
        close: () => new Promise((r) => {
          for (const s of clientSockets) { try { s.destroy(); } catch { /* 忽略 */ } }
          server.close(() => r());
        }),
      });
    });
  });
}
