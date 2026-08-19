# Browser Navigator MCP

A Model Context Protocol (MCP) server that gives AI assistants full control over the **Brave browser** via CDP (Chrome DevTools Protocol). Built for OSINT investigations, social media crawling, and general web automation.

Attaches to your **existing** Brave instance (or launches a fresh one) without touching your tabs — it connects to the browser, not a cloned copy.

## Features

- 🧭 **Full browser control** — navigate, click, type, scroll, hover, screenshots, PDF export
- 🪟 **Window & tab management** — list, open, switch, and close windows/tabs
- 🔐 **CAPTCHA detection** — auto-detects reCAPTCHA, hCaptcha, Cloudflare Turnstile & challenges, then waits for the human to solve them
- 🍪 **Session persistence** — save/load cookies to keep logins alive between runs
- 🎥 **Video control** — play/pause/seek/volume on any HTML5 player (YouTube, etc.)
- 🔍 **Social search** — one-tool searches across Google, X/Twitter, Instagram, Facebook, LinkedIn, TikTok, YouTube
- 🔧 **Arbitrary JS** — `execute_js` for anything else (with an explicit confirmation flag)
- 🏥 **Health check** — confirm server + browser connection state

## Requirements

- **Node.js 20+**
- **Brave browser** (installed at a standard path, or specify via `BRAVE_PATH`)
- No Playwright browser download needed — the server drives Brave directly over CDP

## Installation

```bash
git clone <your-repo-url>
cd brave-browser-mcp
npm install
```

## Quick Start

### 1. Launch Brave with the debug port

```bash
./launch-brave.sh
```

This starts Brave with `--remote-debugging-port=9222`. It **never kills** an existing Brave instance — if port 9222 is already in use it leaves it alone.

> Alternatively, start Brave manually with `brave --remote-debugging-port=9222`.
> If Brave is already running **without** a debug port, the MCP will ask you to close it and retry — it will not kill your running browser for you.

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
      "command": ["node", "index.js"],
      "cwd": "/absolute/path/to/brave-browser-mcp",
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

## Tools

| Tool | Description |
|------|-------------|
| `connect_brave` | Connect to Brave; auto-launches only if nothing is running |
| `disconnect` | Disconnect (browser stays open) |
| `navigate` | Go to a URL; auto-detects CAPTCHAs and waits up to 120s for solving |
| `navigate_history` | Back / forward |
| `click` | Click by CSS selector or visible text; double-click, mouse button options |
| `type` | Type text; optional per-keystroke delay and Enter |
| `scroll` | Scroll up/down/left/right (pixel amount) |
| `hover` | Hover to reveal menus/tooltips |
| `get_page_info` | URL, title, load status, CAPTCHA presence |
| `get_page_content` | Extract text or HTML (10k char cap) |
| `screenshot` | PNG of page or element (saved under `screenshots/`) |
| `pdf_export` | Save page as PDF (saved under `screenshots/`) |
| `execute_js` | Run arbitrary JS in page (requires `confirm=true`) |
| `wait_for` | Wait for an element to appear |
| `wait_for_load` | Wait for full page load |
| `tabs` | List / open / switch / close tabs |
| `windows` | List / switch / close windows |
| `detect_captcha` | Check CAPTCHA presence & solved status |
| `wait_for_captcha` | Poll until the user solves the CAPTCHA |
| `video_control` | Play/pause/seek/volume on HTML5 video |
| `search_social` | Search Google, X, Instagram, Facebook, LinkedIn, TikTok, YouTube |
| `cookies` | Save/load session cookies (stored under `cookies/`) |
| `health` | Server + connection status, open window/tab counts |

## CAPTCHA Handling

CAPTCHAs are **detected automatically** after `navigate` / `navigate_history` and reported in `get_page_info`. When an unsolved CAPTCHA is found, automation **pauses and asks the user to solve it** in the browser — this tool cannot (and will not) bypass them.

Types detected: reCAPTCHA, hCaptcha, Cloudflare Turnstile, Cloudflare Challenge.

## Security Notes

- `execute_js` requires `confirm=true` and is capped at 5000 chars / 50KB output.
- Screenshot & cookie paths are sanitized against path traversal.
- Cookies are stored with `0o600` permissions, directories with `0o700`.
- The server never kills a browser it did not launch.
- See [AUDIT.md](AUDIT.md) for the full security & code-quality audit.

## Testing

The suite drives the server over the real MCP stdio protocol (requires Brave running on port 9222):

```bash
node test.cjs
```

53 assertions covering navigation, CAPTCHA, tabs, windows, screenshots, cookies, video, and security hardening.

## License

**PolyForm Noncommercial 1.0.0** — see [LICENSE](LICENSE).

Free to use for any **noncommercial** purpose (personal, research, education,
hobby, charities, government). For **commercial use**, contact the author
first — please reach out before using this project commercially.