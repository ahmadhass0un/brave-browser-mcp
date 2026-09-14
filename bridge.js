/**
 * browser-navigator — bridge.js
 * Transport abstraction between MCP tools (tools.js) and the browser extension.
 *
 * Sections:
 *   §1  Constants, timeout policy      §5  Current-tab pointer
 *   §2  Transport registry             §6  Facades: tabs/windows/nav/dbg/input
 *   §3  call() + inbound routing       §7  Facades: net/cookies/injected/http/captcha
 *   §4  RefMap                         §8  dom facade (cs.eval composition)
 */

import {
  ERROR_CODES, RpcError, rpcErr, makeReq, makeEvt, uuid, validateEnvelope,
} from "./lib/proto.js";

// ============================================================================
// §1 Constants & timeout policy
// ============================================================================

const LOG_PREFIX = "[bridge]";
const log = (...parts) => { try { console.error(LOG_PREFIX, ...parts); } catch { /* noop */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Transport budgets. tools.js may override per-call via opts.timeoutMs. */
export const TIMEOUTS = Object.freeze({
  DEFAULT: 20_000,
  NAV_GOTO: 45_000,
  READ_PAGE: 30_000,
  SCREENSHOT: 25_000,
  PDF_EXPORT: 40_000,
  NET_STOP: 15_000,
});

const OP_TIMEOUT_MS = Object.freeze({
  "nav.goto": TIMEOUTS.NAV_GOTO,
  read_page: TIMEOUTS.READ_PAGE,
  screenshot: TIMEOUTS.SCREENSHOT,
  pdf_export: TIMEOUTS.PDF_EXPORT,
  "net.stop": TIMEOUTS.NET_STOP,
  "cs.eval": 5_000, // Patch 2: click 5s not 20s (was 20s tail even for instant click)
  "content.exec": 5_000,
});

/** dbg.cmd budgets keyed by CDP method (the read_page / screenshot / pdf trio). */
const DBG_METHOD_TIMEOUT_MS = {
  "Accessibility.getFullAXTree": TIMEOUTS.READ_PAGE,
  "Page.captureScreenshot": TIMEOUTS.SCREENSHOT,
  "Page.printToPDF": TIMEOUTS.PDF_EXPORT,
};

function resolveTimeoutMs(op, args, opts) {
  if (Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0) return Math.min(300_000, Math.floor(opts.timeoutMs));
  const base = OP_TIMEOUT_MS[op]
    || (op === "dbg.cmd" ? DBG_METHOD_TIMEOUT_MS[args?.method] : undefined)
    || TIMEOUTS.DEFAULT;
  return Math.min(300_000, base);
}

// ============================================================================
// §2 Transport — WebSocket only
// ============================================================================

const WebSocket_OPEN = 1;
let wsTransport = null;

export function pick() {
  if (wsTransport && wsTransport.readyState === WebSocket_OPEN) return wsTransport;
  return null;
}

export function transportName() {
  if (wsTransport && wsTransport.readyState === WebSocket_OPEN) return "websocket";
  return null;
}

function sendEnvelope(env) {
  const t = pick();
  if (!t) return false;
  try {
    t.send(JSON.stringify(env));
    return true;
  } catch (e) {
    log("send failed:", e?.message || e);
    return false;
  }
}

/** A new socket is a new session: pending envelopes from the old one are dead. */
function invalidatePending(reason) {
  if (pending.size === 0) return;
  const err = new RpcError(ERROR_CODES.TRANSPORT_LOST, reason, true);
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(err);
  }
}

/** A new socket is a new session ONLY when it supersedes an OPEN one.
 *  A reconnect after a close/restart (prev CLOSED/null) should NOT kill
 *  pending calls — the same extension session continues. */
export function setWs(ws) {
  const prev = wsTransport;
  if (prev === ws) return;
  wsTransport = ws ?? null;
  if (prev && prev.readyState === WebSocket_OPEN) {
    // True supersede (e.g. another client): old session dead
    try { prev.close(4002, "superseded"); } catch { /* already gone */ }
    invalidatePending("transport changed mid-call");
  }
  // Reconnect (prev CLOSED/null): keep pending intact — same session, new link.
}

let shuttingDown = false;

/** Close every transport and fail anything still in flight. Terminal (SIGINT/SIGTERM). */
export function shutdown() {
  shuttingDown = true;
  const err = new RpcError(ERROR_CODES.NOT_CONNECTED, "Bridge shut down", false);
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(err);
  }
  const sock = wsTransport;
  wsTransport = null;
  if (sock) { try { sock.close(1001, "server-shutdown"); } catch { /* gone */ } }
  clearRefs();
  recentEvents.length = 0;
}

