# brower-navigator vs mcp-chrome — Gap Analysis & Porting Guide

> **Audience:** AI agent that wants to cherry-pick the *good* parts of `mcp-chrome` (`~/Videos/mcps/mcp-chrome`) into `brower-navigator` (`~/Videos/mcps/brower-navigator`) without losing its 7k-LOC simplicity.
> **Date:** 2026-09-01

## 1. TL;DR

| Dimension | `brower-navigator` (you are here) | `mcp-chrome` (donor) | Verdict |
|---|---|---|---|
| Philosophy | 7.2k LOC, 1 `ws://127.0.0.1:9224` bridge, stdio MCP, deterministic DOM tools | Monorepo `pnpm`, `app/native-server` Fastify + NativeMessaging + `app/chrome-extension` WXT/Vue + `packages/wasm-simd` Rust | **Keep BN's minimal core**; steal MCP-chrome's *capabilities* not its *complexity* |
| Transport | `ws-server.js:30` `WebSocketServer 127.0.0.1:9224` + envelope `lib/proto.js:92` + `bridge.js:595` facades; `extension/background.js:376` SW dials `ws` with `hello/welcome` + `hb 15s:54` | `app/native-server/src/server/index.ts` Fastify HTTP/SSE `12306/mcp` + `src/native-messaging-host.ts` + `src/mcp/mcp-server-stdio.ts` | BN wins on debuggability; MCP-chrome wins on enterprise clients (CherryStudio, SSE). Worth adding optional HTTP as 2nd transport |
| Tools | 41 tools `tools.js:1781` `registerTools()` with `scope`, `ref_N`, `trusted` CDP fallback | ~30 tools `app/chrome-extension/entrypoints/background/tools/browser/index.ts:1` + `base-browser.ts:10` typed executors | Overlap ~85%. MCP-chrome has `gif-recorder`, `performance trace`, `console-buffer`, `file-upload`, `window` batch, `dialog/download` handling BN lacks. BN has `video_control`, `captcha wait`, `search 9 platforms` MCP-chrome lacks |
| Search | `search_tabs` TF-IDF `lib/tfidf.js:53` + `tools.js:1427` title/URL only | `vector-search.ts` HNSW `hnswlib-wasm` `utils/vector-database.ts` + `semantic-similarity-engine.ts` + `text-chunker.ts` + `content-indexer.ts` (full page chunks, embeddings) | **Biggest gap** — TF-IDF is fast/zero-dep but semantically weak. Port vector search as optional feature flag |
| Perf | Pure JS, no WASM | `packages/wasm-simd/src/lib.rs:13` `SIMDMath` `wide::f32x4` 4-8x `cosine/batch/matrix`, `utils/simd-math-engine.ts` | Steal only if you steal vector search |
| UI | `extension/popup.js:213` 380px + `dashboard.js:349` 6 tabs `manifest.json:45` `options_page: dashboard.html` | `popup/`, `sidepanel/` (workflow), `options/`, `builder/` VueFlow, `quick-panel/` AI chat `shared/quick-panel/ui/ai-chat-panel.ts`, `web-editor-v2/` visual CSS editor `core/editor.ts` | BN's popup/dashboard is enough for ops; SidePanel + Web Editor are donor highlights worth porting selectively |
| Intelligence | `content.js:237` `extractVisibleText`, no embeddings | Offscreen doc `entrypoints/offscreen/main.ts` + Web Workers `utils/semantic-similarity-engine.ts` Transformers.js `bge-small/e5` + `model-cache-manager.ts` + `lru-cache.ts` + `indexeddb-client.ts` | Heavy. Port as *lazy, opt-in* offscreen module |
| Recording | None | `record-replay/` v1 + `record-replay-v3/bootstrap.ts:16` with `rr-graph.ts`, `common/rr-v3-keepalive-protocol.ts`, `offscreen/rr-keepalive.ts` | High-value for "workflow automation" roadmap. BN already has `injected.js:820` persistent scripts — natural base |
| Agent | None | `native-server/src/agent/*` `chat-service.ts` `stream-manager.ts` `session-service.ts` `engines/claude.ts:1` `codex.ts` multi-engine SSE `/agent/chat/:sessionId/stream:958` `agent.ts:1014` 50MB body limit | Only port if you want "Claude Code in browser". Otherwise skip; BN's `injected.send` + `execute_js confirm` covers 90% |
| License | PolyForm Noncommercial `README.md:186` | MIT | If you upstream, keep BN license |

---

## 1b. Advantages — What Each Project Does Better (Not Just Differences)

*So the next AI knows what to **keep** vs what to **steal** — distinct from `§1 TL;DR` which mixes both.*

### ✅ `brower-navigator` Advantages (Keep These — Do NOT Regress)

| # | Advantage | Why It Wins | Evidence `file:line` |
|---|---|---|---|
| BN-1 | **6.8s comment+delete, 0.8s nav** measured `2026-09-01` | 1 hop WS vs 3-hop Fastify+nativeMessaging; no 300ms ping | `bridge.js:134 call()` `ws-server.js:30` vs `mcp-chrome/tools/base-browser.ts:5 PING 300` |
| BN-2 | **Zero build, 3 deps, 18MB nm, 0s install** | `npm install` 2s vs `pnpm -r build 90s + cargo 12s` | `package.json:14` `ws zod sdk` vs `mcp-chrome pnpm-workspace.yaml:1` `wxt tailwind vue-flow elk` |
| BN-3 | **Auditable 7650 LOC** vs 149770 | Read in 1h, `node --check` syntax `11` | `7650` total vs `entrypoints/background 44840` |
| BN-4 | **Minimal perms 6** `tabs windows scripting debugger cookies storage` | MC 17 perms attack surface | `manifest.json:11` vs `wxt.config.ts:40` |
| BN-5 | **Deterministic DOM tools** `scope ref by_text trusted` | Handles dialogs/chips `scope="[role=dialog]"` | `tools.js:1132 list_elements scope:1184` `performClick trusted:690` |
| BN-6 | **Single-client WS security** `4002 superseded 1<<20 maxPayload 4001 hello 30s HB 15s` | MC native host `16MB max` unauth `127.0.0.1:12306` no token | `ws-server.js:31 72 80 174` vs `native-messaging-host.ts:35` `server/index.ts:76 allow no-origin` |
| BN-7 | **Hardened FS** `0o700 dirs 0o600 files` + `AES-256-GCM cookies` `resolveOut sep check` | MC `0o755/0o644` no enc `~/.chrome-mcp-agent` | `server.js:24` `tools.js:642 814` `lib/security.js:96` vs `agent/db/client.ts:168` |
| BN-8 | **Built-in `typed` + `delay_per_char`** `type:918` + `video 11 actions` + `captcha` 4 kinds | MC no video/captcha `video_control` `detect_captcha` | `tools.js:1377 1361 918` `bridge pageVideoControl 485` `pageDetectCaptcha 458` |
| BN-9 | **SERP scraper 9 platforms** `google bing ddg brave youtube reddit github so wiki` `RULES 441` | MC no search | `tools.js:1396 SEARCH_URLS` `pageSearchResults 436` |
| BN-10 | **File JSON store survives without DB** `5000 history cap` `loadJson` | MC needs `better-sqlite3 WAL` + migration | `server.js:39` vs `agent/db/client.ts:51` |
| BN-11 | **Allowlist 19 CDP methods** `CDP_METHOD_BLOCKED` | MC any `sendCommand` passes | `background.js:704` vs `cdp-session-manager.ts:97` |
| BN-12 | **CSP default strict** no `wasm-unsafe-eval` | MC `wasm-unsafe-eval unsafe-inline:119` + WAR `/models/*` | `manifest 51` vs `wxt.config.ts:119 100` |

### ✅ `mcp-chrome` Advantages (Steal These — §4 P0–P2)

| # | Advantage | Why It Wins | Evidence `file:line` |
|---|---|---|---|
| MC-1 | **Vector semantic search** HNSW `hnswlib-wasm 100k*384` + chunker `80w overlap 1:21` + `hnswlib cosine:253` | BN TF-IDF `title+URL only:1424` no semantics | `utils/vector-database.ts:207` `text-chunker.ts:21` `vector-search.ts` `PREDEFINED_MODELS 116MB:147` |
| MC-2 | **116MB E5 + 31.6MB ORT + 25.6K SIMD 4-8x** `wide f32x4 mul_add reduce_add` | BN pure JS | `semantic-similarity-engine.ts:147` `workers/ort-wasm 10.7+20.9` `wasm-simd/lib.rs:45` |
| MC-3 | **Visual CSS editor** `web-editor-v2 2k core drag/resize Flex/Grid live Vue/React props` `Point Click Prompt` `2025/12/30` | BN none | `docs/VisualEditor.md:1` `web-editor-v2/core/editor.ts` `transaction-manager 1913` |
| MC-4 | **Record-Replay V3** `rr_v3 IndexedDB 6 stores rr_graph keepalive 20s` scheduler `poll 500ms`  `recoverFromCrash:260` | BN only `injected replay 1128` | `bootstrap.ts:469` `db.ts:15 RR_V3_STORES 6` `queue/scheduler 336` |
| MC-5 | **Agent orchestration** `better-sqlite3 WAL drizzle projects/sessions/messages` + `claude/codex/cursor/qwen/glm` `streamManager SSE 50MB:1014` `open in vscode/terminal` | BN none | `agent/chat-service.ts:527` `server/routes/agent.ts:1264` `storage.ts:14 ~/.chrome-mcp-agent` |
| MC-6 | **SidePanel + Builder** `VueFlow elkjs auto-layout welcome onboarding _locales 6` | BN `popup 328 vanilla` | `wxt.config.ts:70 side_panel` `builder/App.vue 1262` `_locales/*/messages.json` |
| MC-7 | **Quick-Panel Shadow DOM AI chat** `3401 lines ai-chat-panel 956` | BN none | `shared/quick-panel 3401` `quick-panel.content.ts 115` |
| MC-8 | **Enterprise transports** `StreamableHTTP /mcp 214 + SSE /sse 169 + STDIO` + `NativeMessaging 4B LE header 43` | BN `stdio+WS 30` only | `server/index.ts:167` `native-messaging-host.ts:43` |
| MC-9 | **GIF recorder** `auto_start clickIndicators dragPaths 834` + `enhanced renderer` + `OffscreenCanvas` | BN `capturePng` single | `gif-recorder.ts 1241` `gif-auto-capture.ts 520` |
| MC-10 | **Perf trace** `Tracing.start categories 265 Page.reload 274 getMetrics 346 save 85` + `console snapshot|buffer regex` | BN none | `performance.ts:220` `console.ts:31` |
| MC-11 | **File upload** `DOM.setFileInputFiles` `fileUrl base64 multiple` + `dialog handleJavaScriptDialog` + `download filenameContains wait` | BN none | `file-upload.ts` `dialog.ts` `download.ts` |
| MC-12 | **History/bookmarks native** `chrome.history.search excludeCurrentTabs` `chrome.bookmarks tree folderPath parentId` + `offscreen 31.6MB` | BN JSON flat `tags` | `history.ts:164` `bookmark.ts:46` vs `tools.js:1597 tags` |
| MC-13 | **i18n + typed** `6 locales __MSG_ TypeScript 5.8 strict husky commitlint eslint` | BN vanilla `node --check` | `_locales 6` `wxt 18` `types/chrome 0.0.318` |

