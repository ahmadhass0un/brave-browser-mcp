#!/bin/bash
# Launch Brave with browser-navigator extension loaded

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
PORT=9222

BRAVE=""
for p in /usr/bin/brave-browser /usr/bin/brave /opt/brave.com/brave/brave-browser /snap/bin/brave; do
  [ -x "$p" ] && BRAVE="$p" && break
done
[ -z "$BRAVE" ] && echo "Brave not found" && exit 1

if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
  echo "Brave already running on $PORT"
  exit 0
fi

echo "Launching Brave with extension on $PORT..."
nohup "$BRAVE" --remote-debugging-port=$PORT --load-extension="$EXT_DIR" > /dev/null 2>&1 &
for i in {1..15}; do
  curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1 && echo "Brave ready on $PORT" && exit 0
  sleep 1
done
echo "Warning: port $PORT not ready yet"
