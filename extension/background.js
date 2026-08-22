/**
 * browser-navigator — Manifest V3 service worker
 * Bridges the local MCP server to Brave/Chrome over a WebSocket.
 *
 * Protocol: JSON text envelopes {v:1, type:"hello"|"welcome"|"req"|"res"|"evt"|"ping"|"pong"}
 * See EXTENSION-PLAN.md for the op vocabulary and error codes.
 *
 * Sections:
 *   §1  Constants & error codes          §9  Debugger manager (refcounted)
 *   §2  Small utilities                  §10 Network capture engine
 *   §3  Settings (storage.local)         §11 State tracker (+ upstream events)
 *   §4  Envelope codec                   §12 Injected-script registry
 *   §5  Security guards (SSRF/targets)   §13 Tab-load waiting
 *   §6  WebSocket client                 §14 Operation handlers (25 ops)
 *   §7  Native-messaging fallback        §15 Wiring & init
 */

// ============================================================================
// §1 Constants & error codes
// ============================================================================

const PROTOCOL_VERSION = 1;
const EXT_VERSION = "2.0.0";
const DEFAULT_SERVER_URL = "ws://127.0.0.1:9224";
const NATIVE_HOST_NAME = "com.browser_navigator.mcp";

const HB_INTERVAL_DEFAULT_MS = 10_000; // heartbeat cadence (welcome.hbMs overrides)
const HB_MAX_MISSED = 3;               // missed pongs before force-close
const WELCOME_TIMEOUT_MS = 5_000;      // hello → welcome budget
const RECONNECT_BASE_MS = 500;
const RECONNECT_CAP_MS = 15_000;
const RECONNECT_IMMEDIATE_MS = 250;    // fast redial after a healthy session drops
const SW_KEEPALIVE_MS = 20_000;        // < Chrome's 30s SW idle timer
const DEFAULT_OP_TIMEOUT_MS = 30_000;
const MAX_HTTP_BODY_CHARS = 200_000;
const BODY_PREVIEW_CHARS = 500;
const NATIVE_RETRY_MS = 5_000;
const OUTBOX_MAX = 512;

const ERR = Object.freeze({
  BAD_REQUEST: "BAD_REQUEST",
  UNSUPPORTED_OP: "UNSUPPORTED_OP",
  NOT_READY: "NOT_READY",
  NOT_CONNECTED: "NOT_CONNECTED",
  RESTRICTED_TARGET: "RESTRICTED_TARGET",
  RESTRICTED_URL: "RESTRICTED_URL",
  TAB_NOT_FOUND: "TAB_NOT_FOUND",
  WINDOW_NOT_FOUND: "WINDOW_NOT_FOUND",
  NAV_FAILED: "NAV_FAILED",
  NAV_TIMEOUT: "NAV_TIMEOUT",
  EVAL_FAILED: "EVAL_FAILED",
  DEBUGGER_DETACHED: "DEBUGGER_DETACHED",
  CDP_METHOD_BLOCKED: "CDP_METHOD_BLOCKED",
  HTTP_ERROR: "HTTP_ERROR",
  TIMEOUT: "TIMEOUT",
  INJECTED_TIMEOUT: "INJECTED_TIMEOUT",
  CAPTCHA_WAIT_TIMEOUT: "CAPTCHA_WAIT_TIMEOUT",
  INTERNAL: "INTERNAL",
});

class RpcError extends Error {
  constructor(code, message, retriable = false) {
    super(message);
    this.name = "RpcError";
    this.code = code || ERR.INTERNAL;
    this.retriable = !!retriable;
  }
}
const rpcErr = (code, message, retriable = false) => new RpcError(code, message, retriable);

// ============================================================================
// §2 Small utilities
// ============================================================================

let idCounter = 0;
function uid(prefix = "") {
  idCounter = (idCounter + 1) % 0xffff;
  const t = Date.now().toString(36).padStart(9, "0");
  const c = idCounter.toString(36).padStart(3, "0");
  const r = Math.floor(Math.random() * 46656).toString(36).padStart(3, "0");
  return `${prefix}${t}-${c}-${r}`;
}
const nowTs = () => Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clampNum = (v, min, max, dflt) =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;

/** Promisify any chrome.* callback API whose callback's first arg is the result. */
function cbp(fn, ...args) {
  return new Promise((resolve, reject) => {
    try {
      fn(...args, (result) => {
        const e = chrome.runtime.lastError;
        if (e) reject(new Error(e.message));
        else resolve(result);
      });
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}

function log(...parts) {
  try { console.log("[bg]", ...parts); } catch { /* console unavailable */ }
}

/** Map a raw chrome API error onto a protocol RpcError. */
function mapChromeError(e) {
  if (e instanceof RpcError) return e;
  const msg = String((e && e.message) || e);
  if (/No tab with id|tab was closed|Cannot find.*tab/i.test(msg))
    return rpcErr(ERR.TAB_NOT_FOUND, msg, false);
  if (/No window with id/i.test(msg)) return rpcErr(ERR.WINDOW_NOT_FOUND, msg, false);
  if (/cannot be scripted|Cannot access contents|not been invoked|chrome-web-store|gallery/i.test(msg))
    return rpcErr(ERR.RESTRICTED_TARGET, msg, false);
  if (/Another debugger|already attached/i.test(msg))
    return rpcErr(ERR.DEBUGGER_DETACHED, `Debugger attach refused: ${msg}`, true);
  if (/Debugger is not attached|Detached/i.test(msg))
    return rpcErr(ERR.DEBUGGER_DETACHED, msg, true);
  if (/Cannot attach to this target/i.test(msg))
    return rpcErr(ERR.RESTRICTED_TARGET, msg, false);
  if (/Tabs cannot be edited right now/i.test(msg))
    return rpcErr(ERR.NAV_FAILED, msg, true);
  return rpcErr(ERR.INTERNAL, msg, false);
}

const toOutcome = mapChromeError; // alias used by the router

// ============================================================================
// §3 Settings (chrome.storage.local)
// ============================================================================

const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = Object.freeze({
  serverUrl: DEFAULT_SERVER_URL,
  nativeFallback: false,
});
let settingsCache = { ...DEFAULT_SETTINGS };

async function loadSettings() {
  try {
    const o = await chrome.storage.local.get(SETTINGS_KEY);
    settingsCache = { ...DEFAULT_SETTINGS, ...(o[SETTINGS_KEY] || {}) };
  } catch (e) {
    log("settings load failed:", e?.message || e);
  }
  return settingsCache;
}

async function setSettings(patch) {
  settingsCache = { ...(await loadSettings()), ...patch };
  await chrome.storage.local.set({ [SETTINGS_KEY]: settingsCache });
  return settingsCache;
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[SETTINGS_KEY]) return;
  const prev = { ...settingsCache };
  settingsCache = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
  // Server URL changed → drop socket, redial immediately.
  if (settingsCache.serverUrl !== prev.serverUrl && isOpen(ws)) {
    teardownSocket("server-url-changed");
    reconnectAttempts = 0;
    scheduleReconnect({ immediate: true });
  }
  if (settingsCache.nativeFallback && !prev.nativeFallback && !wsReady) maybeStartNative();
  if (!settingsCache.nativeFallback && nativePort) stopNative("disabled-in-settings");
});

// ============================================================================
// §4 Envelope codec
// ============================================================================

const resOk = (id, result) => ({ v: PROTOCOL_VERSION, type: "res", id, ts: nowTs(), ok: true, result: result ?? {} });
const resFail = (id, error) => ({
  v: PROTOCOL_VERSION, type: "res", id, ts: nowTs(), ok: false,
  error: {
    code: error.code || ERR.INTERNAL,
    message: String(error.message || "error"),
    retriable: !!error.retriable,
  },
});
const evtFrame = (event, data) => ({ v: PROTOCOL_VERSION, type: "evt", id: uid("e"), ts: nowTs(), event, data: data ?? {} });
const helloFrame = () => ({
  v: PROTOCOL_VERSION, type: "hello", ts: nowTs(),
  extVersion: EXT_VERSION, browser: navigator.userAgent,
});

// ============================================================================
// §5 Security guards (ported from server security.js)
// ============================================================================

const ALLOWED_NAV_SCHEMES = new Set(["http:", "https:", "data:", "blob:", "file:"]);
const ALLOWED_FETCH_SCHEMES = new Set(["http:", "https:"]);

const BLOCKED_HOSTS = new Set([
  "localhost", "localhost.localdomain", "localhost4", "localhost6",
  "0.0.0.0", "::", "::1", "169.254.169.254", "100.100.100.200",
  "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal",
]);

const BLOCKED_CIDRS = [
  [0x00000000, 8],   // 0.0.0.0/8            "this network"
  [0x0a000000, 8],   // 10/8                 private
  [0x64400000, 10],  // 100.64/10            CGNAT
  [0x64646400, 24],  // 100.100.100/24       Alibaba metadata
  [0x7f000000, 8],   // 127/8                loopback
  [0xa9fe0000, 16],  // 169.254/16           link-local (cloud metadata lives here)
  [0xac100000, 12],  // 172.16/12            private
  [0xc0a80000, 16],  // 192.168/16           private
];

function ipv4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v > 255) return null;
    n = (n << 8) | v;
  }
  return n >>> 0;
}

