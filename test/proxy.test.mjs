// 本机代理单测：PIN 认证、loopback 改写、ping/status 内省、WS 透传
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { createRemoteProxy, PING_PATH, STATUS_PATH } from '../lib/proxy.mjs';

const PIN = '12345678';
const PUBLIC_HOST = 'dsh.example.com:3080';

let upstream;
let proxy;
const seenHosts = [];

before(async () => {
  upstream = createServer((req, res) => {
    seenHosts.push(req.headers.host);
    if (req.url?.startsWith('/api/hello')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, host: req.headers.host, url: req.url }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('upstream 404');
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (ws, req) => {
    ws.on('message', (m) => ws.send(`echo:${m}`));
    ws.send(`hello:${new URL(req.url, 'http://x').pathname}`);
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  proxy = await createRemoteProxy({
    port: 0,
    host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    auth: { getPin: () => PIN, sessionKey: 'test-session' },
    injectHtml: '',
    heartbeat: false,
    rateLimit: { globalMaxFailures: 1_000_000, maxFailures: 1_000_000 },
    log: () => {},
  });
});

after(async () => {
  await proxy.close();
  await new Promise((r) => upstream.close(r));
});

function req({ method = 'GET', path = '/', host = PUBLIC_HOST, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const r = httpRequest({
      host: '127.0.0.1', port: proxy.port, method, path,
      headers: { host, ...headers }, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    r.on('error', reject);
    r.end();
  });
}

test('ping 内省端点：公网 Host、无 PIN 也可访问', async () => {
  const r = await req({ path: PING_PATH });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
});

test('status 内省端点：loopback 来源可看运行状态', async () => {
  const r = await req({ path: STATUS_PATH });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('公网 Host 无凭证 → 401', async () => {
  const r = await req({ path: '/api/hello' });
  assert.equal(r.status, 401);
});

test('错误 PIN → 401', async () => {
  const r = await req({ path: '/api/hello?token=wrongwrong' });
  assert.equal(r.status, 401);
});

test('正确 PIN（?token=）→ 放行并下发 cookie，且上游看到 loopback Host', async () => {
  const r = await req({ path: `/api/hello?token=${PIN}` });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.ok, true);
  assert.match(j.host, /^127\.0\.0\.1:\d+$/);
  assert.match(String(r.headers['set-cookie']?.[0] ?? ''), /dsh_remote_token=/);
});

test('cookie 复用 → 无需再带 token', async () => {
  const first = await req({ path: `/?token=${PIN}` });
  const cookie = (first.headers['set-cookie']?.[0] ?? '').split(';')[0];
  assert.ok(cookie);
  const r = await req({ path: '/api/hello', headers: { cookie } });
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).ok, true);
});

test('loopback Host（本机直连）→ 免 PIN', async () => {
  const r = await req({ host: `127.0.0.1:${proxy.port}`, path: '/api/hello' });
  assert.equal(r.status, 200);
});

test('连续 5 次错误 PIN → 限速 429', async () => {
  // 单独起一个用默认限速参数的代理，避免污染共享实例
  const locked = await createRemoteProxy({
    port: 0, host: '127.0.0.1',
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    auth: { getPin: () => PIN, sessionKey: 'lock-test' },
    injectHtml: '', heartbeat: false, log: () => {},
  });
  try {
    const ask = () => new Promise((resolve, reject) => {
      const r = httpRequest({
        host: '127.0.0.1', port: locked.port, method: 'GET',
        path: '/api/hello?token=badbadbad',
        headers: { host: PUBLIC_HOST }, agent: false,
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      r.on('error', reject); r.end();
    });
    let last;
    for (let i = 0; i < 6; i++) last = await ask();
    assert.equal(last, 429);
  } finally {
    await locked.close();
  }
});

test('WebSocket 经代理透传（公网 Host + ?token=）', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/echo?token=${PIN}`, {
    headers: { host: PUBLIC_HOST },
  });
  const msgs = [];
  ws.on('message', (m) => msgs.push(String(m)));
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  ws.send('abc');
  await new Promise((r) => setTimeout(r, 300));
  ws.close();
  assert.ok(msgs.includes('hello:/api/echo'));
  assert.ok(msgs.includes('echo:abc'));
});

test('WebSocket 无 PIN → 401 拒绝', async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/api/remote.mux`, {
    headers: { host: PUBLIC_HOST },
  });
  await assert.rejects(new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  }), /response.*401/i);
});
