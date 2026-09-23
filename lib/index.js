// dsh-remote —— DSH 插件入口（node 侧）
//
// 启动两件东西：
//   1. 本机代理（lib/proxy.mjs）：loopback 权威改写 + PIN，端口默认 3081；
//   2. 隧道客户端（lib/tunnel-client.mjs）：主动外拨中继 WSS。
// 局域网里中继直接反代本机代理；外网里中继走隧道回到本机代理，殊途同归。
//
// 两条链路各有开关（设置页 /__dsh-remote/ 控制，配置存在 config.json 的 access）：
//   access.lan    局域网访问：代理拒绝非本机连接 + 不通告 LAN 候选
//   access.tunnel 公网隧道：不创建/启动隧道客户端，零外连

import { createRemoteProxy } from './proxy.mjs';
import { TunnelClient } from './tunnel-client.mjs';
import { loadConfig, resolvePin, resolveRelayToken, saveConfig, savePin } from './config.mjs';
import { lanTargets } from './netutil.mjs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export const name = 'remote';
export const inject = ['connection', 'webServer'];

/**
 * 独立可复用的启动函数（CLI 也调它）。
 * @returns {Promise<{proxy:object, tunnel:TunnelClient|null, config:object, pin:object}>}
 */
export async function startRemote({ ctx = null, configOverride = null, home = null } = {}) {
  // 注意：cordis 上下文未注入 config 服务时访问 ctx.config 会直接抛错，
  // 插件模式的配置由 apply 的第二个参数传入（configOverride）。
  const cordisConfig = configOverride ?? {};
  const homeDir = home ?? process.env.DSH_HOME ?? join(homedir(), '.dsh');
  const config = loadConfig({ home: homeDir, cordisConfig });
  const dshPort = Number(ctx?.webServer?.port ?? configOverride?.upstreamPort ?? process.env.DSH_UPSTREAM_PORT ?? 3080);
  const log = (...args) => {
    const line = args.join(' ');
    if (ctx?.logger) ctx.logger(line);
    else console.log(`[dsh-remote] ${line}`);
  };
  const logObj = {
    info: (...a) => log(...a),
    warn: (...a) => log(`[warn] ${a.join(' ')}`),
    error: (...a) => log(`[error] ${a.join(' ')}`),
    debug() {},
  };

  // 访问 PIN（可变：设置页改密码后直接更新内存值）
  const pinInfo = resolvePin(config, { home: homeDir });
  const sessionKey = `dsh-remote:${dshPort}`;
  log(`访问 PIN 来源：${pinInfo.source === 'generated' ? '已自动生成（见数据目录 pin 文件）' : pinInfo.source}`);

  // dsh web 浏览器会话启动 token（与 dsh-pocket 同机制，issue #77）：
  // authenticatedUrl 是 connection 服务的方法（不是属性），token 每次 dsh 进程
  // 重启都会变，必须每次请求实时取；老版本没有该方法 → 返回空，行为不变。
  const launchToken = () => {
    try {
      const fn = ctx?.connection?.authenticatedUrl;
      if (typeof fn !== 'function') return '';
      const url = new URL(fn.call(ctx.connection, `http://127.0.0.1:${dshPort}`));
      return url.searchParams.get('token') || '';
    } catch { return ''; }
  };

  const localPort = Number(config.local.port);
  let tunnel = null;
  const relayToken = resolveRelayToken(config, { home: homeDir });
  const canTunnel = () => config.relay.urls.length > 0 && !!relayToken;
  const currentCandidates = () => (config.access.lan ? lanTargets(proxy.port) : []);

  // 设置钩子对象先占位（proxy 要持有），方法在 proxy 创建后补齐
  const settingsHooks = { access: () => config.access };

  const proxy = await createRemoteProxy({
    port: localPort,
    host: config.local.host,
    upstream: { host: '127.0.0.1', port: dshPort },
    auth: { getPin: () => pinInfo.pin, sessionKey },
    launchToken,
    node: config.relay.node,
    settings: settingsHooks,
    log: (...a) => logObj.info(...a),
    status: () => ({
      version: pkg.version,
      upstream: `127.0.0.1:${dshPort}`,
      pinSource: pinInfo.source,
      pinSet: pinInfo.pin.length > 0,
      access: { ...config.access },
      relay: tunnel?.status() ?? null,
      lanCandidates: currentCandidates(),
    }),
  });
  log(`本机代理已启动：${config.local.host}:${proxy.port} → 127.0.0.1:${dshPort}`);

  // ---------- 隧道生命周期（受 access.tunnel 开关控制） ----------

  function ensureTunnel() {
    if (tunnel || !canTunnel()) return tunnel;
    tunnel = new TunnelClient({
      urls: config.relay.urls,
      token: relayToken,
      node: config.relay.node,
      localPort: proxy.port,
      localHost: '127.0.0.1',
      getCandidates: currentCandidates,
      log: logObj,
    });
    tunnel.on('connected', () => log(`隧道就绪，App 可经中继访问；LAN 候选：${currentCandidates().map((t) => t.ip).join(', ') || '无'}`));
    return tunnel;
  }

  function setTunnelEnabled(on) {
    config.access.tunnel = on;
    if (on) {
      const t = ensureTunnel();
      if (!t) { log('无法启用隧道：缺少 relay.urls 或 relay token'); return false; }
      t.start();
    } else {
      tunnel?.stop();
      log('公网隧道访问已关闭：不再向服务器发起连接');
    }
    return true;
  }

  function setLanEnabled(on) {
    config.access.lan = on;
    // 连接闸门由代理实时读取；这里立即重新通告候选，让 relay 尽快收敛
    if (tunnel?.state === 'connected' && tunnel.mux) {
      try { tunnel.mux.sendControl({ type: 'lan', candidates: currentCandidates() }); } catch { /* 连接关闭中 */ }
    }
    log(`局域网访问已${on ? '开启' : '关闭'}`);
  }

  function changePin(newPin) {
    savePin(newPin, { home: homeDir });
    pinInfo.pin = newPin;
    pinInfo.source = 'file';
    log(`访问密码已${newPin ? '修改' : '清空（密码校验已关闭）'}`);
  }

  function snapshot() {
    return {
      ok: true,
      node: config.relay.node,
      urls: config.relay.urls,
      access: { ...config.access },
      pin: {
        set: pinInfo.pin.length > 0,
        length: Array.from(pinInfo.pin).length,
        source: pinInfo.source,
      },
      tunnel: canTunnel()
        ? (tunnel?.status() ?? { state: config.access.tunnel ? 'idle' : 'stopped' })
        : null,
    };
  }

  Object.assign(settingsHooks, {
    get: async () => snapshot(),
    post: async (patch) => {
      if (patch.lan !== undefined && patch.lan !== null) setLanEnabled(!!patch.lan);
      if (patch.tunnel !== undefined && patch.tunnel !== null) setTunnelEnabled(!!patch.tunnel);
      if (patch.pin !== undefined && patch.pin !== null) changePin(String(patch.pin));
      saveConfig({ access: config.access }, { home: homeDir });
      return snapshot();
    },
  });

  // 初始：按开关决定是否启动隧道
  if (config.access.tunnel) {
    if (canTunnel()) ensureTunnel().start();
    else log('未配置中继地址/密钥（relay.urls + relay.token），仅启用本机代理（局域网反代模式）');
  } else {
    log('公网隧道访问默认关闭（access.tunnel=false），不发起外连');
  }

  return { proxy, tunnel, config, pin: pinInfo };
}

export async function apply(ctx, config = {}) {
  console.log('[dsh-remote] apply 开始加载');
  const running = await startRemote({ ctx, configOverride: config });
  console.log(`[dsh-remote] 已启动：本机代理端口 ${running.proxy.port}，隧道 ${running.config.access.tunnel ? '启用' : '未启用'}`);
  // cordis effect：外层立即执行，返回的函数才是 dispose 清理（写反会立刻关掉代理）
  ctx.effect(() => () => {
    running.tunnel?.stop();
    running.proxy.close().catch(() => {});
  });
}

export default { name, inject, apply };