function inBlockedCidrs(ip) {
  for (const [base, bits] of BLOCKED_CIDRS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ip & mask) === (base & mask)) return true;
  }
  return false;
}

function isBlockedInternalUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch { return false; }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.startsWith("fe80:")) return true;                    // IPv6 link-local
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;            // IPv6 unique-local fc00::/7
  // Decimal-obfuscated IPv4 (e.g. https://2852039166 ≡ 169.254.169.254)
  if (/^\d{1,10}$/.test(host)) {
    const n = parseInt(host, 10);
    if (Number.isSafeInteger(n)) {
      const dotted = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".");
      const ip2 = ipv4ToInt(dotted);
      if (ip2 !== null && inBlockedCidrs(ip2)) return true;
    }
  }
  const ip = ipv4ToInt(host);
  return ip !== null && inBlockedCidrs(ip);
}

const RESTRICTED_PREFIXES = [
  "chrome://", "brave://", "edge://", "chromium://",
  "devtools://", "view-source:", "chrome-extension://", "moz-extension://",
];

function isRestrictedTargetUrl(url) {
  const u = String(url || "").toLowerCase();
  for (const p of RESTRICTED_PREFIXES) if (u.startsWith(p)) return true;
  try {
    const parsed = new URL(String(url));
    const host = parsed.hostname.toLowerCase();
    if (host === "chromewebstore.google.com") return true;
    if (host === "chrome.google.com" && parsed.pathname.startsWith("/webstore")) return true;
  } catch { /* not a URL */ }
  return false;
}

/** Throws unless `raw` is safe to navigate a tab to. Returns normalized URL. */
function assertSafeNavUrl(raw) {
  if (typeof raw !== "string" || !raw.trim())
    throw rpcErr(ERR.BAD_REQUEST, "url must be a non-empty string");
  const trimmed = raw.trim();
  if (trimmed === "about:blank" || trimmed === "about:blank#") return trimmed;
  if (isRestrictedTargetUrl(trimmed))
    throw rpcErr(ERR.RESTRICTED_TARGET, `Navigation to restricted target blocked: ${trimmed}`);
  const colon = trimmed.indexOf(":");
  if (colon <= 0)
    throw rpcErr(ERR.BAD_REQUEST, `"${trimmed}" is not an absolute URL (missing scheme)`);
  const scheme = trimmed.slice(0, colon + 1).toLowerCase();
  if (!ALLOWED_NAV_SCHEMES.has(scheme))
    throw rpcErr(ERR.RESTRICTED_URL,
      `Scheme "${scheme}" not allowed. Allowed: ${[...ALLOWED_NAV_SCHEMES].join(", ")}`);
  if ((scheme === "http:" || scheme === "https:") && isBlockedInternalUrl(trimmed))
    throw rpcErr(ERR.RESTRICTED_URL,
      `Blocked: "${trimmed}" points to a loopback/internal address (SSRF guard)`);
  return trimmed;
}

/** Stricter variant for http.request: http/https only, SSRF-guarded. */
function assertSafeFetchUrl(raw) {
  if (typeof raw !== "string" || !raw.trim())
    throw rpcErr(ERR.BAD_REQUEST, "url must be a non-empty string");
  const trimmed = raw.trim();
  const colon = trimmed.indexOf(":");
  if (colon <= 0)
    throw rpcErr(ERR.BAD_REQUEST, `"${trimmed}" is not an absolute URL (missing scheme)`);
  const scheme = trimmed.slice(0, colon + 1).toLowerCase();
  if (!ALLOWED_FETCH_SCHEMES.has(scheme))
    throw rpcErr(ERR.RESTRICTED_URL,
      `Scheme "${scheme}" not allowed for http.request. Allowed: ${[...ALLOWED_FETCH_SCHEMES].join(", ")}`);
  if (isBlockedInternalUrl(trimmed))
    throw rpcErr(ERR.RESTRICTED_URL,
      `Blocked: "${trimmed}" points to a loopback/internal address (SSRF guard)`);
  return trimmed;
}

async function getTabOrThrow(tabId) {
  try {
    return await cbp(chrome.tabs.get.bind(chrome.tabs), tabId);
  } catch (e) {
    throw mapChromeError(e);
  }
}

function assertInjectableTab(tab) {
  const url = tab.url || tab.pendingUrl || "";
  if (!url || url.startsWith("about:blank")) return;
  if (isRestrictedTargetUrl(url))
    throw rpcErr(ERR.RESTRICTED_TARGET, `Cannot inject/script restricted target: ${url}`);
}

function tabInfo(t) {
  if (!t) return null;
  return {
    id: t.id, windowId: t.windowId, index: t.index,
    url: t.url ?? t.pendingUrl ?? "",
    title: t.title ?? "",
    status: t.status ?? null,
    active: !!t.active, pinned: !!t.pinned,
    audible: !!t.audible, muted: !!(t.mutedInfo && t.mutedInfo.muted),
    favIconUrl: t.favIconUrl ?? "", incognito: !!t.incognito,
  };
}

function winInfo(w) {
  if (!w) return null;
  return {
    id: w.id, focused: !!w.focused, type: w.type ?? null, state: w.state ?? null,
    left: w.left ?? null, top: w.top ?? null, width: w.width ?? null, height: w.height ?? null,
    incognito: !!w.incognito, alwaysOnTop: !!w.alwaysOnTop,
    tabs: Array.isArray(w.tabs) ? w.tabs.map(tabInfo) : [],
  };
}

// ============================================================================
// §6 WebSocket client
// ============================================================================

let ws = null;
let wsReady = false;          // true only between welcome and teardown
let welcomed = false;
let sessionId = null;
let hbMs = HB_INTERVAL_DEFAULT_MS;
let missedPongs = 0;
let hbTimer = null;
let welcomeTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectInFlight = false;
let outbox = [];              // frames queued while offline (flushed on welcome)
let keepAliveTimer = null;
let lastIdleReset = 0;

const isOpen = (sock) => !!sock && sock.readyState === WebSocket.OPEN;

/**
 * Outbound path: WS first, native port second, otherwise queue (flushed on next
 * welcome). Every successful send bumps the SW idle timer (Chrome 116+ keeps
 * the worker alive while WebSockets are active; the platform-info poke below is
 * belt-and-braces for long silent stretches).
 */
function sendFrame(frame) {
  if (isOpen(ws)) {
    try { ws.send(JSON.stringify(frame)); bumpIdleReset(); return true; }
    catch (e) { log("ws.send failed:", e?.message || e); }
  }
  if (nativePort) {
    try { nativePort.postMessage(frame); bumpIdleReset(); return true; }
    catch (e) { log("native post failed:", e?.message || e); }
  }
  if (outbox.length >= OUTBOX_MAX) outbox.shift();
  outbox.push(frame);
  return false;
}

function emitEvent(event, data) {
  sendFrame(evtFrame(event, data));
}

function bumpIdleReset() {
  const t = nowTs();
  if (t - lastIdleReset < SW_KEEPALIVE_MS / 2) return; // throttle
  lastIdleReset = t;
  try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch { /* noop */ }
}

function startKeepAlive() {
  stopKeepAlive();
  keepAliveTimer = setInterval(() => {
    if (!wsReady) return;
    try { chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError); } catch { /* noop */ }
  }, SW_KEEPALIVE_MS);
}
function stopKeepAlive() {
  if (keepAliveTimer) { clearInterval(keepAliveTimer); keepAliveTimer = null; }
}

/** Exponential backoff: min(500·2^n, 15000) ms ± 20% jitter. */
function scheduleReconnect(opts = {}) {
  if (reconnectTimer) return;
  let delay;
  if (opts.immediate) {
    delay = RECONNECT_IMMEDIATE_MS;   // healthy session dropped — retry fast
    reconnectAttempts = 0;
  } else {
    const exp = Math.min(reconnectAttempts, 10);
    const base = Math.min(RECONNECT_BASE_MS * 2 ** exp, RECONNECT_CAP_MS);
    delay = Math.round(base * (0.8 + Math.random() * 0.4));
  }
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectAttempts += 1;
    connectLoop();
  }, delay);
  log(`reconnecting in ${delay}ms (attempt ${reconnectAttempts + 1})`);
}

