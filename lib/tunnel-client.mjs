// dsh-remote 隧道客户端（跑在装了 dsh 的电脑上）
//
// 主动向中继服务器拨出一条 WSS（外网场景唯一需要的方向：只出不进，
// 能过绝大多数公共 WiFi / 公司网络；443/3080 这类 TLS 端口通常都开着）。
// 中继把 App 的每条 TCP 连接在这条 WSS 上复用成虚拟流，本端把虚拟流
// 对接到本机代理 127.0.0.1:<localPort>，HTTP/WebSocket 全部按原始字节透传。
//
// 可靠性：
//   - 多 URL 兜底（如先 wss://host:3080 再 wss://host:443），全失败则指数退避重连
//   - WS ping/pong 心跳（mux 内），静默断链 2 个周期自动 terminate 重连
//   - 每 60s 重新枚举局域网地址并通告（换网/切 WiFi 后中继探测自动跟上）

import { EventEmitter } from 'node:events';
import { connect as netConnect } from 'node:net';
import WebSocket from 'ws';
import { Mux } from './mux.mjs';
import { lanTargets, primaryLanIPv4 } from './netutil.mjs';

const PROTOCOL = 1;

/**
 * @param {object} opts
 * @param {string[]} opts.urls       中继 WSS 地址列表（按序兜底）
 * @param {string}   opts.token     中继共享密钥
 * @param {string}   opts.node      节点名
 * @param {number}   opts.localPort 本机代理端口（默认 3081）
 * @param {string}   [opts.localHost=127.0.0.1]
 * @param {number}   [opts.advertiseMs=60000]
 * @param {object}   [opts.log]
 * @param {number}   [opts.localConnectTimeoutMs=3000]
 * @param {() => Array<{ip:string,port:number}>} [opts.getCandidates] 覆盖 LAN 候选（测试用）
 */
export class TunnelClient extends EventEmitter {
  constructor({
    urls,
    token,
    node,
    localPort,
    localHost = '127.0.0.1',
    advertiseMs = 60_000,
    localConnectTimeoutMs = 3000,
    getCandidates = null,
    log = console,
  }) {
    super();
    this.urls = [...urls];
    this.token = token;
    this.node = node;
    this.localPort = localPort;
    this.localHost = localHost;
    this.advertiseMs = advertiseMs;
    this.localConnectTimeoutMs = localConnectTimeoutMs;
    this.getCandidates = getCandidates;
    this.log = log;

    this.state = 'idle'; // idle | connecting | connected | wait-retry | stopped
    this.activeUrl = null;
    this.lastError = null;
    this.connectedAt = null;
    this.ws = null;
    this.mux = null;
    this._stopped = false;
    this._attempt = 0;
    this._retryTimer = null;
    this._advertiseTimer = null;
  }

  start() {
    this._stopped = false;
    if (this.state === 'connecting' || this.state === 'connected') return;
    this._setState('connecting');
    void this._run();
  }

  stop() {
    this._stopped = true;
    if (this._retryTimer) clearTimeout(this._retryTimer);
    if (this._advertiseTimer) clearInterval(this._advertiseTimer);
    try { this.mux?.close(); } catch { /* 忽略 */ }
    try { this.ws?.terminate(); } catch { /* 忽略 */ }
    this.mux = null;
    this.ws = null;
    this._setState('stopped');
  }

  status() {
    return {
      state: this.state,
      activeUrl: this.activeUrl,
      node: this.node,
      local: `${this.localHost}:${this.localPort}`,
      connectedAt: this.connectedAt,
      lastError: this.lastError,
      lanCandidates: this._candidates().map((t) => t.ip),
    };
  }

  _candidates() {
    return this.getCandidates ? this.getCandidates() : lanTargets(this.localPort);
  }

  _setState(state, extra = {}) {
    this.state = state;
    this.emit('state', state, extra);
  }

  async _run() {
    while (!this._stopped) {
      let anyConnected = false;
      for (const url of this.urls) {
        if (this._stopped) return;
        this.activeUrl = url;
        try {
          await this._connectOne(url);
          if (this._denied) {
            // 注册被拒（token 错误等）：长退避，避免疯狂重连打爆日志
            this._attempt = Math.max(this._attempt, 4);
          }
          anyConnected = true;
          break; // _connectOne 在连接结束后才 resolve → 外层统一退避重连
        } catch (err) {
          this.lastError = err.message;
          this.log.warn?.(`dsh-remote tunnel: ${url} 连接失败：${err.message}`);
          this.emit('connectError', { url, error: err.message });
        }
      }
      if (this._stopped) return;
      const delay = this._backoffMs(++this._attempt);
      this._setState('wait-retry');
      this.log.info?.(`dsh-remote tunnel: ${anyConnected ? '连接断开' : '全部中继地址不可达'}，${Math.round(delay / 1000)}s 后重连`);
      await new Promise((r) => {
        this._retryTimer = setTimeout(r, delay);
        this._retryTimer.unref?.();
      });
      if (!this._stopped) this._setState('connecting');
    }
  }

