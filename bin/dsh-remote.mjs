#!/usr/bin/env node
// dsh-remote CLI
//
// 两种用法：
//   1) 装在 dsh 里当插件（正常用法）：dsh plugin --profile web add dsh-remote -w
//   2) 独立运行（调试 / 不装插件）：
//        dsh-remote host --upstream 3080 --port 3081 \
//          --relay wss://dsh.example.com:3080/relay/ws --token <密钥>
//        dsh-remote relay --host 127.0.0.1 --port 3090 --token <密钥>   # 服务器端

import { parseArgs } from 'node:util';
import { startRemote } from '../lib/index.js';
import { createRelayServer } from '../relay/server.mjs';
import { generateRelayToken } from '../lib/config.mjs';

function parseCommon({ values }) {
  return values;
}

async function runHost(v) {
  const upstreamPort = Number(v.upstream ?? process.env.DSH_UPSTREAM_PORT ?? 3080);
  const override = {
    local: { port: Number(v.port ?? process.env.DSH_REMOTE_PORT ?? 3081), host: v.host ?? '0.0.0.0' },
    relay: {
      urls: v.relay ? (Array.isArray(v.relay) ? v.relay : [v.relay]) : [],
      token: v.token ?? process.env.DSH_RELAY_TOKEN ?? '',
      node: v.node ?? process.env.DSH_RELAY_NODE,
    },
    pin: v.pin ?? '',
    upstreamPort,
  };
  const running = await startRemote({ configOverride: override });
  const stop = async () => {
    running.tunnel?.stop();
    await running.proxy.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log('[dsh-remote] host 模式运行中，Ctrl-C 退出');
}

async function runRelay(v) {
  const token = v.token ?? process.env.DSH_RELAY_TOKEN ?? '';
  if (!token) {
    console.error('缺少中继密钥：--token 或 DSH_RELAY_TOKEN');
    console.error(`可生成一个：dsh-remote gen-token  →  ${generateRelayToken()}`);
    process.exit(2);
  }
  const relay = await createRelayServer({
    host: v.host ?? process.env.DSH_RELAY_HOST ?? '127.0.0.1',
    port: Number(v.port ?? process.env.DSH_RELAY_PORT ?? 3090),
    token,
    probeMs: Number(v['probe-ms'] ?? 8000),
    probeTimeoutMs: Number(v['probe-timeout'] ?? 900),
  });
  const stop = async () => { await relay.close(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (!sub || sub === 'host') {
    const { values } = parseArgs({
      args: rest,
      options: {
        upstream: { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        relay: { type: 'string', multiple: true },
        token: { type: 'string' },
        node: { type: 'string' },
        pin: { type: 'string' },
      },
      allowPositionals: true,
    });
    await runHost(parseCommon({ values }));
  } else if (sub === 'relay') {
    const { values } = parseArgs({
      args: rest,
      options: {
        host: { type: 'string' },
        port: { type: 'string' },
        token: { type: 'string' },
        'probe-ms': { type: 'string' },
        'probe-timeout': { type: 'string' },
      },
      allowPositionals: true,
    });
    await runRelay(values);
  } else if (sub === 'gen-token') {
    process.stdout.write(`${generateRelayToken()}\n`);
  } else if (sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(`dsh-remote

用法：
  dsh-remote host [--upstream 3080] [--port 3081] [--relay wss://.../relay/ws]...
                  [--token TOKEN] [--node NAME] [--pin PIN]
  dsh-remote relay [--host 127.0.0.1] [--port 3090] --token TOKEN
  dsh-remote gen-token

正常使用请作为 dsh 插件安装，配置见 $DSH_HOME/dsh-remote/config.json。
`);
  } else {
    console.error(`未知子命令：${sub}`);
    process.exit(2);
  }
}

main().catch((err) => {
  console.error('[dsh-remote] 启动失败：', err);
  process.exit(1);
});
