// dsh-remote 多路复用：在一条 WebSocket 上承载多条原始 TCP 字节流
//
// 为什么需要它：外网场景下只有插件主动拨出的一条 WSS（能过绝大多数公共网络），
// 而 App 的访问模式是「大量短 HTTP 请求 + 长连接 WebSocket」。中继把每一条
// 入站 TCP 连接映射成 mux 里的一条虚拟流（VirtualSocket），插件侧把虚拟流
// 对接到本机代理端口（127.0.0.1:3081）。HTTP 与 WebSocket 都是原始字节，
// 不需要解析应用协议，WS ping/pong、压缩、TLS（在 nginx 层）全部逐跳自然工作。
//
// 线路格式（WS 二进制帧，可在一条 WS message 里连续放多个帧）：
//   byte 0      版本 0x01
//   byte 1..4   streamId，uint32 BE
//   byte 5      帧类型：0=DATA  1=FIN（本侧写半关闭） 2=RESET
//   byte 6..7   负载长度，uint16 BE（DATA 帧 <= 16KiB；FIN/RESET 为 0）
//   byte 8..    DATA 负载
// WS 文本帧 = JSON 控制消息（hello/welcome/deny/lan/bye），由调用方处理。
//
// streamId 分配：relay 侧用奇数（1,3,5…），agent 侧用偶数（2,4,6…），
// 避免两端并发开流时撞 id。

import { Duplex } from 'node:stream';
import { EventEmitter } from 'node:events';

export const MUX_VERSION = 1;
export const FRAME_DATA = 0;
export const FRAME_FIN = 1;
export const FRAME_RESET = 2;
const HEADER_SIZE = 8;
export const MAX_PAYLOAD = 16 * 1024;
const HIGH_WATER = 512 * 1024; // ws.bufferedAmount 背压阈值

/**
 * 编码一个 mux 帧。
 */
export function encodeFrame(streamId, type, payload = Buffer.alloc(0)) {
  const buf = Buffer.allocUnsafe(HEADER_SIZE + payload.length);
  buf.writeUInt8(MUX_VERSION, 0);
  buf.writeUInt32BE(streamId >>> 0, 1);
  buf.writeUInt8(type, 5);
  buf.writeUInt16BE(payload.length, 6);
  if (payload.length) payload.copy(buf, HEADER_SIZE);
  return buf;
}

/**
 * 从 Buffer 中切出全部完整帧（不完整的尾部留在 rest 里等下一帧）。
 * @returns {{frames:Array<{id:number,type:number,payload:Buffer}>, rest:Buffer, error?:Error}}
 */
export function decodeFrames(buf) {
  const frames = [];
  let offset = 0;
  while (buf.length - offset >= HEADER_SIZE) {
    const ver = buf.readUInt8(offset);
    if (ver !== MUX_VERSION) {
      return { frames, rest: buf.subarray(offset), error: new Error(`bad mux version: ${ver}`) };
    }
    const id = buf.readUInt32BE(offset + 1);
    const type = buf.readUInt8(offset + 5);
    const len = buf.readUInt16BE(offset + 6);
    if (type === FRAME_DATA && len > MAX_PAYLOAD) {
      return { frames, rest: buf.subarray(offset), error: new Error(`mux frame too large: ${len}`) };
    }
    const total = HEADER_SIZE + len;
    if (buf.length - offset < total) break; // 等下一帧拼齐
    const payload = type === FRAME_DATA ? Buffer.from(buf.subarray(offset + HEADER_SIZE, offset + total)) : Buffer.alloc(0);
    frames.push({ id, type, payload });
    offset += total;
  }
  return { frames, rest: buf.subarray(offset) };
}

class VirtualSocket extends Duplex {
  constructor(mux, id) {
    super({ allowHalfOpen: true });
    this.mux = mux;
    this.id = id;
    this._sentFin = false;
    this._sentReset = false;
    this._gotFin = false;
    this._gotReset = false;
    // 兼容 http.ClientRequest 对 createConnection 返回值的 net.Socket 假设：
    // relay 侧开流时虚拟流立即可写（首帧会在对端懒注册该流），报一个 connect。
    if (mux.role === 'relay') {
      this.connecting = true;
      queueMicrotask(() => {
        if (!this.destroyed) {
          this.connecting = false;
          this.emit('connect');
        }
      });
    } else {
      this.connecting = false;
    }
    this.localAddress = '127.0.0.1';
    this.remoteAddress = '127.0.0.1';
  }