  _backoffMs(attempt) {
    const base = Math.min(1000 * 2 ** Math.min(attempt, 5), 30_000);
    return base + Math.floor(Math.random() * 1000);
  }

  _connectOne(url) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(url, {
        headers: { Authorization: `Bearer ${this.token}` },
        handshakeTimeout: 10_000,
      });
      this.ws = ws;
      let mux = null;

      const cleanup = () => {
        if (this._advertiseTimer) { clearInterval(this._advertiseTimer); this._advertiseTimer = null; }
      };

      ws.on('open', () => {
        mux = new Mux(ws, { role: 'agent', log: this.log });
        this.mux = mux;
        mux.on('control', (msg) => this._onControl(msg, mux));
        mux.on('stream', (sock) => this._attachLocal(sock));
        mux.on('close', () => {
          cleanup();
          if (!settled) { settled = true; resolve(); } // 连接结束 → 外层重连
        });
        // 注册
        mux.sendControl({
          type: 'hello',
          protocol: PROTOCOL,
          token: this.token,
          node: this.node,
          version: pkgVersion(),
          candidates: this._candidates(),
        });
      });

      ws.on('message', () => { /* Mux 已挂监听，这里防止未监听报错 */ });

      ws.on('error', (err) => {
        cleanup();
        if (!settled) { settled = true; reject(err); }
      });
      ws.on('unexpected-response', (_req, res) => {
        cleanup();
        if (!settled) {
          settled = true;
          reject(new Error(`HTTP ${res.statusCode}（检查中继地址与 token）`));
        }
      });
      ws.on('close', (code) => {
        cleanup();
        if (!settled) {
          settled = true;
          if (mux && this._denied) reject(new Error(`中继拒绝注册：${this._denied}`));
          else resolve();
        }
      });
    });
  }

  _onControl(msg, mux) {
    if (msg.type === 'welcome') {
      this.connectedAt = Date.now();
      this.lastError = null;
      this._denied = null;
      this._attempt = 0;
      this._setState('connected', { url: this.activeUrl });
      this.log.info?.(`dsh-remote tunnel: 已连接中继 ${this.activeUrl}（节点 ${this.node}）`);
      this.emit('connected', msg);
      // 周期性通告局域网候选
      if (this._advertiseTimer) clearInterval(this._advertiseTimer);
      const advertise = () => {
        try {
          mux.sendControl({ type: 'lan', candidates: this._candidates() });
        } catch { /* 连接关闭中 */ }
      };
      advertise();
      this._advertiseTimer = setInterval(advertise, this.advertiseMs);
      this._advertiseTimer.unref?.();
    } else if (msg.type === 'deny') {
      this._denied = msg.reason || 'unknown';
      this.lastError = this._denied;
      this.log.warn?.(`dsh-remote tunnel: 中继拒绝注册：${this._denied}`);
      try { this.ws?.close(4401, 'denied'); } catch { /* 忽略 */ }
    }
  }

  /**
   * 把一条中继来的虚拟流对接到本机代理端口（原始字节双向透传 + 半关闭）。
   */
  _attachLocal(vs) {
    let local = null;
    let finished = false;
    const teardown = (err) => {
      if (finished) return;
      finished = true;
      if (err) this.log.warn?.(`dsh-remote tunnel: 虚拟流 ${vs.id} 异常：${err.message}`);
      try { vs.destroy(); } catch { /* 忽略 */ }
      try { local?.destroy(); } catch { /* 忽略 */ }
    };
    const timer = setTimeout(() => {
      if (!local) teardown(new Error('local connect timeout'));
    }, this.localConnectTimeoutMs);
    timer.unref?.();

    local = netConnect({ host: this.localHost, port: this.localPort });
    local.on('connect', () => timer.unref?.());
    // 半关闭：对端 FIN（App 写完请求）→ end 本地写侧；本地读完 → FIN 回中继
    vs.pipe(local, { end: false });
    local.pipe(vs, { end: false });
    vs.on('end', () => { try { local.end(); } catch { /* 忽略 */ } });
    local.on('end', () => { try { vs.end(); } catch { /* 忽略 */ } });
    vs.on('error', (e) => teardown(e));
    local.on('error', (e) => teardown(e));
    vs.on('close', () => teardown());
    local.on('close', () => teardown());
  }
}

function pkgVersion() {
  try {
    return requirePkgVersion();
  } catch { return '0.0.0'; }
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function requirePkgVersion() {
  return require('../package.json').version;
}

export { primaryLanIPv4 };
