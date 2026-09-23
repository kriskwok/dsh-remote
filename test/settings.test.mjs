// 设置页集成测试：页面/接口、LAN 与隧道开关实时生效、改密码（任意格式）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest, get as httpGet } from 'node:http';
import { WebSocketServer } from 'ws';
import { readFileSync } from 'node:fs';
import { createRemoteProxy } from '../lib/proxy.mjs';
import { createRelayServer } from '../relay/server.mjs';
import { TunnelClient } from '../lib/tunnel-client.mjs';
import { primaryLanIPv4 } from '../lib/netutil.mjs';
import { SETTINGS_PAGE_PATH, SETTINGS_CONFIG_PATH } from '../lib/settings-page.mjs';

const PIN0 = '87654321';
const TOKEN = 'test-relay-secret';
const PUBLIC_HOST = 'dsh.example.com:3443';
const silent = { info: (...a)=>console.log('[R]',...a), warn: (...a)=>console.warn('[R!]',...a), error: console.error, debug() {} };

let upstream; let proxy; let relay; let tunnel = null;
const access = { lan: true, tunnel: true };

before(async () => {
  upstream = createServer((req, res) => {
    if (req.url?.startsWith('/api/hello')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404); res.end();
  });
  new WebSocketServer({ server: upstream });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));

  const pinHolder = { pin: PIN0 };
  const settingsHooks = { access: () => access };

  proxy = await createRemoteProxy({
    port: 0, host: '0.0.0.0',
    upstream: { host: '127.0.0.1', port: upstream.address().port },
    auth: { getPin: () => pinHolder.pin, sessionKey: 'settings-test' },
    injectHtml: '', heartbeat: false, settings: settingsHooks, log: () => {},
  });

  relay = await createRelayServer({
    host: '127.0.0.1', port: 0, token: TOKEN,
    probeMs: 60_000, probeTimeoutMs: 500, lanDialTimeoutMs: 500, log: silent,
  });

  const candidates = () => (access.lan ? [{ ip: '127.0.0.1', port: proxy.port }] : []);
  function ensureTunnel() {
    if (tunnel) return tunnel;
    tunnel = new TunnelClient({
      urls: [`ws://127.0.0.1:${relay.port}/relay/ws`],
      token: TOKEN, node: 'test-mac', localPort: proxy.port,
      advertiseMs: 60_000, getCandidates: candidates, log: {info:(...a)=>console.log('[T]',...a),warn:(...a)=>console.warn('[T!]',...a),error:console.error,debug(){}},
    });
    return tunnel;
  }
  function snapshot() {
    return {
      ok: true, node: 'test-mac', urls: [], access: { ...access },
      pin: { set: pinHolder.pin.length > 0, length: Array.from(pinHolder.pin).length, source: 'file' },
      tunnel: tunnel?.status() ?? { state: 'stopped' },
    };
  }
  Object.assign(settingsHooks, {
    get: async () => snapshot(),
    post: async (patch) => {
      if (patch.lan !== undefined && patch.lan !== null) {
        access.lan = !!patch.lan;
        if (tunnel?.state === 'connected') tunnel.mux.sendControl({ type: 'lan', candidates: candidates() });
      }
      if (patch.tunnel !== undefined && patch.tunnel !== null) {
        access.tunnel = !!patch.tunnel;
        if (access.tunnel) ensureTunnel().start(); else tunnel?.stop();
      }
      if (patch.pin !== undefined && patch.pin !== null) pinHolder.pin = String(patch.pin);
      return snapshot();
    },
  });

  ensureTunnel().start();
  await new Promise((r) => tunnel.on('connected', r));
});

after(() => {
  tunnel?.stop();
  relay?.close();
  proxy?.close();
  upstream?.close();
});

// ---------- 工具 ----------