> **Rule for downstream AI:** Keep BN-1..12 (speed/security/minimal) intact. Add MC-1..13 **only behind flags** `VECTOR_SEARCH SIMD WEB_EDITOR` per `§4 P0→P2`; never replace BN's `ws-server 209` with `Fastify` wholesale.

---

## 2. Repo Shapes Side-by-Side

```
brower-navigator/
  server.js:60           McpServer stdio + startWsServer()
  ws-server.js:209       single-client WS, hello timeout 3s:76, hb 15s:81
  bridge.js:595           call()/onTransportMessage() + dom facades pageClick/pageFill…
  tools.js:1781           41 tools, page-side fns stringified via cs.eval
  extension/
    manifest.json:51      MV3, 6 perms, background SW module
    background.js:1987    §1-§15, 25 ops HANDLERS:646, dbg manager 9, net capture 10
    content.js:955        OPS extractVisibleText/listInteractive/inspectDom/clickElement/fillField…
    injected.js:820       MAIN-world CustomEvent mcp-inject:<name>
  lib/proto.js:95         envelope codec, ERROR_CODES
  lib/security.js:113     SSRF, AES-256-GCM cookies
  lib/tfidf.js:53         tokenize/termFreq/idf/cosine

mcp-chrome/
  app/native-server/
    src/server/index.ts, src/server/routes/agent.ts:1264 (projects/sessions/chat/attachments/open)
    src/mcp/mcp-server.ts:24  Server{name:ChromeMcpServer}, src/mcp/register-tools.ts
    src/native-messaging-host.ts, src/file-handler.ts, src/trace-analyzer.ts
    src/agent/  chat-service, stream-manager, project-service, db/schema, engines/*
  app/chrome-extension/
    wxt.config.ts:172     WXT+Vue, perms 18:40, side_panel:71, CSP wasm-unsafe-eval:119
    entrypoints/background/index.ts:87  initNativeHostListener + semanticSimilarity + recordReplay + elementMarker…
    entrypoints/background/tools/browser/*.ts  29 files (bookmark, computer, history, screenshot…)
    entrypoints/background/tools/base-browser.ts:173  BaseBrowserToolExecutor injectContentScript ping 300ms:5
    common/tool-handler.ts:24  ToolExecutor interface, createErrorResponse
    utils/ vector-database, semantic-similarity-engine, simd-math-engine, text-chunker, content-indexer, offscreen-manager…
    shared/quick-panel/, entrypoints/sidepanel/, entrypoints/web-editor-v2/core/*, entrypoints/offscreen/
  packages/shared/src/tools.ts, packages/wasm-simd/src/lib.rs:245
  docs/ARCHITECTURE.md:308, docs/TOOLS.md:599
```

---

## 3. Tool-Level Gap Table

| Capability | BN (`tools.js:*`) | MC (`background/tools/browser/*`) | Action |
|---|---|---|---|
| navigate/window/tabs | `navigate:852`, `tabs:1298`, `windows:1339` `assertSafeUrl` | `common.ts`, `window.ts` viewport `width/height`, `background` | MC adds viewport + background tab — **easy win**, add `active:false` pass-through to `bridge.tabs.open` already exists |
| read_page / refs | `read_page:1013` AXTree + `bridge.refMap:200` `ref_N` | `read-page.ts` + `cdp-session-manager.ts` + `marker` | BN's `ref_N` loop is more robust (`ROLE_ALIASES`, alias search `tools.js:1099`). **Keep BN** |
| list/inspect/dom | `list_elements:1132`, `inspect_dom:1198` kind filter + scope | `web-fetcher.ts` `getInteractiveElements` | BN already richer (`scope`, kind `image/heading`). **No port** |
| click/type/scroll/hover | `performClick:661` `performType:711` `performScroll:736` `performHover:741` | `interaction.ts`, `keyboard.ts`, `computer.ts` | Rough parity. MC's `computer.ts` has `fill` selector fallback + auto-scale from screenshot `screenshot-context.ts`. **Port fill/scale** |
| screenshot/pdf | `capturePng:762` `exportPdf:781` `Page.captureScreenshot/printToPDF` | `screenshot.ts` element targeting `selector`+`fullPage`+`storeBase64` | BN already does clip `tools.js:764` via `pageRectOf`. MC adds `storeBase64` return. **Trivial** |
| network | `network_start:1466` `Network+Fetch` + `bodyPreview 500:62` | `network-capture-debugger.ts` + `network-capture-web-request.ts` + `network-capture.ts` unified | BN's capture is solid `background.js:840`. MC adds webRequest fallback when debugger detached — **worth copying** |
| execute_js/inject | `execute_js:1231` `confirm`+`redactSecrets:796` `inject_script:1249` `storage.session` | `javascript.ts`, `inject-script.ts`, `userscript.ts` isolated world | BN's registry `background.js:1072` `injectedScripts Map` + `replayInjectedOnTab:1128` is cleaner. **Keep** |
| search | `search:1395` `SEARCH_URLS` + `pageSearchResults:436` | none (relies on navigate) | **BN lead — keep** |
| search_tabs | `search_tabs:1424` TF-IDF title/URL only | `search_tabs_content` vector over chunked page text | **Port MC's content-indexed search** (see §4.1) |
| cookies/history/bookmarks | file JSON `data/cookies/*.enc` + `server.js:34` `saveJson 0o600` | `chrome.cookies/bookmarks/history` native APIs + `storage-manager.ts` IndexedDB | BN's encrypted file store (`lib/security.js:96`) is portable; MC's native `chrome.history/bookmarks` is richer. **Add native fallback** behind flag |
| dialog/download | not handled | `dialog.ts`, `download.ts` | **Add** — 20-line handlers in `background.js` HANDLERS |
| perf/gif/console | not handled | `performance.ts` `chrome.debugger` trace, `gif-recorder.ts`+`gif-enhanced-renderer.ts` | **Add only if requested** — offscreen GIF encoder `entrypoints/offscreen/gif-encoder.ts` |
| semantic/vector | `lib/tfidf.js` | `semantic-similarity-engine.ts` + `vector-database.ts` + `wasm-simd` | **Flagship port** — §4.1 |

---

## 4. What to Steal — Prioritized Blueprint for an AI Agent

### P0 — No-Regret, Low Effort (<1 day, no deps)

#### P0.1 Unified `computer` parity + `fill` selector fallback
- **Why:** MC's `computer.ts` handles `ref`/`selector`/`coordinates` + screenshot auto-scale via `utils/screenshot-context.ts`. BN's `computer:1688` already has `action: click/type/fill/key/scroll/hover/wait/navigate/screenshot` but `fill` lacks selector→ref resolve.
- **Do:** In `brower-navigator/tools.js:661` `performClick`/`performType`, copy `targetOf:346` helper to resolve `ref`→`selector` then call `content.exec fillField`. Add `tools.js:738` `performHover` CDP path for coords. Touch `bridge.js:345` `unwrap()` to surface `BAD_REQUEST` for fillable check.
- **Verify:** `node --check tools.js` + `tools.js: cli` `click selector="#search" trusted=false` fallback path.

#### P0.2 Viewport + background tab + dialog/download handlers
- **Files:** `brower-navigator/extension/background.js:646` add `dialog.handle` (`chrome.debugger` `Page.handleJavaScriptDialog`), `download.handle` (`chrome.downloads`).
- **Ref donor:** `mcp-chrome/app/chrome-extension/entrypoints/background/tools/browser/dialog.ts`, `download.ts`, `common.ts` `navigateTool` `width/height/background` params.
- **Change:** Extend `bridge.nav.goto` to accept `width/height/background` and pass to `hNavGoto: concrete` via `chrome.tabs.update` + `chrome.windows.update`. BN already has `tabs open active:false:1367`.

#### P0.3 Streamable HTTP as second transport (optional)
- **Why:** BN is stdio+WS only `server.js:57`. Many clients (CherryStudio, OpenCode) prefer `http://127.0.0.1:12306/mcp` `README.md:98` of MC. Adding Fastify is heavy; add a tiny `node:http` SSE bridge instead.
- **Do:** Create `brower-navigator/http-server.js` (30 lines, no new deps) that re-uses `bridge.call` — mirror `mcp-chrome/app/native-server/src/server/index.ts`. Keep WS primary, HTTP opt-in via `BROWSER_NAV_HTTP_PORT=12306`. Don't touch `ws-server.js:30`.
- **Ref:** `mcp-chrome/app/native-server/src/mcp/mcp-server.ts:10` split `getMcpServer()` from transport.

### P1 — High Impact, Medium Effort (2-4 days) — RECOMMENDED FLAGSHIP

#### P1.1 Semantic `search_tabs_content` (content-indexed vector search)
MCP-chrome's crown jewel `docs/ARCHITECTURE.md:160` AI flow `content → chunker → embeddings → HNSW`. BN's `search_tabs:1427` only sees titles `tools.js:1434` `tokenize(title+url)`.

**Donor files to read:**
- `mcp-chrome/app/chrome-extension/utils/text-chunker.ts`
- `mcp-chrome/app/chrome-extension/utils/vector-database.ts` (HNSW `hnswlib-wasm-static:0.8.5` `package.json:35`)
- `mcp-chrome/app/chrome-extension/utils/semantic-similarity-engine.ts` (`@xenova/transformers:2.17` `package.json:30`)
- `mcp-chrome/app/chrome-extension/utils/content-indexer.ts`, `model-cache-manager.ts`, `lru-cache.ts`, `indexeddb-client.ts`
- `mcp-chrome/app/chrome-extension/entrypoints/offscreen/main.ts` + `utils/offscreen-manager.ts`
- `mcp-chrome/app/chrome-extension/entrypoints/background/tools/browser/vector-search.ts`