function teardownSocket(reason) {
  clearTimeout(welcomeTimer);
  welcomeTimer = null;
  stopHeartbeat();
  stopKeepAlive();
  const dropped = outbox.length;
  outbox = [];                       // stale frames are worthless post-session
  wsReady = false;
  welcomed = false;
  sessionId = null;
  const sock = ws;
  ws = null;
  if (sock) {
    sock.onopen = sock.onmessage = sock.onerror = sock.onclose = null;
    try { sock.close(); } catch { /* already gone */ }
  }
  log("socket down:", reason || "", dropped ? `(dropped ${dropped} queued frames)` : "");
}

async function connectLoop() {
  if (connectInFlight || isOpen(ws)) return;
  connectInFlight = true;
  try {
    await loadSettings();
    const url = settingsCache.serverUrl || DEFAULT_SERVER_URL;
    log(`connecting → ${url}`);
    const okOpen = await openSocket(url);
    if (!okOpen) log("connection attempt failed");
  } catch (e) {
    log("connectLoop error:", e?.message || e);
  } finally {
    connectInFlight = false;
  }
}

function openSocket(url) {
  return new Promise((resolve) => {
    let opened = false;
    let sock;
    try { sock = new WebSocket(url); } catch (e) { resolve(false); return; }
    ws = sock;
    sock.onopen = () => {
      opened = true;
      welcomed = false;
      missedPongs = 0;
      try { sock.send(JSON.stringify(helloFrame())); } catch { /* retry via close */ }
      clearTimeout(welcomeTimer);
      welcomeTimer = setTimeout(() => teardownSocket("welcome-timeout"), WELCOME_TIMEOUT_MS);
      resolve(true);
    };
    sock.onmessage = (ev) => {
      bumpIdleReset();
      let env = null;
      try { env = JSON.parse(typeof ev.data === "string" ? ev.data : ""); } catch { return; }
      routeEnvelope(env);
    };
    sock.onerror = () => { /* the close event always follows */ };
    sock.onclose = () => {
      const hadSession = wsReady;
      teardownSocket(hadSession ? "closed-by-peer" : "connect-failed");
      if (hadSession) {
        emitEvent("transport.lost", { reason: "socket closed unexpectedly" });
        scheduleReconnect({ immediate: true });
      } else {
        scheduleReconnect();
      }
      if (!opened) resolve(false);
    };
  });
}

function startHeartbeat() {
  stopHeartbeat();
  hbTimer = setInterval(heartbeatTick, hbMs);
}
function stopHeartbeat() {
  if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
}
function heartbeatTick() {
  if (!wsReady || !isOpen(ws)) return;
  if (missedPongs >= HB_MAX_MISSED) {
    log(`${missedPongs} missed pongs — force-closing socket`);
    teardownSocket("heartbeat-miss");
    scheduleReconnect({ immediate: true });
    return;
  }
  missedPongs += 1;
  try { ws.send(JSON.stringify({ v: PROTOCOL_VERSION, type: "ping", id: uid("p"), ts: nowTs() })); }
  catch { /* close will handle it */ }
}

function routeEnvelope(env) {
  if (!env || typeof env !== "object") return;
  switch (env.type) {
    case "welcome": {
      clearTimeout(welcomeTimer);
      welcomeTimer = null;
      welcomed = true;
      wsReady = true;
      sessionId = typeof env.sessionId === "string" && env.sessionId ? env.sessionId : uid("s");
      hbMs = clampNum(env.hbMs, 1000, 60_000, HB_INTERVAL_DEFAULT_MS);
      reconnectAttempts = 0;
      missedPongs = 0;
      startHeartbeat();
      startKeepAlive();
      log(`session ready (${sessionId}), heartbeat ${hbMs}ms`);
      stopNative("ws-preferred");     // WS wins once healthy; native stands down
      const queued = outbox;
      outbox = [];
      for (const f of queued) sendFrame(f);
      break;
    }
    case "ping":                      // server-initiated keepalive
      sendFrame({ v: PROTOCOL_VERSION, type: "pong", id: env.id });
      break;
    case "pong":
      missedPongs = 0;
      break;
    case "req":
      void dispatchRequest(env);
      break;
    case "bye":
      teardownSocket("server-bye");
      scheduleReconnect();
      break;
    default:
      break;                          // res/evt from upstream are not our concern
  }
}

async function dispatchRequest(env) {
  const id = typeof env.id === "string" && env.id ? env.id : null;
  if (!id) { log("req missing id — dropped"); return; }

  if (!welcomed) {
    sendFrame(resFail(id, {
      code: ERR.NOT_READY,
      message: "Handshake incomplete — ops rejected until welcome",
      retriable: true,
    }));
    return;
  }
  if (env.v !== PROTOCOL_VERSION) {
    sendFrame(resFail(id, {
      code: ERR.BAD_REQUEST,
      message: `Unsupported protocol version: ${JSON.stringify(env.v)}`,
      retriable: false,
    }));
    return;
  }

  const op = typeof env.op === "string" ? env.op : "";
  const handler = HANDLERS[op];

  let frame;
  if (!handler) {
    frame = resFail(id, { code: ERR.UNSUPPORTED_OP, message: `Unknown op "${op}"`, retriable: false });
  } else {
    try {
      let outcome = await handler(env.args ?? {});
      if (!outcome || typeof outcome !== "object" || typeof outcome.ok !== "boolean") {
        outcome = { ok: true, result: outcome ?? {} };   // defensive normalization
      }
      frame = outcome.ok ? resOk(id, outcome.result) : resFail(id, outcome.error ?? {});
    } catch (e) {
      const err = e instanceof RpcError ? e : mapChromeError(e);
      frame = resFail(id, err);
    }
  }
  sendFrame(frame);
}

// ============================================================================
// §7 Native-messaging fallback
// ============================================================================

let nativePort = null;
let nativeRetryTimer = null;

function maybeStartNative() {
  if (!settingsCache.nativeFallback || nativePort || wsReady) return;
  openNative();
}

function openNative() {
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (e) {
    log("native host unavailable:", e?.message || e);
    nativePort = null;
    scheduleNativeRetry();
    return;
  }
  // Native messaging delivers already-parsed JSON objects; same envelope codec.
  nativePort.onMessage.addListener(routeEnvelope);
  nativePort.onDisconnect.addListener(() => {
    const e = chrome.runtime.lastError;
    log("native host disconnected:", e?.message || "clean exit");
    nativePort = null;
    if (settingsCache.nativeFallback && !wsReady) scheduleNativeRetry();
  });
  log("native fallback connected");
}

function stopNative(reason) {
  if (nativeRetryTimer) { clearTimeout(nativeRetryTimer); nativeRetryTimer = null; }
  if (!nativePort) return;
  try { nativePort.disconnect(); } catch { /* already gone */ }
  nativePort = null;
  log("native fallback stopped:", reason || "");
}

function scheduleNativeRetry() {
  if (nativeRetryTimer || !settingsCache.nativeFallback) return;
  nativeRetryTimer = setTimeout(() => {
    nativeRetryTimer = null;
    maybeStartNative();
  }, NATIVE_RETRY_MS);
}

// ============================================================================
// §8 Message router — dispatch table
// ============================================================================

const HANDLERS = {
  // Browser state
  "browser.state": hBrowserState,

  // Tab operations
  "tab.list": hTabList,
  "tab.open": hTabOpen,
  "tab.activate": hTabActivate,
  "tab.close": hTabClose,
  "tab.info": hTabInfo,

  // Window operations
  "win.list": hWinList,
  "win.activate": hWinActivate,
  "win.close": hWinClose,

  // Navigation
  "nav.goto": hNavGoto,
  "nav.waitReady": hNavWaitReady,

  // Content-script eval
  "cs.eval": hCsEval,

  // Debugger
  "dbg.cmd": hDbgCmd,

  // Trusted input (CDP Input domain)
  "input.mouse": hInputMouse,
  "input.key": hInputKey,

  // Network capture
  "net.start": hNetStart,
  "net.stop": hNetStop,
  "net.peek": hNetPeek,

  // HTTP through the browser profile
  "http.request": hHttpRequest,

  // Cookies
  "cookie.all": hCookieAll,
  "cookie.set": hCookieSet,

  // Injected scripts
  "injected.register": hInjectedRegister,
  "injected.replay": hInjectedReplay,
  "injected.send": hInjectedSend,

  // CAPTCHA wait
  "captcha.wait": hCaptchaWait,
};