  // net.Socket 上有、Duplex 上没有的方法，http 客户端可能调用
  setNoDelay() {}
  setKeepAlive() {}
  ref() { return this; }
  unref() { return this; }
  setTimeout(ms, cb) {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (ms > 0) {
      this._idleTimer = setTimeout(() => {
        this.emit('timeout');
        try { cb?.(); } catch { /* 忽略 */ }
      }, ms);
      this._idleTimer.unref?.();
    }
    return this;
  }

  // 数据由网络到达时主动 push；消费者跟不上时由 Readable 内部缓冲，
  // _read 无需主动拉取（pull 模式不适用）。
  _read() {}

  _write(chunk, _enc, cb) {
    if (this._sentFin || this._sentReset) { cb(); return; }
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    try {
      for (let off = 0; off < data.length; off += MAX_PAYLOAD) {
        const slice = data.subarray(off, Math.min(off + MAX_PAYLOAD, data.length));
        this.mux._sendFrame(this.id, FRAME_DATA, slice);
      }
    } catch (err) {
      cb(err);
      return;
    }
    // 背压：WS 发送缓冲堆积时暂停一下，等 drain 轮询恢复
    if (this.mux._wsBuffered() > HIGH_WATER) {
      this.mux._waitDrain(cb);
    } else {
      cb();
    }
  }

  _final(cb) {
    if (!this._sentFin && !this._sentReset) {
      this._sentFin = true;
      try { this.mux._sendFrame(this.id, FRAME_FIN); } catch { /* 关闭中 */ }
    }
    cb();
  }

  _destroy(err, cb) {
    if (this._idleTimer) clearTimeout(this._idleTimer);
    if (!this._sentReset && !this._sentFin) {
      this._sentReset = true;
      try { this.mux._sendFrame(this.id, FRAME_RESET); } catch { /* 关闭中 */ }
    }
    this.mux._unregister(this.id);
    cb(err);
  }

  /** 对端 DATA */
  _deliverData(payload) {
    if (this._gotFin || this._gotReset) return;
    this.push(payload);
  }

  /** 对端 FIN（写半关闭 → 本侧读 EOF） */
  _deliverFin() {
    if (this._gotFin || this._gotReset) return;
    this._gotFin = true;
    this.push(null);
  }

  /** 对端 RESET */
  _deliverReset() {
    if (this._gotReset) return;
    this._gotReset = true;
    this.destroy(new Error('stream reset by peer'));
  }
}

/**
 * @param {import('ws').WebSocket} ws 已建立的 WebSocket
 * @param {{role:'relay'|'agent', heartbeatMs?:number, log?:object}} opts
 *   role=relay：主动开流（App 连接侧）；role=agent：被动接流（插件侧，对接到本机）
 */