/** Reversible disconnect (the `disconnect` MCP tool): drop the transport and
 *  pending calls, but let the next extension handshake re-wire via setWs().
 *  The extension's auto-reconnect will re-handshake and recover. */
export function reset() {
  const sock = wsTransport;
  wsTransport = null;
  const err = new RpcError(ERROR_CODES.TRANSPORT_LOST, "Disconnected by request", true);
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(err);
  }
  if (sock) { try { sock.close(1000, "client-disconnect"); } catch { /* gone */ } }
  setCurrentTab(null);
  clearRefs();
  recentEvents.length = 0;
}

// ============================================================================
// §3 call() — request/response correlation over the active transport
// ============================================================================

const pending = new Map(); // req id -> { resolve, reject, timer }

const PENDING_MAX = 500; // §F.1 cap unbounded pending (was O(n) invalidate + 20s tail)
export async function call(op, args = {}, opts = {}) {
  if (shuttingDown) throw new RpcError(ERROR_CODES.NOT_CONNECTED, "Bridge shut down", false);
  if (!pick()) {
    throw new RpcError(ERROR_CODES.NOT_CONNECTED,
      "Not connected to the browser extension. Run connect_brave first.", true);
  }
  if (pending.size >= PENDING_MAX) {
    throw new RpcError(ERROR_CODES.TIMEOUT, `Too many pending calls (${pending.size}) — throttling`, true);
  }
  const env = makeReq(op, args ?? {});
  const budgetMs = resolveTimeoutMs(op, args, opts);
  const outcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(env.id);
      reject(new RpcError(ERROR_CODES.TIMEOUT, `"${op}" timed out after ${budgetMs}ms`, true));
    }, budgetMs);
    timer.unref?.();
    pending.set(env.id, { resolve, reject, timer });
  });
  if (!sendEnvelope(env)) {
    const entry = pending.get(env.id);
    if (entry) {
      clearTimeout(entry.timer);
      pending.delete(env.id);
      entry.reject(new RpcError(ERROR_CODES.TRANSPORT_LOST, "Transport dropped while sending", true));
    }
  }
  return outcome;
}

/** Single inlet for every frame a transport receives (res + evt). */
export function onTransportMessage(env) {
  if (!validateEnvelope(env)) {
    log("dropping malformed envelope:", JSON.stringify(env)?.slice(0, 160));
    return;
  }
  if (env.type !== "res" && env.type !== "evt") return;
  if (env.type === "res") {
    const key = String(env.id);
    const entry = pending.get(key);
    if (!entry) { log("stale/duplicate res ignored:", env.id); return; }
    clearTimeout(entry.timer);
    pending.delete(key);
    if (env.ok) {
      entry.resolve(env.result ?? {});
    } else {
      const e = env.error ?? {};
      entry.reject(new RpcError(e.code, e.message, e.retriable, e.data));
    }
    return;
  }
  ingestEvent(env); // evt
}

// ---- Event bus (recent only; no external listeners needed) -------------------

const EVENT_BUFFER_MAX = 200;
const recentEvents = [];

export const drainRecentEvents = () => recentEvents.splice(0);

function ingestEvent(env) {
  // keep bridge tab pointer in sync with browser
  if (env.event === "tab.activated" && env.data?.tabId != null) {
    setCurrentTab(env.data.tabId, env.data.windowId ?? null);
  } else if (env.event === "win.focused" && env.data?.windowId != null) {
    // win focus will be followed by tab.activated but record
    currentWindowId = env.data.windowId;
  }
  // cap data size per event
  let data = env.data;
  try {
    const s = JSON.stringify(data);
    if (s && s.length > 100 * 1024) data = { truncated: true, _origSize: s.length };
  } catch {}
  const record = makeEvt(env.event, data);
  record.ts = env.ts ?? record.ts;
  recentEvents.push(record);
  if (recentEvents.length > EVENT_BUFFER_MAX) recentEvents.shift();
}

// ============================================================================
// §4 RefMap — read_page produces ref_N ids; click/computer consume them
// ============================================================================