// ============================================================================
// §9 Debugger manager — refcounted attach/detach per tab
// ============================================================================

const ALLOWED_CDP_METHODS = new Set([
  "Accessibility.getFullAXTree",
  "DOM.getDocument",
  "DOM.resolveNode",
  "Network.enable",
  "Network.disable",
  "Network.getResponseBody",
  "Fetch.enable",
  "Fetch.disable",
  "Fetch.continueRequest",
  "Page.captureScreenshot",
  "Page.printToPDF",
  "Page.captureSnapshot",
  "Page.getLayoutMetrics",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Runtime.evaluate",
  "Emulation.setEmulatedMedia",
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.insertText",
]);

const dbgTabs = new Map();   // tabId -> { refs, pending:Set<rejectFn>, listeners:Set<fn> }
const attaching = new Map(); // tabId -> Promise<void> (coalesces concurrent attaches)

async function acquireDebugger(tabId) {
  let st = dbgTabs.get(tabId);
  if (!st) {
    st = { refs: 0, pending: new Set(), listeners: new Set() };
    dbgTabs.set(tabId, st);
  }
  if (st.refs === 0 && !attaching.has(tabId)) {
    attaching.set(
      tabId,
      new Promise((resolve, reject) => {
        chrome.debugger.attach({ tabId }, "1.3", () => {
          const e = chrome.runtime.lastError;
          if (e) reject(new Error(e.message));
          else resolve();
        });
      }).finally(() => attaching.delete(tabId)),
    );
  }
  if (attaching.has(tabId)) {
    try {
      await attaching.get(tabId);
    } catch (e) {
      if (dbgTabs.get(tabId)?.refs === 0) dbgTabs.delete(tabId);
      throw mapChromeError(e);
    }
  }
  st.refs += 1;
}

function releaseDebugger(tabId) {
  const st = dbgTabs.get(tabId);
  if (!st) return;
  st.refs -= 1;
  if (st.refs > 0) return;
  dbgTabs.delete(tabId);
  try { chrome.debugger.detach({ tabId }, () => void chrome.runtime.lastError); } catch { /* noop */ }
}

/** Run fn(tabId) with the debugger attached; detaches when the last ref drops. */
async function withDebugger(tabId, fn) {
  await acquireDebugger(tabId);
  try {
    return await fn(tabId);
  } finally {
    releaseDebugger(tabId);
  }
}

function cdpSend(tabId, method, params = {}) {
  if (!ALLOWED_CDP_METHODS.has(method)) {
    return Promise.reject(rpcErr(ERR.CDP_METHOD_BLOCKED, `CDP method not allowlisted: ${method}`));
  }
  const st = dbgTabs.get(tabId);
  if (!st) {
    return Promise.reject(rpcErr(ERR.DEBUGGER_DETACHED, `Debugger not attached to tab ${tabId}`, true));
  }
  return new Promise((resolve, reject) => {
    const rejector = (err) => { st.pending.delete(rejector); reject(err); };
    st.pending.add(rejector);
    try {
      chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
        const e = chrome.runtime.lastError;
        st.pending.delete(rejector);
        if (e) reject(mapChromeError(new Error(e.message)));
        else resolve(result ?? {});
      });
    } catch (e) {
      st.pending.delete(rejector);
      reject(mapChromeError(e));
    }
  });
}

const cdpQuiet = (tabId, method, params) => {
  cdpSend(tabId, method, params).catch(() => { /* fire-and-forget */ });
};

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (tabId == null) return;
  const st = dbgTabs.get(tabId);
  if (!st || st.listeners.size === 0) return;
  for (const fn of [...st.listeners]) {
    try { fn(method, params ?? {}); }
    catch (e) { log("debugger listener error:", e?.message || e); }
  }
});

chrome.debugger.onDetach.addListener((source) => {
  const tabId = source?.tabId;
  if (tabId == null) return;
  const st = dbgTabs.get(tabId);
  if (st) {
    for (const rej of [...st.pending]) {
      rej(rpcErr(ERR.DEBUGGER_DETACHED, "Debugger detached (DevTools opened or infobar dismissed)"));
    }
    st.pending.clear();
    st.listeners.clear();
    dbgTabs.delete(tabId);
  }
  if (netCapture && netCapture.tabId === tabId) {
    void finalizeCapture("detached").then((entries) => {
      emitEvent("net.stopped", { reason: "detached", tabId, count: entries.length });
    });
  }
  emitEvent("debugger.detached", { tabId });
});

// ============================================================================
// §10 Network capture engine
// ============================================================================

