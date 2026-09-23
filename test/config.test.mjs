// 配置加载与 PIN 管理单测
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadConfig, resolvePin, resolveRelayToken,
  saveConfig, saveRelayToken, generateRelayToken, savePin,
} from '../lib/config.mjs';

let home;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dsh-remote-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

test('默认配置：端口 3081、空 relay', () => {
  const c = loadConfig({ home, env: {} });
  assert.equal(c.local.port, 3081);
  assert.deepEqual(c.relay.urls, []);
  assert.equal(c.relay.token, '');
});

test('config.json + 环境变量覆盖', () => {
  saveConfig({ relay: { urls: ['wss://a.example/relay/ws'], token: 'file-token', node: 'n1' } }, { home });
  const c = loadConfig({ home, env: { DSH_RELAY_URL: 'wss://b.example/relay/ws,wss://c.example/relay/ws', DSH_RELAY_TOKEN: 'env-token' } });
  assert.deepEqual(c.relay.urls, ['wss://b.example/relay/ws', 'wss://c.example/relay/ws']);
  assert.equal(c.relay.token, 'env-token'); // env 优先
  assert.equal(c.relay.node, 'n1');
});

test('PIN：未配置时自动生成并落盘 0600', () => {
  const c = loadConfig({ home, env: {} });
  const { pin, source } = resolvePin(c, { home });
  assert.equal(source, 'generated');
  assert.match(pin, /^\d{8}$/);
  assert.ok(existsSync(join(home, 'dsh-remote', 'pin')));
  const mode = statSync(join(home, 'dsh-remote', 'pin')).mode & 0o777;
  assert.equal(mode, 0o600);
  // 再次读取应拿到同一个 PIN
  assert.equal(resolvePin(c, { home }).pin, pin);
});

test('PIN：显式配置不做任何格式校验（短密码/中文/符号均可）', () => {
  for (const v of ['1', 'a', '我的 密码!@#', 'x'.repeat(500)]) {
    const c = loadConfig({ home, env: { DSH_REMOTE_PIN: v } });
    const r = resolvePin(c, { home });
    assert.equal(r.pin, v);
    assert.equal(r.source, 'config');
  }
});

test('PIN：savePin 写入任意密码（含空格/空串），原样读回且 0600', () => {
  for (const v of ['  p  ', '密码🔑 with space', '']) {
    const p = savePin(v, { home });
    assert.equal(statSync(p).mode & 0o777, 0o600);
    const c = loadConfig({ home, env: {} });
    const r = resolvePin(c, { home });
    assert.equal(r.pin, v);
    assert.equal(r.source, 'file');
  }
});

test('access 开关：默认全开；文件与环境变量可关闭', () => {
  assert.deepEqual(loadConfig({ home, env: {} }).access, { lan: true, tunnel: true });
  saveConfig({ access: { lan: false } }, { home });
  assert.deepEqual(loadConfig({ home, env: {} }).access, { lan: false, tunnel: true });
  assert.deepEqual(
    loadConfig({ home, env: { DSH_ACCESS_TUNNEL: 'off' } }).access,
    { lan: false, tunnel: false },
  );
});

test('PIN：合法显式值优先于文件', () => {
  const c = loadConfig({ home, env: { DSH_REMOTE_PIN: 'abcdefgh' } });
  const r = resolvePin(c, { home });
  assert.equal(r.pin, 'abcdefgh');
  assert.equal(r.source, 'config');
});

test('中继密钥：独立 token 文件读取', () => {
  const p = saveRelayToken('file-relay-token', { home });
  assert.equal(statSync(p).mode & 0o777, 0o600);
  const c = loadConfig({ home, env: {} });
  assert.equal(resolveRelayToken(c, { home }), 'file-relay-token');
});

test('saveConfig 合并而非覆盖', () => {
  saveConfig({ relay: { urls: ['wss://a/relay/ws'], node: 'n1' }, pin: 'aaaaaaaa' }, { home });
  saveConfig({ relay: { token: 't1' } }, { home });
  const raw = JSON.parse(readFileSync(join(home, 'dsh-remote', 'config.json'), 'utf8'));
  assert.equal(raw.relay.urls[0], 'wss://a/relay/ws');
  assert.equal(raw.relay.node, 'n1');
  assert.equal(raw.relay.token, 't1');
  assert.equal(raw.pin, 'aaaaaaaa');
});

test('生成的中继密钥长度足够', () => {
  assert.ok(generateRelayToken().length >= 40);
});
