#!/usr/bin/env bash
# 运行时安装：生成 .env、装依赖、注册到 Codex、自检。
# 幂等，可重复执行。
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "[install] 已生成 $DIR/.env —— 请填入 LIBSEAT_USER / LIBSEAT_PASS"
fi
chmod 600 .env 2>/dev/null || true

echo "[install] 安装依赖"
if command -v pnpm >/dev/null 2>&1; then
  pnpm install --prefer-offline
elif command -v npm >/dev/null 2>&1; then
  npm install --no-audit --no-fund
else
  echo "[install] 需要 pnpm 或 npm" >&2
  exit 1
fi

NODE_BIN="$(command -v node)"
echo "[install] 注册 MCP 到 Codex"
if command -v codex >/dev/null 2>&1; then
  codex mcp remove libseat >/dev/null 2>&1 || true
  codex mcp add libseat --env "LIBSEAT_ENV_FILE=$DIR/.env" -- "$NODE_BIN" "$DIR/server.mjs"
else
  echo "[install] 未找到 codex CLI，请手动写入 ~/.codex/config.toml："
  printf '\n[mcp_servers.libseat]\ncommand = "%s"\nargs = ["%s"]\n\n[mcp_servers.libseat.env]\nLIBSEAT_ENV_FILE = "%s"\n' \
    "$NODE_BIN" "$DIR/server.mjs" "$DIR/.env"
fi

echo "[install] 自检"
node "$DIR/doctor.mjs"
