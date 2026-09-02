#!/bin/bash
# Start Brave (with extension) + MCP server
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
nvm use 20 > /dev/null 2>&1

DIR="$(cd "$(dirname "$0")" && pwd)"
if ! curl -s "http://localhost:9222/json/version" > /dev/null 2>&1; then
  bash "$DIR/launch-brave.sh"
fi
exec node "$DIR/index.js" "$@"
