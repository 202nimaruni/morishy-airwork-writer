#!/bin/bash
# 一時的な公開URLを発行（Cloudflare Quick Tunnel）
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/bin/cloudflared"
PORT="${PORT:-8765}"

mkdir -p "$ROOT/bin"

if [ ! -x "$BIN" ]; then
  echo "cloudflared をダウンロード中..."
  ARCH="$(uname -m)"
  case "$ARCH" in
    arm64|aarch64) CF_ARCH="darwin-arm64" ;;
    *) CF_ARCH="darwin-amd64" ;;
  esac
  curl -fsSL -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${CF_ARCH}.tgz" \
    | tar -xzf - -C "$ROOT/bin"
  chmod +x "$BIN"
fi

echo "ローカルサーバー起動: http://127.0.0.1:${PORT}"
python3 -m http.server "$PORT" --directory "$ROOT" &
SERVER_PID=$!
trap 'kill $SERVER_PID 2>/dev/null || true' EXIT

sleep 1
echo ""
echo "公開URLを取得中（数秒かかります）..."
echo "Ctrl+C で停止"
echo ""
"$BIN" tunnel --url "http://127.0.0.1:${PORT}"
