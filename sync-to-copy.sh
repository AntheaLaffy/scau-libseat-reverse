#!/usr/bin/env bash
# 把本仓库同步到番茄todo 实际加载的那份副本。
#
# 番茄todo 的 mcp.json 里 `seat` 指向副本的 server.mjs（副本在 todo 仓库里，被 gitignore，
# 不入库），所以在这边改完代码要同步过去，app 下次会话才会用上新版本。
# 不同步 .env / 样本 / node_modules —— 那些属于各自的环境。
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${LIBSEAT_COPY:-$HOME/code/todo/mcp/libseat}"
rsync -a --delete \
  --exclude .git --exclude node_modules --exclude .env \
  --exclude captcha-samples --exclude '*-session.json' --exclude '*-pending.json' \
  --exclude sync-to-copy.sh \
  "$HERE"/ "$DEST"/
node --check "$DEST/server.mjs"
echo "[sync] $HERE -> $DEST（.env、样本、node_modules 保持原样）"
