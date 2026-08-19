# Browser Navigator MCP

A [Model Context Protocol](https://modelcontextprotocol.io) server that gives AI assistants full control over the **Brave browser** (and other Chromium browsers) through the Chrome DevTools Protocol (CDP).

It attaches to your **existing** Brave instance — or launches a fresh one — and drives the real browser: tabs, windows, clicks, typing, screenshots, PDFs, sessions, and even HTML5 video playback.

Built so that an LLM can operate **complex, dynamic UIs** (dialogs, modals, dropdowns, token chips, custom widgets) without needing to reverse-engineer the DOM by hand.

## Highlights

- 🧭 **Full browser control** — navigate, back/forward, click, type, scroll, hover, keyboard input
- 🗂 **Adaptive DOM tools** — `list_elements`, `inspect_dom`, `focus_element`, `press_key` discover how a UI is built and interact with it (see [Working with complex UIs](#working-with-complex-uis))
- 🪟 **Window & tab management** — list, open, switch, and close windows and tabs
- 🔐 **CAPTCHA detection** — detects reCAPTCHA, hCaptcha, Cloudflare Turnstile & challenges, pauses automation, and waits for a human to solve it
- 🍪 **Session persistence** — save/load cookies to keep logins alive between runs
- 🎥 **Video control** — play/pause/seek/volume/fullscreen on any HTML5 player
- 🔍 **Social search** — one-tool searches across Google, X, Instagram, Facebook, LinkedIn, TikTok, YouTube
- 📄 **Export** — full-page screenshots and PDF archiving
- 🔧 **Arbitrary JS** — `execute_js` for anything else (requires an explicit `confirm=true`)
- 🏥 **Health check** — server + browser connection state, open window/tab counts

## Requirements

- **Node.js 20+**
- **Brave browser** (or any Chromium browser; the server auto-launches Brave from standard install paths)
- No Playwright browser download needed — the server drives the real browser over CDP

## Installation

```bash
git clone https://github.com/ahmadhass0un/brave-browser-mcp.git
cd brave-browser-mcp
npm install
```

## Quick Start

### 1. Launch Brave with the debug port

```bash
./launch-brave.sh
```

This starts Brave with `--remote-debugging-port=9222`. It **never kills** an existing Brave instance — if the port is already in use it leaves it alone.

> Alternatively, start Brave manually: `brave --remote-debugging-port=9222`.
> If Brave is already running **without** a debug port, the MCP asks you to close it and retry — it will not kill your running browser for you.

### 2. Run the server

```bash
node index.js
```

The server speaks MCP over stdio. `connect_brave` attaches to the running Brave instance automatically.

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

All 27 tools:

| Tool | Description |
|------|-------------|
| `connect_brave` | Connect to Brave; auto-launches only if nothing is running |
| `disconnect` | Disconnect from the browser (windows/tabs stay open) |
| `navigate` | Go to a URL; auto-detects CAPTCHAs and waits up to 120s for solving |
| `navigate_history` | Back / forward; fast on bfcache pages |
| `click` | Click by CSS selector or visible text; double-click & mouse button options |
| `type` | Type text; optional per-keystroke delay and Enter |
| `focus_element` | Focus an element (needed for custom widgets like tag/chip inputs) |
| `press_key` | Send keys: Escape, Tab, Backspace, Arrow keys, combos, sequences |
| `scroll` | Scroll up/down/left/right (pixel amount) |
| `hover` | Hover to reveal menus and tooltips |
| `get_page_info` | URL, title, load status, CAPTCHA presence |
| `get_page_content` | Extract visible text or raw HTML (10k char cap) |
| `list_elements` | List interactive elements with reusable CSS selectors |
| `inspect_dom` | Inspect an element's structure, attributes, and children |
| `screenshot` | PNG of the page or an element (saved under `screenshots/`) |
| `pdf_export` | Save the page as a PDF (saved under `screenshots/`) |
| `execute_js` | Run arbitrary JS in the page (requires `confirm=true`) |
| `wait_for` | Wait until an element appears in the DOM |
| `wait_for_load` | Wait for full page load |
| `tabs` | List / open / switch / close tabs |
| `windows` | List / switch / close windows |
| `detect_captcha` | Check CAPTCHA presence & solved status |
| `wait_for_captcha` | Poll until the user solves a CAPTCHA |
| `video_control` | Play/pause/seek/volume/fullscreen on HTML5 video |
| `search_social` | Search Google, X, Instagram, Facebook, LinkedIn, TikTok, YouTube |
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

Free to use for any **noncommercial** purpose (personal, research, education, hobby, charities, government). For **commercial use**, contact the author first.