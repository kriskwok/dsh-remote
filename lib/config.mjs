// dsh-remote 配置：$DSH_HOME/dsh-remote/config.json + 环境变量覆盖
//
// config.json 示例：
// {
//   "relay": {
//     "urls": ["wss://dsh.example.com:3443/relay/ws"],
//     "token": "中继共享密钥",
//     "node": "macbook"
//   },
//   "local": { "port": 3081, "host": "0.0.0.0" },
//   "access": { "lan": true, "tunnel": true },
//   "pin": "访问密码（不填则用 pin 文件；格式长度不限）"
// }
//
// 密钥优先级：环境变量 > config.json > 默认值。
// relay.token 也可以用 DSH_RELAY_TOKEN 提供（不落盘）。

import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomInt, randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

export const DEFAULT_LOCAL_PORT = 3081;
export const DEFAULT_RELAY_PATH = '/relay/ws';

/** 插件数据目录：$DSH_HOME/dsh-remote（默认 ~/.dsh/dsh-remote） */
export function dataDir(home = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(home, 'dsh-remote');
}

export function configPath(home) {
  return join(dataDir(home), 'config.json');
}

function readJsonFile(p) {
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

function deepMerge(base, override) {
  if (!override || typeof override !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...(base ?? {}) };
  for (const [k, v] of Object.entries(override)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** 默认节点名：机器名清洗成合法短标识 */
function defaultNodeName() {
  const h = hostname().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  return h || 'node';
}

/**
 * 读取并归一化配置。
 * @param {{home?:string, env?:NodeJS.ProcessEnv, cordisConfig?:object}} [opts]
 */
export function loadConfig({ home, env = process.env, cordisConfig = {} } = {}) {
  const homeDir = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const file = readJsonFile(configPath(homeDir));
  const merged = deepMerge({
    relay: {
      urls: [],
      token: '',
      node: defaultNodeName(),
    },
    local: {
      port: DEFAULT_LOCAL_PORT,
      host: '0.0.0.0',
    },
    access: {
      lan: true,
      tunnel: true,
    },
    pin: '',
  }, deepMerge(file, cordisConfig ?? {}));

  // 环境变量覆盖
  if (env.DSH_RELAY_URL) merged.relay.urls = String(env.DSH_RELAY_URL).split(',').map((s) => s.trim()).filter(Boolean);
  if (env.DSH_RELAY_TOKEN) merged.relay.token = String(env.DSH_RELAY_TOKEN);
  if (env.DSH_RELAY_NODE) merged.relay.node = String(env.DSH_RELAY_NODE);
  if (env.DSH_REMOTE_PORT) merged.local.port = Number(env.DSH_REMOTE_PORT) || merged.local.port;
  if (env.DSH_REMOTE_PIN) merged.pin = String(env.DSH_REMOTE_PIN);
  if (env.DSH_ACCESS_LAN) merged.access.lan = !/^(0|false|no|off)$/i.test(String(env.DSH_ACCESS_LAN).trim());
  if (env.DSH_ACCESS_TUNNEL) merged.access.tunnel = !/^(0|false|no|off)$/i.test(String(env.DSH_ACCESS_TUNNEL).trim());

  // urls 归一化：允许传单个字符串
  if (typeof merged.relay.urls === 'string') merged.relay.urls = [merged.relay.urls];
  merged.relay.urls = (merged.relay.urls ?? []).map((u) => String(u).trim()).filter(Boolean);
  merged.relay.token = String(merged.relay.token ?? '').trim();
  merged.relay.node = String(merged.relay.node ?? defaultNodeName()).trim() || defaultNodeName();
  merged.local.port = Number.isInteger(merged.local.port) ? merged.local.port : DEFAULT_LOCAL_PORT;
  merged.local.host = String(merged.local.host ?? '0.0.0.0');
  merged.access = {
    lan: merged.access?.lan !== false,
    tunnel: merged.access?.tunnel !== false,
  };

  return merged;
}

// ---------- 访问密码（PIN） ----------

export function pinPath(home) {
  return join(dataDir(home), 'pin');
}

/** CSPRNG 生成 8 位数字 PIN（首次启动未设置密码时的默认值） */
export function generatePin() {
  return String(randomInt(10_000_000, 100_000_000));
}

/** 读密码文件原文：只去掉单个结尾换行，保留空格/中文/符号等全部字符 */
function readPinFile(p) {
  let raw = readFileSync(p, 'utf8');
  if (raw.endsWith('\n')) raw = raw.slice(0, -1);
  if (raw.endsWith('\r')) raw = raw.slice(0, -1);
  return raw;
}

/**
 * 取当前访问密码：config.pin（非空）> pin 文件（文件存在即可，含空文件）>
 * 自动生成并写入（0600）。密码不做任何格式/长度校验。
 * @returns {{pin:string, source:'config'|'file'|'generated'}}
 */
export function resolvePin(config, { home } = {}) {
  const homeDir = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const explicit = String(config?.pin ?? '');
  if (explicit) return { pin: explicit, source: 'config' };
  const p = pinPath(homeDir);
  if (existsSync(p)) return { pin: readPinFile(p), source: 'file' };
  const fresh = generatePin();
  savePin(fresh, { home: homeDir });
  return { pin: fresh, source: 'generated' };
}

/**
 * 修改访问密码：任意字符串均可（含中文/空格/符号/超长；空串 = 关闭密码校验）。
 * 写入独立 pin 文件（0600，无结尾换行）。
 */
export function savePin(pin, { home } = {}) {
  const homeDir = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const p = pinPath(homeDir);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  // 原子写
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, String(pin), { mode: 0o600 });
  renameSync(tmp, p);
  return p;
}

// ---------- 中继共享密钥 ----------

/**
 * 取中继共享密钥：config/env 之外，也可落盘在 token 文件（0600），便于
 * 「写一次文件、config.json 里不放密钥」。
 */
export function relayTokenPath(home) {
  return join(dataDir(home), 'relay-token');
}

export function resolveRelayToken(config, { home } = {}) {
  const fromConfig = String(config?.relay?.token ?? '').trim();
  if (fromConfig) return fromConfig;
  const homeDir = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  try {
    return readFileSync(relayTokenPath(homeDir), 'utf8').trim();
  } catch { return ''; }
}

/** 生成新的中继共享密钥（部署时用一次） */
export function generateRelayToken() {
  return randomBytes(32).toString('base64url');
}

/** 原子写 config.json（合并现有字段） */
export function saveConfig(patch, { home } = {}) {
  const homeDir = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const p = configPath(homeDir);
  const current = readJsonFile(p);
  const next = deepMerge(current, patch);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  renameSync(tmp, p);
  return next;
}

/** 写中继密钥到独立 0600 文件 */
export function saveRelayToken(token, { home } = {}) {
  const homeDir = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const p = relayTokenPath(homeDir);
  mkdirSync(dirname(p), { recursive: true, mode: 0o700 });
  writeFileSync(p, String(token).trim(), { mode: 0o600 });
  return p;
}

export { existsSync };
