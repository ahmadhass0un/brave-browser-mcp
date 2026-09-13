# Browser Navigator Extension Rewrite Plan

## Architecture Overview

```
┌──────────┐ stdio   ┌─────────────────────────────────┐
│ LLM      │◄───────►│ MCP Server (Node.js)            │
│ (Opencode)│        │  server.js → tools.js → bridge.js│
└──────────┘         │       ↕ ws-server.js (WS:9224)  │
                     │          + GET /health → 204     │
                     └──────────────┬──────────────────┘
                                    │ WebSocket
                                    ▼
┌──────────────────── Brave Extension (MV3) ──────────────────┐
│ background.js (SW): WS client (ws://127.0.0.1:9224) +        │
│  debugger mgr, network capture, uiStatus (waiting/connected) │
│   ↕ chrome.runtime.onMessage (getStatus/getTabs/...)         │
│ content.js: DOM ops, clicks, text, a11y                      │
│ injected.js: persistent script runtime                       │
│ popup.html/js: toolbar popup (380px)                         │
│ dashboard.html/js: control center (overview/browser/tools/   │
│  captures/settings/logs)                                     │
└─────────────────────────────────────────────────────────────┘
```

## Extension Structure (current: v2.1 → v2.0.1 actual)

```
extension/
├── manifest.json          # MV3 manifest (action + dashboard as options_page)
├── background.js          # Service worker (type: module, ~1978 lines)
├── content.js             # Content script, ISOLATED world (~917 lines)
├── injected.js            # Persistent injection runtime (~820 lines)
├── popup.html             # Toolbar popup (380px, connection + tabs + quick tools)
├── popup.js               # Popup logic (~206 lines)
├── dashboard.html         # Full control center (overview/browser/tools/captures/settings/logs)
├── dashboard.js           # Dashboard logic (~358 lines)
└── icons/
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```
> `options.html`/`options.js` removed — functionality merged into `dashboard.html` `#page-settings` (single place). `manifest.json` `options_page` now points to `dashboard.html`.

### Permissions (current `extension/manifest.json:11`)
- `tabs`, `windows`, `scripting` — tab/window management, DOM injection
- `debugger` — accessibility tree (`read_page`), screenshots, PDF, trusted input
- `cookies` — cookie save/load across all sites
- `storage` — injected-script registry, settings persistence
- `downloads` — `handle_download` tool (`chrome.downloads` polling)
- `host_permissions: ["<all_urls>"]` — content scripts on arbitrary sites, CORS-free fetch, debugger attachment

### Not needed
- `activeTab` — calls arrive from MCP server, not user gestures
- `webRequest` — removed (networkidle detection is not used; captures use CDP Network/Fetch domains)
- `nativeMessaging` — removed (WS-only transport)
- `bookmarks`/`history` — server-owned JSON stores (`data/bookmarks`, `data/history`)

## Server Structure

```
mcp/
├── index.js                  # Entry point (14 lines)
├── server.js                # MCP stdio server, tool registration (60 lines)
├── ws-server.js              # WebSocket listener for extension + /health endpoint (274 lines)
├── bridge.js                 # Transport abstraction + op routing (659 lines)
├── tools.js                  # All 43 tool definitions (1912 lines)
├── lib/
│   ├── security.js           # SSRF guards + AES-256-GCM cookies (133 lines)
│   ├── tfidf.js              # TF-IDF helpers (55 lines)
│   └── proto.js              # Envelope codec, error codes (95 lines)
├── data/                     # cookies/ bookmarks/ history/ screenshots/
├── start.sh                  # Server launcher (optional Brave launch)
├── launch-brave.sh           # Brave + extension launcher (convenience only)
└── package.json              # mcp-sdk, ws, zod
```

## Communication Protocol

