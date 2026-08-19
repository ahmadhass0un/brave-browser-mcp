#!/bin/bash
# Launch Brave with remote debugging port
# Does NOT kill existing Brave instances

NORMAL_PORT=9222

# Detect Brave browser path
BRAVE_PATH=""
for p in /usr/bin/brave-browser /usr/bin/brave /opt/brave.com/brave/brave-browser /snap/bin/brave "$HOME/.config/BraveSoftware/Brave-Browser/brave-browser"; do
    if [ -x "$p" ]; then
        BRAVE_PATH="$p"
        break
    fi
done
if [ -z "$BRAVE_PATH" ]; then
    echo "Error: Brave browser not found"
    exit 1
fi

launch_brave() {
    local PORT=$1
    local EXTRA_ARGS=$2
    local LABEL=$3

    if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
        echo "Brave ($LABEL) already running on port $PORT"
        return 0
    fi

    echo "Launching Brave ($LABEL) on port $PORT..."
    nohup "$BRAVE_PATH" --remote-debugging-port=$PORT $EXTRA_ARGS > /dev/null 2>&1 &
    local PID=$!
    echo "Brave ($LABEL) launched with PID: $PID"

    for i in {1..15}; do
        if curl -s "http://localhost:$PORT/json/version" > /dev/null 2>&1; then
            echo "Port $PORT ready"
            return 0
        fi
        sleep 1
    done
    echo "Warning: Port $PORT may not be ready yet"
    return 1
}

launch_brave $NORMAL_PORT "" "normal"
