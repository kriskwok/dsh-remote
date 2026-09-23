// dsh-remote 中继服务（部署在公网服务器上，nginx :3443 TLS 的上游）
//
//   App ──HTTPS/WSS──▶ nginx :3443 ──▶ 本服务 127.0.0.1:3090
//                                          │
//              局域网可达 ────────────────▶ http://<电脑LAN IP>:3081（插件本机代理）
//              外网/公共网络 ──▶ 插件主动拨入的 WSS 隧道（/relay/ws，mux 复用）
//
// 公共 WiFi 常只放行 443：可在 nginx 443 上按 SNI 再加一个 dsh.example.com
// vhost 指到本服务，插件 relay.urls 把它作为第二条兜底地址。
// 服务器本机自己的 dsh 仍占 :3080，与本服务互不影响。
//
// 选路：周期性探测插件通告的 LAN 候选（GET /__dsh-remote/ping，~0.9s 超时），
// 探得到就直连反代（最低延迟），探不到就走隧道；每个请求失败还会在两种路径间
// 兜底重试一次。App 侧永远只看到 dsh.example.com:3443，网络切换完全无感。
//
// 认证：
//   - 插件隧道：Bearer token（env DSH_RELAY_TOKEN），timingSafe 比较，错即 401/4401
//   - App 访问：本服务不做认证，PIN 校验统一由插件本机代理完成（fail-closed）
//
// 仅依赖 ws（零传递依赖）。Node >= 22。

import { createServer, request as httpRequest, get as httpGet } from 'node:http';
import { connect as netConnect } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { Mux } from '../lib/mux.mjs';

const PROTOCOL = 1;
const PING_PATH = '/__dsh-remote/ping';

