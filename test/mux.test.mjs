// mux 单测：虚拟流多路复用、字节完整性、半关闭、并发流
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect as netConnect } from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';
import { Mux, encodeFrame, decodeFrames, FRAME_DATA, FRAME_FIN } from '../lib/mux.mjs';

function startWss() {
  return new Promise((resolve) => {
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 }, () => resolve(wss));
  });
}

/** 建一对 mux：relay 端（服务侧）+ agent 端（客户端侧），agent 把流对接到 echo TCP */
async function muxPair(echoPort) {
  const wss = await startWss();
  const addr = wss.address();
  return new Promise((resolve) => {
    const clientWs = new WebSocket(`ws://127.0.0.1:${addr.port}/relay/ws`);
    wss.on('connection', (serverWs) => {
      const relayMux = new Mux(serverWs, { role: 'relay', heartbeatMs: 0 });
      clientWs.on('open', () => {
        const agentMux = new Mux(clientWs, { role: 'agent', heartbeatMs: 0 });
        agentMux.on('stream', (vs) => {
          const sock = netConnect(echoPort, '127.0.0.1');
          vs.pipe(sock, { end: false });
          sock.pipe(vs, { end: false });
          vs.on('end', () => sock.end());
          sock.on('end', () => vs.end());
          vs.on('error', () => sock.destroy());
          sock.on('error', () => vs.destroy());
        });
        resolve({ relayMux, agentMux, close: async () => {
          relayMux.close(); agentMux.close();
          await new Promise((r) => wss.close(r));
          clientWs.terminate();
        } });
      });
    });
  });
}

function echoTcpServer() {
  return new Promise((resolve) => {
    const chunks = [];
    const server = createServer((sock) => {
      sock.pipe(sock); // 原样回显
      sock.on('data', (c) => chunks.push(c.length));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, chunks }));
  });
}

test('帧编解码：小帧不粘连后续 FIN 头', () => {
  const buf = Buffer.concat([
    encodeFrame(7, FRAME_DATA, Buffer.from('hello')),
    encodeFrame(7, FRAME_FIN),
    encodeFrame(9, FRAME_DATA, Buffer.from('x'.repeat(300))),
  ]);
  const { frames, rest } = decodeFrames(buf);
  assert.equal(rest.length, 0);
  assert.deepEqual(frames.map((f) => [f.id, f.type, f.payload.length]), [[7, 0, 5], [7, 1, 0], [9, 0, 300]]);
  assert.equal(frames[0].payload.toString(), 'hello');
});

test('帧编解码：半包留在 rest 等下次拼齐', () => {
  const full = encodeFrame(3, FRAME_DATA, Buffer.from('abcdef'));
  const r1 = decodeFrames(full.subarray(0, 5));
  assert.equal(r1.frames.length, 0);
  assert.equal(r1.rest.length, 5);
  const r2 = decodeFrames(Buffer.concat([r1.rest, full.subarray(5)]));
  assert.equal(r2.frames.length, 1);
  assert.equal(r2.frames[0].payload.toString(), 'abcdef');
});

test('端到端：单条虚拟流 echo 字节一致', async () => {
  const echo = await echoTcpServer();
  const { relayMux, close } = await muxPair(echo.port);
  try {
    const vs = relayMux.openStream();
    const got = [];
    vs.on('data', (c) => got.push(c));
    const ended = new Promise((r) => vs.on('end', r));
    vs.write(Buffer.from('ping-'));
    vs.write(Buffer.from('pong'));
    vs.end();
    await ended;
    assert.equal(Buffer.concat(got).toString(), 'ping-pong');
  } finally {
    await close();
    await new Promise((r) => echo.server.close(r));
  }
});

test('端到端：1MiB 大负载完整回显', async () => {
  const echo = await echoTcpServer();
  const { relayMux, close } = await muxPair(echo.port);
  try {
    const vs = relayMux.openStream();
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const checksum = payload.reduce((a, b) => a + b, 0);
    const got = [];
    vs.on('data', (c) => got.push(c));
    const ended = new Promise((r) => vs.on('end', r));
    vs.end(payload);
    await ended;
    const out = Buffer.concat(got);
    assert.equal(out.length, payload.length);
    assert.equal(out.reduce((a, b) => a + b, 0), checksum);
  } finally {
    await close();
    await new Promise((r) => echo.server.close(r));
  }
});

test('端到端：8 条并发虚拟流互不串流', async () => {
  const echo = await echoTcpServer();
  const { relayMux, close } = await muxPair(echo.port);
  try {
    const streams = Array.from({ length: 8 }, (_, i) => {
      const vs = relayMux.openStream();
      const marker = Buffer.from(`stream-${i}-`.repeat(100));
      const got = [];
      vs.on('data', (c) => got.push(c));
      return { vs, marker, got, done: new Promise((r) => vs.on('end', r)) };
    });
    for (const s of streams) s.vs.end(s.marker);
    await Promise.all(streams.map((s) => s.done));
    for (const s of streams) {
      assert.equal(Buffer.concat(s.got).toString(), s.marker.toString());
    }
  } finally {
    await close();
    await new Promise((r) => echo.server.close(r));
  }
});