export const refMap = new Map(); // "ref_N" -> { selector, role, name }
let refCounter = 0;

export function registerRef(info) {
  refCounter += 1;
  const refId = `ref_${refCounter}`;
  refMap.set(refId, {
    selector: info?.selector ?? null,
    role: info?.role ?? null,
    name: info?.name ?? null,
  });
  return refId;
}

export function clearRefs() {
  refMap.clear();
  refCounter = 0;
}

export function resolveRef(refId) {
  if (refId == null) return undefined;
  let key = typeof refId === "number" && Number.isInteger(refId) ? `ref_${refId}` : String(refId);
  if (!refMap.has(key) && /^\d+$/.test(key)) key = `ref_${key}`; // tolerate bare/numeric-string ids
  return refMap.get(key);
}

// ============================================================================
// §5 Current-tab pointer — connect_brave sets it, most tools read it
// ============================================================================

export let currentTabId = null;
export let currentWindowId = null;

export function setCurrentTab(tabId, windowId = null) {
  const changed = currentTabId !== (tabId ?? null);
  currentTabId = tabId ?? null;
  currentWindowId = windowId ?? null;
  if (changed) clearRefs();
}

export function requireTab() {
  if (currentTabId == null) throw new RpcError(ERROR_CODES.NOT_CONNECTED, "Not connected. Run connect_brave first.", true);
  return currentTabId;
}

// ============================================================================
// §6 Facades — tabs / windows / nav / dbg / input / browser
// ============================================================================

export const tabs = {
  list: (windowId) => call("tab.list", windowId != null ? { windowId } : {}),
  open: (url, opts = {}) => call("tab.open", { url, ...opts }),
  activate: (tabId) => call("tab.activate", { tabId }),
  close: (tabId) => call("tab.close", { tabId }),
  info: (tabId) => call("tab.info", { tabId }),
};

export const windows = {
  list: () => call("win.list"),
  activate: (windowId) => call("win.activate", { windowId }),
  close: (windowId) => call("win.close", { windowId }),
};

export const nav = {
  goto: (url, opts = {}) => {
    const args = { tabId: opts.tabId ?? requireTab(), url };
    if (opts.waitUntil) args.waitUntil = opts.waitUntil;
    if (Number.isFinite(opts.timeoutMs)) args.timeoutMs = opts.timeoutMs;
    if (Number.isFinite(opts.width)) args.width = opts.width;
    if (Number.isFinite(opts.height)) args.height = opts.height;
    if (typeof opts.background === "boolean") args.background = opts.background;
    return call("nav.goto", args, { timeoutMs: opts.timeoutMs });
  },
  waitReady: (opts = {}) => {
    const args = { tabId: opts.tabId ?? requireTab() };
    if (opts.until) args.until = opts.until;
    if (Number.isFinite(opts.timeoutMs)) args.timeoutMs = opts.timeoutMs;
    return call("nav.waitReady", args, { timeoutMs: opts.timeoutMs });
  },
};

export const dbg = {
  command: (tabId, method, params = {}, opts = {}) =>
    call("dbg.cmd", { tabId, method, params }, opts),
};

export const input = {
  /** Atomic trusted click — press+release in one debugger attach (tap-plugin safe). */
  click: (tabId, x, y, opts = {}) =>
    call("input.click", { tabId, x, y, ...opts }),
  mouse: (tabId, params = {}, opts = {}) =>
    call("input.mouse", { tabId, ...params }, opts),
  key: (tabId, params = {}, opts = {}) =>
    call("input.key", { tabId, ...params }, opts),
};

export const history = {
  navigate: (tabId, delta) => call("history.navigate", { tabId, delta }),
};

export const js = {
  evaluate: (tabId, code) => call("js.evaluate", { tabId, code }),
};

export const browser = {
  state: () => call("browser.state"),
};

// ============================================================================
// §7 Facades — net / cookies / injected / http / captcha
// ============================================================================

export const net = {
  start: (opts = {}) => call("net.start", {
    tabId: opts.tabId ?? requireTab(),
    maxTimeMs: opts.maxTimeMs,
    includeStatic: !!opts.includeStatic,
  }),
  stop: () => call("net.stop"),
  peek: () => call("net.peek"),
};

export const cookies = {
  all: (filter = {}) => call("cookie.all", filter),
  set: (cookie) => call("cookie.set", { cookie }),
  remove: (args = {}) => call("cookie.remove", args),
};

