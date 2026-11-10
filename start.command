#!/bin/bash
# macOS: двойной клик в Finder запускает дашборд и открывает его в браузере.
cd "$(dirname "$0")"
PORT="${PORT:-8765}"
if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  open "http://127.0.0.1:$PORT"
else
  exec python3 server.py --port "$PORT" --open
fi
