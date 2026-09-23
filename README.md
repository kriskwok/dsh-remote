# dsh-remote

DSH 远程访问插件：**一个固定地址，两种链路自动切换**。替代 dsh-pocket + 手工 SSH 反代。

```
                            手机 App（地址永远不变）
                    https://dsh.example.com:3443
                                      │  HTTPS / WSS（nginx 终止 TLS）
                                      ▼
              公网服务器：dsh-remote relay（127.0.0.1:3090）
                                      │
              电脑与服务器同局域网 ◀───┴───▶ 电脑在外网 / 公共网络
              （探测 /__dsh-remote/ping 可达）   （只允许出网，SSH 出网被封）
                    │ 直连反代                      │ 插件主动拨出的 WSS 隧道
                    │ http://<电脑LAN IP>:3081      │ （/relay/ws，TCP-over-WS 多路复用）
                    └───────────────┬───────────────┘
                                    ▼
                  电脑：dsh-remote 本机代理（0.0.0.0:3081）
                    PIN 认证 + loopback Host 改写 + dsh 启动 token 握手
                                    ▼
                  电脑：dsh web（127.0.0.1:3080）
```

- **固定入口 `dsh.example.com:3443`**（原 dsh-pocket 反代端口，App 零改动）。
  服务器本机自己的 dsh 仍在 **:3080**，完全不受影响。
- **局域网模式**：relay 周期性探测插件通告的本机 LAN 地址，探得到就直连反代，延迟最低。
- **隧道模式**：电脑在公共网络（酒店/公司 WiFi，SSH 出网被封）时，插件**主动向外**拨一条
  WSS 到服务器（TLS，能过绝大多数网络），App 流量在这条连接上多路复用回电脑。
- **无感切换**：两种模式由 relay 自动选择，每 8 秒探测一次；LAN 拨号失败的单个请求还会
  立刻兜底走隧道。换网络时 App 现有重连逻辑自动恢复。
- **443 兜底**：公共 WiFi 常只放 443，可在服务器 443 上按 SNI 再加一个
  `dsh.example.com` vhost 指向 relay，插件隧道在 3443 连不上时自动改走 443。

## 与 dsh-pocket 的关系

dsh-pocket 只解决「dsh web 绑定 loopback，手机访问不到」的本机代理问题，外网穿透要另配
cloudflared/SSH。dsh-remote 把**本机代理**和**服务器中继隧道**做进同一个插件：

| 能力 | dsh-pocket | dsh-remote |
|---|---|---|
| loopback 权威改写代理（HTTP+WS） | ✅ | ✅（同套安全口径） |
| PIN 访问密码 + 限速 | ✅ | ✅ |
| dsh 启动 token 自动握手 | ✅ | ✅ |
| 手机端 UI / 扫码 / cloudflared | ✅ | ❌（原生 App 不需要） |
| 服务器中继 + 外网隧道 | ❌（另配 SSH/cloudflared） | ✅ 内置 |
| 局域网/外网自动选路、无感切换 | ❌ | ✅ |

安装 dsh-remote 后即可从 profile 移除 dsh-pocket（见下文迁移）。

## 组件

| 路径 | 运行位置 | 作用 |
|---|---|---|
| `lib/index.js` | 电脑（dsh 插件） | 插件入口，拉起本机代理 + 隧道客户端 |
| `lib/client.js` | 电脑（浏览器侧） | 无构建手写 bundle：向 `plugins.row.config` 注册插件卡片里的配置面板 |
| `lib/proxy.mjs` | 电脑 | 本机代理：PIN、Host 改写、WS 透传、启动 token、压缩 |
| `lib/tunnel-client.mjs` | 电脑 | 主动外拨 WSS，把隧道虚拟流对接到本机代理 |
| `lib/mux.mjs` | 电脑 + 服务器 | TCP-over-WebSocket 多路复用协议（双方共用） |
| `relay/server.mjs` | 公网服务器 | 中继：App 流量入口、LAN 探测、选路、隧道终结 |
| `relay/dsh-remote-relay.service` | 服务器 | systemd 单元 |
| `relay/nginx-dsh-mac.live.conf` | 服务器 | 3443 主入口 vhost（线上在用） |
| `relay/nginx-dsh-mac-443.live.conf` | 服务器 | 443 SNI 兜底 vhost（线上在用） |
| `relay/deploy-relay.sh` | 电脑执行 | 一键部署/更新 relay 到服务器 |