export const injected = {
  register: (name, code) => call("injected.register", { name, code }),
  replay: (opts = {}) => call("injected.replay", { tabId: opts.tabId ?? requireTab() }),
  send: (name, data = null, opts = {}) => call("injected.send", {
    tabId: opts.tabId ?? requireTab(), name, data,
    ...(Number.isFinite(opts.timeoutMs) ? { timeoutMs: opts.timeoutMs } : {}),
  }, opts),
};

export const http = {
  request: (args = {}) => call("http.request", args, { timeoutMs: args?.timeoutMs }),
};

export const content = {
  exec: (tabId, op, args = {}) => call("content.exec", { tabId, op, args }),
};

export const dialog = {
  handle: (opts = {}) => call("dialog.handle", opts),
};

export const download = {
  wait: (opts = {}) => call("download.wait", opts),
};

export const captcha = {
  wait: (opts = {}) => {
    const inner = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? opts.timeoutMs : 60_000;
    return call("captcha.wait",
      { tabId: opts.tabId ?? requireTab(), timeoutMs: inner },
      { timeoutMs: inner + 5_000 });
  },
};

// ============================================================================
// §8 dom facade — cs.eval compositions; page fns must be closure-free
// ============================================================================

/** cs.eval returns { value, frameCount }; page fns report failure via {ok:false}. */
async function unwrap(promise, fallbackCode) {
  const res = await promise;
  const value = res && typeof res === "object" && "value" in res ? res.value : res;
  if (value && typeof value === "object" && value.ok === false) {
    throw rpcErr(value.reason || fallbackCode || ERROR_CODES.INTERNAL,
      value.message || `DOM op failed (${value.reason || "unknown"})`, false, value);
  }
  return value ?? res;
}

const targetOf = (target) => {
  if (typeof target === "string") return { selector: target };
  if (target && typeof target === "object") {
    if (target.ref != null) {
      const info = resolveRef(target.ref);
      if (!info?.selector) {
        throw rpcErr(ERROR_CODES.ELEMENT_NOT_FOUND,
          `Unknown ref "${target.ref}" — run read_page to refresh refs`);
      }
      return { selector: info.selector };
    }
    return target; // {selector} | {text}
  }
  throw rpcErr(ERROR_CODES.BAD_REQUEST, "target must be a selector, {text}, or {ref}");
};

function pageClick(t) {
  let el = null;
  let root = document;
  if (t.scope) {
    root = document.querySelector(t.scope);
    if (!root) return { ok: false, reason: "ELEMENT_NOT_FOUND", message: `scope not found: ${t.scope}` };
  }
  if (t.selector) el = root.querySelector(t.selector);
  else if (t.byText != null || t.text != null) {
    const needle = String(t.byText ?? t.text).trim().toLowerCase();
    el = [...root.querySelectorAll(
      "a,button,input[type=submit],input[type=button],summary,label,[role=button],[onclick]",
    )].find((n) => ((n.innerText || n.value || "")).trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.byText ?? t.text };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (hit && hit !== el && !el.contains(hit)) {
    return { ok: false, reason: "CLICK_BLOCKED", target: t.selector ?? t.byText ?? t.text, coveredBy: hit.tagName.toLowerCase() };
  }
  el.click();
  return { ok: true, clicked: t.selector ?? t.byText ?? t.text, tag: el.tagName.toLowerCase() };
}

function pageFill(t, value) {
  const el = t.selector ? document.querySelector(t.selector) : null;
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector };
  const fillable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
  if (!fillable) return { ok: false, reason: "BAD_REQUEST", message: `cannot type into <${el.tagName.toLowerCase()}>` };
  el.focus();
  if (el.isContentEditable) {
    el.textContent = String(value);
  } else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value)); // bypass React/Angular overrides
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, filled: String(value).length, tag: el.tagName.toLowerCase() };
}

function pageExtract(selector) {
  const el = selector ? document.querySelector(selector) : document.body;
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: selector };
  return {
    ok: true, text: (el.innerText || "").slice(0, 200_000),
    title: document.title, url: location.href, readyState: document.readyState,
  };
}

