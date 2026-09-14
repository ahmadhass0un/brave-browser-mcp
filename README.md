# Browser Navigator MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants full control over **Brave / Chrome** via a **Manifest V3 extension** (no external browser download).

The extension (`extension/background.js` service worker + `content.js` DOM ops) bridges to the local MCP server over **WebSocket `ws://127.0.0.1:9224`**. The server speaks MCP over `stdio` and drives the *real* user profile — tabs, windows, clicks, typing, screenshots, PDFs, cookies, video — through `chrome.tabs`, `chrome.windows`, `chrome.scripting` and `chrome.debugger`.

Built so that an LLM can operate **complex, dynamic UIs** (dialogs, modals, dropdowns, token chips) without reverse-engineering the DOM: `list_elements` + `inspect_dom` + `focus_element` + `press_key` + `scope`.

## Highlights

- 🧭 **Full browser control** — navigate, back/forward, click, type, scroll, hover, keyboard input (extension `cs.eval` + `debugger` Input)
- 🗂 **Adaptive DOM tools** — `list_elements`, `inspect_dom`, `focus_element`, `press_key` discover how a UI is built and interact with it
- 🪟 **Window & tab management** — list, open, switch, and close windows and tabs (`chrome.tabs/windows`)
- 🔐 **CAPTCHA detection** — detects reCAPTCHA, hCaptcha, Cloudflare Turnstile & challenges, pauses automation, and waits for a human
- 🍪 **Session persistence** — save/load cookies via `chrome.cookies` (encrypted), `data/` JSON stores
- 🎥 **Video control** — play/pause/seek/volume/mute on any HTML5 player
- 🔍 **Social search** — `search` + `search_tabs` (TF‑IDF) across 9 platforms
- 📄 **Export** — screenshots (`Page.captureScreenshot` + `captureVisibleTab`) and PDF (`Page.printToPDF`) to `data/screenshots/`
- 🔧 **Arbitrary JS** — `execute_js` (wrapped `async () => (code)`, requires `confirm=true`)
- 🏥 **Health check** — server + extension transport state (`waiting`/`connected`), window/tab counts
- 🧩 **UI** — toolbar `popup.html` (380px) + full `dashboard.html` (overview/browser/tools/captures/settings/logs), `manifest.json` `options_page` → dashboard

## Requirements

- **Node.js 20+**
- **Brave / Chrome 118+** with extension loaded (see below)
- No Playwright — extension does DOM/debugger work; server is `ws` + `zod` + `@modelcontextprotocol/sdk`

## Installation

```bash
git clone https://github.com/ahmadhass0un/brave-browser-mcp.git
cd brave-browser-mcp
npm install
```

## Quick Start

### 1. Load the extension

`brave://extensions` → Developer mode → **Load unpacked** → select `extension/`. (A normal browser launch is enough — `--remote-debugging-port` is *not* required; the extension uses the in-browser `chrome.debugger` API, not the CDP port.) The toolbar shows **Browser Navigator** with popup (`popup.html`) and full dashboard (`dashboard.html` via `chrome.runtime.getURL("dashboard.html")`).

The extension probes `http://127.0.0.1:9224/health` every 2s and shows `Waiting for MCP server…` (yellow) until the server is up — the console stays silent in the meantime — then `Connected`.

### 2. Run the server (provides the WS counterpart)

```bash
npm install
node index.js              # stdio MCP + ws://127.0.0.1:9224
# or ./start.sh (optionally launches Brave via launch-brave.sh, then node)
```

The server speaks MCP over `stdio`. `connect_brave` wires the current tab (`health` shows `connected:true`) and `navigate` etc. go through the extension.

### 3. Register it as an MCP server

For **opencode**, add to `opencode.json`:

```json
{
  "mcp": {
    "browser-navigator": {
      "type": "local",
      "command": ["node", "/absolute/path/to/brave-browser-mcp/index.js"],
      "enabled": true
    }
  }
}
```