## 一、部署服务器 relay（一次性）

前置：服务器有 Node.js ≥ 18（推荐 22）、nginx，SSH 能登录；假设你能通过 ssh 登录服务器（下面记作 `ssh server`）。

```bash
cd dsh-remote
bash relay/deploy-relay.sh server
```

脚本幂等：同步代码到 `/opt/dsh-remote`、安装零依赖的 `ws`、安装并启动
`dsh-remote-relay` 服务（监听 `127.0.0.1:3090`），首次运行会生成并打印
`DSH_RELAY_TOKEN`，**复制保存**（Mac 插件要用同一个）。

验证（在服务器上）：

```bash
systemctl status dsh-remote-relay
curl -s http://127.0.0.1:3090/relay/healthz
journalctl -u dsh-remote-relay -f
```

### nginx：3443 反代到 relay

线上配置直接参考 `relay/nginx-dsh-mac.live.conf`（旧的 dsh-mac vhost 就是
`proxy_pass http://192.168.1.10:3081` 的局域网直连，把它整体替换为指向
`http://127.0.0.1:3090` 即可；**不要动 :3080 的 dsh-web vhost**）：

```bash
scp relay/nginx-dsh-mac.live.conf server:/tmp/dsh-mac
ssh server 'cp /etc/nginx/sites-enabled/dsh-mac /root/dsh-mac.bak
           cp /tmp/dsh-mac /etc/nginx/sites-enabled/dsh-mac
           nginx -t && systemctl reload nginx'
```

### 可选：443 兜底（公共网络只放 443 时）

`relay/nginx-dsh-mac-443.live.conf` 是按 SNI 与 443 上既有站点共存的 vhost
（证书需覆盖 dsh.example.com）。放到 sites-enabled、reload 即可，不影响其它域名。

回滚：把 `/root/dsh-mac.bak` 放回 sites-enabled 再 reload。

## 二、安装电脑端插件

### 1. 安装插件到 web profile

> 注意：本机 profile 里若有失效的 `file:` 依赖（如已卸载的 DSH Computer Use.app），
> `dsh plugin add` 会被 pnpm 连带校验卡住。可按「手动集成」处理（见文末）。

正常情况本地路径直接装（会自动打 cordis 补丁）：

```bash
dsh plugin --profile web add ~/path/to/dsh-remote -w
```

升级代码后重新执行同一条命令。launchd 会自动重启 dsh web。

### 2. 写配置

目录：`$DSH_HOME/dsh-remote/`（本机即 `~/.dsh/dsh-remote/`）。

`config.json`（线上在用）：

```json
{
  "relay": {
    "urls": [
      "wss://dsh.example.com:3443/relay/ws",
      "wss://dsh.example.com/relay/ws"
    ],
    "node": "macbook"
  },
  "local": { "port": 3081, "host": "0.0.0.0" },
  "access": { "lan": true, "tunnel": true }
}
```

- `relay.urls`：中继隧道地址，按顺序兜底（第二条是可选的 443 入口）。
- `access.lan` / `access.tunnel`：两种访问方式的开关，默认都开（也可用环境变量
  `DSH_ACCESS_LAN` / `DSH_ACCESS_TUNNEL` 覆盖，`0/false/no/off` 视为关）。
  语义见下文「设置页」。
- `relay.token` 不建议写进 json；放到独立文件 `relay-token`（0600）：

```bash
mkdir -p ~/.dsh/dsh-remote
printf '%s' '服务器上生成的 DSH_RELAY_TOKEN' > ~/.dsh/dsh-remote/relay-token
chmod 600 ~/.dsh/dsh-remote/relay-token
```

- **访问 PIN**：不配置时首次启动自动生成 8 位数字到 `~/.dsh/dsh-remote/pin`（0600）。
  这就是手机 App 连接时「密码」一栏要填的值。**PIN 格式与长度完全不限**
  （中文、空格、符号、任意长度都可以；也可在设置页直接修改，见下节）。

