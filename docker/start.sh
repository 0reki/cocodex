#!/usr/bin/env sh
set -eu

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-53141}"
export WEB_PORT="${WEB_PORT:-53332}"

backend_pid=""
web_pid=""

cleanup() {
  if [ -n "$backend_pid" ]; then
    kill "$backend_pid" 2>/dev/null || true
  fi
  if [ -n "$web_pid" ]; then
    kill "$web_pid" 2>/dev/null || true
  fi
}

trap cleanup INT TERM EXIT

bun /app/apps/backend/dist/apps/backend/src/server.js &
backend_pid=$!

(cd /app/apps/web && HOSTNAME=0.0.0.0 PORT="$WEB_PORT" bun server.js) &
web_pid=$!

wait -n "$backend_pid" "$web_pid"
