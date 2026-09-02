# Browser Navigator MCP - Quick Notes for LLM (current: extension + WS)

## CRITICAL: CAPTCHA Detection & Handling

**CAPTCHAs are detected automatically.** No need to call `detect_captcha()` manually.

### Auto-detection integrated into:
- `navigate()` — Detects CAPTCHA after navigation, auto-waits if unsolved
- `navigate_history()` — Detects CAPTCHA after back/forward
- `get_page_info()` — Shows CAPTCHA status in page info

### Manual tools (still available):
- `detect_captcha()` — Explicitly check CAPTCHA status
- `wait_for_captcha(timeout=120)` — Manually wait for user to solve

### CAPTCHA Types Detected:
- reCAPTCHA (Google) - checkbox or image challenge
- hCaptcha - checkbox or image challenge
- Cloudflare Turnstile - auto-solving widget
- Cloudflare Challenge - "Checking your browser" page

## How to Use (extension WS — no dual browser)

1. Extension must be loaded (`brave://extensions` → Load unpacked `extension/`), shows `Waiting for MCP server…` until `node index.js` (ws://127.0.0.1:9224) is up.
2. `connect_brave()` — wires `currentTabId` via `browser.state` (no `action` param)
3. All tools auto-wait for page to load (`nav.waitReady`)
4. If click fails, it tries JS fallback automatically
5. For CAPTCHAs: detect → wait → verify success
6. Use `health` to see `connected`, `transport` (`websocket`/`native`), `tabs`/`windows` counts

## Tool Cheat Sheet (current)

```
connect_brave()                          # Connect via extension WS (sets currentTabId)
health()                                 # {connected, transport, browser:{windows,tabs}, bookmarks, historyEntries}
disconnect()                             # Mark session closed (browser stays open)

# Navigation (auto-detects CAPTCHAs, via nav.goto + nav.waitReady)
navigate(url="https://google.com", wait_until="load", timeout_ms=10000)
navigate_history(direction="back", steps=1)

# Interaction (via cs.eval + debugger Input when needed)
click(selector="button.submit")           # also by_text, scope, ref, double_click, button, trusted
computer(action="click", selector="...")  # unified: click/type/fill/key/scroll/hover/wait/screenshot
type(selector="input[name=q]", text="test", delay=50)
scroll(direction="down", amount=500)
wait_for(selector=".content", timeout=3000)
wait_for_load(timeout=5000)
execute_js(code="document.title", confirm=true)

# Page Info (includes CAPTCHA status)
get_page_info()                          # URL, title, status, CAPTCHA detection
get_page_content(selector="body", format="text") # or html
read_page(filter="interactive", max_refs=150) # a11y snapshot with ref_N
list_elements(kind="button", contains="Save", limit=20) # reusable selectors
inspect_dom(selector="h1", max_depth=3)
screenshot(full_page=false, selector="body")
pdf_export()

# Tabs / Windows (chrome.tabs/windows via extension)
tabs(action="list")                      # {count, tabs:[{id, url, title, active}]}
tabs(action="open", url="https://...")   # {newTabId}
tabs(action="close", tab_id=123)         # close by tab_id
windows(action="list")                   # {count, windows:[{id, focused, tabs}]}
windows(action="switch", windowId=1)
```

## CAPTCHA Tools

```
detect_captcha()                         # Check if CAPTCHA present & solved/unsolved
wait_for_captcha(timeout=120)            # Poll every 1s until user solves (max 120s)
```

### CAPTCHA workflow (automatic):
```
1. navigate(url="https://site-with-captcha.com")
   → Auto-detects CAPTCHA → "⚠️ CAPTCHA detected: Cloudflare Turnstile [UNSOLVED]"
   → Automatically waits for user to solve → "✅ CAPTCHA solved in 8s"
2. (continue automation)
```

### Manual CAPTCHA tools (if needed):
```
detect_captcha()                         # Check if CAPTCHA present & solved/unsolved
wait_for_captcha(timeout=60)             # Poll every 1s until user solves (max 120s)
```

## Social Media

```
search_social(platform="twitter", query="target")
search_social(platform="instagram", query="target")
search_social(platform="facebook", query="target")
search_social(platform="linkedin", query="target")
search_social(platform="tiktok", query="target")
search_social(platform="youtube", query="target")
```

**Note:** All platforms use infinite scroll (lazy loading). Initial results are limited. To get more results:
1. `search_social()` — loads first batch
2. `scroll(direction="down", amount=1000)` — triggers next batch to load
3. `wait_for_load()` — wait for new content
4. Repeat scroll + wait as needed
5. `get_page_content()` — extract all loaded results

## Video Control

Works on any page with HTML5 video (via `content.js` `videoControl`)

```
video_control(action="pause")
video_control(action="play")
video_control(action="seek", value=60)
video_control(action="mute")
video_control(action="unmute")
video_control(action="set_volume", value=0.5)
video_control(action="get_info")
```

## Cookies / Bookmarks / History (server JSON stores)

```
cookies(action="get", domain="example.com")
cookies(action="set", cookies=[{name:"sid", value:"...", domain:"example.com"}])
cookies(action="export", file="backup.json.enc")
bookmark_add(url="https://example.com", title="Example")
bookmark_list()
history_search(query="example", limit=20)
network_start(maxTimeMs=15000)
network_list()
```

## Tips

- Page is ready before every action (auto-wait via `nav.waitReady`)
- Click tries trusted `Input.dispatchMouseEvent` then JS fallback; `by_text` matches `aria-label`
- Use `get_page_info()` if something seems stuck
- Use `execute_js(code="...", confirm=true)` for custom actions
- CAPTCHA detected? Use `wait_for_captcha()` - don't try to solve it
- Extension shows `Waiting for MCP server…` until `node index.js` (ws://127.0.0.1:9224) is up; no manual `launch-brave.sh` needed if Brave already running with extension

## Supported Platforms

Twitter/X, Instagram, Facebook, LinkedIn, TikTok, YouTube, Reddit (needs VPN off)
