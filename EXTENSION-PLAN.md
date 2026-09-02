# Browser Navigator Extension Rewrite Plan

## Architecture Overview

```
┌──────────┐ stdio   ┌─────────────────────────────────┐
│ LLM      │◄───────►│ MCP Server (Node.js)            │
│ (Opencode)│        │  server.js → tools.js → bridge.js│
└──────────┘         │       ↕ ws-server.js (WS:9224)  │
                     │       ↕ native-host.js (fallback)│
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

### Permissions (current `extension/manifest.json:8`)
- `tabs`, `windows`, `scripting` — tab/window management, DOM injection
- `debugger` — accessibility tree (`read_page`), screenshots, PDF, trusted input
- `cookies` — cookie save/load across all sites
- `webRequest` — networkidle detection (observational only)
- `storage` — injected-script registry, settings persistence
- `nativeMessaging` — fallback transport (ws preferred)
- `host_permissions: ["<all_urls>"]` — content scripts on arbitrary sites, CORS-free fetch, debugger attachment

### Not needed
- `activeTab` — calls arrive from MCP server, not user gestures
- `webRequestBlocking` — not available in MV3 store extensions
- `downloads` — server writes files itself
- `bookmarks`/`history` — server-owned JSON stores (`data/bookmarks`, `data/history`)
- `history` permission — removed (was for dashboard history tab, now deleted)

## Server Structure

```
mcp/
├── index.js                  # Entry point (~25 lines)
├── server.js                 # MCP stdio server, tool registration (~250 lines)
├── ws-server.js              # WebSocket listener for extension (~220 lines)
├── native-host.js            # Native messaging host fallback (~180 lines)
├── bridge.js                 # Transport abstraction + op routing (~380 lines)
├── tools.js                  # All 41 tool definitions (~1,400-1,600 lines)
├── lib/
│   ├── security.js           # Ported guards (~180 lines)
│   ├── tfidf.js              # TF-IDF helpers (~60 lines)
│   └── proto.js              # Envelope codec, error codes (~90 lines)
├── data/                     # cookies/ bookmarks/ history/ screenshots/
├── install-native-host.sh    # Native host installer (~80 lines)
└── package.json              # Drop playwright; keep mcp-sdk, ws, zod
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

### Op Vocabulary (~18 ops, tools compose from these)
| Op | Executed via |
|---|---|
| `browser.state` | `windows.getAll` + `tabs.query` |
| `tab.list/open/activate/close/info` | `chrome.tabs/windows` |
| `win.list/activate/close` | `chrome.windows` |
| `nav.goto` | `tabs.update` (+guards) |
| `nav.waitReady` | onUpdated + content.js poll + webRequest counter |
| `cs.eval` | `scripting.executeScript` |
| `dbg.cmd` | allowlisted `chrome.debugger` |
| `input.mouse/key` | dbg Input domain |
| `net.start/stop/peek` | debugger Network/Fetch engine |
| `http.request` | `fetch()` in SW with `credentials:"include"` |
| `cookie.all/set` | `chrome.cookies` |
| `injected.register/replay/send` | registry + injected.js protocol |
| `captcha.wait` | content.js MutationObserver |

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
- **Extension**: exponential backoff `min(500·2^n, 15000)ms ± 20% jitter`
- **Heartbeat**: ping every 10s, 3 missed pongs → force-close & redial
- **Server**: holds new requests up to 5s during gaps, then rejects
- **Session identity**: new `hello` invalidates all pending envelopes

## Tool Migration (41 tools)

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
- Native messaging fallback
- Reconnect chaos-testing
- Restricted-page matrix (chrome://, store, PDF viewer, incognito)
- Port test.cjs assertions to new backend
- Retire Playwright dependency

## File Size Estimates (actual `wc -l` 2026-08-30)

| File | Actual |
|---|---|
| `extension/manifest.json` | 24 |
| `extension/background.js` | 1978 |
| `extension/content.js` | 917 |
| `extension/injected.js` | 820 |
| `extension/popup.html` | 112 |
| `extension/popup.js` | 206 |
| `extension/dashboard.html` | 209 |
| `extension/dashboard.js` | 358 |
| **Extension subtotal** | **~4600** |
| `index.js` (entry) | 14 |
| `server.js` | 45 |
| `ws-server.js` | 176 |
| `bridge.js` | 596 |
| `tools.js` | 1645 |
| `lib/security.js` | 82 |
| `lib/tfidf.js` | 51 |
| `lib/proto.js` | 92 |
| **Server subtotal** | **~2700** |
| **Total** | **~7300** |

## Build & Package

### Extension (sideload)
```bash
cd extension && zip -r ../browser-navigator-extension-v2.0.0.zip .
# brave://extensions → Developer mode → "Load unpacked" → select extension/
```

### Native messaging host (fallback)
```bash
./install-native-host.sh
# Writes manifest to Brave/Chrome/Chromium NativeMessagingHosts dirs
```

### Config
```json
{ "mcp": { "browser-navigator":
  { "type":"local", "command":["node","/abs/mcp/index.js"], "enabled":true } } }
```

### package.json changes
- Remove: `playwright` (−50 MB)
- Keep: `@modelcontextprotocol/sdk`, `ws`, `zod`
- Add scripts: `"serve"`, `"host"`, `"test"`

## Known Risks
1. **`Page.printToPDF` on headful Brave** — may be unimplemented; fallback to `captureSnapshot` (MHTML)
2. **Debugger infobar frequency** — `read_page` + `screenshot` cadence; may need batch-attach
3. **Incognito** — extensions don't auto-access private windows; user must enable "Allow in Incognito"
