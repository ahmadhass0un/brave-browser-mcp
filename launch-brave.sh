#!/bin/bash
# Launch Brave with browser-navigator extension loaded — fixed 2026-09-01
# - verifies extension actually loaded, not just port open
# - faster poll 0.5s×20=10s vs 1s×15, no 4s blind sleep
# - restarts Brave if running without extension (AI pkill case)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$SCRIPT_DIR/extension"
PORT=9222

BRAVE=""
for p in /usr/bin/brave-browser /usr/bin/brave /opt/brave.com/brave/brave-browser /opt/brave.com/brave/brave /snap/bin/brave; do
  [ -x "$p" ] && BRAVE="$p" && break
done
[ -z "$BRAVE" ] && echo "Brave not found" >&2 && exit 1
[ ! -d "$EXT_DIR" ] && echo "Extension dir missing: $EXT_DIR" >&2 && exit 1

# Helper: is extension loaded? (checks /json for SW background.js)
is_ext_loaded() {
  curl -s "http://localhost:$PORT/json" 2>/dev/null | grep -q "background\.js" 2>/dev/null
}

if is_ext_loaded; then
  echo "Brave already running on $PORT with extension"
  exit 0
fi
if curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
  echo "Brave on $PORT without extension — restarting with --load-extension"
  pkill -f "brave --remote-debugging-port=$PORT" 2>/dev/null || true
  sleep 1
  # wait for port to close
  for i in {1..10}; do ! curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1 && break; sleep 0.3; done
fi

echo "Launching Brave with extension on $PORT..."
nohup "$BRAVE" --remote-debugging-port=$PORT --load-extension="$EXT_DIR" --no-first-run --disable-hang-monitor > /dev/null 2>&1 &
# fast poll 0.5s×20 =10s
for i in {1..20}; do
  if is_ext_loaded; then
    echo "Brave ready on $PORT with extension (attempt $i)"
    exit 0
  fi
  # also accept version ready as halfway
  if [ $i -eq 10 ] && curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
    echo "Brave port $PORT open, waiting for extension (attempt $i)..."
  fi
  sleep 0.5
done
# final check
if curl -s "http://localhost:$PORT/json/version" >/dev/null 2>&1; then
  echo "Brave port $PORT open but extension not yet listed — check brave://extensions" >&2
  exit 0
fi
echo "Warning: port $PORT not ready after 10s" >&2
exit 1