const NET_STATIC_RE =
  /\.(?:css|js|mjs|cjs|map|png|jpe?g|gif|svg|ico|webp|avif)(?:[?#]|$)|\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;

let netCapture = null;
// Shape: { tabId, startedAt, maxTimeMs, includeStatic, timer, entries:[], byReq:Map, listener }

function ensureNetEntry(cap, requestId) {
  let entry = cap.byReq.get(requestId);
  if (!entry) {
    entry = {
      requestId, ts: nowTs(),
      method: null, url: null, requestHeaders: null, postData: null,
      status: null, statusText: null, mimeType: null, responseHeaders: null,
      resourceType: null, fromCache: false,
      state: "pending", errorText: null, encodedDataLength: null,
      bodyPreview: null, bodyTruncated: false,
    };
    cap.byReq.set(requestId, entry);
    cap.entries.push(entry);
  }
  return entry;
}

function decodeBodyPreview(res) {
  if (!res || typeof res.body !== "string") return null;
  let text = res.body;
  if (res.base64Encoded) {
    try { text = atob(text); }
    catch { return { preview: `[base64 ${text.length} chars]`, truncated: true }; }
  }
  return { preview: text.slice(0, BODY_PREVIEW_CHARS), truncated: text.length > BODY_PREVIEW_CHARS };
}

function netOnDebuggerEvent(method, params) {
  const cap = netCapture;
  if (!cap) return;
  switch (method) {
    case "Fetch.requestPaused": {
      const r = params.request || {};
      const isStatic = !cap.includeStatic && NET_STATIC_RE.test(r.url || "");
      if (!isStatic) {
        Object.assign(ensureNetEntry(cap, params.requestId), {
          method: r.method || null,
          url: r.url || null,
          requestHeaders: r.headers || null,
          postData: typeof r.postData === "string" ? r.postData.slice(0, 2048) : null,
          state: "requested",
        });
      }
      cdpQuiet(cap.tabId, "Fetch.continueRequest", { requestId: params.requestId }); // never stall traffic
      break;
    }
    case "Network.requestWillBeSent": { // safety net for requests Fetch didn't pause
      if (cap.byReq.has(params.requestId)) break;
      if (!cap.includeStatic && NET_STATIC_RE.test(params.request?.url || "")) break;
      Object.assign(ensureNetEntry(cap, params.requestId), {
        method: params.request?.method || null,
        url: params.request?.url || null,
        requestHeaders: params.request?.headers || null,
        state: "requested",
      });
      break;
    }
    case "Network.responseReceived": {
      const entry = cap.byReq.get(params.requestId);
      if (!entry) break;
      const resp = params.response || {};
      Object.assign(entry, {
        status: resp.status ?? null,
        statusText: resp.statusText || null,
        mimeType: resp.mimeType || null,
        responseHeaders: resp.headers || null,
        resourceType: params.type || null,
        fromCache: !!resp.fromDiskCache,
        state: "responded",
      });
      break;
    }
    case "Network.loadingFinished": {
      const entry = cap.byReq.get(params.requestId);
      if (!entry) break;
      entry.state = "finished";
      entry.encodedDataLength = params.encodedDataLength ?? null;
      cdpQuiet(cap.tabId, "Network.getResponseBody", { requestId: params.requestId })
        .then((body) => {
          const d = decodeBodyPreview(body);
          if (d) { entry.bodyPreview = d.preview; entry.bodyTruncated = d.truncated; }
        });
      break;
    }
    case "Network.loadingFailed": {
      const entry = cap.byReq.get(params.requestId);
      if (!entry) break;
      entry.state = "failed";
      entry.errorText = params.errorText || "failed";
      break;
    }
    default:
      break;
  }
}

async function startNetCapture(tabId, { maxTimeMs, includeStatic }) {
  if (netCapture) await finalizeCapture("superseded");
  await acquireDebugger(tabId); // held for the whole capture window
  try {
    await cdpSend(tabId, "Network.enable", {});
    await cdpSend(tabId, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
  } catch (e) {
    releaseDebugger(tabId);
    throw e;
  }
  const cap = {
    tabId,
    startedAt: nowTs(),
    maxTimeMs,
    includeStatic,
    timer: null,
    entries: [],
    byReq: new Map(),
    listener: netOnDebuggerEvent,
  };
  dbgTabs.get(tabId)?.listeners.add(cap.listener);
  netCapture = cap;
  cap.timer = setTimeout(() => {
    void finalizeCapture("max-time").then((entries) => {
      emitEvent("net.stopped", { reason: "max-time", tabId, count: entries.length });
    });
  }, maxTimeMs);
  return cap;
}

async function finalizeCapture(reason) {
  const cap = netCapture;
  if (!cap) return [];
  netCapture = null;
  clearTimeout(cap.timer);
  dbgTabs.get(cap.tabId)?.listeners.delete(cap.listener);
  try { await cdpSend(cap.tabId, "Fetch.disable", {}); } catch { /* detached */ }
  try { await cdpSend(cap.tabId, "Network.disable", {}); } catch { /* detached */ }
  releaseDebugger(cap.tabId);
  cap.entries.sort((a, b) => a.ts - b.ts);
  log(`network capture finalized (${reason}): ${cap.entries.length} request(s)`);
  return cap.entries;
}

// ============================================================================
// §11 State tracker — mirrors focus/tab state, pushes events upstream
// ============================================================================

const browserState = {
  lastFocusedWindowId: null,
  currentTabId: null,
  activeTabByWindow: new Map(), // windowId -> tabId
};

async function primeBrowserState() {
  const wins = await cbp(chrome.windows.getAll.bind(chrome.windows), { populate: false });
  for (const w of wins) {
    const act = await cbp(chrome.tabs.query.bind(chrome.tabs), { windowId: w.id, active: true }).catch(() => []);
    if (act && act[0]) browserState.activeTabByWindow.set(w.id, act[0].id);
  }
  const fw = await cbp(chrome.windows.getLastFocused.bind(chrome.windows)).catch(() => null);
  browserState.lastFocusedWindowId = fw?.id ?? null;
  browserState.currentTabId = fw ? (browserState.activeTabByWindow.get(fw.id) ?? null) : null;
}

chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
  browserState.activeTabByWindow.set(windowId, tabId);
  if (windowId === browserState.lastFocusedWindowId) browserState.currentTabId = tabId;
  emitEvent("tab.activated", { windowId, tabId, previousTabId: browserState.currentTabId ?? null });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  // Replay registered scripts at navigation start so MAIN-world hooks survive reloads.
  if (changeInfo.status === "loading" && injectedScripts.size > 0) {
    replayInjectedOnTab(tabId).catch(() => { /* restricted pages etc. */ });
  }
  const interesting = {};
  for (const k of ["status", "url", "title", "pinned", "audible", "mutedInfo"]) {
    if (k in changeInfo) interesting[k] = changeInfo[k];
  }
  if (Object.keys(interesting).length === 0) return; // skip favicon-only churn
  emitEvent("tab.updated", {
    tabId,
    windowId: tab?.windowId ?? null,
    url: tab?.url ?? null,
    status: tab?.status ?? null,
    title: tab?.title ?? null,
    changes: interesting,
  });
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  browserState.activeTabByWindow.delete(removeInfo.windowId);
  if (browserState.currentTabId === tabId) browserState.currentTabId = null;
  emitEvent("tab.removed", { tabId, windowId: removeInfo.windowId, isWindowClosing: !!removeInfo.isWindowClosing });
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  const none = windowId === chrome.windows.WINDOW_ID_NONE;
  browserState.lastFocusedWindowId = none ? null : windowId;
  if (!none) {
    cbp(chrome.tabs.query.bind(chrome.tabs), { windowId, active: true })
      .then((act) => {
        if (act && act[0]) {
          browserState.activeTabByWindow.set(windowId, act[0].id);
          browserState.currentTabId = act[0].id;
        }
      })
      .catch(() => { /* transient */ });
  }
  emitEvent("win.focused", { windowId: none ? null : windowId });
});

chrome.windows.onCreated.addListener((win) => {
  if (win && win.id != null) {
    cbp(chrome.tabs.query.bind(chrome.tabs), { windowId: win.id, active: true })
      .then((act) => { if (act && act[0]) browserState.activeTabByWindow.set(win.id, act[0].id); })
      .catch(() => { /* noop */ });
  }
  emitEvent("win.created", { windowId: win?.id ?? null, type: win?.type ?? null, incognito: !!win?.incognito });
});

chrome.windows.onRemoved.addListener((windowId) => {
  browserState.activeTabByWindow.delete(windowId);
  if (browserState.lastFocusedWindowId === windowId) browserState.lastFocusedWindowId = null;
  emitEvent("win.removed", { windowId });
});

// ============================================================================
// §12 Injected-script registry (chrome.storage.session) + page-side bootstraps
// ============================================================================

const KEY_INJECTED = "injectedScripts";
const injectedScripts = new Map(); // name -> source code

async function loadInjectedRegistry() {
  try {
    const o = await chrome.storage.session.get(KEY_INJECTED);
    const obj = o?.[KEY_INJECTED];
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "string") injectedScripts.set(k, v);
      }
    }
    if (injectedScripts.size) log(`restored ${injectedScripts.size} injected script(s)`);
  } catch (e) {
    log("injected registry load failed:", e?.message || e);
  }
}

const persistInjectedRegistry = () =>
  chrome.storage.session.set({ [KEY_INJECTED]: Object.fromEntries(injectedScripts) })
    .catch((e) => log("injected registry persist failed:", e?.message || e));

/** Best-effort install of injected.js (persistent MAIN-world helper runtime). */
async function ensureRunner(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["injected.js"],
      world: "MAIN",
    });
    return true;
  } catch {
    return false; // file absent or page restricted; named scripts still run standalone
  }
}

async function runInjectedSource(tabId, name, code) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (c) => { (0, eval)(c); }, // indirect eval → runs in global scope
      args: [code],
    });
    const r = results && results[0];
    if (r && r.error) throw new Error(String(r.error));
    return { name, ok: true };
  } catch (e) {
    return { name, ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }
}

async function replayInjectedOnTab(tabId) {
  const names = [...injectedScripts.keys()];
  if (names.length === 0) return [];
  await ensureRunner(tabId);
  const results = [];
  for (const name of names) {
    results.push(await runInjectedSource(tabId, name, injectedScripts.get(name)));
  }
  return results;
}

// ---- Page-context bootstrap functions --------------------------------------
// These are serialized into the page by executeScript; they MUST NOT close
// over module scope. Everything arrives via `args`.

/** Compile + run `source` (arrow/function expression preferred, statements ok).
 *  Statement bodies access their arguments via the rest array `__argv`. */
function __mcpEval(source, callArgs) {
  const argv = Array.isArray(callArgs) ? callArgs : [];
  let fn;
  try {
    fn = new Function(`"use strict"; return (${source});`)();
  } catch {
    fn = undefined;
  }
  if (typeof fn !== "function") {
    fn = new Function(`"use strict"; return (function (...__argv) {\n${source}\n});`)();
  }
  return Promise.resolve()
    .then(() => fn.apply(null, argv))
    .then(
      (v) => {
        try { return JSON.parse(JSON.stringify(v === undefined ? null : v)); }
        catch { return String(v); }
      },
      (e) => ({ __mcpError: String((e && e.message) || e) }),
    );
}

/** Dispatch CustomEvent `mcp-inject:<name>` and await the reply event carrying
 *  our nonce. Contract for injected.js:
 *    addEventListener(`mcp-inject:${name}`, (ev) => {
 *      const { data, replyEvent } = ev.detail;
 *      ...work...
 *      window.dispatchEvent(new CustomEvent(replyEvent, { detail: result }));
 *    });
 */
function __mcpSendInjected(name, payload, nonce, timeoutMs) {
  return new Promise((resolve) => {
    const replyEvent = `mcp-inject-res:${nonce}`;
    let timer = null;
    const onReply = (ev) => {
      if (timer) clearTimeout(timer);
      cleanup();
      resolve({ detail: ev && ev.detail !== undefined ? ev.detail : null });
    };
    function cleanup() {
      window.removeEventListener(replyEvent, onReply, true);
    }
    cleanup();
    window.addEventListener(replyEvent, onReply, true);
    try {
      window.dispatchEvent(new CustomEvent(`mcp-inject:${name}`, {
        detail: { data: payload, nonce, replyEvent },
      }));
    } catch (e) {
      if (timer) clearTimeout(timer);
      cleanup();
      resolve({ detail: null, dispatchError: String((e && e.message) || e) });
      return;
    }
    timer = setTimeout(() => { cleanup(); resolve({ __timeout: true }); }, timeoutMs);
  });
}

