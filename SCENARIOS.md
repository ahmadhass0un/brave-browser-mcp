# MCP Browser Navigator — Scenario Matrix (current: extension + WS)

## Transport

```
┌─────────────────────┐   stdio    ┌──────────────────────┐   ws://127.0.0.1:9224   ┌─────────────────────┐
│ LLM / opencode      │ ◄────────► │ MCP Server (Node)    │ ◄────────────────────► │ Brave Extension MV3 │
│                     │            │  server.js → bridge  │                        │ background.js (SW)  │
└─────────────────────┘            │  ws-server.js:9224   │                        │ content.js + injected │
                                   └──────────────────────┘                        └─────────────────────┘
```

*Extension is loaded unpacked:* `brave --load-extension=/abs/extension --remote-debugging-port=9222` (9222 only for `launch-brave.sh` convenience, not the control path). Control path is extension `chrome.tabs`/`chrome.scripting`/`chrome.debugger` → WS → `bridge.js` → `tools.js`.

## State Diagram — What Happens on `connect_brave()`

```
                     ┌──────────────────────┐
                     │   connect_brave()    │
                     └──────────┬───────────┘
                                │
                     ┌──────────▼───────────┐
                     │  health → waiting?   │
                     │  extension WS state  │
                     └──────────┬───────────┘
                                │
                  ┌─────────────┴─────────────┐
                  │                           │
            WS connected                 WS not connected
            (wsReady)                    (waiting)
                  │                           │
     ┌────────────▼────────────┐   ┌──────────▼──────────┐
     │  browser.state → tabs   │   │  Still waiting —    │
     │  windows via extension  │   │  start `node        │
     │  sets currentTabId      │   │  index.js` (ws:9224)│
     └─────────────────────────┘   └─────────────────────┘
```

No dual Brave instances. Single user profile is always used (extension runs in Default profile, `chrome.tabs` sees user's real tabs). No 9223 private port, no `action=new_window`/`new_private` (removed).

## Profile Data Matrix

```
┌──────────────────────────────┬─────────┬─────────┬──────────┬───────────┬─────────────┐
│  Connected To                │ Cookies │ History │ Settings │ Extensions│ Persistence │
├──────────────────────────────┼─────────┼─────────┼──────────┼───────────┼─────────────┤
│  Brave with extension (WS)   │ SHARED  │ SHARED  │ SHARED   │ SHARED    │ ✅ Persists │
│  (Default profile)           │ (chrome.cookies) │ (chrome.history) │           │             │
├──────────────────────────────┼─────────┼─────────┼──────────┼───────────┼─────────────┤
│  MCP server JSON stores      │ Manual  │ Manual  │ N/A      │ N/A       │ ✅ data/*.json│
│  data/cookies, bookmarks,    │ export/import │ history_search │          │             │
│  history, screenshots        │         │         │          │             │
└──────────────────────────────┴─────────┴─────────┴──────────┴───────────┴─────────────┘
```

*Extension `chrome.cookies` is the source of truth; `data/` is just JSON snapshots for `cookies export`/`import`.*

## Action Matrix — What Works

```
┌─────────────────────────────┬──────────┬──────────┐
│  MCP Action                 │ No WS    │ WS connected │
│                             │ server   │ (health true)│
├─────────────────────────────┼──────────┼──────────┤
│  health                     │ waiting  │ ✅ connected, tabs/windows counts │
│  connect_brave              │ waiting  │ ✅ sets currentTabId │
│  navigate, click, type,     │ ❌ NOT_CONNECTED │ ✅ via cs.eval / debugger │
│  scroll, screenshot, etc.   │ (bridge) │ on active tab │
│  tabs / windows             │ ❌       │ ✅ chrome.tabs/windows │
│  cookies / bookmarks        │ ✅ (server JSON, no browser needed) │ ✅ │
│  disconnect                 │ ✅       │ ✅ clears currentTabId │
└─────────────────────────────┴──────────┴──────────┘

  ✅ = Works as expected
  ❌ = Returns NOT_CONNECTED until node index.js is up (extension shows Waiting…)
```

## Window Creation — No CDP Contexts

No `Target.createBrowserContext` — `tabs`/`windows` are just `chrome.tabs.create` / `chrome.windows.create` in the *same* Default profile. New tabs share cookies/history/settings/extensions.

```
  tabs(action="open", url="https://example.com")
         │
  ┌──────▼──────────────────────┐
  │  chrome.tabs.create({url})  │
  │  returns {id, windowId}     │
  └──────┬──────────────────────┘
         │
  ┌──────▼──────────────────────┐
  │  chrome.tabs.query → tabInfo│
  └─────────────────────────────┘
```

## The Profile Problem — Solved by Extension

```
  BEFORE (CDP Playwright, now removed)
  ┌─────────────────────────────────────┐
  │  MCP launches new Brave with        │
  │  --user-data-dir=./browser-profiles │
  │  Cookies: ❌ empty                  │
  └─────────────────────────────────────┘

  NOW (extension)
  ┌─────────────────────────────────────┐
  │  User's Brave (Default profile)     │
  │  Extension: --load-extension=...    │
  │  MCP: ws://127.0.0.1:9224 bridge    │
  │  Cookies: ✅ shared                 │
  │  History: ✅ shared                 │
  └─────────────────────────────────────┘

  RESULT: No isolated profile. Extension sees user's real tabs.
```

## Key Findings (current)

1. **Single profile** — extension runs in Default, `chrome.tabs` sees user's real tabs. No isolated `mcp-normal` / `mcp-private` dirs.
2. **WS is the control path** — `ws://127.0.0.1:9224` (extension → `ws-server.js` → `bridge.js`). `--remote-debugging-port=9222` only for `launch-brave.sh` convenience / `chrome.debugger` attach.
3. **Waiting is normal** — extension shows `Waiting for MCP server…` (yellow pulse) until `node index.js` is up; then `Connected` green. No `action=new_window` etc.
4. **No killing** — `disconnect` just clears `currentTabId`; `launch-brave.sh` never kills existing Brave.
5. **History/bookmarks are server JSON** — `data/history/history.json` appended by `navigate`, searchable via `history_search`; not `chrome.history` (permission removed).