function settingsGet(path = SETTINGS_CONFIG_PATH) {
  return new Promise((resolve, reject) => {
    httpGet({ host: '127.0.0.1', port: proxy.port, path, agent: false }, (res) => {
      let b = ''; res.on('data', (c) => (b += c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: path === SETTINGS_CONFIG_PATH ? JSON.parse(b) : b,
      }));
    }).on('error', reject);
  });
}

function settingsPost(patch) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(patch);
    const req = httpRequest(
      { host: '127.0.0.1', port: proxy.port, path: SETTINGS_CONFIG_PATH, method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }, agent: false },
      (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(b) }));
      },
    );
    req.on('error', reject); req.end(data);
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
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`等待 mode=${mode} 超时`);
}

function throughRelay(path) {
  return new Promise((resolve, reject) => {
    httpRequest({
      host: '127.0.0.1', port: relay.port, method: 'GET', path,
      headers: { host: PUBLIC_HOST }, agent: false,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    }).on('error', reject).end();
  });
}

// ---------- 用例 ----------

test('设置页：loopback 直接打开返回 HTML', async () => {
  const r = await settingsGet(SETTINGS_PAGE_PATH);
  assert.equal(r.status, 200);
  assert.match(r.body, /DSH Remote 设置/);
});

test('配置读取：两个开关默认开启、隧道已连接', async () => {
  const r = await settingsGet();
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.access, { lan: true, tunnel: true });
  assert.equal(r.body.tunnel.state, 'connected');
  assert.equal(r.body.pin.set, true);
});

test('关闭公网隧道：隧道停止、节点离线、App 请求 502', async () => {
  const r = await settingsPost({ tunnel: false });
  assert.equal(r.body.tunnel.state, 'stopped');
  await new Promise((r) => setTimeout(r, 250));
  assert.equal((await relayStatus()).nodes.length, 0);
  assert.equal((await throughRelay('/api/hello')).status, 502);
});

test('重新开启公网隧道：自动重连，App 请求恢复', async () => {
  const r = await settingsPost({ tunnel: true });
  assert.equal(r.body.tunnel.state, 'connecting');
  await waitMode('lan'); // 默认候选可达 → lan
  const hello = await throughRelay(`/api/hello?token=${PIN0}`);
  assert.equal(hello.status, 200, hello.body);
});

test('关闭局域网访问：候选清空，relay 切到隧道模式，请求仍成功', async () => {
  const r = await settingsPost({ lan: false });
  assert.equal(r.body.access.lan, false);
  await waitMode('tunnel');
  const hello = await throughRelay(`/api/hello?token=${PIN0}`);
  assert.equal(hello.status, 200, hello.body);
});

test('局域网闸门：LAN 关闭时非 loopback 连接被拒；恢复后可达', { skip: !primaryLanIPv4() }, async () => {
  const lanIp = primaryLanIPv4();
  const probe = () => new Promise((resolve) => {
    const sock = httpRequest({ host: lanIp, port: proxy.port, path: '/__dsh-remote/ping', agent: false });
    sock.on('error', () => resolve('rejected'));
    sock.on('response', (res) => { res.resume(); resolve('ok'); });
    sock.end();
  });
  assert.equal(await probe(), 'rejected');
  await settingsPost({ lan: true });
  await waitMode('lan');
  assert.equal(await probe(), 'ok');
});

test('修改密码（中文/空格/符号）：旧会话 401，新密码可用', async () => {
  const newPin = '新 密码🔑!';
  const r = await settingsPost({ pin: newPin });
  assert.equal(r.body.pin.length, Array.from(newPin).length);
  assert.equal((await throughRelay(`/api/hello?token=${PIN0}`)).status, 401);
  const hello = await throughRelay(`/api/hello?token=${encodeURIComponent(newPin)}`);
  assert.equal(hello.status, 200, hello.body);
});

test('清空密码：空密码时无需认证即可访问', async () => {
  await settingsPost({ pin: '' });
  const hello = await throughRelay('/api/hello');
  assert.equal(hello.status, 200, hello.body);
  // 恢复一个密码，避免影响后续
  await settingsPost({ pin: PIN0 });
});