export class Mux extends EventEmitter {
  constructor(ws, { role = 'relay', heartbeatMs = 20_000, log = console } = {}) {
    super();
    if (role !== 'relay' && role !== 'agent') throw new Error('role must be relay|agent');
    this.ws = ws;
    this.role = role;
    this.log = log;
    this.streams = new Map();
    this._nextId = role === 'relay' ? 1 : 2;
    this._recvBuffer = Buffer.alloc(0);
    this._closed = false;
    this._drainWaiters = [];
    this._drainTimer = null;

    this.ws.on('message', (data, isBinary) => {
      // ws v8 的 isBinary 是布尔值且对文本帧同样传 Buffer，必须以它为准；
      // 其它实现没给布尔值时再按类型嗅探。
      const binary = typeof isBinary === 'boolean'
        ? isBinary
        : (Buffer.isBuffer(data) || data instanceof ArrayBuffer || ArrayBuffer.isView(data));
      if (binary) {
        this._onBinary(Buffer.isBuffer(data) ? data : Buffer.from(data));
      } else {
        this._onText(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
      }
    });
    this.ws.on('close', () => this._onClose());
    this.ws.on('error', (err) => {
      this.log.warn?.(`mux: ws error: ${err.message}`);
      this._onClose();
    });

    // 心跳：标准 ws isAlive 模式（ws 自动回 pong）
    this._alive = true;
    this.ws.on('pong', () => { this._alive = true; });
    if (heartbeatMs > 0) {
      this._heartbeat = setInterval(() => {
        if (!this.ws || this.ws.readyState !== 1) return;
        if (!this._alive) {
          this.log.warn?.('mux: heartbeat timeout, terminating ws');
          try { this.ws.terminate(); } catch { /* 已关闭 */ }
          return;
        }
        this._alive = false;
        try { this.ws.ping(); } catch { /* 关闭中 */ }
      }, heartbeatMs);
      this._heartbeat.unref?.();
    }
  }

  _sendFrame(id, type, payload) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('mux ws not open');
    this.ws.send(encodeFrame(id, type, payload));
  }

  sendControl(obj) {
    if (!this.ws || this.ws.readyState !== 1) throw new Error('mux ws not open');
    this.ws.send(JSON.stringify(obj));
  }

  _wsBuffered() {
    return this.ws?.bufferedAmount ?? 0;
  }

  _waitDrain(cb) {
    this._drainWaiters.push(cb);
    if (!this._drainTimer) {
      this._drainTimer = setInterval(() => {
        if (this._wsBuffered() <= HIGH_WATER / 2) {
          const waiters = this._drainWaiters;
          this._drainWaiters = [];
          clearInterval(this._drainTimer);
          this._drainTimer = null;
          for (const w of waiters) w();
        }
      }, 25);
      this._drainTimer.unref?.();
    }
  }

  /** relay 侧开一条新虚拟流 */
  openStream() {
    if (this.role !== 'relay') throw new Error('only relay side opens streams');
    const id = this._nextId;
    this._nextId += 2;
    const sock = new VirtualSocket(this, id);
    this.streams.set(id, sock);
    return sock;
  }

  _registerIncoming(id) {
    let sock = this.streams.get(id);
    if (sock) return sock;
    if (this.role !== 'agent') {
      // relay 不应收到对端新开的流
      try { this._sendFrame(id, FRAME_RESET); } catch { /* 忽略 */ }
      return null;
    }
    sock = new VirtualSocket(this, id);
    this.streams.set(id, sock);
    queueMicrotask(() => this.emit('stream', sock));
    return sock;
  }

  _unregister(id) {
    this.streams.delete(id);
  }

  _onBinary(chunk) {
    this._recvBuffer = this._recvBuffer.length
      ? Buffer.concat([this._recvBuffer, chunk])
      : chunk;
    const { frames, rest, error } = decodeFrames(this._recvBuffer);
    this._recvBuffer = rest;
    if (error) {
      this.log.warn?.(`mux: ${error.message}, closing`);
      try { this.ws.close(1008, 'protocol error'); } catch { /* 忽略 */ }
      return;
    }
    for (const f of frames) {
      const sock = this.streams.get(f.id) ?? (f.type === FRAME_DATA ? this._registerIncoming(f.id) : null);
      if (!sock) continue;
      if (f.type === FRAME_DATA) sock._deliverData(f.payload);
      else if (f.type === FRAME_FIN) sock._deliverFin();
      else if (f.type === FRAME_RESET) sock._deliverReset();
    }
  }

  _onText(text) {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (msg && typeof msg === 'object' && msg.type) this.emit('control', msg);
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    if (this._heartbeat) clearInterval(this._heartbeat);
    if (this._drainTimer) clearInterval(this._drainTimer);
    for (const sock of [...this.streams.values()]) {
      try { sock._deliverReset(); } catch { /* 忽略 */ }
    }
    this.streams.clear();
    this.emit('close');
  }

  close() {
    if (this._closed) return;
    try { this.ws.close(1000, 'bye'); } catch { /* 忽略 */ }
    this._onClose();
  }
}
