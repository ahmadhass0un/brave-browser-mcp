# Browser Navigator MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants full control over **Brave / Chrome** via a **Manifest V3 extension** (no external browser download).

The extension (`extension/background.js` service worker + `content.js` DOM ops) bridges to the local MCP server over **WebSocket `ws://127.0.0.1:9224`** (native-messaging fallback). The server speaks MCP over `stdio` and drives the *real* user profile — tabs, windows, clicks, typing, screenshots, PDFs, cookies, video — through `chrome.tabs`, `chrome.windows`, `chrome.scripting` and `chrome.debugger`.

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

`brave://extensions` → Developer mode → **Load unpacked** → select `extension/` (or `brave-browser --load-extension=/abs/path/extension --remote-debugging-port=9222`). The toolbar shows **Browser Navigator** with popup (`popup.html`) and full dashboard (`dashboard.html` via `chrome.runtime.getURL("dashboard.html")`).

The extension auto-connects to `ws://127.0.0.1:9224` and shows `Waiting for MCP server…` (yellow) until the server is up, then `Connected`.

### 2. Run the server (provides the WS counterpart)

```bash
npm install
node index.js              # stdio MCP + ws://127.0.0.1:9224
# or ./start.sh (launches Brave with --remote-debugging-port=9222 if needed, then node)
```

The server speaks MCP over `stdio`. `connect_brave` wires the current tab (`health` shows `connected:true`) and `navigate` etc. go through the extension.

> Still uses `--remote-debugging-port=9222` only for `launch-brave.sh` / `start.sh` to ensure Brave is running with a debuggable profile; the *control path* is now extension → WS, not direct CDP from Node.

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

All 40+ tools (via `tools.js:1` → `bridge.js` → `background.js` ops):

| Tool | Description |
|------|-------------|
| `connect_brave` | Connect to Brave; auto-launches only if nothing is running |
| `disconnect` | Disconnect from the browser (windows/tabs stay open) |
| `navigate` | Go to a URL; auto-detects CAPTCHAs and waits up to 120s for solving |
| `navigate_history` | Back / forward; fast on bfcache pages |
| `click` | Click by CSS selector, visible text, or ref (ref_N from read_page); double-click & mouse buttons |
| `computer` | Unified interaction: click/drag/scroll/type/key/fill/hover/wait/screenshot by selector, coordinates, or ref |
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
| `bookmark_add` / `bookmark_delete` / `bookmark_search` / `bookmark_list` | Local bookmark store with Chrome/Brave import |
| `history_search` | Search browsing history (time-filtered, persisted) |
| `cookies` | Save/load session cookies (stored under `cookies/`) |
| `health` | Server + connection status, open window/tab counts |

## Working with complex UIs

Dynamic pages — dialogs, modals, dropdowns, token chips, custom widgets — are hard to automate when you don't know the DOM. Instead of guessing selectors, use the discovery tools:

1. **`list_elements`** — see what is actually clickable or typeable, with a reusable CSS selector for each element. Filter by kind (`button`, `link`, `input`, …), by text (`contains`), or scope to an open container.
2. **`inspect_dom`** — understand how a widget is built: tag, attributes, classes, a CSS path, and child elements. Match by selector or exact visible text.
3. **`focus_element`** — many widgets (e.g. GitHub tag/chip inputs) only accept keyboard input once focused. Focus the element, then:
4. **`press_key`** — send keyboard input: `Backspace`/`Delete` to remove a token chip, `ArrowDown`+`Enter` to pick a menu item, `Escape` to dismiss a dialog, `Tab` to move between fields.

The **`scope`** parameter on `click`, `type`, `focus_element`, `list_elements`, and `inspect_dom` limits the search to a container — e.g. `"[role=dialog]"` for the currently open dialog — so you interact with the right element even when the page has many matches.

For example, removing a tag from GitHub's "Edit repository metadata" dialog:

```
inspect_dom(selector="automation", by_text=true, scope="[role=dialog]")
focus_element(selector="automation", by_text=true, scope="[role=dialog]")
press_key(key="Backspace")
```

## CAPTCHA Handling

CAPTCHAs are **detected automatically** after `navigate` / `navigate_history` and reported in `get_page_info`. When an unsolved CAPTCHA is found, automation **pauses and asks the user to solve it** in the browser — this tool cannot (and will not) bypass them.

Types detected: reCAPTCHA, hCaptcha, Cloudflare Turnstile, Cloudflare Challenge.

## Security Notes

- `execute_js` requires `confirm=true` and is capped at 5000 chars / 50KB output.
- Screenshot & cookie paths are sanitized against path traversal.
- Cookies are stored with `0o600` permissions, directories with `0o700`.
- The server never kills a browser it did not launch.
- Signal handlers clean up CDP sessions on exit.
- See [AUDIT.md](AUDIT.md) for the full security & code-quality audit.

## Testing

The suite drives the server over the real MCP stdio protocol (requires Brave running on port 9222):

```bash
node test.cjs
```

63 assertions covering navigation, CAPTCHA detection, tabs, windows, screenshots, PDF export, cookies, video, security hardening, and the adaptive DOM tools.

## License

**PolyForm Noncommercial 1.0.0** — see [LICENSE](LICENSE).

Free to use for any **noncommercial** purpose. For **commercial use**, contact the author first.