/** One poll-slice of the captcha wait. Requires the content.js observer
 *  contract: `window.__mcpCaptcha = { solved:boolean, kind:string|null }`
 *  plus a `mcp:captcha-solved` CustomEvent on completion. */
function __mcpWaitCaptchaChunk(sliceMs) {
  return new Promise((resolve) => {
    const snap = () =>
      (window.__mcpCaptcha && typeof window.__mcpCaptcha === "object")
        ? { solved: !!window.__mcpCaptcha.solved, kind: window.__mcpCaptcha.kind ?? null }
        : null;
    const s0 = snap();
    if (s0 && s0.solved) { resolve({ solved: true, kind: s0.kind, alreadyClear: true }); return; }
    const EV = "mcp:captcha-solved";
    const deadline = Date.now() + sliceMs;
    let done = false;
    let iv = null;
    const finish = (outcome) => {
      if (done) return;
      done = true;
      window.removeEventListener(EV, onSolved, true);
      if (iv) clearInterval(iv);
      resolve(outcome);
    };
    const onSolved = (ev) => finish({ solved: true, kind: (ev && ev.detail && ev.detail.kind) ?? null });
    window.addEventListener(EV, onSolved, true);
    iv = setInterval(() => {
      const s = snap();
      if (s && s.solved) finish({ solved: true, kind: s.kind });
      else if (Date.now() >= deadline) finish({ sliced: true });
    }, 350);
  });
}

// ============================================================================
// §13 Tab-load waiting
// ============================================================================

function normUntil(v) {
  if (v === "complete" || v === "load") return "complete";
  if (v === "domcontentloaded" || v === "interactive") return "domcontentloaded";
  return "domcontentloaded";
}

async function probeReadyState(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.readyState,
    });
    return results && results[0] ? results[0].result : null;
  } catch {
    return null; // restricted targets: fall back to tab.status polling
  }
}

/**
 * Wait until the tab settles. `until="complete"` waits for tab.status; the
 * faster `until="domcontentloaded"` additionally probes document.readyState so
 * we resolve the moment parsing finishes rather than waiting for subresources.
 */
async function waitTabSettled(tabId, until, timeoutMs) {
  const interactive = until === "domcontentloaded";
  const deadline = nowTs() + timeoutMs;
  for (;;) {
    const tab = await getTabOrThrow(tabId); // throws TAB_NOT_FOUND mid-navigation
    const status = tab.status || "complete";
    if (status === "complete") {
      return { tabId, url: tab.url ?? null, status: "complete", title: tab.title ?? null };
    }
    if (interactive) {
      const rs = await probeReadyState(tabId);
      if (rs && rs !== "loading") {
        return { tabId, url: tab.url ?? null, status: rs, title: tab.title ?? null };
      }
    }
    if (nowTs() >= deadline) {
      throw rpcErr(ERR.NAV_TIMEOUT, `Tab did not reach "${until}" within ${timeoutMs}ms`, true);
    }
    await sleep(Math.min(200, Math.max(50, deadline - nowTs())));
  }
}

// ============================================================================
// §14 Operation handlers
// ============================================================================

function reqNum(args, key) {
  const v = args ? args[key] : undefined;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  throw rpcErr(ERR.BAD_REQUEST, `Missing or invalid numeric argument: ${key}`);
}

function optNum(args, key, dflt, min, max) {
  const v = args ? args[key] : undefined;
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v === "number" && Number.isFinite(v)) return Math.min(max, Math.max(min, v));
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.min(max, Math.max(min, Number(v)));
  }
  throw rpcErr(ERR.BAD_REQUEST, `Invalid numeric argument: ${key}`);
}

function optStr(args, key) {
  const v = args ? args[key] : undefined;
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

const ok = (result) => ({ ok: true, result });

// ---- Browser state ----------------------------------------------------------

async function hBrowserState(args) {
  const wins = await cbp(chrome.windows.getAll.bind(chrome.windows), {}).catch((e) => { throw mapChromeError(e); });
  const tabs = await cbp(chrome.tabs.query.bind(chrome.tabs), {}).catch((e) => { throw mapChromeError(e); });
  const activeWindowId = browserState.lastFocusedWindowId;
  let activeTabId = browserState.currentTabId;
  if (activeWindowId != null) {
    const act = await cbp(chrome.tabs.query.bind(chrome.tabs), { windowId: activeWindowId, active: true }).catch(() => []);
    if (act && act[0]) {
      activeTabId = act[0].id;
      browserState.activeTabByWindow.set(activeWindowId, act[0].id);
      browserState.currentTabId = act[0].id;
    }
  }
  return ok({
    windowCount: wins.length,
    tabCount: tabs.length,
    activeTabId: activeTabId ?? null,
    activeWindowId: activeWindowId ?? null,
    connected: true,
    transport: isOpen(ws) ? "websocket" : nativePort ? "native" : "offline",
    sessionId,
    extVersion: EXT_VERSION,
  });
}

// ---- Tab operations ----------------------------------------------------------

async function hTabList(args) {
  const tabs = await cbp(chrome.tabs.query.bind(chrome.tabs), {}).catch((e) => { throw mapChromeError(e); });
  const widRaw = args ? args.windowId : undefined;
  const filtered = (widRaw !== undefined && widRaw !== null && Number.isFinite(Number(widRaw)))
    ? tabs.filter((t) => t.windowId === Number(widRaw))
    : tabs;
  return ok({ count: filtered.length, tabs: filtered.map(tabInfo) });
}

async function hTabOpen(args) {
  const rawUrl = optStr(args, "url") ?? "about:blank";
  const url = rawUrl === "about:blank" ? rawUrl : assertSafeNavUrl(rawUrl);
  const active = args && args.background !== undefined
    ? !args.background
    : (args && args.active !== undefined ? !!args.active : true);
  const createProps = { url, active };
  if (args && args.windowId !== undefined && args.windowId !== null && Number.isFinite(Number(args.windowId))) {
    createProps.windowId = Number(args.windowId);
  }
  if (args && Number.isFinite(args.index)) createProps.index = args.index;
  const tab = await cbp(chrome.tabs.create.bind(chrome.tabs), createProps).catch((e) => { throw mapChromeError(e); });
  return ok({ created: true, tab: tabInfo(tab) });
}

async function hTabActivate(args) {
  const tabId = reqNum(args, "tabId");
  const tab = await getTabOrThrow(tabId);
  await cbp(chrome.tabs.update.bind(chrome.tabs), tabId, { active: true }).catch((e) => { throw mapChromeError(e); });
  if (tab.windowId != null) {
    cbp(chrome.windows.update.bind(chrome.windows), tab.windowId, { focused: true }).catch(() => { /* noop */ });
  }
  const updated = await getTabOrThrow(tabId).catch(() => null);
  return ok({ activated: true, tab: updated ? tabInfo(updated) : { id: tabId } });
}

async function hTabClose(args) {
  const tabId = reqNum(args, "tabId");
  await cbp(chrome.tabs.remove.bind(chrome.tabs), tabId).catch((e) => { throw mapChromeError(e); });
  return ok({ closed: true, tabId });
}

async function hTabInfo(args) {
  const tabId = reqNum(args, "tabId");
  const tab = await getTabOrThrow(tabId);
  return ok({ tab: tabInfo(tab) });
}

// ---- Window operations -------------------------------------------------------

async function hWinList(args) {
  const wins = await cbp(chrome.windows.getAll.bind(chrome.windows), { populate: true })
    .catch((e) => { throw mapChromeError(e); });
  return ok({ count: wins.length, windows: wins.map(winInfo) });
}

async function hWinActivate(args) {
  const windowId = reqNum(args, "windowId");
  await cbp(chrome.windows.update.bind(chrome.windows), windowId, { focused: true })
    .catch((e) => { throw mapChromeError(e); });
  return ok({ focused: true, windowId });
}

async function hWinClose(args) {
  const windowId = reqNum(args, "windowId");
  await cbp(chrome.windows.remove.bind(chrome.windows), windowId)
    .catch((e) => { throw mapChromeError(e); });
  return ok({ closed: true, windowId });
}

// ---- Navigation ----------------------------------------------------------------

async function hNavGoto(args) {
  const tabId = reqNum(args, "tabId");
  const url = assertSafeNavUrl(optStr(args, "url"));
  await getTabOrThrow(tabId); // early, clean TAB_NOT_FOUND
  const startedAt = nowTs();
  await cbp(chrome.tabs.update.bind(chrome.tabs), tabId, { url }).catch((e) => { throw mapChromeError(e); });
  const until = normUntil(args ? args.waitUntil : undefined);
  const timeoutMs = optNum(args, "timeoutMs", DEFAULT_OP_TIMEOUT_MS, 1000, 300_000);
  const settled = await waitTabSettled(tabId, until, timeoutMs);
  return ok({ ...settled, requestedUrl: url, until, elapsedMs: nowTs() - startedAt });
}

async function hNavWaitReady(args) {
  const tabId = reqNum(args, "tabId");
  await getTabOrThrow(tabId);
  const until = normUntil(args ? args.until : undefined);
  const timeoutMs = optNum(args, "timeoutMs", DEFAULT_OP_TIMEOUT_MS, 1000, 300_000);
  const settled = await waitTabSettled(tabId, until, timeoutMs);
  return ok({ ...settled, until });
}

// ---- Content-script eval --------------------------------------------------------

async function hCsEval(args) {
  const tabId = reqNum(args, "tabId");
  const source = optStr(args, "func") ?? optStr(args, "source");
  if (!source) throw rpcErr(ERR.BAD_REQUEST, 'cs.eval requires "func" (function/arrow source string)');
  const tab = await getTabOrThrow(tabId);
  assertInjectableTab(tab);
  const world = args && args.world === "MAIN" ? "MAIN" : "ISOLATED";
  const callArgs = Array.isArray(args.args) ? args.args : [];
  const allFrames = !!(args && args.allFrames);
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames },
    world,
    func: __mcpEval,
    args: [source, callArgs],
  }).catch((e) => { throw mapChromeError(e); });

  const frames = (results || []).map((r) => {
    if (r && r.error) return { frameId: r.frameId, error: String(r.error).slice(0, 300) };
    const v = r ? r.result : undefined;
    if (v && typeof v === "object" && !Array.isArray(v) && typeof v.__mcpError === "string") {
      return { frameId: r.frameId, error: v.__mcpError.slice(0, 300) };
    }
    return { frameId: r ? r.frameId : null, value: v === undefined ? null : v };
  });

  const bad = frames.find((f) => f.error);
  if (!allFrames && bad) throw rpcErr(ERR.EVAL_FAILED, bad.error);
  return ok(allFrames ? { allFrames: true, frames } : { value: frames[0] ? frames[0].value : null, frameCount: frames.length });
}

