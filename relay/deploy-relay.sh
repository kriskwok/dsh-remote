#!/usr/bin/env bash
# 在公网服务器上安装/更新 dsh-remote relay（幂等）。
# 用法：
#   relay/deploy-relay.sh [ssh-target]        # 默认 ssh 别名 server
#   relay/deploy-relay.sh root@1.2.3.4 -p 22
# 只做三件事：同步代码 → npm 安装 ws → 安装并重启 systemd 服务。
# 不碰 nginx；nginx 切换见 relay/nginx-dsh-remote.conf.example。
set -euo pipefail

SSH_TARGET="${1:-server}"
shift || true
REMOTE_DIR=/opt/dsh-remote
SERVICE=dsh-remote-relay

cd "$(dirname "$0")/.."
PKG_ROOT="$(pwd)"

echo "==> [1/4] 打包代码（lib/ relay/ package.json）"
STAGE="$(mktemp -d)"
mkdir -p "$STAGE/dsh-remote"
cp -R lib relay package.json "$STAGE/dsh-remote/"
# 不带测试与本地 node_modules，服务器端单独装 ws
tar -C "$STAGE" -czf "$STAGE/dsh-remote.tgz" dsh-remote

echo "==> [2/4] 上传到 ${SSH_TARGET}:${REMOTE_DIR}"
# shellcheck disable=SC2086
ssh "$@" "$SSH_TARGET" "mkdir -p ${REMOTE_DIR}"
# shellcheck disable=SC2086
scp "$@" "$STAGE/dsh-remote.tgz" "${SSH_TARGET}:/tmp/dsh-remote.tgz"
# shellcheck disable=SC2086
ssh "$@" "$SSH_TARGET" "
  set -euo pipefail
  tar -xzf /tmp/dsh-remote.tgz -C ${REMOTE_DIR} --strip-components=1
  rm -f /tmp/dsh-remote.tgz
  cd ${REMOTE_DIR}
  NODE_BIN=\$(command -v node)
  echo \"node: \$NODE_BIN \$(\$NODE_BIN --version)\"
  # ws 是零传递依赖；优先 npm 安装，网络不通时回退由本机 scp 过去的 vendor 包
  if [ -d node_modules/ws ]; then
    echo 'ws already present'
  elif npm --version >/dev/null 2>&1; then
    npm install --omit=dev --no-audit --no-fund --silent || {
      echo 'npm install 失败，请手动放置 ws 包到 node_modules/ws'; exit 1; }
  else
    echo 'npm 不可用且 node_modules/ws 缺失'; exit 1
  fi
  node -e \"require('ws'); console.log('ws ok')\"
"

echo "==> [3/4] 安装 systemd 服务与环境文件"
# shellcheck disable=SC2086
ssh "$@" "$SSH_TARGET" "
  set -euo pipefail
  NODE_BIN=\$(command -v node)
  sed \"s#/usr/bin/node#\$NODE_BIN#\" ${REMOTE_DIR}/relay/dsh-remote-relay.service \
    > /etc/systemd/system/${SERVICE}.service
  if [ ! -f ${REMOTE_DIR}/relay.env ]; then
    TOKEN=\$(\$NODE_BIN -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\")
    cp ${REMOTE_DIR}/relay/relay.env.example ${REMOTE_DIR}/relay.env
    sed -i \"s#change-me-to-a-long-random-token#\$TOKEN#\" ${REMOTE_DIR}/relay.env
    chmod 600 ${REMOTE_DIR}/relay.env
    echo '已生成 relay.env 与 token（见下，请妥善保存，Mac 插件要用同一个）'
  fi
  chmod 600 ${REMOTE_DIR}/relay.env || true
  systemctl daemon-reload
  systemctl enable ${SERVICE} >/dev/null 2>&1 || true
  systemctl restart ${SERVICE}
  sleep 1
  systemctl --no-pager --lines=0 status ${SERVICE} | head -5 || true
  echo '----- relay.env（token 在这） -----'
  grep -E 'DSH_RELAY_(TOKEN|PORT|HOST)' ${REMOTE_DIR}/relay.env
  echo '-----------------------------------'
  curl -fsS http://127.0.0.1:3090/relay/healthz && echo
"

rm -rf "$STAGE"
echo "==> [4/4] 完成"
echo "下一步："
echo "  1) 把上面的 DSH_RELAY_TOKEN 写到 Mac：\$DSH_HOME/dsh-remote/relay-token（0600）"
echo "  2) Mac 插件 config.json 配 relay.urls，例如 wss://dsh.example.com:3443/relay/ws"
echo "  3) nginx：3443 vhost 反代到 127.0.0.1:3090（见 relay/nginx-dsh-mac.live.conf）；"
echo "     可选再加 443 SNI vhost 做公共网络兜底（relay/nginx-dsh-mac-443.live.conf）"
