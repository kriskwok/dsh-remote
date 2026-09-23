// 端到端：上游 dsh 替身 + 本机代理 + 中继 + 隧道客户端，全链路验证
//   隧道模式（无 LAN 候选）→ HTTP/WS 经 mux 回连
//   局域网模式（候选可达）→ 中继直连代理
//   LAN 候选失效 → 当次请求自动兜底隧道
//   无节点 → 502/503
//   隧道鉴权失败 → 401
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, get as httpGet } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createRemoteProxy } from '../lib/proxy.mjs';
import { createRelayServer } from '../relay/server.mjs';
import { TunnelClient } from '../lib/tunnel-client.mjs';

const PIN = '87654321';
const TOKEN = 'test-relay-secret';
const PUBLIC_HOST = 'dsh.example.com:3080';
const silent = { info() {}, warn() {}, error() {}, debug() {} };

let upstream;
let proxy;
let relay;
let tunnel;
let candidates = [];

function upstreamServer() {
  const server = createServer((req, res) => {
    if (req.url?.startsWith('/api/hello')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, via: 'upstream', host: req.headers.host, url: req.url }));
      return;
    }
    res.writeHead(404); res.end();
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws) => ws.on('message', (m) => ws.send(`echo:${m}`)));
  return server;
}

before(async () => {
  upstream = upstreamServer();
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  proxy = await createRemoteProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    auth: { getPin: () => PIN, sessionKey: 'e2e' },
    injectHtml: '', heartbeat: false, log: () => {},
  });
  relay = await createRelayServer({
    host: '127.0.0.1', port: 0, token: TOKEN,
    probeMs: 60_000, probeTimeoutMs: 500, lanDialTimeoutMs: 500, log: silent,
  });
  tunnel = new TunnelClient({
    urls: [`ws://127.0.0.1:${relay.port}/relay/ws`],
    token: TOKEN, node: 'test-mac', localPort: proxy.port,
    advertiseMs: 60_000, getCandidates: () => candidates, log: silent,
  });
  tunnel.start();
  await new Promise((r) => tunnel.on('connected', r));
});

after(async () => {
  tunnel?.stop();
  await relay?.close();
  await proxy?.close();
  await new Promise((r) => upstream.close(r));
});

function throughRelay(path, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({
      host: '127.0.0.1', port: relay.port, method, path,
      headers: { host: PUBLIC_HOST, ...headers }, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.end();
  });
}

function relayStatus() {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port: relay.port, path: '/relay/status', agent: false }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve(JSON.parse(b)));
    }).on('error', reject);
  });
}

async function waitMode(mode, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const s = await relayStatus();
    if (s.nodes[0]?.mode === mode) return s;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`等待中继进入 ${mode} 模式超时：${JSON.stringify(await relayStatus())}`);
}

test('隧道模式：HTTP 请求经 mux 回到本机代理并到达上游', async () => {
  candidates = [];
  // 主动触发一次 lan 通告（advertise 间隔在测试里被拉长）
  tunnel.mux.sendControl({ type: 'lan', candidates: [] });
  await waitMode('tunnel');
  const r = await throughRelay(`/api/hello?token=${PIN}`);
  assert.equal(r.status, 200, r.body);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
  assert.match(j.host, /^127\.0\.0\.1:\d+$/); // 代理把 Host 改写成了 loopback
});

test('隧道模式：WebSocket 经 mux 透传', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/api/echo?token=${PIN}`, {
    headers: { host: PUBLIC_HOST },
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send('hello-tunnel');
  const reply = await new Promise((r) => ws.on('message', (m) => { if (String(m) === 'echo:hello-tunnel') r(String(m)); }));
  assert.equal(reply, 'echo:hello-tunnel');
  ws.close();
});

test('隧道模式：无 PIN 被代理 401 拒绝', async () => {
  const r = await throughRelay('/api/hello');
  assert.equal(r.status, 401);
});

test('局域网模式：候选可达后中继切到 LAN 直连', async () => {
  candidates = [{ ip: '127.0.0.1', port: proxy.port }];
  tunnel.mux.sendControl({ type: 'lan', candidates });
  const s = await waitMode('lan');
  assert.deepEqual(s.nodes[0].lanTarget, { ip: '127.0.0.1', port: proxy.port });
  const r = await throughRelay(`/api/hello?token=${PIN}`);
  assert.equal(r.status, 200, r.body);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('局域网模式：WebSocket 直连透传', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/api/echo?token=${PIN}`, {
    headers: { host: PUBLIC_HOST },
  });
  await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  ws.send('hello-lan');
  const reply = await new Promise((r) => ws.on('message', (m) => { if (String(m) === 'echo:hello-lan') r(String(m)); }));
  assert.equal(reply, 'echo:hello-lan');
  ws.close();
});

test('LAN 候选失效（端口不通）→ 自动兜底隧道，请求仍成功', async () => {
  // 手动把中继的 lanTarget 指到一个必然拒绝连接的端口
  const s = await relayStatus();
  assert.equal(s.nodes[0].mode, 'lan');
  candidates = [{ ip: '127.0.0.1', port: 1 }];
  tunnel.mux.sendControl({ type: 'lan', candidates });
  // 等探测把 lanTarget 置空（1 端口探测失败）→ tunnel
  await waitMode('tunnel');
  const r = await throughRelay(`/api/hello?token=${PIN}`);
  assert.equal(r.status, 200, r.body);
});

test('节点离线 → HTTP 502', async () => {
  tunnel.stop();
  await new Promise((r) => setTimeout(r, 200));
  const r = await throughRelay('/api/hello');
  assert.equal(r.status, 502);
});

test('隧道鉴权：错误 token 被 401 拒绝', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/relay/ws`, {
    headers: { authorization: 'Bearer wrong-token' },
  });
  await assert.rejects(new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  }), /response.*401/i);
});