For **Claude Desktop**, add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "browser-navigator": {
      "command": "node",
      "args": ["/absolute/path/to/brave-browser-mcp/index.js"]
    }
  }
}
```

### 4. Start automating

```
connect_brave
navigate to https://example.com
list_elements on the page
click "Learn more"
```

## Tools

All 43 tools (via `tools.js` → `bridge.js` → `background.js` ops):

| Tool | Description |
|------|-------------|
| `connect_brave` | Connect to the browser extension (WebSocket already established by the extension); returns browser state |
| `disconnect` | Reset the transport (windows/tabs stay open); next call re-handshakes automatically |
| `navigate` | Go to a URL (SSRF-guarded); `wait_for_captcha` available when a challenge appears |
| `navigate_history` | Back / forward; fast on bfcache pages |
| `click` | Click by CSS selector, visible text, or ref (ref_N from read_page); double-click & mouse buttons |
| `computer` | Unified interaction: click/double-click/right-click/move/type/fill/key/scroll/hover/wait/navigate/screenshot by selector, text, coordinates, or ref |
| `type` | Type text; optional per-keystroke delay and Enter |
| `focus_element` | Focus an element (needed for custom widgets like tag/chip inputs) |
| `press_key` | Send keys: Escape, Tab, Backspace, Arrow keys, combos, sequences |
| `scroll` | Scroll up/down/left/right (pixel amount) |
| `hover` | Hover to reveal menus and tooltips |
| `get_page_info` | URL, title, load status, CAPTCHA presence |
| `get_page_content` | Extract visible text or raw HTML (10k char cap) |
| `read_page` | Accessibility tree with stable ref IDs (ref_1, ref_2...); filter interactive/all |
| `list_elements` | List interactive elements with reusable CSS selectors |
| `inspect_dom` | Inspect an element's structure, attributes, and children |
| `screenshot` | PNG of the page or an element (saved under `screenshots/`) |
| `pdf_export` | Save the page as a PDF (saved under `screenshots/`) |
| `execute_js` | Run arbitrary JS in the page (requires `confirm=true`) |
| `inject_script` | Inject persistent content script (survives navigations, isolated world) |
| `send_to_injected` | Send message to injected script and await reply |
| `wait_for` | Wait until an element appears in the DOM |
| `wait_for_load` | Wait for full page load |
| `network_start` | Start capturing HTTP requests via CDP (Fetch+Network) |
| `network_stop` | Stop capture, return all requests as JSON |
| `network_list` | Peek at captured requests without stopping |
| `network_request` | Send custom HTTP request through browser (cookies apply) |
| `search_tabs` | Semantic search across ALL open tabs (TF-IDF cosine similarity) |
| `tabs` | List / open / switch / close tabs (background mode supported) |
| `windows` | List / switch / close windows |
| `detect_captcha` | Check CAPTCHA presence & solved status |
| `wait_for_captcha` | Poll until the user solves a CAPTCHA |
| `video_control` | Play/pause/seek/volume/fullscreen on HTML5 video |
| `search` | Search 9 platforms: Google, Bing, DuckDuckGo, Brave, YouTube, Reddit, GitHub, Stack Overflow, Wikipedia |
| `bookmark_add` / `bookmark_delete` / `bookmark_search` / `bookmark_list` | Local JSON bookmark store (tags, upsert by url) |
| `history_search` | Search server-recorded navigation history (time-filtered, persisted, capped 5000) |
| `cookies` | Get/set/export/import cookies (AES-256-GCM encrypted snapshots under `cookies/`) |
| `health` | Server + connection status, open window/tab counts |

## Working with complex UIs

Dynamic pages — dialogs, modals, dropdowns, token chips, custom widgets — are hard to automate when you don't know the DOM. Instead of guessing selectors, use the discovery tools:

1. **`list_elements`** — see what is actually clickable or typeable, with a reusable CSS selector for each element. Filter by kind (`button`, `link`, `input`, …), by text (`contains`), or scope to an open container.
2. **`inspect_dom`** — understand how a widget is built: tag, attributes, classes, a CSS path, and child elements. Match by selector or exact visible text.
3. **`focus_element`** — many widgets (e.g. GitHub tag/chip inputs) only accept keyboard input once focused. Focus the element, then:
4. **`press_key`** — send keyboard input: `Backspace`/`Delete` to remove a token chip, `ArrowDown`+`Enter` to pick a menu item, `Escape` to dismiss a dialog, `Tab` to move between fields.

The **`scope`** parameter on `click`, `type`, `focus_element`, `hover`, `inspect_dom`, `list_elements`, and `by_text` targeting limits the search to a container — e.g. `"[role=dialog]"` for the currently open dialog — so you interact with the right element even when the page has many matches.

For example, removing a tag from GitHub's "Edit repository metadata" dialog:

```
focus_element(by_text="automation", scope="[role=dialog]")
press_key(key="Backspace")
```

## CAPTCHA Handling

`detect_captcha` reports CAPTCHA presence (reCAPTCHA, hCaptcha, Cloudflare Turnstile, Cloudflare Challenge) and `get_page_info` includes a captcha field. `wait_for_captcha` blocks until a human solves the challenge in the browser — this tool cannot (and will not) bypass CAPTCHAs.

## Security Notes

- `execute_js` requires `confirm=true` and is capped at 20000 chars.
- Screenshot & cookie paths are sanitized against path traversal.
- Cookies are stored AES-256-GCM encrypted with `0o600` permissions, directories with `0o700`.
- The server never kills a browser it did not launch.
- URL guards block loopback/private/metadata targets (SSRF) on navigate, tabs open, network_request, and `fetch` paths.
- Signal handlers fail in-flight RPCs and close sockets on exit.
- See [AUDIT.md](AUDIT.md) for the security & code-quality audit.

## Testing

The suite drives the server over the real MCP stdio protocol (needs the extension loaded in a running Brave; no `--remote-debugging-port` required):

```bash
node test.cjs
```

Five smoke assertions (health, connect_brave, navigate, get_page_info, disconnect) run against the live extension bridge.

## License

**PolyForm Noncommercial 1.0.0** — see [LICENSE](LICENSE).

Free to use for any **noncommercial** purpose. For **commercial use**, contact the author first.
