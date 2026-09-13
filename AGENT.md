# Browser Navigator MCP - Development Guide

## Architecture

```
LLM → MCP Server (server.js / bridge.js) --stdio--> ws://127.0.0.1:9224 --WS--> extension/background.js (MV3 SW) → chrome.tabs/windows/scripting/debugger → Brave/Chrome
```

Single user profile. No Playwright. No separate `--user-data-dir`.

## Install (for the LLM / agent setting this up)

```bash
git clone https://github.com/ahmadhass0un/brave-browser-mcp.git
cd brave-browser-mcp
npm install            # deps: @modelcontextprotocol/sdk, ws, zod
```

1. **Load the extension** — `brave://extensions` → Developer mode → Load unpacked → `extension/`. No `--remote-debugging-port` needed (normal browser launch is fine).
2. **Start the server** — `node index.js` (stdio MCP + `ws://127.0.0.1:9224`; extension shows "Waiting…" until up, then "Connected").
3. **Register as MCP server** — opencode `opencode.json`:
```json
{ "mcp": { "browser-navigator": {
  "type": "local",
  "command": ["node", "/absolute/path/to/brave-browser-mcp/index.js"],
  "enabled": true } } }
```
Claude Desktop `claude_desktop_config.json`:
```json
{ "mcpServers": { "browser-navigator": {
  "command": "node",
  "args": ["/absolute/path/to/brave-browser-mcp/index.js"] } } }
```

## Key Files

| File | Purpose |
|------|---------|
| `index.js` | Entry, creates data dirs, handles SIGINT, calls server.main() |
| `server.js` | McpServer stdio + ws-server:9224 |
| `bridge.js` | Transport abstraction (call, pending, tabs/windows/nav/dbg/dom facades) |
| `tools.js` | 43 MCP tools |
| `ws-server.js` | WS listener 127.0.0.1:9224, handshake hello→welcome |
| `extension/background.js` | MV3 service worker, 28 ops (§14) |
| `extension/content.js` | DOM ops (listInteractive, inspectDom, click, etc.) |
| `extension/injected.js` | MAIN-world persistent runtime |
| `extension/manifest.json` | MV3, permissions tabs/windows/scripting/debugger/cookies/storage/downloads |

## Requirements

- Node 20+ (nvm)
- Brave/Chrome 118+ with extension loaded (`brave://extensions` → Load unpacked `extension/`)
- `node index.js` provides ws://127.0.0.1:9224 (extension shows Waiting… until up)

## Connection

`connect_brave` → `bridge.browser.state()` → sets `currentTabId`. Most tools use `tab()` or `ensureTab()`.

## Adding a Tool

In `tools.js:624 registerTools()`:
```js
server.tool("name", "desc", { param: z.string() }, guard(async ({param}) => json({ok:true})));
```
Guard bridges DOM via `bridge.dom.*` or `bridge.dbg.command` or `bridge.tabs.*`.

## Debugging

```bash
curl http://localhost:9222/json/version  # only if launched with --remote-debugging-port
node --check bridge.js tools.js extension/background.js
```

See README.md for full tool list, EXTENSION-PLAN.md for op vocabulary.