### Envelope Format (JSON text frames over WS)
```jsonc
// Request (server → extension)
{ "v": 1, "type": "req", "id": "01J8...", "ts": 1737500000000,
  "op": "cs.eval", "args": { "tabId": 123, "func": "...source...", "args": [] } }

// Success response
{ "v": 1, "type": "res", "id": "01J8...", "ok": true,
  "result": { "value": "...", "meta": {} } }

// Error response
{ "v": 1, "type": "res", "id": "01J8...", "ok": false,
  "error": { "code": "ELEMENT_NOT_FOUND", "message": "...", "retriable": false } }

// Event (extension → server, unsolicited)
{ "v": 1, "type": "evt", "id": "e01...", "event": "tab.activated",
  "ts": 1737500000100, "data": { "windowId": 1, "tabId": 124 } }

// Keepalive
{ "v": 1, "type": "ping", "id": "p01..." }   // → { type:"pong", id:"p01..." }
```

### Op Vocabulary (28 ops, tools compose from these)
| Op | Executed via |
|---|---|
| `browser.state` | `windows.getAll` + `tabs.query` |
| `tab.list/open/activate/close/info` | `chrome.tabs/windows` |
| `win.list/activate/close` | `chrome.windows` |
| `nav.goto` | `tabs.update` (+guards) |
| `nav.waitReady` | onUpdated + content.js readyState probe |
| `cs.eval` | `scripting.executeScript` (closure-free fn + JSON args) |
| `content.exec` | `tabs.sendMessage` → content.js ops (CSP-safe path) |
| `dbg.cmd` | allowlisted `chrome.debugger` |
| `input.mouse/key` | dbg Input domain |
| `net.start/stop/peek` | debugger Network/Fetch engine |
| `http.request` | `fetch()` in SW with `credentials:"include"` |
| `cookie.all/set` | `chrome.cookies` |
| `injected.register/replay/send` | registry + injected.js protocol |
| `captcha.wait` | content.js `waitForCaptchaSolved` via `tabs.sendMessage` |
| `dialog.handle` | CDP `Page.handleJavaScriptDialog` |
| `download.wait` | `chrome.downloads` polling |

### Error Codes
| Code | Meaning |
|---|---|
| `BAD_REQUEST` | schema/validation failure |
| `UNSUPPORTED_OP` | unknown op (version skew) |
| `NOT_CONNECTED` | no transport available |
| `RESTRICTED_TARGET` | chrome://, Web Store, chrome-extension:// |
| `DEBUGGER_DETACHED` | user canceled infobar / opened DevTools |
| `NAV_FAILED`, `NAV_TIMEOUT` | goto errors |
| `ELEMENT_NOT_FOUND`, `CLICK_BLOCKED` | content.js outcomes |
| `INJECTED_NO_SCRIPT`, `INJECTED_TIMEOUT` | injection states |
| `CAPTCHA_WAIT_TIMEOUT` | captcha poll expiry |
| `TIMEOUT` | per-op budget exceeded |
| `TRANSPORT_LOST` | socket died with calls in flight |
| `INTERNAL` | catch-all |

### Reconnection
- **Extension**: exponential backoff `min(500·2^n, 15000)ms ± 20% jitter`; after 5 failed attempts switches to silent 2s `GET /health` probing and dials immediately once the server answers (avoids `ERR_CONNECTION_REFUSED` console spam)
- **Heartbeat**: ping every 15s, 3 missed pongs → force-close & redial
- **Server**: hello within 3s (else 4001); link silent 30s → terminate
- **Session identity**: new `hello` invalidates all pending envelopes

## Tool Migration (43 tools)

### Phase 1: P0 Skeleton
- `connect_brave` → WS hello/welcome + browser.state
- `disconnect` → mark session closed
- `health` → server info + transport state

### Phase 2: P1 Read Path
| Tool | Replacement | Needs debugger? |
|---|---|---|
| `navigate` | `nav.goto` + `nav.waitReady` + CAPTCHA auto-wait | No |
| `navigate_history` | content.js `history.back()/forward()` | No |
| `get_page_info` | `tabs.get` + content.js eval | No |
| `get_page_content` | content.js `extractVisibleText` | No |
| `list_elements` | content.js `listInteractive` | No |
| `inspect_dom` | content.js `inspectDom` | No |
| `wait_for` | server polls content.js existence checks | No |
| `wait_for_load` | poll `readyState==="complete"` | No |
| `tabs` | `chrome.tabs` | No |
| `windows` | `chrome.windows` | No |
| `detect_captcha` | content.js `detectCaptcha` | No |
| `wait_for_captcha` | content.js MutationObserver | No |
| `video_control` | content.js `videoControl` | No |
| `search` | compose nav.goto + selector-wait + extraction | No |
| `search_tabs` | parallel content.js extraction + TF-IDF | No |