**Porting recipe that preserves BN minimalism:**

1. **Create** `brower-navigator/extension/offscreen.html` + `extension/offscreen.js` (copy MC's offscreen doc skeleton, strip Vue). Offscreen hosts `Transformers.js` + `hnswlib-wasm` so SW stays lean.
2. **Create** `brower-navigator/lib/vector-store.js` — thin JS port of `vector-database.ts` (use `hnswlib-wasm` CDN or `npm i hnswlib-wasm-static`). Keep BN's `CONTENT_DIR data/` for persistence or use IndexedDB like MC.
3. **Create** `brower-navigator/extension/content-indexer.js` — reuse BN's `content.js:237` `extractVisibleText(limit)` harvesting, then chunk (1000 chars, 200 overlap like MC's `text-chunker.ts`). Send chunks via `chrome.runtime.sendMessage` to offscreen for embedding.
4. **Modify** `brower-navigator/bridge.js` add `content.extract` → `cs.eval pageExtract` already there; add `vector.search` op. New handler `vector.search` in `extension/background.js:646` dispatches to offscreen via `chrome.offscreen` message.
5. **Modify** `brower-navigator/tools.js` add tool `search_tabs_content` alongside existing `search_tabs:1423`. Keep TF-IDF as fallback when `vectorStore.ready===false`. Return same shape as MC `docs/TOOLS.md:273` `{matchedTabsCount, vectorSearchEnabled, matchedTabs:[{semanticScore, matchedSnippets}]}`.
6. **Feature-flag** via `VECTOR_SEARCH=1` env / `chrome.storage.local vectorEnabled`. Lazy-load: only `offscreen.createDocument` when first search runs (`utils/offscreen-manager.ts` pattern).
7. **Deps:** `npm i @xenova/transformers hnswlib-wasm-static` (or `hnswlib-wasm` like MC). Pin `transformers ^2.17` to avoid breaking. Optional: keep Rust SIMD out until P1.2.

**Why not copy verbatim:** MC's engine supports 3 models `BGE/E5/USE` `ARCHITECTURE.md:192` + `lru-cache` — start with one (`Xenova/bge-small-en-v1.5` quantized) and add others later.

**Test:** Index 5 tabs `tools.js: await bridge.content.exec(tabId,"extractVisibleText",{limit:50000})` → embed → query "machine learning" returns `semanticScore>0.7` like `docs/TOOLS.md:289`.

#### P1.2 SIMD WASM (only if you do P1.1)
- **Donor:** `mcp-chrome/packages/wasm-simd/src/lib.rs:245` (`cosine_similarity`, `batch_similarity`, `similarity_matrix` with `wide::f32x4`), `utils/simd-math-engine.ts`, `app/chrome-extension/wxt.config.ts:118` `wasm-unsafe-eval`.
- **Do:** Build once `wasm-pack build --target web` → copy `simd_math_bg.wasm` to `brower-navigator/extension/wasm/`. BN's `tools.js` can call it from offscreen for `batch_similarity` — MC shows 4-8x speedup `README.md:35`. Skip if TF-IDF stays.
- **Cost:** Adds Rust toolchain + `wxt` build step. Keep behind `SIMD=1`.

### P2 — Nice to Have, Higher Effort (1-2 weeks)

#### P2.1 Web Editor (Visual CSS) — the 2025/12/30 highlight `mcp-chrome/docs/VisualEditor.md:1`
- **Donor:** `mcp-chrome/app/chrome-extension/entrypoints/web-editor-v2/{core/editor.ts, core/transaction-manager.ts, core/design-tokens/, selection/selection-engine.ts, ui/property-panel/}` + `entrypoints/background/web-editor/index.ts`.
- **Value:** Drag to resize, visual Flex/Grid, live Vue/React props (`props-bridge.ts`), "click element + prompt Claude" `Point, Click & Prompt`.
- **Lightweight port for BN:** Don't copy full `web-editor-v2` (Vue/ELKjs/gifs). Instead:
  1. Create `brower-navigator/extension/web-editor.js` content script that injects a shadow-DOM toolbar (copy `shadow-host.ts` idea).
  2. Reuse BN's `injected.js:820` MAIN-world bridge to apply CSS via `CSSStyleSheet` edits and report back `mutation` diffs.
  3. New tool `web_editor_toggle` → `bridge` op `webEditor.toggle` like MC's `toggle_web_editor Ctrl+Shift+O` `wxt.config.ts:91`.
  4. Persist edits as `injected.register("web-editor-patch", code)` so they survive navigations `background.js:1128`.
- **Keep BN simple:** Start with 3 actions: `resize (width/height/fontSize)`, `css prop (margin/padding/background)`, `inspect props`. Leave React/Vue prop live-edit for v2.