环境变量覆盖（launchd/systemd 场景）：`DSH_RELAY_URL`、`DSH_RELAY_TOKEN`、
`DSH_RELAY_NODE`、`DSH_REMOTE_PORT`、`DSH_REMOTE_PIN`、
`DSH_ACCESS_LAN`、`DSH_ACCESS_TUNNEL`。

### 3. 重启 dsh web 并验证

```bash
launchctl kickstart -k gui/$(id -u)/com.dsh.web
sleep 15
curl -s http://127.0.0.1:3081/__dsh-remote/ping     # 本机代理存活
curl -s http://127.0.0.1:3081/__dsh-remote/status   # 仅 loopback：看隧道状态
cat ~/.dsh/dsh-remote/pin                            # 看自动生成的 PIN
```

`status` 里 `relay.state` 为 `connected` 即隧道已注册到服务器；服务器上
`curl -s http://127.0.0.1:3090/relay/status` 能看到节点与当前 `mode`
（`lan` / `tunnel`）。

## 三、设置：访问开关与修改密码

配置入口在 DSH 自带的插件管理里，**没有独立页面**：

- 打开 DSH → 设置 → 插件 → 点开 **remote / dsh-remote** 那张卡片，点齿轮「配置」
  （浏览器侧 `lib/client.js` 向 host 的 `plugins.row.config` 槽位注册了
  `dsh-remote#remote` 面板，host 自动渲染齿轮按钮）。
- 面板内容：
  - **局域网访问开关**：关掉后 relay 不再把本机作为 LAN 候选（通告空候选），
    且本机代理在 TCP 层拒绝所有非 loopback 的新连接；本机 loopback 使用不受影响。
  - **公网隧道开关**：关掉后插件**立即停止隧道客户端，且不会再主动向服务器发起任何
    外连**；重新打开则自动重连。
  - **修改密码**：新密码格式、长度完全不限制（中文、空格、符号、超长均可），
    保存后写入 `pin` 文件（0600），旧会话 cookie 立即失效，需用新密码重新进入。
  - **清空密码**：勾选「清空访问密码」并确认后，pin 文件写为空串，
    此后**任何人访问都不再需要密码**——请仅在清楚风险时使用。

改动即时生效并落盘，无需重启。底层读写接口：`GET/POST /__dsh-remote/config`
（JSON；与页面同口径鉴权），本机排障可直接
`curl http://127.0.0.1:3081/__dsh-remote/config` 查看当前状态。

## 四、App 侧（无感）

- 服务器地址、用户名密码栏位**全部不变**：`https://dsh.example.com:3443`，
  用户名为空、密码填上面的 PIN（与 dsh-pocket 的 ?token= 流程一致）。
- App 已有的 `/login 404 → /?token=` 回退逻辑、WSS mux、Basic 兼容均无需改动。
- 换网络（家里 WiFi ↔ 手机热点/公共 WiFi）时正在进行的连接可能断一次，
  App 现有重连逻辑会自动恢复；之后所有新请求由 relay 自动选路。

## 五、从 dsh-pocket 迁移

```bash
# 正常情况：
dsh plugin --profile web remove dsh-pocket -w
dsh plugin --profile web add ~/path/to/dsh-remote -w
# 确认 3081 已由 dsh-remote 监听
lsof -nP -iTCP:3081 -sTCP:LISTEN
```

服务器侧旧的 SSH 反代 / `ssh -R` 定时任务可以停用。

## 六、独立运行（不装插件 / 调试）

```bash
# 电脑端：代理 + 隧道（上游 dsh web 在 3080）
node bin/dsh-remote.mjs host --upstream 3080 --port 3081 \
  --relay wss://dsh.example.com:3443/relay/ws --token "$DSH_RELAY_TOKEN"

# 服务器端 relay
node bin/dsh-remote.mjs relay --host 127.0.0.1 --port 3090 --token "$DSH_RELAY_TOKEN"

# 生成密钥
node bin/dsh-remote.mjs gen-token
```

> 独立 CLI 模式拿不到 dsh 的 `ctx.connection.authenticatedUrl`，启动 token 握手会
> 401——这是预期现象；正式作为插件运行时由 ctx 提供。