// ---- Debugger passthrough ---------------------------------------------------------

async function hDbgCmd(args) {
  const method = optStr(args, "method");
  if (!method) throw rpcErr(ERR.BAD_REQUEST, 'dbg.cmd requires "method"');
  if (!ALLOWED_CDP_METHODS.has(method)) {
    throw rpcErr(ERR.CDP_METHOD_BLOCKED, `CDP method not allowlisted: ${method}`);
  }
  const tabId = reqNum(args, "tabId");
  await getTabOrThrow(tabId);
  const params = (args.params && typeof args.params === "object" && !Array.isArray(args.params))
    ? args.params
    : {};
  const result = await withDebugger(tabId, (t) => cdpSend(t, method, params));
  return ok(result);
}

// ---- Trusted input (CDP Input domain) ----------------------------------------------

const MOUSE_TYPES = new Set(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]);
const KEY_TYPES = new Set(["rawKeyDown", "keyDown", "char", "keyUp"]);
const MODIFIER_BITS = { alt: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, shift: 8 };
const VK_TABLE = {
  Enter: 13, Backspace: 8, Delete: 46, Tab: 9, Escape: 27,
  " ": 32, Spacebar: 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45,
};

function parseModifiers(m) {
  if (m === undefined || m === null) return 0;
  if (typeof m === "number" && Number.isFinite(m)) return Math.max(0, Math.floor(m));
  if (Array.isArray(m)) {
    return m.reduce((acc, k) => acc | (MODIFIER_BITS[String(k).toLowerCase()] || 0), 0);
  }
  if (typeof m === "string") {
    const b = MODIFIER_BITS[m.toLowerCase()];
    if (b) return b;
  }
  throw rpcErr(ERR.BAD_REQUEST, "modifiers must be a bitmask number or an array like [\"ctrl\",\"shift\"]");
}

function virtualKeyFor(key, code) {
  if (key && VK_TABLE[key] != null) return VK_TABLE[key];
  if (code) {
    let m = /^Key([A-Z])$/.exec(code);
    if (m) return m[1].charCodeAt(0);
    m = /^Digit([0-9])$/.exec(code);
    if (m) return 48 + Number(m[1]);
    m = /^Numpad([0-9])$/.exec(code);
    if (m) return 96 + Number(m[1]);
  }
  if (key && key.length === 1) return key.toUpperCase().charCodeAt(0);
  return 0;
}

async function hInputMouse(args) {
  const tabId = reqNum(args, "tabId");
  const type = optStr(args, "type");
  if (!type || !MOUSE_TYPES.has(type)) {
    throw rpcErr(ERR.BAD_REQUEST, `input.mouse.type must be one of: ${[...MOUSE_TYPES].join(", ")}`);
  }
  const x = reqNum(args, "x");
  const y = reqNum(args, "y");
  const params = { type, x, y, modifiers: parseModifiers(args.modifiers) };
  if (type === "mousePressed" || type === "mouseReleased") {
    params.button = ["left", "middle", "right"].includes(args.button) ? args.button : "left";
    params.clickCount = optNum(args, "clickCount", 1, 1, 5);
  } else if (type === "mouseWheel") {
    params.button = "none";
    params.deltaX = Number(args.deltaX) || 0;
    params.deltaY = Number(args.deltaY) || 0;
  }
  await getTabOrThrow(tabId);
  await withDebugger(tabId, (t) => cdpSend(t, "Input.dispatchMouseEvent", params));
  return ok({ sent: true, input: params });
}

async function hInputKey(args) {
  const tabId = reqNum(args, "tabId");
  const type = optStr(args, "type");
  if (!type || !KEY_TYPES.has(type)) {
    throw rpcErr(ERR.BAD_REQUEST, `input.key.type must be one of: ${[...KEY_TYPES].join(", ")}`);
  }
  const key = optStr(args, "key");
  const code = optStr(args, "code");
  if (!key && !code) throw rpcErr(ERR.BAD_REQUEST, 'input.key requires "key" or "code"');
  const vk = typeof args.windowsVirtualKeyCode === "number" && Number.isFinite(args.windowsVirtualKeyCode)
    ? args.windowsVirtualKeyCode
    : virtualKeyFor(key || "", code || "");
  const params = {
    type,
    key: key || "",
    code: code || "",
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    modifiers: parseModifiers(args.modifiers),
  };
  const text = optStr(args, "text");
  if (text) params.text = text;
  else if (type === "char" && key && key.length === 1) params.text = key;
  await getTabOrThrow(tabId);
  await withDebugger(tabId, (t) => cdpSend(t, "Input.dispatchKeyEvent", params));
  return ok({ sent: true, input: params });
}

// ---- Network capture -----------------------------------------------------------------

async function hNetStart(args) {
  const tabId = reqNum(args, "tabId");
  const maxTimeMs = optNum(args, "maxTimeMs", optNum(args, "maxTime", DEFAULT_OP_TIMEOUT_MS, 1000, 600_000), 1000, 600_000);
  const includeStatic = !!(args && args.includeStatic);
  const tab = await getTabOrThrow(tabId);
  assertInjectableTab(tab); // debugger cannot attach to Web Store / chrome://
  const cap = await startNetCapture(tabId, { maxTimeMs, includeStatic });
  return ok({ capturing: true, tabId, startedAt: cap.startedAt, maxTimeMs, includeStatic });
}

async function hNetStop(args) {
  const entries = netCapture ? await finalizeCapture("stopped") : [];
  return ok({ capturing: false, reason: entries.length ? "stopped" : "inactive", count: entries.length, requests: entries });
}

async function hNetPeek(args) {
  if (!netCapture) return ok({ capturing: false, count: 0, requests: [] });
  const snapshot = netCapture.entries.slice().sort((a, b) => a.ts - b.ts);
  return ok({
    capturing: true,
    tabId: netCapture.tabId,
    elapsedMs: nowTs() - netCapture.startedAt,
    count: snapshot.length,
    requests: snapshot.slice(-20), // last 20 without stopping
  });
}

// ---- HTTP through the browser profile ---------------------------------------------------

const FORBIDDEN_HEADERS = new Set([
  "cookie", "cookie2", "host", "content-length", "connection", "origin",
  "referer", "user-agent", "accept-charset", "accept-encoding", "date",
  "dnt", "expect", "keep-alive", "te", "trailer", "transfer-encoding",
  "upgrade", "via", "proxy-connection",
]);