function safeEqual(a, b) {
  const ba = Buffer.from(String(a ?? ''), 'utf8');
  const bb = Buffer.from(String(b ?? ''), 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

function offlineHtml() {
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH Remote</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:24px 28px;text-align:center;max-width:380px}
h1{font-size:16px;color:#111827;margin:0 0 8px}p{font-size:13px;color:#6b7280;line-height:1.7;margin:0}</style>
</head><body><div class="card"><h1>🖥️ 电脑端 DSH 不在线</h1>
<p>dsh-remote 中继正常，但还没有电脑接入。<br>请确认电脑上的 dsh web 与 dsh-remote 插件正在运行。</p>
</div></body></html>`;
}

/**
 * 一个已接入的电脑节点。
 */
class NodeSession {
  constructor({ name, ws, mux, candidates = [], version = '' }) {
    this.name = name;
    this.ws = ws;
    this.mux = mux;
    this.candidates = candidates;
    this.version = version;
    this.lanTarget = null; // {ip, port} 或 null
    this.connectedAt = Date.now();
    this.lastProbeAt = 0;
  }

  get tunnelOpen() {
    return this.ws?.readyState === 1;
  }

  mode() {
    if (this.lanTarget) return 'lan';
    if (this.tunnelOpen) return 'tunnel';
    return 'offline';
  }

  toJSON() {
    return {
      node: this.name,
      mode: this.mode(),
      version: this.version,
      connectedAt: new Date(this.connectedAt).toISOString(),
      lastProbeAt: this.lastProbeAt ? new Date(this.lastProbeAt).toISOString() : null,
      lanTarget: this.lanTarget,
      candidates: this.candidates,
    };
  }
}

/**
 * @param {object} opts
 * @param {string} opts.host            监听地址（默认 127.0.0.1，只给本机 nginx 用）
 * @param {number} opts.port            监听端口（默认 3090）
 * @param {string} opts.token           插件隧道共享密钥（必填）
 * @param {number} [opts.probeMs=8000]  LAN 探测周期
 * @param {number} [opts.probeTimeoutMs=900]
 * @param {number} [opts.lanDialTimeoutMs=1200]
 * @param {object} [opts.log]
 */
export function createRelayServer({
  host = '127.0.0.1',
  port = 3090,
  token = '',
  probeMs = 8000,
  probeTimeoutMs = 900,
  lanDialTimeoutMs = 1200,
  log = console,
} = {}) {
  if (!token) throw new Error('relay token 必填（env DSH_RELAY_TOKEN）');

  /** @type {Map<string, NodeSession>} */
  const nodes = new Map();
  let defaultNode = null;

  // ---------- LAN 探测 ----------

  function probeCandidate({ ip, port }, timeoutMs) {
    return new Promise((resolve) => {
      const req = httpGet({
        host: ip,
        port,
        path: PING_PATH,
        timeout: timeoutMs,
        headers: { host: `dsh-remote-probe:${port}` },
        agent: false,
      }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => { body += c; if (body.length > 512) req.destroy(); });
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve(res.statusCode === 200 && j.ok === true);
          } catch { resolve(false); }
        });
      });
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.on('error', () => resolve(false));
    });
  }

  async function probeNode(node) {
    node.lastProbeAt = Date.now();
    const list = node.candidates ?? [];
    if (!list.length) { node.lanTarget = null; return; }
    const results = await Promise.all(list.map((c) => probeCandidate(c, probeTimeoutMs)));
    const idx = results.findIndex((ok) => ok);
    node.lanTarget = idx >= 0 ? list[idx] : null;
    log.info?.(`relay: node=${node.name} 探测结果 ${node.lanTarget ? `LAN 直连 ${node.lanTarget.ip}:${node.lanTarget.port}` : '走隧道'}`);
  }

  const probeTimer = setInterval(() => {
    for (const node of nodes.values()) {
      probeNode(node).catch((e) => log.warn?.(`relay probe error: ${e.message}`));
    }
  }, probeMs);
  probeTimer.unref?.();

  // ---------- 拨号器 ----------

  function dialLan(target, timeoutMs) {
    const sock = netConnect({ host: target.ip, port: target.port });
    const timer = setTimeout(() => sock.destroy(new Error('lan dial timeout')), timeoutMs);
    timer.unref?.();
    // 注意：连上后必须 clearTimeout，只 unref 的话定时器照样会触发，
    // 会在 connect 之后把一条好连接误杀掉（连接建立稍慢时必现）。
    const clear = () => clearTimeout(timer);
    sock.once('connect', clear);
    sock.once('error', clear);
    return sock;
  }

  function dialTunnel(node) {
    return node.mux.openStream();
  }

  /**
   * 自定义 agent：agent:false 会让 http 客户端忽略 createConnection、直接按
   * Host 头去 net.connect（会拨到 dsh.example.com:3080）。最小 agent 只需实现
   * addRequest：自己建好 LAN socket / mux 虚拟流，再 onSocket 交给请求。
   */
  function dialAgent(dial) {
    return {
      addRequest(req) {
        const sock = dial();
        process.nextTick(() => req.onSocket(sock));
      },
      destroy() {},
    };
  }

  /**
   * 按当前选路结果返回一个已连接/连接中的 Duplex。
   * LAN 优先；LAN 拨号失败且隧道在线时由调用方触发一次兜底（forceTunnel）。
   */
  function makeDialer(node, { forceTunnel = false } = {}) {
    if (!forceTunnel && node.lanTarget) {
      return { mode: 'lan', dial: () => dialLan(node.lanTarget, lanDialTimeoutMs) };
    }
    if (node.tunnelOpen) return { mode: 'tunnel', dial: () => dialTunnel(node) };
    return null;
  }

  // ---------- App 流量转发 ----------

  function currentNode() {
    return defaultNode ? nodes.get(defaultNode) ?? null : null;
  }

  function sendOffline(req, res) {
    if (String(req.headers.accept ?? '').includes('text/html') || !String(req.url ?? '').startsWith('/api')) {
      const body = Buffer.from(offlineHtml(), 'utf8');
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(body.length), 'cache-control': 'no-store' });
      res.end(body);
    } else {
      const body = Buffer.from(JSON.stringify({ error: 'dsh-remote: no node connected' }), 'utf8');
      res.writeHead(502, { 'content-type': 'application/json', 'content-length': String(body.length), 'cache-control': 'no-store' });
      res.end(body);
    }
  }

  function forwardHttpRequest(req, res, { retried = false } = {}) {
    const node = currentNode();
    console.log('FWD', req.url, 'mode', node && node.mode(), 'retried', retried);
    if (!node || node.mode() === 'offline') { sendOffline(req, res); return; }
    const pick = makeDialer(node);
    console.log('FWD pick', pick && pick.mode, 'target', node.lanTarget, 'open', node.tunnelOpen);
    if (!pick) { sendOffline(req, res); return; }

    const proxyReq = httpRequest({
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent: dialAgent(() => pick.dial()),
    });

    let settled = false;
    proxyReq.on('error',(e)=>console.log('FWD err:',e.message));
    proxyReq.on('response', (proxyRes) => {
      console.log('FWD response', proxyRes.statusCode);
      settled = true;
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
      res.on('close', () => proxyRes.destroy());
      proxyRes.on('error', () => res.destroy());
    });
    proxyReq.on('error', (err) => {
      if (settled) { try { res.destroy(); } catch { /* 忽略 */ } return; }
      // LAN 路径在拿到响应前失败：立刻清掉探测结果，兜底走隧道重试一次
      if (pick.mode === 'lan' && !retried && node.tunnelOpen) {
        log.warn?.(`relay: LAN 转发失败（${err.message}），本次请求改走隧道`);
        node.lanTarget = null;
        forwardHttpRequest(req, res, { retried: true });
        return;
      }
      if (!res.headersSent) sendOffline(req, res);
      else try { res.destroy(); } catch { /* 忽略 */ }
    });
    req.pipe(proxyReq);
  }

  function forwardUpgrade(req, socket, head, { retried = false } = {}) {
    const node = currentNode();
    if (!node || node.mode() === 'offline') {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    const pick = makeDialer(node);
    if (!pick) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const proxyReq = httpRequest({
      method: req.method,
      path: req.url,
      headers: req.headers,
      agent: dialAgent(() => pick.dial()),
    });

    let upgraded = false;
    proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
      upgraded = true;
      socket.write('HTTP/1.1 101 Switching Protocols\r\n');
      const raw = [];
      for (const [k, v] of Object.entries(proxyRes.headers)) raw.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      socket.write(`${raw.join('\r\n')}\r\n\r\n`);
      if (proxyHead?.length) socket.write(proxyHead);
      socket.pipe(proxySocket, { end: false });
      proxySocket.pipe(socket, { end: false });
      const teardown = () => {
        try { proxySocket.destroy(); } catch { /* 忽略 */ }
        try { socket.destroy(); } catch { /* 忽略 */ }
      };
      proxySocket.on('error', teardown);
      proxySocket.on('close', teardown);
      socket.on('error', teardown);
      socket.on('close', teardown);
    });
    proxyReq.on('response', (proxyRes) => {
      // 非 101（如 401/502）：把原始响应回写给 App
      try {
        const lines = [`HTTP/1.1 ${proxyRes.statusCode} ${proxyRes.statusMessage ?? ''}`.trim()];
        for (const [k, v] of Object.entries(proxyRes.headers)) lines.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
        socket.write(lines.join('\r\n') + '\r\n\r\n');
        proxyRes.pipe(socket);
      } catch { socket.destroy(); }
    });
    proxyReq.on('error', (err) => {
      if (upgraded) { try { socket.destroy(); } catch { /* 忽略 */ } return; }
      if (pick.mode === 'lan' && !retried && node.tunnelOpen) {
        log.warn?.(`relay: LAN upgrade 失败（${err.message}），本次连接改走隧道`);
        node.lanTarget = null;
        try { socket.destroyed || socket.destroy(); } catch { /* 忽略 */ }
        // socket 已销毁，无法重试同一个 upgrade；客户端（URLSession）会自动重连，
        // 下一次探测/连接即走隧道。这里只保证状态尽快收敛。
        return;
      }
      try { socket.destroy(); } catch { /* 忽略 */ }
    });
    if (head?.length) proxyReq.write(head);
    proxyReq.end();
  }

  // ---------- HTTP 服务 ----------

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    if (url.pathname === '/relay/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ts: Date.now() }));
      return;
    }
    if (url.pathname === '/relay/status') {
      const auth = String(req.headers.authorization ?? '');
      const fromLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      if (!fromLoopback && !(auth.startsWith('Bearer ') && safeEqual(auth.slice(7), token))) {
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{"ok":false,"error":"forbidden"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({
        ok: true,
        defaultNode,
        nodes: [...nodes.values()].map((n) => n.toJSON()),
      }, null, 2));
      return;
    }
    forwardHttpRequest(req, res);
  });

  // ---------- 插件隧道 WSS ----------

  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://relay.invalid');
    if (url.pathname !== '/relay/ws') {
      forwardUpgrade(req, socket, head);
      return;
    }
    // 隧道鉴权：Authorization: Bearer，或 ?token=（某些极简 WS 客户端用）
    const bearer = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const queryToken = url.searchParams.get('token');
    const provided = bearer || queryToken || '';
    if (!safeEqual(provided, token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      log.warn?.(`relay: 隧道鉴权失败 from ${socket.remoteAddress}`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleTunnel(ws));
  });

  function handleTunnel(ws) {
    let registered = false;
    const helloTimer = setTimeout(() => {
      if (!registered) { try { ws.close(4400, 'hello timeout'); } catch { /* 忽略 */ } }
    }, 5000);
    helloTimer.unref?.();

    const mux = new Mux(ws, { role: 'relay', log });

    mux.on('control', (msg) => {
      if (msg.type === 'hello' && !registered) {
        if (!safeEqual(String(msg.token ?? ''), token)) {
          mux.sendControl({ type: 'deny', reason: 'bad token' });
          try { ws.close(4401, 'unauthorized'); } catch { /* 忽略 */ }
          return;
        }
        if (Number(msg.protocol) !== PROTOCOL) {
          mux.sendControl({ type: 'deny', reason: `protocol mismatch (want ${PROTOCOL})` });
          try { ws.close(4402, 'protocol'); } catch { /* 忽略 */ }
          return;
        }
        clearTimeout(helloTimer);
        registered = true;

        const name = String(msg.node || 'node').slice(0, 64);
        // 同名旧连接踢掉（重连场景）；不同名则全部保留，默认指向最新接入者
        const old = nodes.get(name);
        if (old) {
          try { old.mux.sendControl({ type: 'bye', reason: 'replaced by newer connection' }); } catch { /* 忽略 */ }
          try { old.ws.close(4000, 'replaced'); } catch { /* 忽略 */ }
        }
        const node = new NodeSession({
          name,
          ws,
          mux,
          candidates: Array.isArray(msg.candidates) ? msg.candidates.slice(0, 16) : [],
          version: String(msg.version ?? ''),
        });
        nodes.set(name, node);
        defaultNode = name;
        mux.sendControl({ type: 'welcome', ok: true, protocol: PROTOCOL, server: 'dsh-remote-relay' });
        log.info?.(`relay: 节点接入 ${name}（候选 ${node.candidates.map((c) => c.ip).join(', ') || '无'}）`);
        probeNode(node).catch(() => {});
      } else if (msg.type === 'lan' && registered) {
        const node = nodes.get(String(msg.node || defaultNode));
        if (node && node.ws === ws) {
          node.candidates = Array.isArray(msg.candidates) ? msg.candidates.slice(0, 16) : [];
          probeNode(node).catch(() => {});
        }
      }
    });

    mux.on('close', () => {
      clearTimeout(helloTimer);
      for (const [name, node] of [...nodes.entries()]) {
        if (node.ws === ws) {
          nodes.delete(name);
          if (defaultNode === name) defaultNode = [...nodes.keys()].pop() ?? null;
          log.info?.(`relay: 节点离线 ${name}`);
        }
      }
    });
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      log.info?.(`relay: dsh-remote 中继监听 ${host}:${addr.port}（App 流量 + 隧道 /relay/ws）`);
      resolve({
        server,
        wss,
        port: addr.port,
        async close() {
          clearInterval(probeTimer);
          for (const node of nodes.values()) { try { node.ws.terminate(); } catch { /* 忽略 */ } }
          wss.close();
          await new Promise((r) => server.close(r));
        },
      });
    });
  });
}

// 直接运行（systemd / node relay/server.mjs）：从环境变量读配置
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const token = process.env.DSH_RELAY_TOKEN || '';
  if (!token) {
    console.error('缺少 DSH_RELAY_TOKEN（/opt/dsh-remote/relay.env）');
    process.exit(2);
  }
  const log = {
    info: (...a) => console.log(new Date().toISOString(), ...a),
    warn: (...a) => console.warn(new Date().toISOString(), '[warn]', ...a),
    error: (...a) => console.error(new Date().toISOString(), '[error]', ...a),
    debug() {},
  };
  createRelayServer({
    host: process.env.DSH_RELAY_HOST || '127.0.0.1',
    port: Number(process.env.DSH_RELAY_PORT || 3090),
    token,
    probeMs: Number(process.env.DSH_RELAY_PROBE_MS || 8000),
    probeTimeoutMs: Number(process.env.DSH_RELAY_PROBE_TIMEOUT_MS || 900),
    log,
  }).catch((err) => {
    console.error('relay 启动失败：', err);
    process.exit(1);
  });
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}