## 安全模型

1. **TLS**：App↔服务器、插件↔服务器都在 nginx 的 TLS 内（wss/https）。
2. **隧道鉴权**：插件注册必须带与服务器相同的 `DSH_RELAY_TOKEN`（Bearer，
   timing-safe 比较），错误直接 401/4401；relay 只监听 127.0.0.1，不直接暴露。
3. **访问 PIN**：relay 不做应用鉴权，PIN 校验统一在电脑本机代理完成。
   Host 不是 loopback 的请求一律要 PIN（隧道回连源地址虽然是 loopback，
   但 Host 是公网域名，仍按公网处理，fail-closed）；错误尝试有 IP/全局限速。
   PIN 为空（设置页清空密码）时显式关闭密码校验，属于用户主动选择的降级。
4. **loopback 信任栅栏**：代理把 Host/Origin 改写成 `127.0.0.1:<dshPort>`，
   dsh 始终认为浏览器会话来自本机，无需放开 dsh 的绑定限制。
5. 密钥/PIN 文件权限 0600；`/relay/status` 只允许 loopback 或 Bearer。

## 协议说明（lib/mux.mjs）

一条 WSS 承载多条虚拟 TCP 流，HTTP 与 WebSocket 都按原始字节透传，
因此 WS ping/pong、压缩、dsh 自己的子协议全部逐跳自然工作：

- 二进制帧：`[ver=1:1][streamId:4 BE][type:1][len:2 BE][payload]`，
  type `0=DATA / 1=FIN / 2=RESET`，DATA 每片 ≤16KiB；
- 文本帧：JSON 控制消息 `hello / welcome / deny / lan / bye`；
- streamId：relay 侧奇数、agent 侧偶数；WS ping/pong 20s 心跳。

## 开发与测试

```bash
npm install
npm test          # 41 个用例：mux 字节完整性/并发流、PIN 认证、HTTP/WS 端到端、lan/tunnel 切换、设置页开关/改密码/清空密码、鉴权
```

测试覆盖：隧道模式 HTTP/WS、LAN 模式 HTTP/WS、LAN 探测失败回落隧道、
节点离线 502、错误 token 401、PIN 限速、启动 token 握手、
隧道/LAN 开关即时生效、任意格式密码修改与空密码免校验等。

## 手动集成（pnpm 被失效 file: 依赖卡住时）

本机 web profile 曾因 `dsh-computer-use` 指向已卸载的 .app 导致任何
`dsh plugin add/remove` 报 ENOENT。等价的手动做法：

```bash
cd ~/.dsh/profiles/web
ln -sfn /path/to/dsh-remote node_modules/dsh-remote
# 编辑 package.json：
#   dependencies 加 "dsh-remote": "link:/path/to/dsh-remote"，删掉 dsh-pocket
#   dsh.profile.bundles 里把 "dsh-pocket" 换成 "dsh-remote"
dsh --profile web --dump-config | grep -A2 dsh-remote   # 确认补丁层出现
launchctl kickstart -k gui/$(id -u)/com.dsh.web
```

## 排障

| 现象 | 排查 |
|---|---|
| App 显示「电脑端 DSH 不在线」 | relay 没收到隧道：服务器 `journalctl -u dsh-remote-relay`；Mac `curl 127.0.0.1:3081/__dsh-remote/status` 看 state/lastError |
| 隧道一直 `wait-retry` | token 不一致（401/deny）、公共网络封了 3443（urls 加 443 兜底） |
| App 弹 PIN 页/401 | 密码栏填的是 `~/.dsh/dsh-remote/pin`，不是服务器 token |
| 模式不切换 | relay 每 8s 探测一次；`/relay/status` 看 candidates 与 lanTarget；候选来自插件枚举的物理网卡私网 IP |
| 502 但 status 在线 | LAN 误判：单请求会自动兜底隧道；持续出现请检查 Mac 防火墙是否放行 3081 |
| 插件装上即崩（cannot get property "config"） | cordis 配置从 `apply(ctx, config)` 第二参取，不要访问 `ctx.config`；本插件已处理 |