async function hHttpRequest(args) {
  const url = assertSafeFetchUrl(optStr(args, "url"));
  const method = (typeof args.method === "string" ? args.method : "GET").toUpperCase();
  if (!["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(method)) {
    throw rpcErr(ERR.BAD_REQUEST, `http.request method "${method}" not allowed`);
  }
  const headersIn = (args.headers && typeof args.headers === "object" && !Array.isArray(args.headers))
    ? args.headers
    : {};
  const headers = {};
  const skippedHeaders = [];
  for (const [k, v] of Object.entries(headersIn)) {
    const lk = String(k).toLowerCase();
    if (FORBIDDEN_HEADERS.has(lk) || typeof v !== "string") {
      skippedHeaders.push(String(k));
      continue;
    }
    headers[String(k)] = v;
  }
  let body;
  const wantsBody = args.body !== undefined && args.body !== null && method !== "GET" && method !== "HEAD";
  if (wantsBody) {
    if (typeof args.body === "string") {
      body = args.body;
    } else {
      body = JSON.stringify(args.body);
      if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
  }
  const timeoutMs = optNum(args, "timeoutMs", DEFAULT_OP_TIMEOUT_MS, 1000, 300_000);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body,
      credentials: "include", // ride the browser profile's cookies
      redirect: "follow",
      signal: ctl.signal,
    });
    const text = await res.text();
    const truncated = text.length > MAX_HTTP_BODY_CHARS;
    const resHeaders = {};
    res.headers.forEach((v, k) => { resHeaders[k] = v; });
    return ok({
      status: res.status,
      statusText: res.statusText,
      ok: res.ok,
      url: res.url,
      redirected: res.redirected,
      headers: resHeaders,
      body: truncated ? text.slice(0, MAX_HTTP_BODY_CHARS) : text,
      truncated,
      byteLength: text.length,
      skippedHeaders,
    });
  } catch (e) {
    if (ctl.signal.aborted) {
      throw rpcErr(ERR.TIMEOUT, `http.request timed out after ${timeoutMs}ms`, true);
    }
    throw rpcErr(ERR.HTTP_ERROR, String((e && e.message) || e), true);
  } finally {
    clearTimeout(timer);
  }
}

// ---- Cookies ------------------------------------------------------------------------------

async function hCookieAll(args) {
  const details = {};
  const u = optStr(args, "url"); if (u) details.url = u;
  const nm = optStr(args, "name"); if (nm) details.name = nm;
  const dm = optStr(args, "domain"); if (dm) details.domain = dm;
  const pt = optStr(args, "path"); if (pt) details.path = pt;
  const sid = optStr(args, "storeId"); if (sid) details.storeId = sid;
  const cookies = await cbp(chrome.cookies.getAll.bind(chrome.cookies), details)
    .catch((e) => { throw mapChromeError(e); });
  return ok({ count: cookies.length, cookies });
}

async function hCookieSet(args) {
  const c = args ? args.cookie : undefined;
  if (!c || typeof c !== "object" || Array.isArray(c)) {
    throw rpcErr(ERR.BAD_REQUEST, 'cookie.set requires "cookie" object');
  }
  if (typeof c.name !== "string" || c.name === "") {
    throw rpcErr(ERR.BAD_REQUEST, "cookie.name is required");
  }
  const details = { name: c.name, value: typeof c.value === "string" ? c.value : "" };
  if (typeof c.url === "string" && c.url) {
    details.url = c.url;
  } else if (typeof c.domain === "string" && c.domain) {
    details.url = `https://${c.domain.replace(/^\./, "")}${typeof c.path === "string" && c.path ? c.path : "/"}`;
  } else {
    throw rpcErr(ERR.BAD_REQUEST, "cookie requires url or domain");
  }
  if (typeof c.path === "string" && c.path) details.path = c.path;
  if (typeof c.secure === "boolean") details.secure = c.secure;
  if (typeof c.httpOnly === "boolean") details.httpOnly = c.httpOnly;
  if (typeof c.expirationDate === "number" && Number.isFinite(c.expirationDate)) {
    details.expirationDate = c.expirationDate;
  }
  if (typeof c.storeId === "string" && c.storeId) details.storeId = c.storeId;
  if (typeof c.sameSite === "string" &&
      ["no_restriction", "lax", "strict", "unspecified"].includes(c.sameSite)) {
    details.sameSite = c.sameSite;
  }
  const stored = await cbp(chrome.cookies.set.bind(chrome.cookies), details)
    .catch((e) => { throw mapChromeError(e); });
  if (!stored) throw rpcErr(ERR.INTERNAL, "cookies.set rejected the cookie (check url/domain/path)");
  return ok({ set: true, cookie: stored });
}

// ---- Injected scripts ----------------------------------------------------------------------

async function hInjectedRegister(args) {
  const name = optStr(args, "name");
  if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw rpcErr(ERR.BAD_REQUEST, "name must match [A-Za-z0-9_-]{1,64}");
  }
  const code = optStr(args, "code");
  if (!code) throw rpcErr(ERR.BAD_REQUEST, 'injected.register requires "code"');
  injectedScripts.set(name, code);
  await persistInjectedRegistry();
  return ok({ registered: name, total: injectedScripts.size });
}

async function hInjectedReplay(args) {
  const tabId = reqNum(args, "tabId");
  const tab = await getTabOrThrow(tabId);
  assertInjectableTab(tab);
  const results = injectedScripts.size > 0 ? await replayInjectedOnTab(tabId) : [];
  return ok({
    total: results.length,
    okCount: results.filter((r) => r.ok).length,
    results,
  });
}

async function hInjectedSend(args) {
  const tabId = reqNum(args, "tabId");
  const name = optStr(args, "name");
  if (!name) throw rpcErr(ERR.BAD_REQUEST, 'injected.send requires "name"');
  const tab = await getTabOrThrow(tabId);
  assertInjectableTab(tab);
  await ensureRunner(tabId); // best-effort: runtime may pre-exist on the page
  const payload = args.data === undefined ? null : args.data; // must be JSON-serializable
  const nonce = uid("n");
  const timeoutMs = optNum(args, "timeoutMs", 10_000, 500, 60_000);
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: "MAIN",
    func: __mcpSendInjected,
    args: [name, payload, nonce, timeoutMs],
  }).catch((e) => { throw mapChromeError(e); });
  const r = results && results[0];
  if (r && r.error) throw rpcErr(ERR.EVAL_FAILED, String(r.error).slice(0, 300));
  const out = r ? r.result : undefined;
  if (out && out.__timeout) {
    throw rpcErr(ERR.INJECTED_TIMEOUT, `No response for injected.send("${name}") within ${timeoutMs}ms`, true);
  }
  return ok({ name, data: out ? (out.detail ?? null) : null });
}

// ---- CAPTCHA wait ---------------------------------------------------------------------------

async function hCaptchaWait(args) {
  const tabId = reqNum(args, "tabId");
  const tab = await getTabOrThrow(tabId);
  assertInjectableTab(tab);
  const timeoutMs = optNum(args, "timeoutMs", 60_000, 1000, 180_000);
  const startedAt = nowTs();
  const deadline = startedAt + timeoutMs;
  // Chunked slices keep each executeScript bounded; the outer loop spans the
  // full budget. Delegates detection to content.js's MutationObserver contract.
  for (;;) {
    const remaining = deadline - nowTs();
    if (remaining <= 0) break;
    const slice = Math.min(8000, remaining);
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED", // shares the world with content.js
      func: __mcpWaitCaptchaChunk,
      args: [slice],
    }).catch((e) => { throw mapChromeError(e); });
    const r = results && results[0];
    if (r && r.error) throw rpcErr(ERR.EVAL_FAILED, String(r.error).slice(0, 300));
    const res = r ? r.result : undefined;
    if (res && res.solved) {
      return ok({ solved: true, kind: res.kind ?? null, alreadyClear: !!res.alreadyClear, elapsedMs: nowTs() - startedAt });
    }
  }
  throw rpcErr(ERR.CAPTCHA_WAIT_TIMEOUT,
    `No captcha resolution within ${timeoutMs}ms (needs content.js observer: window.__mcpCaptcha / "mcp:captcha-solved")`);
}

// ============================================================================
// §15 Wiring & init
// ============================================================================

let initStarted = false;

async function init() {
  if (initStarted) return;
  initStarted = true;
  await loadSettings();
  loadInjectedRegistry();
  primeBrowserState().catch((e) => log("state priming failed:", e?.message || e));
  connectLoop();
  maybeStartNative();
  log(`background ready (v${EXT_VERSION})`);
}

init();