function pageListInteractive(limit) {
  // §F.1 fix: layout thrash — check visible cheap first where possible, cap scan to limit*3
  const nodes = document.querySelectorAll([
    "a[href]", "button", "input", "select", "textarea", "summary",
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    "[onclick]", "[contenteditable=true]",
  ].join(","));
  const out = [];
  let scanned = 0;
  const maxScan = Math.min(nodes.length, Math.max(limit * 3, 150));
  for (let i = 0; i < nodes.length && out.length < limit && scanned < maxScan; i++) {
    const el = nodes[i];
    scanned++;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    const label = el.getAttribute("aria-label");
    out.push({
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      name: (label || el.innerText || el.value || el.placeholder || el.alt || "").trim().slice(0, 80) || null,
      id: el.id || null,
      href: el.href || null,
      type: el.getAttribute("type"),
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    });
  }
  return { ok: true, count: out.length, elements: out, url: location.href, title: document.title };
}

function pageInspect(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: selector };
  const r = el.getBoundingClientRect();
  return {
    ok: true, target: selector, tag: el.tagName.toLowerCase(),
    text: (el.innerText || "").slice(0, 500),
    attrs: [...el.attributes].reduce((m, a) => ((m[a.name] = a.value.slice(0, 200)), m), {}),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    visible: r.width > 0 && r.height > 0,
  };
}

function pageExists(t) {
  if (t.selector) return { ok: true, found: !!document.querySelector(t.selector) };
  if (t.text != null) {
    const needle = String(t.text).trim().toLowerCase();
    if (!needle) return { ok: true, found: false };
    // §F.1 fix: TreeWalker 10k poll → single walk O(n) not QSA 10k + .some 10k
    const root = document.body || document.documentElement;
    if (!root) return { ok: true, found: false };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const txt = (n.nodeValue || "").trim().toLowerCase();
      if (!txt.includes(needle)) continue;
      const parent = n.parentElement;
      if (!parent || parent.children.length !== 0) continue;
      return { ok: true, found: true };
    }
    return { ok: true, found: false };
  }
  return { ok: false, reason: "BAD_REQUEST", message: "target needs selector or text" };
}

function pageDetectCaptcha() {
  // §F.1 fix: avoid outerHTML 1-5MB serialize + 5 regex (30-200ms GC) — use selector checks
  const kinds = [];
  const signals = [];
  if (document.querySelector('iframe[src*="recaptcha"], .g-recaptcha') || window.grecaptcha) { kinds.push("recaptcha"); signals.push("recaptcha"); }
  if (document.querySelector('iframe[src*="hcaptcha"], .h-captcha') || window.hcaptcha) { kinds.push("hcaptcha"); signals.push("hcaptcha"); }
  if (document.querySelector('iframe[src*="challenges.cloudflare"], .cf-turnstile') || window.turnstile) { kinds.push("turnstile"); signals.push("turnstile"); }
  if (document.querySelector('script[src*="geetest"], [class*="geetest"]')) { kinds.push("geetest"); signals.push("geetest"); }
  if (document.querySelector('script[src*="arkoselabs"], script[src*="funcaptcha"]')) { kinds.push("funcaptcha"); signals.push("funcaptcha"); }
  for (const f of document.querySelectorAll("iframe[src]")) {
    const m = /(recaptcha|hcaptcha|turnstile|geetest|arkoselabs)/i.exec(f.src || "");
    if (m) {
      const k = m[1].toLowerCase();
      if (!kinds.includes(k)) { kinds.push(k); signals.push(`iframe:${f.src.slice(0, 120)}`); }
    }
  }
  if (!kinds.length && /verify you are human|are you a robot|confirm you.?re? (a )?human/i.test(document.body?.innerText || "")) {
    kinds.push("unknown");
    signals.push("challenge-text");
  }
  return { ok: true, detected: kinds.length > 0, kind: kinds[0] ?? null, signals: signals.slice(0, 10) };
}

function pageVideoControl(action, arg) {
  const area = (v) => { const r = v.getBoundingClientRect(); return r.width * r.height; };
  const vids = [...document.querySelectorAll("video")].filter((v) => area(v) > 0);
  if (!vids.length) return { ok: false, reason: "ELEMENT_NOT_FOUND", message: "no visible <video> element" };
  const v = vids.reduce((a, b) => (area(b) > area(a) ? b : a));
  switch (action) {
    case "play": v.play().catch(() => {}); break;
    case "pause": v.pause(); break;
    case "toggle": if (v.paused) v.play().catch(() => {}); else v.pause(); break;
    case "seek": v.currentTime = Math.max(0, Math.min(Number(v.duration) || Infinity, Number(arg) || 0)); break;
    case "rate": v.playbackRate = Number(arg) || 1; break;
    case "mute": v.muted = true; break;
    case "unmute": v.muted = false; break;
    default: return { ok: false, reason: "BAD_REQUEST", message: `unknown video action "${action}"` };
  }
  return {
    ok: true, action,
    state: {
      currentTime: v.currentTime, duration: v.duration ?? null, paused: v.paused,
      playbackRate: v.playbackRate, muted: v.muted,
    },
  };
}

