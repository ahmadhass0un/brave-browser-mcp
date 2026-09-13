# Browser Navigator MCP - Quick Notes for LLM (current: extension + WS)

## CRITICAL: CAPTCHA Detection & Handling

**Check CAPTCHAs explicitly.** Detection is not wired into `navigate` (it returns as soon as the page settles).

### Where CAPTCHA status appears:
- `get_page_info()` — includes a `captcha` field ({detected, kind})
- `detect_captcha()` — explicit check; returns detected/kind/signals

### Wait for a human:
- `wait_for_captcha(timeout_ms=60000)` — blocks until solved (content.js visibility checks + `mcp:captcha-solved` event)

### CAPTCHA Types Detected:
- reCAPTCHA (Google) - checkbox or image challenge
- hCaptcha - checkbox or image challenge
- Cloudflare Turnstile - auto-solving widget
- Cloudflare Challenge - "Checking your-browser" page

## How to Use (extension WS — no dual browser)

1. Extension must be loaded (`brave://extensions` → Load unpacked `extension/`), shows `Waiting for MCP server…` until `node index.js` (ws://127.0.0.1:9224) is up. While waiting it silently probes `http://127.0.0.1:9224/health` every 2s — no console noise.
2. `connect_brave()` — wires `currentTabId` via `browser.state` (no `action` param)
3. Tools that navigate auto-wait for the page to load (`nav.goto` includes `waitReady`)
4. If a content-script click fails, it escalates to trusted CDP `Input.dispatchMouseEvent` automatically
5. For CAPTCHAs: detect → wait_for_captcha → verify success
6. Use `health` to see `connected`, `transport` (`websocket`), `tabs`/`windows` counts

## Tool Cheat Sheet (current)

```
connect_brave()                          # Connect via extension WS (sets currentTabId)
health()                                 # {connected, transport, browser:{windows,tabs}, bookmarks, historyEntries}
disconnect()                             # Reset transport; browser stays open, next call re-handshakes

# Navigation (SSRF-guarded, http/https only)
navigate(url="https://google.com", wait_until="load", timeout_ms=30000)
navigate_history(direction="back", steps=1)

# Interaction (content.js first, trusted CDP input fallback)
click(selector="button.submit")           # also by_text, scope, ref, double_click, button, trusted
computer(action="click", selector="...")  # unified: click/type/fill/key/scroll/hover/wait/navigate/screenshot
type(selector="input[name=q]", text="test", delay=50)
scroll(direction="down", amount=500)
wait_for(selector=".content", timeout_ms=3000)
wait_for_load(timeout_ms=30000)
execute_js(code="document.title", confirm=true)

# Page Info (captcha field included)
get_page_info()                          # URL, title, readyState, captcha: {detected, kind}
get_page_content(selector="body", format="text") # or html
read_page(filter="interactive", max_refs=150) # a11y snapshot with ref_N
list_elements(kind="button", contains="Save", limit=20) # reusable selectors
inspect_dom(selector="h1", max_depth=3)
screenshot(full_page=false, selector="body")
pdf_export()

# Tabs / Windows (chrome.tabs/windows via extension)
tabs(action="list")                      # {count, tabs:[{id, url, title, active}]}
tabs(action="open", url="https://...")   # sets current tab (active) or background=true
tabs(action="close", tab_id=123)         # close by tab_id
windows(action="list")                   # {count, windows:[{id, focused, tabs}]}
windows(action="focus", window_id=1)
```

## CAPTCHA Tools

```
detect_captcha()                         # Check if CAPTCHA present (detected, kind, signals)
wait_for_captcha(timeout_ms=60000)       # Block until user solves (1s-180s)
```

### CAPTCHA workflow:
```
1. navigate(url="https://site-with-captcha.com")
2. get_page_info() → captcha.detected == true
3. wait_for_captcha(timeout_ms=120000)    # ask the user to solve in the browser
4. (continue automation)
```

## Search (9 platforms)

```
search(query="rust vs go", platform="google")   # google|bing|duckduckgo|brave|youtube|reddit|github|stackoverflow|wikipedia
search_tabs(query="docs", limit=20)             # TF-IDF across open tabs
```

**Note:** Results load lazily on some platforms. To get more:
1. `search(...)` — loads first batch
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
network_start(max_time=15000)
network_list()
```

## Tips

- Navigation waits for load by default (`wait_until="load"`)
- Click tries CSP-safe content-script events first, then trusted `Input.dispatchMouseEvent`; `by_text` matches visible text (exact) or `aria-label`
- Use `get_page_info()` if something seems stuck
- Use `execute_js(code="...", confirm=true)` for custom actions
- CAPTCHA detected? Use `wait_for_captcha()` - don't try to solve it
- Extension shows `Waiting for MCP server…` until `node index.js` (ws://127.0.0.1:9224) is up; no manual `launch-brave.sh` needed if Brave already running with extension

## Search Platforms Supported

Google, Bing, DuckDuckGo, Brave Search, YouTube, Reddit, GitHub, Stack Overflow, Wikipedia