#### P2.2 Record-Replay V3
- **Donor:** `mcp-chrome/app/chrome-extension/entrypoints/background/record-replay-v3/bootstrap.ts:16` + `common/rr-v3-keepalive-protocol.ts` + `shared/rr-graph.ts` + `packages/shared/src/step-types.ts` + offscreen `rr-keepalive.ts`.
- **BN fit:** BN already replays `injectedScripts` on `tabs.onUpdated loading` `background.js:1017`. Add:
  1. `record.start/stop` ops using `content.js` capture `click/type/scroll` listeners (like MC's `rr-utils.ts` + `selector-engine.ts`).
  2. Store as `data/workflows/*.json` with MC's `rr-graph` shape for later `replay`. New tools `record_start, record_stop, replay_workflow` mirroring `mcp-chrome/app/chrome-extension/entrypoints/background/tools/record-replay.ts`.
  3. **Scope:** V1 recorder (DOM events) first; V3's `keepalive` + `debugger` tracing second.

#### P2.3 SidePanel + Quick Panel + Agent Bridge (only if you need in-browser LLM)
- **Donor:** `mcp-chrome/app/chrome-extension/entrypoints/sidepanel/` + `shared/quick-panel/` (`core/agent-bridge.ts`, `ui/ai-chat-panel.ts`, `core/search-engine.ts`) + `entrypoints/background/quick-panel/*` + `native-server/src/agent/*` (chat/stream/project).
- **BN alternative:** BN's `dashboard.html` already is control center. Instead of full MCP agent server (Fastify+drizzle+better-sqlite3), add a minimal `quick-panel.content.ts` shadow UI that calls `bridge.http.request` to your LLM endpoint. Saves ~2000 LOC of `agent/*`.

---

## 5. What NOT to Steal (Protect BN's Strengths)

- **Don't import `wxt`+`Vue`+`tailwind` build chain** unless you need SidePanel. BN's vanilla `background.js` + `content.js` is debuggable with `node --check` `package.json:11` `syntax`. Keep `manifest.json:51` minimal.
- **Don't replace `ws-server.js` with Fastify.** BN's `ws-server.js:209` single-client eviction `CLOSE_SUPERSEDED 4002`, `HELLO_TIMEOUT 3s:76`, `badFrames>10` guard is *more secure* than MC's native host. Add HTTP as *sidecar*, not replacement.
- **Don't duplicate `lib/security.js` + `background.js:5 guards`.** BN already syncs `BLOCKED_CIDRS` `lib/security.js:30` vs `background.js:225` `ALLOW_SCHEMES`. Keep one source of truth.
- **Don't force `pnpm` or monorepo.** BN's `package.json:5` `type:module` + 3 deps is its superpower for auditability.

---

## 6. Concrete Next Steps for the Agent (Copy-Paste Checklist)

```bash
# 1. Baseline
cd ~/Videos/mcps/brower-navigator
npm run syntax  # tools.js: node --check all files
node test.cjs    # 63 assertions README:178

# 2. P0 quick wins (no new deps)
# - edit tools.js:661 performClick -> add ref→selector path like bridge.dom targetOf:346
# - edit bridge.js: add background.js HANDLERS dialog/download (copy from MC dialog.ts/download.ts)
# - test: click with ref_N, type with scope, dialog dismiss

# 3. P1 vector search (feature-flagged)
npm i @xenova/transformers hnswlib-wasm-static
mkdir -p extension/offscreen extension/wasm lib/vector
# copy donors (read first):
#   ~/Videos/mcps/mcp-chrome/app/chrome-extension/utils/text-chunker.ts -> lib/vector/chunker.js
#   ~/Videos/mcps/mcp-chrome/app/chrome-extension/utils/vector-database.ts -> lib/vector/store.js
#   ~/Videos/mcps/mcp-chrome/app/chrome-extension/utils/semantic-similarity-engine.ts -> extension/offscreen.js (trim to 1 model)
# add op vector.search in extension/background.js:646 HANDLERS
# add tool search_tabs_content in tools.js:1781 registerTools after search_tabs

# 4. Verify
node --check lib/vector/*.js extension/offscreen.js
# manual: navigate to 3 docs, run search_tabs_content query="authentication" -> expect matchedTabs[].semanticScore
# fallback: VECTOR_SEARCH=0 -> search_tabs TF-IDF still works

# 5. P1.2 SIMD (optional, needs Rust)
# cargo new packages/wasm-simd --lib (copy mcp-chrome/packages/wasm-simd/src/lib.rs:245)
# wasm-pack build --target web && cp pkg/*.wasm extension/wasm/
```

---

## 7. File-Level Donor Map (Where to Read in mcp-chrome)

| Want | Read in `~/Videos/mcps/mcp-chrome` |
|---|---|
| Overall arch | `docs/ARCHITECTURE.md:26` diagram + `README.md:47` comparison table |
| Tool impl pattern | `app/chrome-extension/entrypoints/background/tools/base-browser.ts:10` + `.../browser/computer.ts` + `common/tool-handler.ts:24` |
| Vector search | `.../tools/browser/vector-search.ts` + `utils/vector-database.ts` + `utils/semantic-similarity-engine.ts` + `utils/text-chunker.ts` + `utils/content-indexer.ts` + `entrypoints/offscreen/main.ts` |
| SIMD | `packages/wasm-simd/src/lib.rs:13` + `utils/simd-math-engine.ts` + `app/chrome-extension/utils/output-sanitizer.ts` |
| Web Editor | `docs/VisualEditor.md:1` + `entrypoints/web-editor-v2/core/editor.ts` + `.../core/transaction-manager.ts` + `.../ui/property-panel/*` + `entrypoints/background/web-editor/index.ts` |
| Record-Replay | `entrypoints/background/record-replay-v3/bootstrap.ts:16` + `common/rr-v3-keepalive-protocol.ts` + `packages/shared/src/rr-graph.ts` |
| Agent/Stream | `app/native-server/src/agent/chat-service.ts` + `stream-manager.ts` + `server/routes/agent.ts:1264` + `engines/claude.ts` |
| Tool schemas | `packages/shared/src/tools.ts` (add `streamableHttp` + `mcp-server` naming) |
| Performance | `docs/ARCHITECTURE.md:232` SIMD code + Memory/Workers `docs/ARCHITECTURE.md:268` |

---

## 8. Why `mcp-chrome` Is Slower — Measured 2026-09-01

Live test on same Brave profile (`http://127.0.0.1:9222` + `ws://127.0.0.1:9224`, `node:32550`):

* `brower-navigator` CDP direct: `Page.loadEventFired 816ms` warm / `1765ms` cold, `TYPE 19ms`, `POST 2555ms`, `DELETE 3194ms`, **`FLOW comment+delete 6832ms (6.8s)`**, `WALL 11.2s`. Earlier harness `TOTAL 6852ms (6.9s)` included `3s` SPA sleep.
* `mcp-chrome` `dist/` missing (`ls: cannot access .../native-server/dist`) so not live-measured, but code path adds **+1.5–3s** per tool batch (see below). Extrapolated `mcp-chrome` same task ≈ `8.5–10s` wall.

### 8.1 Transport: 3 hops vs 1

| | `brower-navigator` | `mcp-chrome` |
|---|---|---|
| Path | `MCP stdio → ws-server.js:30` `WebSocketServer 127.0.0.1:9224` → `extension/background.js:376` `HANDLERS:646` (1 `ws.send(JSON.stringify(env))` `bridge.js:134`) | `MCP StreamableHTTP/SSE → Fastify → nativeMessaging (stdin 4-byte LE header) → chrome.runtime.connectNative → Port.onMessage` (`app/native-server/src/server/index.ts:44`, `native-messaging-host.ts:31` `stdin.on(readable):78`, `sendRequestToExtensionAndWait:193` `UUID+pendingRequests Map:207` + `stdout.write header+body:283`) |
| Cost | 0 framework, `HELLO_TIMEOUT 3s:76` `hb 15s:54` only | `Fastify({logger})` `server/index.ts:55` + `cors:73` regex `CORS_ORIGIN:80` + `transportsMap:49` `StreamableHTTPServerTransport:224` `randomUUID:223` `/mcp` POST/GET/DELETE `214/256/289` hijack + `AgentStreamManager/ChatService:56` even when unused |

### 8.2 SW wake tax

`mcp-chrome/entrypoints/background/index.ts:28` boots **8 subsystems every SW wake**: `initNativeHostListener:40` + `initSemanticSimilarityListener:41` + `initializeSemanticEngineIfCached:69` (`chrome.storage.local STORAGE_KEYS.SEMANTIC_MODEL` + `ModelCacheManager.hasAnyValidCache`) + `bootstrapV3:48` `ENABLE_RR_V3=true:22` + `initElementMarker:58` + `initWebEditor:60` + `QuickPanel×3:62` + `cleanupModelCache:84`. Each does async `storage.local.get` / `IndexedDB`.

`brower-navigator/background.js` only runs `connectLoop` `RECONNECT_BASE 500ms:56` `cap 15s` + `HB 15s:54`.

### 8.3 Per-tool ping + framing

`mcp-chrome/tools/base-browser.ts:5` `PING_TIMEOUT_MS=300` `Promise.race(tabs.sendMessage ping, 300ms):30` on **every** `injectContentScript:17` even if already injected → `+0–300ms` per `click/type/screenshot`. Plus `native-messaging-host.ts:43` `readUInt32LE` + `MAX_MESSAGE_SIZE 16MB:35` framing + `TIMEOUTS.EXTENSION_REQUEST_TIMEOUT:143`.

`brower-navigator/bridge.js:134` `call()` no ping, direct `cs.eval:557` / `content.exec:919` via `scripting.executeScript:67`.

### 8.4 Semantic/keepalive overhead

`mcp-chrome/utils/semantic-similarity-engine.ts:1211` `_doInitialize` does `isWorkerSupported:815` + `isInOffscreen:832` + `ensureOffscreenDocument:848` + `AutoTokenizer.from_pretrained:1344` + `getCachedModelData:16` fetch `116MB multilingual-e5-small:149` + `SIMDMathEngine.checkSIMDSupport:1400` even when idle if cache exists. `native-host.ts:149` `acquireKeepalive('native-host')` + `ensureNativeConnected:284` `ensurePromise` gate + `getReconnectDelayMs:115` `500*2^n→60s` + `withJitter:106` on every `onDisconnect:440`.

`brower-navigator` TF-IDF `lib/tfidf.js:53` is sync in-process, no model.

### 8.5 Focus serialization

`mcp-chrome/base-browser.ts:139` `ensureFocus` `await windows.update:146` **then** `await tabs.update:149` sequential.

`brower-navigator/background.js:1382` `hTabActivate` `tabs.update` + `windows.update .catch(()=>{})` fire-and-forget.

### 8.6 Bundle

`mcp-chrome/wxt.config.ts:18` WXT+Vue+Tailwind+`elkjs`+`markstream-vue` + `web-editor-v2` 10k LOC → SW parse `>200ms`. `brower-navigator/manifest.json:51` 6 perms vanilla JS `background.js:1987`.

### 8.7 What to fix if you want `mcp-chrome` speed ≈ BN

1. Make `PING_TIMEOUT` cached (remember `pong` per `tabId:name`, skip race on hit) — saves `~200ms` avg.
2. Make `Fastify + nativeHost` optional sidecar; default to WS like `brower-navigator` (`DIFF.md:P0.3`).
3. Lazy-init `semanticSimilarity` only on first `search_tabs_content` (gate `initializeSemanticEngineIfCached:69` behind flag).
4. Remove `acquireKeepalive` when `autoConnectEnabled=false` (`native-host.ts:146`), and parallelize `ensureFocus`.

## 9. Risks & Mitigations

- **Model download size** (`transformers` ~30-80MB per model): cache under `data/models/` like MC `wxt.config.ts:102` `web_accessible_resources /models/*`, lazy-load only on first `search_tabs_content`.
- **Offscreen lifecycle** (MV3 SW kills): mirror MC `utils/offscreen-manager.ts` keepalive `SW_KEEPALIVE_MS 20s:59` + `chrome.offscreen.createDocument` guard.
- **Debugger infobar spam** (`debugger` perm): MC's `cdp-session-manager.ts` refcounts `acquireDebugger:728` — BN already does `dbgTabs Map:725` + `ALLOW_CDP_METHODS:704`. Reuse that for vector search? No — vector search needs no debugger.
- **License drift**: MC MIT `LICENSE` vs BN PolyForm `README.md:186` — if you copy >10 lines, keep BN header and add `Ported from mcp-chrome (MIT) — see mcp-chrome/LICENSE`.

---

## 10. Exhaustive Diff — 20 Things We Glossed Over (You’re Right, It’s a Lot)

You’re right — §1–§8 focused on perf/arch but skipped half the repo differences. Full sweep `408` vs `14` entrypoints, `17` vs `6` perms, `175` vs `11` storage hits, `15` vs `3` deps:

| # | Category | `brower-navigator` (`browser-navigator-mcp@2.0.3`) | `mcp-chrome` (`mcp-chrome-bridge@1.0.29` + `chrome-mcp-server@1.0.0` monorepo) | Why It Matters |
|---|---|---|---|---|
| 1 | **Monorepo** | Single `package.json:5` `type:module`, `node_modules 95 dirs` | `pnpm-workspace.yaml:1` `app/*` + `packages/*` (`native-server`, `chrome-extension`, `shared`, `wasm-simd`), `pnpm-config enable-pre-post-scripts:74` `README.md:74`, `husky prepare:25` | BN audit in 2 min; MC needs `pnpm -r build:14` + Rust |
| 2 | **Build** | No build: `npm run syntax:11` `node --check $f` | `wxt build` + `vue-tsc` + `vite-plugin-static-copy:136` + `wasm-pack` `copy:wasm:13` `vite target es2015 sourcemap:160` | MC build fails if WASM missing; BN `node index.js` just works |
| 3 | **Deps heavy** | `3` deps `sdk@^1.0.0 ws@^8.21.3 zod@^3.22.0` `package.json:14` | `native-server:15` deps `fastify@5 pino better-sqlite3 drizzle-orm @anthropic-ai/claude-agent-sdk commander chrome-devtools-frontend is-admin node-fetch` + `chrome-extension:14` deps `vue@3 @vue-flow/* elkjs @xenova/transformers hnswlib-wasm gifenc` + `devDeps 15+14` `wxt tailwind unplugin-icons vitest jest husky` | BN `install 2s`; MC `install 60s + 50MB Playwright removal saved:205` |
| 4 | **Manifest perms** | `6` `tabs windows scripting debugger cookies storage` `manifest.json:11` | `17` `nativeMessaging tabs activeTab scripting contextMenus downloads webRequest webNavigation debugger history bookmarks offscreen storage declarativeNetRequest alarms sidePanel` `wxt.config.ts:40` | MC can touch `history/bookmarks/downloads/contextMenus/alarms`; BN deliberately removed `history:59` `downloads:57` `bookmarks:58` for file-store simplicity `EXTENSION-PLAN.md:58` |
| 5 | **Manifest features** | `content_scripts http* + https* all_frames:19` `options_page dashboard.html:45` | `default_locale zh_CN:37` `key:36` `options_ui open_in_tab:62` `action default_popup:64` + `side_panel default_path sidepanel.html:71` + `commands toggle_web_editor 91 toggle_quick_panel 95` + `web_accessible_resources /models/* /workers/* /inject-scripts/*:100` + `CSP require-corp:115` `wasm-unsafe-eval:119` | MC has i18n, sidepanel, commands, CSP hardening; BN has none |
| 6 | **Entrypoints / files** | `14` files `extension/*` + `lib/*` `7244 LOC` | `408` files under `entrypoints/` alone, `29` tools `background/tools/browser:29` + `shared/quick-panel` + `web-editor-v2` + `sidepanel/ popup/ options/ builder/ offscreen/` | BN you read in 1h; MC you grep |
| 7 | **Extension pages** | `popup.html 112 + popup.js 206` (380px) + `dashboard.html 209 + dashboard.js 358` 6 tabs | `popup/` Vue + `sidepanel/` workflow + `options/` + `builder/` `@vue-flow` graph + `welcome.html` `onInstalled:30` `chrome.tabs.create welcome:33` | MC has first-run onboarding; BN jumps straight to dashboard |
| 8 | **i18n** | None | `_locales/{en,de,ja,ko,zh_CN,zh_TW}/messages.json` `wxt.config.ts:37` `__MSG_extensionName__` | MC ships 6 languages |
| 9 | **Tool naming** | terse `connect_brave, navigate, click, type, press_key, list_elements, inspect_dom` `tools.js:825` `server.tool("...")` | `chrome_` prefix `packages/shared/src/tools.ts:43` `chrome_navigate chrome_screenshot chrome_close_tabs chrome_click_element chrome_fill_or_select` | BN easier for LLM; MC namespaced but verbose |
| 10 | **Tool count gap (detail)** | `41` inc `video_control:1377` `detect_captcha:1361` `wait_for_captcha:1370` `search:1395` 9 platforms `SEARCH_URLS:1396` `cookies export/import:1512` encrypted | `~30` inc `gif-recorder:30` `performance trace:29` `console-buffer:4` `file-upload:19` `download.ts dialog.ts userscript.ts` `window.ts` viewport | BN owns media/captcha/search; MC owns gif/perf/console |
| 11 | **Storage** | `data/{cookies,bookmarks,history,screenshots}/` JSON `server.js:34` `saveJson 0o600` `mkdir 0o700` `browsingHistory 5000:39` | `chrome.storage.local` + `IndexedDB` `utils/indexeddb-client.ts` + `storage-manager.ts` + `better-sqlite3` `drizzle-orm` `agent/db/schema.ts:13` `projects/sessions/messages` `0o600?` + `file-handler.ts` | MC has SQL + migrations; BN survives without DB file |
| 12 | **Agent / DB** | None | `native-server/src/agent/*` `project-service.ts` `session-service.ts` `message-service.ts` `storage.ts` `directory-picker.ts` `open-project.ts` `attachment-service.ts` `stream-manager.ts` `chat-service.ts` `engines/claude.ts codex.ts` + `server/routes/agent.ts:1264` `projects/sessions/chat/stream/cancel/attachments/open` `50MB bodyLimit:1014` | MC can host Claude/Codex in-browser; BN has no agent |
| 13 | **Network capture** | `background.js:840` `Network+Fetch` `bodyPreview 500:62` `includeStatic:41` | `network-capture-debugger.ts` + `network-capture-web-request.ts` + `network-capture.ts` unified + `webRequest + debugger` fallback `TIMEOUTS.NET_STOP 15s:32` | MC fallback when infobar dismissed |
| 14 | **Security surface** | `lib/security.js:113` `AES-256-GCM + scrypt` `BLOCKED_HOSTS 169.254...` `BLOCKED_CIDRS 10/8 127/8 ...` `assertSafeUrl:83` + `background.js:224` `BLOCKED_CIDRS` + `ws-server.js:136` `BROWSER_NAV_TOKEN + origin chrome-extension://:146` | `common/constants.ts` `ERROR_MESSAGES` + `declarativeNetRequest` + `CSP require-corp:115` + `cross_origin_opener_policy same-origin` + `is-admin` check | Both have SSRF guards; MC adds enterprise CSP |
| 15 | **Tests / CI** | `test.cjs:2277` `63` assertions over `stdio` `README.md:178` `node test.cjs` | `vitest` `chrome-extension:22` + `jest` `native-server:14` `server.test.ts` `supertest` + `husky pre-commit:74` `commitlint config-conventional:2` `lint-staged 15.5:44` `eslint 9 + typescript-eslint` `prettier 3` | MC has `pnpm -r lint typecheck` gate; BN `syntax` only |
| 16 | **Docs** | `7` MD `README AGENT AUDIT EXTENSION-PLAN NOTES SCENARIOS DIFF` `~14074 AUDIT:2` | `15` MD `docs/ARCHITECTURE.md:308 TOOLS.md:599 VisualEditor.md CONTRIBUTING TROUBLESHOOTING WINDOWS_INSTALL CHANGELOG mcp-cli-config` × `zh` | MC has bilingual docs + `prompt/` |
| 17 | **Publish** | Not published (git clone + `node index.js`) | `mcp-chrome-bridge` `npm: npm install -g mcp-chrome-bridge:66` `bin chrome-mcp-bridge:8` `postinstall register:20` `files dist:22` `preferGlobal:true` | MC has `install-native-host.sh` + `register-dev.ts` |
| 18 | **Language / types** | Vanilla JS `bridge.js:595` `server.js:60` | TypeScript `5.8` `tsconfig` `vue-tsc` `types/chrome@0.0.318` `types/node@22` strict | MC type-safe; BN `node --check` only |
| 19 | **Perf gifts** | None (we measured `6.8s`) | `wasm-simd/src/lib.rs:13` `wide::f32x4` `cosine:45 batch:97 matrix:183` 4-8x, `lru-cache.ts` + `text-chunker.ts` + `offscreen-manager.ts` | MC faster on vector search once loaded |
| 20 | **Typo / branding** | Folder `brower-navigator` (typo) but `package name browser-navigator-mcp:2` `README title Browser Navigator MCP` | Correct `mcp-chrome` `chrome-mcp-server` `chrome-mcp-shared` `BUILD.md` consistent | BN typo confuses `require("brower-navigator")` |

> **Bottom line:** BN chose *boring JS, file-store, 3 deps, 6 perms* to stay runnable on any laptop. MC chose *enterprise TypeScript, SQL, WASM, 17 perms, 408 entrypoints* to ship VisualEditor/SidePanel/Agent workflows. If you want BN to stay BN, only steal §4 P0–P1 behind flags; if you want MC features, you pay MC’s complexity tax.

---

## 11. Appendix A — Complete File Map (LOC) for Downstream AI

*Generated 2026-09-01 via `wc -l` + subagents; paths absolute for copy-paste.*

### BN (`brower-navigator` 7650 LOC core + 364 data JSON)

| File | LOC | Role |
|---|---|---|
| `bridge.js:595` | 595 | `call()/pending/Map` `RefMap ref_N` `tabs/windows/nav/dbg/net/cookies/injected/http/content/captcha/dom` facades `dom.eval:556` `dom.waitFor:590` |
| `server.js:60` | 60 | `McpServer(name:browser-navigator v2.0.0)` + `StdioServerTransport` + `startWsServer(9224)` `loadJson/saveJson 0o600/0o700:24` |
| `index.js:14` | 14 | `mkdirSync data/{cookies,bookmarks,history,screenshots} 0o700` `main().catch` |
| `ws-server.js:209` | 209 | `WebSocketServer 127.0.0.1:9224 maxPayload 1<<20:31` `hello timeout 4001:72` `HB 15s/30s:18` `handleHello token+origin:137` `welcome uuid:163` `evict 4002:174` |
| `tools.js:1781` | 1781 | `registerTools 41 tools:571` `pageSide fns 23-565` `performClick:661 performType:711 performHover:741 capturePng:762 exportPdf:781` |
| `extension/background.js:1987` | 1987 | §1-§15 `HANDLERS 25:646` `dbgTabs Map 725` `ALLOWED_CDP 23:704` `netCapture 840` `injected 1076` `scheduleReconnect 432` `HB 549` |
| `extension/content.js:955` | 955 | `OPS 14:918` `extractVisibleText:237` `detectCaptcha:285` `listInteractive:348` `clickElement:458 jsClicked` `fillField:615 native setter` |
| `extension/injected.js:820` | 820 | `MAIN world CustomEvent mcp-inject:<name> nonce:1151` `CAPTCHA_SIGNATURES 9:347` `video pickVideo:442` |
| `extension/dashboard.js:349` | 349 | 6 tabs overview/browser/tools/captures/settings/logs |
| `extension/popup.js:213` | 213 | `chrome.tabs.query` + `waiting/connected` `uiStatus` |
| `lib/proto.js:95` | 95 | `PROTOCOL_VERSION 1:16` `ERROR_CODES 16:1-95` `makeReq/Res/Evt uuid validateEnvelope 1MiB` |
| `lib/security.js:113` | 113 | `ALLOWED_SCHEMES http https data blob:20` `BLOCKED_HOSTS 7:22` `BLOCKED_CIDRS 9:30` `assertSafeUrl:83` `AES-256-GCM:96` |
| `lib/tfidf.js:53` | 53 | `tokenize termFreq idf cosineSimilarity` TF-IDF `search_tabs:1424` |
| `data/history/history.json:349` | 349 | `[{url,title,tabId,timestamp}]` capped `5000:39` |
| **Total** | **7650** | `wc -l` validated; add `launch-brave.sh:35` `start.sh:10` |

### MC (`mcp-chrome` 149770 LOC TS+RS, `entrypoints/background/**/*.ts` 44840 LOC)

| File | LOC | Role |
|---|---|---|
| `app/chrome-extension/entrypoints/background/index.ts:87` | 87 | `defineBackground` 8 inits `40-66` + `RR_V3 bootstrapV3:47` |
| `app/chrome-extension/entrypoints/background/native-host.ts:627` | 627 | `connectNativeHost:338` `ensureNativeConnected:284` `scheduleReconnect 500*2^n:233` `keepalive syncHold:146` |
| `app/chrome-extension/entrypoints/background/keepalive-manager.ts:87` | 87 | singleton `acquireKeepalive` |
| `app/chrome-extension/entrypoints/background/record-replay-v3/bootstrap.ts:469` | 469 | `storage→events→ownerId→lease→runner→keepalive→plugins→scheduler→triggers→rpc→recoverFromCrash→start:280-415` |
| `app/chrome-extension/entrypoints/background/record-replay-v3/engine/transport/rpc-server.ts:1168` | 1168 | `rr_v3.*` methods |
| `app/chrome-extension/entrypoints/background/record-replay-v3/storage/db.ts:231` | 231 | `rr_v3` IndexedDB `6 stores:15` |
| `app/chrome-extension/utils/semantic-similarity-engine.ts:2388` | 2388 | `Xenova transformers 116MB:147` `Proxy 459` + `Engine 771` `Worker chrome.runtime.getURL workers/similarity.worker.js:992` |
| `app/chrome-extension/utils/vector-database.ts:1501` | 1501 | `hnswlib-wasm 100k*384*4=146MB:207` `HierarchicalNSW cosine:253` |
| `app/native-server/src/native-messaging-host.ts:334` | 334 | `stdin LE 4B:43` `pendingRequests UUID:199` `stdout header+body:283` |
| `app/native-server/src/server/index.ts:366` | 366 | `Fastify CORS:72` `/mcp SSE:167` `/ask-extension:124` |
| `app/native-server/src/server/routes/agent.ts:1264` | 1264 | `projects/sessions/chat/stream 50MB:1014` |
| `app/native-server/src/agent/db/client.ts:232` | 232 | `better-sqlite3 WAL:194` `CREATE TABLE projects/sessions/messages:51` |
| `packages/wasm-simd/src/lib.rs:245` | 245 | `wide::f32x4` `cosine:45 batch:97 matrix:183` `opt-level=3 lto:20` |
| `wxt.config.ts:172` | 172 | `permissions 17:40` `side_panel:71` `CSP wasm-unsafe-eval:119` |
| **Build output** | `~8-12MB zip` | `dist/chrome-mv3` 2.1MB JS + 31.6MB ORT wasm + locales |

*Cite `file:line` above for every downstream edit.*

---

## 12. Appendix B — Tool-by-Tool Exhaustive Table (Subagent Synthesis)

*Full diff: `A/packages/shared/src/tools.ts:43` (`TOOL_NAMES chrome_…`) vs `B/tools.js:571` (`server.tool 41`). Key rows; see `DIFF.md:60` gap table for terse version.*

| Category | MC tool `shared/tools.ts` | BN tool `tools.js` | MC params `tools.ts:…` | BN params `tools.js:…` | Port effort |
|---|---|---|---|---|---|
| navigate | `chrome_navigate:7` `398-446` `url newWindow width height refresh tabId background` | `navigate:852` `url wait_until timeout_ms tab_id background` + `navigate_history:887` `direction steps 1-50` | MC has `newWindow` + `back/forward` via `common.ts:99 url==back` | BN has `wait_until networkidle` + `steps>1` `history.go(delta):893` | MC→BN medium (add `newWindow/w/h/refresh`), BN→MC trivial (loop `goBack`) |
| tabs | `get_windows_and_tabs:5` `{}` + `chrome_close_tabs:9` `tabIds url` + `chrome_switch_tab:10` `tabId windowId` (`common.ts:444,634` `window.ts:5`) | `tabs:1298` `action list/open/switch/close/info` `url tab_id window_id active background` (`bridge tabs:248`) | MC `url wildcard pathname/*:465` bulk close | BN `open active:false:1314` `setCurrentTab:1323` | MC bulk+wildcard →BN trivial; BN unified CRUD →MC medium |
| windows | `window.ts:5` read-only via `windows.getAll populate:true:9` | `windows:1339` `list/focus/close` + `health:1759` `wins/tabs` (`bridge windows:256`) | MC none | BN `focus` `close` | BN focus/close →MC trivial (`windows.update/remove`) |
| read_page | `chrome_read_page:161` `filter depth refId tabId windowId` `read-page.ts:22` `accessibility-tree-helper.js:64` | `read_page:1013` `filter interactive/all max_refs 10-1000` `Accessibility.getFullAXTree:1019` + `pageCollectCandidates 222` `bridge refMap 201` | MC `depth` subtree + `refId` + `sparse fallback <10 lines:101` | BN `max_refs:1109` + `ROLE_ALIASES 1099` dual AX+DOM fusion `1065` | depth/refId →BN medium; max_refs →MC trivial |
| list/inspect | `chrome_get_interactive_elements:15` `textQuery selector types includeCoordinates` `web-fetcher.ts:170` + `chrome_get_web_content:11` `url htmlContent selector` + `request_element_selection:14` human-in-loop | `list_elements:1132` `kind contains scope limit 1-500` + `inspect_dom:1198` `selector by_text scope max_depth include_html` → `pageInspectDeep 325` + `get_page_content:978` `format limit selector` | MC `includeCoordinates` + `request_element_selection` panel | BN `scopeSel:628` `image/heading` kinds `image/heading:1153` + `captcha:get_page_info 962` | BN scope/image →MC trivial; MC `request_element_selection` →BN heavy (panel) |
| click | `chrome_click_element:12` `868-936` `selector selectorType css|xpath ref coordinates double button modifiers waitForNavigation tabId frameId` `interaction.ts:32` | `click:901` `selector double_click button by_text scope ref trusted:true` `performClick 661` `pageClick 362` `elementFromPoint blocked` + `trusted dbg Input:690` + `pageClickCoords 23` | MC `xpath frameId waitForNavigation coordinates` | BN `by_text needle:366` `scope` `trusted` flag `isTrusted` vs `jsClicked` hint `content.js:504` | BN by_text/scope/trusted →MC medium; MC xpath/frameId →BN medium |
| fill/type | `chrome_fill_or_select:13` `938-977` `value string|num|bool selectorType ref frameId` `interaction.ts:172` | `type:918` `selector text delay delay_per_char scope ref` `performType 711` `pageTypeChars 44` `dom.fillField 382` `Object.getOwnPropertyDescriptor set:392` | MC typed boolean/num | BN `delay_per_char 0-1000` per-char `typeCharacter 605` | per-char →MC medium; selectorType →BN medium |
| keyboard | `chrome_keyboard:23` `1031-1070` `keys selectorType delay frameId` `keyboard.ts:17` | `press_key:943` `key times 1-100 selector` + `focus_element:933` `selector by_text scope` `pageFocus 90` `pagePressKey 109` `SPECIAL+mods 122` | MC single chords | BN split focus+press `times repeat` `parseKeyGroups 563` | BN focus/times →MC trivial; MC chords →BN trivial |
| scroll/hover | `chrome_computer:34` `scroll/scroll_to hover wait resize zoom` `computer.ts:847` | `scroll:952` `direction amount selector` + `hover:1675` `selector by_text ref x y` + `computer:1688` thin dispatcher `performScroll 736 performHover 741` | MC `triple_click left_click_drag fill_form resize_page Emulation` `computer.ts:222` | BN `x/y coords` `hover standalone` | BN x/y →MC trivial; MC drag/resize/zoom →BN heavy |
| screenshot | `chrome_screenshot:8` `448-488` `name selector tabId background width height storeBase64 fullPage savePng` `screenshot.ts:108` `stitch SCROLL_DELAY 350:13` | `screenshot:1214` `full_page selector save_path` + `computer screenshot` `capturePng 762` `clip pageRectOf 380` `resolveOut 642` | MC `storeBase64` + `stitch 50k height:13` + `screenshotContextManager scale:272` | BN `save_path` server file `0o600:773` | BN save_path →MC trivial; MC stitch/context →BN heavy |
| pdf | — | `pdf_export:1223` `save_path` `Page.printToPDF printBackground:782` | — | BN only | →MC medium (`Page.printToPDF` allowlist `background.js:704`) |
| network | `chrome_network_capture:16` `599-636` `action start/stop needResponseBody url maxCaptureTime inactivityTimeout includeStatic` + `chrome_network_request:19` `formData files base64` `network-capture.ts:72` | `network_start:1466` `max_time include_static` + `network_stop:1474` + `network_list peek:1479` + `network_request:1483` `method headers body timeout_ms` `bridge net 290 http 314` | MC `needResponseBody` fork `106` `formData` | BN `peek` | peek →MC trivial; needResponseBody/formData →BN medium |
| execute_js | `chrome_javascript:30` `838-865` `code tabId timeoutMs maxOutputBytes` `javascript.ts:403` `wrapUserCode IIFE:151` `Runtime.evaluate awaitPromise:231` + `output-sanitizer.ts:98` | `execute_js:1231` `code max20k confirm redact tab_id` `looksLikeFn async()=>:1242` `redactSecrets 796` | MC `timeout/maxOutputBytes` sanitizer | BN `confirm true` gate `1237` | confirm/redact →MC trivial; fallback metrics →BN medium |
| inject | `chrome_inject_script:28` + `chrome_send_command:29` + `chrome_userscript:37` `create/list/get/enable/disable/update/remove/send_command/export` `userscript.ts` | `inject_script:1249` `name regex 64 run_now` `injected.register:305` + `send_to_injected:1261` `injected.send:308` `replay 1128` | MC `world MAIN|ISOLATED matches excludes css persist` | BN `replaysOnNavigation:true` `CustomEvent mcp-inject:<name> nonce:1151` | BN name→MC trivial; MC userscript →BN heavy |
| wait | `chrome_computer wait duration text appear timeout` | `wait_for:1270` `selector text ref interval timeout` `dom.waitFor 590` `pageWaitFor MutationObserver 509` + `wait_for_load:1289` `until load` `nav.waitReady 269` | MC text `appear` | BN standalone + `interval_ms` | B standalone →MC trivial |
| search | `search_tabs_content:758` `query` vector `vector-search.ts` | `search:1407` `query platform region limit` `SEARCH_URLS 9:1396` `pageSearchResults 436 RULES 441` + `search_tabs:1424` `query limit` TF-IDF `tokenize 9` | MC semantic HNSW | BN SERP + TF-IDF substringHit +0.25:1456 | vector →BN heavy; SERP+TF-IDF →MC medium |
| cookies | — | `cookies:1496` `get/set/delete/clear/export/import` `cookies[] name value url domain path secure http_only same_site` `bridge cookies 300` `snapshotCookies 804` AES `lib/security.js:96` `0o600:814` | — | BN encrypted `iv:data:tag hex` `COOKIES_DIR` | →MC heavy (chrome.cookies + enc) |
| bookmarks | `chrome_bookmark_search:25` `query maxResults folderPath` + `add:26` `url title parentId createFolder` + `delete:27` `bookmarkId url` `bookmark.ts` | `bookmark_add:1597` `url title tags[]` + `delete:1619` `id/url` + `search:1631` `query tags limit` + `list:1654` `history_search:1658` `query hours limit` `data/history:349` | MC `folderPath` tree | BN `tags` flat + `hours` filter | tags↔folderPath mutual medium |
| history | `chrome_history:24` `text startTime endTime maxResults excludeCurrentTabs` `history.ts:57 parseDateString date-fns` | (BN history via above) | MC ISO `1 day ago` | BN `hours 1-168` | full Chrome history →BN heavy |
| dialog/download/upload | `chrome_handle_dialog:35` `accept|dismiss` `dialog.ts` + `handle_download:36` `filenameContains` `download.ts` + `chrome_upload_file:32` `fileUrl base64` `file-upload.ts` | — | MC CDP `Page.handleJavaScriptDialog` `downloads.search` `DOM.setFileInputFiles` | — | →BN medium-heavy |
| perf/gif/console | `performance_start/stop/analyze:38-40` `Tracing:220 categories` `gif_recorder:41` `auto_start capture 16` `gif-enhanced-renderer` + `chrome_console:31` `snapshot|buffer regex` `console.ts` | — | MC `Tracing.start:265` `getMetrics:346` | — | →BN heavy (Tracing + OffscreenCanvas) |
| video/captcha | — | `video_control:1377` 11 actions `pageVideoExtra 398` + `detect_captcha:1361` `wait_for_captcha:1370` `pageDetectCaptcha 458` iframe `recaptcha/hcaptcha` | — | BN `get_page_info captcha:970` | →MC trivial |
| computer | `chrome_computer:34` `195-318` **14 actions** `left|right|double|triple left_drag scroll type key fill fill_form hover wait resize zoom screenshot` `coordinates startCoordinates ref startRef scrollDirection text modifiers region selector value elements width height timeout` `computer.ts:222` `CDPHelper 81 scaleCoordinates 245 hostname guard 426` | `computer:1688` **12 actions** `click/double/right/move/type/fill/key/scroll/hover/wait/navigate/screenshot` `selector by_text ref text x y key url button` dispatcher `1687` | MC `triple drag fill_form resize Emulation zoom clip wait text` | BN `move navigate` flat `x/y` | MC →BN heavy; BN →MC trivial |

*For every row, open `file:line` listed to copy zod `z.string().url()` schema or `TOOL_NAMES` constant before adding BN tool.*

---

## 13. Appendix C — Security & Storage Matrix (Subagent Audit)

### Manifest / CSP

| | MC `wxt.config.ts:34-122` | BN `manifest.json:1-51` | Risk |
|---|---|---|---|
| Perms | 17 `nativeMessaging tabs activeTab scripting contextMenus downloads webRequest webNavigation debugger history bookmarks offscreen storage declarativeNetRequest alarms sidePanel:40` + `<all_urls>:59` | 6 `tabs windows scripting debugger cookies storage:11` + `<all_urls>:19` `all_frames:true:32` | MC wider attack surface; BN `cookies` reads all cookies |
| CSP | `IS_DEV ? {} : {COEP require-corp COOP same-origin CSP script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline' :112}` | none → MV3 default `script-src 'self'` | MC `wasm-unsafe-eval` needed for ORT/SIMD |
| WAR | `/models/* /workers/* /inject-scripts/* <all_urls>:100` expose 116MB ONNX | none | MC fingerprintable |

### SSRF

| | MC | BN `lib/security.js:20-93` + `background.js:216-332` |
|---|---|---|
| `ALLOWED_SCHEMES` | none | `http https data blob:20` server vs `http https` bg `216` → mismatch |
| `BLOCKED_HOSTS/CIDRS` | 0 hits — **CRITICAL** `file-handler.ts:81 fetch(fileUrl)` no guard | `BLOCKED_HOSTS 7:22` `BLOCKED_CIDRS 9:30` `ipv4ToInt:41 inBlockedCidrs:54 isBlockedInternalUrl:64` decimal `70` IPv6 `fe80/fc` |
| `assertSafeUrl` | none | `assertSafeUrl:83` used `tools.js:859 navigate 1306 tabs 1398 search 1491 network` + bg mirror `assertSafeNavUrl:296 allow about:blank` `assertSafeFetchUrl:317` |

### Cookies / History / Bookmarks

| | MC `history.ts:164 chrome.history.search` `bookmark.ts:46/98/181/297` native profile, `db/client.ts:168 mkdir` default `0o755` `agent.db 0o644` no enc | BN `server.js:24 mkdir 0o700 28 write 0o600` `index.js:9 dataDirs 0o700` `tools.js:653 773 788 814 write 0o600` `lib/security.js:6 COOKIE_ENCRYPTION_KEY 64hex or randomBytes 32:16` `AES-GCM iv16 tag:96` |
|---|---|---|

### Exec / Redact / CDP

| | MC `javascript.ts:221 Runtime.evaluate MAIN world 304 fallback ISOLATED:312` `output-sanitizer.ts:98` `sanitizeText:117` `JWT Bearer base64/hex bulk` `sanitizeValue 200 keys depth6` `truncate 50KB:311` no confirm | BN `bridge dom.eval ISOLATED:556` `redactSecrets 796` narrow `password|token` regex only, no confirm gate | Neither confirms; MC sanitizer broader |
|---|---|---|

### Screenshot / Path

| | MC `screenshot.ts:312 name.replace(/[^a-z0-9_-]/gi,'_')` + `downloads.download` + `attachment-service.ts:117 isValidFilename regex ^[a-zA-Z0-9_-]+\.[a-z]+$ + resolve+startsWith 164` | BN `tools.js:642 resolveOut isAbsolute join SHOTS_DIR resolve+sep traversal 648` `0o700/0o600` |
|---|---|---|

### Debugger / Auth

| | MC `utils/cdp-session-manager.ts:97` **no allowlist** any `sendCommand` passes | BN `background.js:704 ALLOWED_CDP 19` `cdpSend 776` `CDP_METHOD_BLOCKED` `DEBUGGER_DETACHED` |
| Auth | MC `127.0.0.1:12306` no token `CORS allow no-origin:76` `Stdio` unauth | BN `127.0.0.1:9224` `BROWSER_NAV_TOKEN:137` opt-in `origin chrome-extension://:146` `maxPayload 1MiB 1<<20:31` `helloTimeout 4001:72` `badFrames>10:105` |

### Persistence

| | MC `chrome.storage.local` `SERVER_STATUS:49` + `IndexedDB rr_v3 FLOWS/RUNS/EVENTS/QUEUE:15` + `better-sqlite3 WAL:194 ~/.chrome-mcp-agent/agent.db` `projects/sessions/messages` no enc `~10MB quota` | BN `data/bookmarks/history.json` `data/cookies/*.enc` `data/screenshots/*.png` `chrome.storage.session injectedScripts:1076` `chrome.storage.local settings serverUrl:158` JSON no migration |
|---|---|---|

---

## 14. Appendix D — UI / AI / Keepalive Deep Dive (Subagent Synthesis)

### UI 7 vs 2 entrypoints

* **MC WXT** `wxt.config.ts:18 modules:['@wxt-dev/module-vue']` `vite:{tailwindcss 127 Components Icons viteStaticCopy 136}` `build target es2015 minify false chunkWarning 1500:160`:
  * `popup/App.vue 2679 + icons 8 SFC` Vue `script setup` | `sidepanel/App.vue 1368` `useAgentTheme` | `builder/App.vue 1262` `@vue-flow/core 1.47 elkjs 0.11` | `quick-panel.content.ts 115 + shared/quick-panel 3401` Shadow DOM `shadow-host 386 ai-chat-panel 956` | `web-editor-v2.ts 47 + core 2k` `transaction-manager 1913` | `offscreen/main.ts 441` `reasons:['WORKERS']` | `element-picker.content.ts 120` | `welcome/options 400`.
* **BN** `manifest.json:1` 51 lines: `popup.html 115 + popup.js 213` inline style 67 lines vanilla `getElementById`; `dashboard.html 209 + dashboard.js 349` vanilla table.
* **i18n** MC `6 locales _locales/*/messages.json` `zh_CN 15.5KB:default` `wxt copy _locales:136`; BN hardcoded English `popup.js:18`.
* **Build** MC `~8-12MB zip` 2.1MB JS + 31.6MB wasm workers + locales `pnpm -r build 45-90s` `cargo wasm 12s`; BN `~120KB zip` `18MB node_modules` `0s build` `parse 12ms vs 400ms:169`.

### AI Stack

```
MC popup/sidepanel --sendMessage--> background SemanticSimilarityEngineProxy:459 --ensureOffscreenDocument offscreen-manager:27--> offscreen/main.ts:60
  -> Worker chrome.runtime.getURL workers/similarity.worker.js:992 -> @xenova/transformers 2.17 AutoTokenizer.from_pretrained:1344 512 tokens LRU 500:913
     -> ORT wasm 31.6MB (ort-wasm-simd-threaded.wasm 10.7MB + jsep 20.9MB) -> ModelCacheManager IndexedDB arrayBuffer 40:29
        -> 116MB multilingual-e5-small dim384 20ms vs 279MB base dim768 30ms PREDEFINED_MODELS:147
        -> SIMD simd_math_bg.wasm 25.6K Rust f32x4 wide 0.7 Cargo opt3 lto:20
     -> VectorDatabase 1501 lines 100k*384*4=146MB +30% HNSW HierarchicalNSW cosine:253 syncFS 1080 5s
     -> Text chunker 264 lines maxWords 80 overlap 1 min 20:21 aggressive fallback >500 chars:84
```

**BN**: zero AI, `bridge.js` sync facades no offscreen.

### Keepalive

* **MC 2-tier**: `native-host.ts:141 syncKeepaliveHold acquireKeepalive('native-host'):149` `RECONNECT 500*2^n jitter 0.7-1.3:106 cooldown 5min:18` vs `keepalive-manager.ts:48 acquireKeepalive tag Map totalRefs scheduleSync 185 syncOnce 199 ensureConnectionListener 238 Port rr_v3_keepalive:5 ping 20s protocol:10 renderer 30MB`.
* **BN 1-tier**: `background.js:45 HB 15s:53 missed 3:54 SW_KEEPALIVE 20s:59 bumpIdleReset getPlatformInfo:412` `outbox 512:63` no offscreen.

### Perf Delta Table

| | MC | BN | Δ |
|---|---|---|---|
| `/ping` | Fastify+CORS+4B LE+double JSON `~300ms` `server:112 native:40` | ws ping `~4ms` | +295 |
| Tool RTT | `sendRequestToExtensionAndWait 15s:196` + `stdout tick` `~350ms` | `bridge.call 134 + dispatch 600` `~100ms` | +250 |
| Screenshot | `scroll 350ms + stitch 50 parts:13` | single `Page.captureScreenshot` `background:816` | +350 |
| SW parse | Vue/elk 2.1MB `~400ms` `wxt minify false:169` | `12ms` | +388 |
| Model cold | `116MB fetch + ORT 600ms` `~10s` | 0 | +10s |
| Focus | `windows+tabs serial 139` `+50ms` | batched `hBrowserState 1316` | +50 |

---

## 15. Appendix E — Quantified Costs (ms / MB / LOC)

| Subsystem | MC | BN | File |
|---|---|---|---|
| Popup | 2679 + icons 4k | 328 | `popup/App.vue 2679` vs `popup.html 115` |
| Quick-panel | 3516 | — | `quick-panel 3401` |
| Web-editor | 2047 | — | `web-editor-v2 2k` |
| Inject scripts | 16× ~4k | `injected 820` | `inject-scripts/*` |
| Semantic | 2388 + 116MB +31.6MB ORT | 0 | `semantic 147 elk` |
| Vector | 1501 +190MB | 0 | `vector 195` |
| Chunker | 264 80w | 0 | `text-chunker 20` |
| Offscreen keepalive | 108+451+20s | `bumpIdle 8` +20s | `offscreen-manager 27` |
| Native keepalive | 627 `500*2^n` | 452 `500*2^n` | `native-host 115` |
| Bundle | 8-12MB zip 380MB nm | 120KB zip 18MB nm | `wxt 18` vs `manifest 1` |
| Build time | 45-90s pnpm +12s cargo | 0s | `pnpm -r build` |
| Cold parse | 400ms | 12ms | `wxt minify false:169` |
| Model download | 116MB | 0 | `getCachedModelData 29` |

*Use this table to decide which subsystem to flag-gate (`VECTOR_SEARCH`, `SIMD`, `WEB_EDITOR`).*

---

## 16. Appendix F — Slowness / Inefficiency Audit (Subagent Deep Dive 2026-09-01)

*Focus: “other project” = `brower-navigator` (you asked to check it). Also re-audited `mcp-chrome` beyond §8/§14. All `file:line` absolute.*

### F.1 `brower-navigator` — Top Inefficiencies (7 high, rest medium)

| File:Line | Issue | Impact | Fix |
|---|---|---|---|
| `bridge.js:34` `TIMEOUTS` + `132 pending Map` | `pending` unbounded, 1 `setTimeout` per `call` kept 20-45s even for instant `click`; `invalidatePending 90` `O(n)` sync loop on flap | Memory leak, tail 20s `TIMEOUT`, 2-5ms block at `n=1000` | Cap `pending 500`, pool timers, `invalidatePending` chunked `setImmediate` |
| `bridge.js:373 pageClick` `419 pageListInteractive` `468 pageDetectCaptcha` | `scrollIntoView → getBoundingClientRect → elementFromPoint` forced reflows `2×` per click; `pageListInteractive` layouts all 1000 before `limit 50`; `outerHTML 1-5MB` serialize + 5 regex | 5-30ms click thrash, 10-50ms list, 30-200ms captcha `MB GC` | `pageListInteractive` break before `rect`, `pageDetectCaptcha` use `querySelector` not `outerHTML` |
| `bridge.js:457 pageExists` `520 pageWaitFor` | `querySelectorAll("body *")` scan `10k` + `TreeWalker 10k` per poll `500ms ×30` =300k nodes | 20-100ms jank, 15-50ms per poll | Index `Map text→el` once, `MutationObserver` only |
| `ws-server.js:31 maxPayload 1MiB` `101 JSON.parse+validate double stringify` | `1MiB * N` flood `15ms` parse + `validateEnvelope JSON.stringify length` 2× | 30ms/MiB blocked | Validate via `data.length` not stringify, add per-IP rate limit `10/s` |
| `ws-server.js:72 hello 3s` `80 hb 15s/30s` `44 sessions Set` | `sessions` held 3s pending hello, `hbTimer` per session, mismatch BN 15/45s vs server 15/30s → 15s blackout | 10MB at 1000 scans, stale `active` | Sync HB to `10s/30s` both sides, cap `sessions 100`, reuse timer |
| `extension/background.js:63 OUTBOX 512` `404 shift O(n)` `185 recentEvents shift` | `Array.shift 512` `O(n)` per drop, `recentEvents 200` shift | 5-10MB queued, 0.05ms per drop | Use ring buffer or `splice 0, n` dequeue index |
| `extension/background.js:731 acquireDebugger` `782 cdpSend` `1542 withDebugger per cmd` | `attach` no timeout `100ms` banner `600s capture`, `cdpSend` no timeout leak until `onDetach`, `performClick 661` `3× dbg.cmd` → `3 attaches =300ms` | 300ms per trusted click | Single `withDebugger` per `performClick`, add 5s `attach` timeout, `cdpSend` 8s budget `DBG_METHOD_TIMEOUT_MS:42` |
| `extension/background.js:843 netCapture` `852 ensureNetEntry` `980 sort O(n log n)` | No cap, `10k req →3MB` + `sort 133k comps` per `stop`, `atob 872 full body 500` decode 750KB per response | 10-50ms stop, 60-160ms body | Cap `5000 entries`, truncate before `atob` `slice 0,700`, `sort` only on `peek` if needed |
| `extension/background.js:1004 primeBrowserState` `1100 ensureRunner` | `for(w) await tabs.query` sequential `500ms` for 10 wins; `replay 1139 sequential for(name) await` 10 scripts `500ms` | 500ms init | `Promise.all` |
| `extension/background.js:1227 waitTabSettled` `1477 hCsEval` | `probeReadyState scripting.executeScript 1229` thundering herd 100 updates ×50ms; `hCsEval JSON.stringify args + Function('return('+src+')') 5-15ms` per `execute_js` | IPC storm | Debounce `waitTabSettled` 100ms, cache `Function` compile |
| `extension/content.js:104 visChecker getComputedStyle 116` `202 buildSelector 5 QSA scans` `237 extractVisibleText string += O(n²) 242` `348 listInteractive 800×5 scans 100-300ms` `387 serializeElement 900*5 scans 200ms` | Per node style flush `10-20ms`, `buildSelector` 250 scans for 50 els `50-100ms`, string concat `15ms` | 100-300ms `listInteractive 800` | Use `el.checkVisibility 110` fast path cached, encode selector once, `text join array` not `+=` |
| `tools.js:438 pageCollectCandidates 222` `694 performClick 3× dbg` `711 performType delay` `1428 search_tabs 1454 substringHit` | `path filter([...parent.children].filter) 48k ops`, `type 100 chars 30ms delay 3s`, `TF-IDF idf per query 2-5ms 50 tabs` `pageSearchResults fallback qsa a[href] 5k 80-250ms` | 30-60ms `collect`, 3s type, 15-40ms search | Cache `idf 5s WeakMap`, hoist `tokenize` LRU 200, cap fallback `500 anchors`, `Input.insertText` batch |

### F.2 `mcp-chrome` — Additional Inefficiencies Beyond §8/§14

| File:Line | Issue | Impact | Fix |
|---|---|---|---|
| `native-messaging-host.ts:81 Buffer.concat per chunk` `60 slice` `283 concat header+body` | `O(n²)` copy per `stdin.read`, double alloc per send, linger 16MB slice | 1-5ms/msg GC 20-50ms burst | Use `BufferList` or `Uint8Array` growth `1.5×` |
| `native-messaging-host.ts:283 stdout.write` no `drain` check | Buffer overflow silent drop | 5-50ms stall | Check `write()===false` `await drain` |
| `server/index.ts:73 CORS regex per req` `49 transportsMap leak "" key` `222 isInitializeRequest zod` | `0.05ms/req`, `200B leak MBs`, `0.5-2ms zod` | 10% CPU at 1k rps | Cache `CORS allow`, TTL evict `Map` 10min, skip zod if `sessionId` present |
| `agent/stream-manager.ts:68 publish JSON.stringify 50KB` `160 broadcast 30s O(n*m)` | `1-8ms/event` blocking | 2-5ms heartbeat | `JSON.stringify` once, `for…of` single pass, `unref` timer `251` |
| `agent/db/client.ts:194 WAL pragma` `137 3× PRAGMA table_info + ALTER` `167 existsSync mkdirSync sync` | `10-30ms WAL 1-50MB`, `100-300ms migrate` per start | 15ms typical | `PRAGMA` once, `exec` batch `CREATE_TABLES_SQL:51` lazy, `mkdir async` |
| `file-handler.ts:81 fetch buffer()` `94 writeFileSync` `259 readdirSync statSync` | `100MB heap OOM`, `10-100ms sync block` | critical | `fetch stream pipeline` `fs.createWriteStream` + 5MB guard |
| `vector-database.ts:1130 syncFS 5s per 10 docs` `462 per-chunk saveIndex+saveMappings` `544 4 fallback encodings 384 push_back` | `25s per 50 chunks`, `1-5s`, `1ms/search` | critical | Debounce `syncFS 1s`, `hasVectorFloat` memo once |
| `content-indexer.ts:174 sequential await 50×20ms` `34 80w 50 chunks` | `1.75s+2s` vs `1s batch` | high | `getEmbeddingsBatch:684` bulk |
| `semantic-similarity-engine.ts:568 3 retries 100*attempt + ensure per embedding` `16 fetch 116MB arrayBuffer double` `241 SIMD wasm compile 200ms` | `600ms tail`, `116MB spike`, `200ms` | high | Batch 50, `ensure` once per batch, stream `fetch` |
| `lru-cache.ts:45 findVictim 5 scan Date.now` `offscreen-manager.ts:50 getContexts 5-10ms per embedding` | `0.02ms/evict` but 50× | med | Pure LRU `Map`, cache `ensureOffscreen 1×` |
| `transaction-aggregator.ts:353 sort+group+locateElement per keystroke` `1719 gif stitch OffscreenCanvas 50000×1920 768MB` `wxt.config.ts:169 minify false 5MB + elk/vue-flow 600KB` | `20ms/keystroke`, `384MB`, `200ms parse` | high | Throttle aggregator 100ms, cap canvas 15k, `minify true` dynamic import `elk` |

### F.3 Immediate Fixes (Copy-Paste for Next AI)

**BN 1-file fixes:**
* `tools.js:1428 idf` cache `WeakMap snapshot → idfMap 5s TTL`
* `tools.js:541 fallback qsa` cap `500` or remove `else` fallback
* `extension/content.js:242` `text = []; walker → push; finally join(" ")` not `+=`
* `extension/background.js:704` memoize `NET_STATIC_RE.test` result per `requestId`

**MC 1-file fixes:**
* `content-indexer.ts:174` `getEmbeddingsBatch(chunks.map(c=>c.text))`
* `vector-database.ts:1130` `if(documents.size%10===0) /*remove*/ → debounce 1s trailing`
* `wxt.config.ts:169` `minify: true` + `manualChunks: {elk: ['elkjs'], vendor: ['vue']}`

---

## 17. Suggested Commit Sequence

1. `feat: P0 computer fill + viewport/background + dialog handlers`
2. `feat: optional http transport sidecar`
3. `feat(vector): offscreen semantic search (flag VECTOR_SEARCH)`
4. `feat(simd): wasm SIMD for batch similarity (flag SIMD)`
5. `feat(editor): minimal web-editor shadow toolbar`
6. `feat(rr): record start/stop/replay v1`

Each commit keeps `node test.cjs` green and `npm run syntax` clean — BN's `AGENT.md:41` rule for adding a tool: `tools.js: registerTools() guard(async()=>json())` + `bridge.dom.*` facade.