function pageWaitFor(t, timeoutMs) {
  const startedAt = Date.now();
  const existsNow = () => {
    if (t.selector) { try { return !!document.querySelector(t.selector); } catch { return false; } }
    if (t.text != null) {
      const needle = String(t.text).trim().toLowerCase();
      if (!needle) return false;
      const root = document.body || document.documentElement;
      if (!root) return false;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const txt = (n.nodeValue || "").trim().toLowerCase();
        if (!txt.includes(needle)) continue;
        const parent = n.parentElement;
        if (!parent || parent.children.length !== 0) continue;
        return true;
      }
      return false;
    }
    return false;
  };
  if (existsNow()) return { ok: true, found: true, elapsedMs: 0 };
  return new Promise((resolve) => {
    let done = false;
    let observer = null;
    let timer = null;
    const finish = (found) => {
      if (done) return;
      done = true;
      if (observer) try { observer.disconnect(); } catch {}
      if (timer) clearTimeout(timer);
      if (found) resolve({ ok: true, found: true, elapsedMs: Date.now() - startedAt });
      else resolve({ ok: false, reason: "TIMEOUT", message: `wait_for timed out after ${timeoutMs}ms` });
    };
    try {
      observer = new MutationObserver(() => { if (existsNow()) finish(true); });
      observer.observe(document.documentElement || document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch { observer = null; }
    // Patch 2: MutationObserver only, remove setInterval poll (was 1000ms) — saves 15-50ms jank per wait_for + 30 polls
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

export const dom = {
  eval: (tabId, func, args = [], opts = {}) =>
    call("cs.eval", {
      tabId,
      func: typeof func === "function" ? func.toString() : String(func),
      args,
      ...(opts.world ? { world: opts.world } : {}),
      ...(opts.allFrames ? { allFrames: true } : {}),
    }, opts),

  clickElement: (tabId, target, opts = {}) =>
    unwrap(dom.eval(tabId, pageClick, [targetOf(target)], opts), ERROR_CODES.ELEMENT_NOT_FOUND),

  fillField: (tabId, target, value, opts = {}) =>
    unwrap(dom.eval(tabId, pageFill, [targetOf(target), value], opts)),

  extractVisibleText: (tabId, selector = null, opts = {}) =>
    unwrap(dom.eval(tabId, pageExtract, [selector], opts)),

  listInteractive: (tabId, opts = {}) =>
    unwrap(dom.eval(tabId, pageListInteractive, [Math.min(Math.max(opts.limit ?? 150, 1), 500)], opts)),

  inspectDom: (tabId, target, opts = {}) =>
    unwrap(dom.eval(tabId, pageInspect, [targetOf(target).selector], opts)),

  exists: (tabId, target, opts = {}) =>
    unwrap(dom.eval(tabId, pageExists, [typeof target === "string" ? { selector: target } : target], opts)),

  detectCaptcha: (tabId, opts = {}) =>
    unwrap(dom.eval(tabId, pageDetectCaptcha, [], opts)),

  videoControl: (tabId, action, arg = null, opts = {}) =>
    unwrap(dom.eval(tabId, pageVideoControl, [action, arg], opts)),

  /** Single-eval wait with MutationObserver + 500ms poll inside page (avoids per-slice serialization). */
  waitFor: async (tabId, target, opts = {}) => {
    const budgetMs = Math.max(1_000, Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15_000);
    const normalized = typeof target === "string" ? { selector: target } : target;
    // outer RPC budget = inner page budget + 5s slack, so the page-side
    // {ok:false,reason:TIMEOUT} result wins the race over the RPC timeout
    return unwrap(dom.eval(tabId, pageWaitFor, [normalized, budgetMs], { ...opts, timeoutMs: budgetMs + 5_000 }), ERROR_CODES.TIMEOUT);
  },
};