### Phase 3: P2 Interaction
| Tool | Replacement | Needs debugger? |
|---|---|---|
| `click` | content.js synthetic click → trusted escalation | Optional |
| `type` | content.js `fillField` / per-char keystroke | Optional |
| `focus_element` | content.js focus | No |
| `press_key` | content.js `KeyboardEvent` chain | Optional |
| `scroll` | `window.scrollBy` / Input mouseWheel for coord | Optional |
| `hover` | content.js synthetic mouseover | Optional |
| `computer` | content.js (selector/ref) + debugger Input (coordinates) | For coords |

### Phase 4: P3 Debugger Trio
| Tool | Replacement | Needs debugger? |
|---|---|---|
| `read_page` | `Accessibility.getFullAXTree` → ref_N IDs | Yes |
| `screenshot` | `Page.captureScreenshot` / `captureVisibleTab` | Yes (full-page) |
| `pdf_export` | `Page.printToPDF` (may not work headful) | Yes |

### Phase 5: P4 Capture/Session
| Tool | Replacement | Needs debugger? |
|---|---|---|
| `network_start` | `Network.enable` + `Fetch.enable` | Yes |
| `network_stop` | detach + flush buffer | Yes |
| `network_list` | peek buffer | Yes |
| `network_request` | `fetch()` in SW | No |
| `cookies` | `chrome.cookies.getAll/set` | No |
| `inject_script` | `chrome.storage.session` + `executeScript` | No |
| `send_to_injected` | content.js eval of CustomEvent snippet | No |
| `bookmark_*` | server JSON store (unchanged) | No |
| `history_search` | server-recorded store (unchanged) | No |

### Phase 6: P5 Hardening
- Reconnect chaos-testing (done: backoff → 2s health-probe switch, welcome-timeout reschedule)
- Restricted-page matrix (chrome://, store, PDF viewer, incognito)
- Port test.cjs assertions to new backend

## File Size Estimates (actual `wc -l` 2026-09-13)

| File | Actual |
|---|---|
| `extension/manifest.json` | 52 |
| `extension/background.js` | 2283 |
| `extension/content.js` | 993 |
| `extension/injected.js` | 820 |
| `extension/popup.html` | 115 |
| `extension/popup.js` | 213 |
| `extension/dashboard.html` | 209 |
| `extension/dashboard.js` | 434 |
| **Extension subtotal** | **~5100** |
| `index.js` (entry) | 14 |
| `server.js` | 60 |
| `ws-server.js` | 274 |
| `bridge.js` | 659 |
| `tools.js` | 1912 |
| `lib/security.js` | 133 |
| `lib/tfidf.js` | 55 |
| `lib/proto.js` | 95 |
| **Server subtotal** | **~3100** |
| **Total** | **~8270** |

## Build & Package

### Extension (sideload)
```bash
cd extension && zip -r ../browser-navigator-extension-v2.0.9.zip .
# brave://extensions → Developer mode → "Load unpacked" → select extension/
```

### Config
```json
{ "mcp": { "browser-navigator":
  { "type":"local", "command":["node","/abs/mcp/index.js"], "enabled":true } } }
```

### package.json
- Keep: `@modelcontextprotocol/sdk`, `ws`, `zod`
- Scripts: `start`, `serve`, `test`, `syntax`

## Known Risks
1. **`Page.printToPDF` on headful Brave** — may be unimplemented; fallback to `captureSnapshot` (MHTML)
2. **Debugger infobar frequency** — `read_page` + `screenshot` cadence; may need batch-attach
3. **Incognito** — extensions don't auto-access private windows; user must enable "Allow in Incognito"
