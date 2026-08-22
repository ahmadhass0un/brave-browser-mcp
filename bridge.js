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
const log = (...parts) => { try { console.log(LOG_PREFIX, ...parts); } catch { /* noop */ } };
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

const OP_TIMEOUT_MS = {
  "nav.goto": TIMEOUTS.NAV_GOTO,
  read_page: TIMEOUTS.READ_PAGE,
  screenshot: TIMEOUTS.SCREENSHOT,
  pdf_export: TIMEOUTS.PDF_EXPORT,
  "net.stop": TIMEOUTS.NET_STOP,
};

/** dbg.cmd budgets keyed by CDP method (the read_page / screenshot / pdf trio). */
const DBG_METHOD_TIMEOUT_MS = {
  "Accessibility.getFullAXTree": TIMEOUTS.READ_PAGE,
  "Page.captureScreenshot": TIMEOUTS.SCREENSHOT,
  "Page.printToPDF": TIMEOUTS.PDF_EXPORT,
};

function resolveTimeoutMs(op, args, opts) {
  if (Number.isFinite(opts?.timeoutMs) && opts.timeoutMs > 0) return Math.floor(opts.timeoutMs);
  if (op === "wait_for") { // inner budget + slack for the final poll slice
    const inner = Number.isFinite(args?.timeoutMs) && args.timeoutMs > 0 ? args.timeoutMs : TIMEOUTS.DEFAULT;
    return Math.floor(inner) + 5_000;
  }
  return OP_TIMEOUT_MS[op]
    || (op === "dbg.cmd" ? DBG_METHOD_TIMEOUT_MS[args?.method] : undefined)
    || TIMEOUTS.DEFAULT;
}

// ============================================================================
// §2 Transport registry — WebSocket preferred, native-messaging fallback
// ============================================================================

const WebSocket_OPEN = 1; // ws' WebSocket.OPEN without importing the class
const transports = { ws: null, native: null };

export function pick() {
  if (transports.ws && transports.ws.readyState === WebSocket_OPEN) return transports.ws;
  return transports.native ?? null;
}

export const isConnected = () => pick() !== null;

export function transportName() {
  if (transports.ws && transports.ws.readyState === WebSocket_OPEN) return "websocket";
  if (transports.native) return "native";
  return null;
}

function sendEnvelope(env) {
  const t = pick();
  if (!t) return false;
  try {
    if (t === transports.ws) t.send(JSON.stringify(env));
    else t.postMessage(env); // native port carries structured objects
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

export function setWs(ws) {
  const prev = transports.ws;
  if (prev === ws) return;
  transports.ws = ws ?? null;
  if (prev && prev.readyState === WebSocket_OPEN) {
    try { prev.close(4002, "superseded"); } catch { /* already gone */ }
  }
  invalidatePending("transport changed mid-call");
}

export function setNative(native) {
  const prev = transports.native;
  if (prev === native) return;
  transports.native = native ?? null;
  invalidatePending("transport changed mid-call");
}

let shuttingDown = false;

/** Close every transport and fail anything still in flight. */
export function shutdown() {
  shuttingDown = true;
  const err = new RpcError(ERROR_CODES.NOT_CONNECTED, "Bridge shut down", false);
  for (const [id, entry] of pending) {
    clearTimeout(entry.timer);
    pending.delete(id);
    entry.reject(err);
  }
  const sock = transports.ws;
  transports.ws = null;
  if (sock) { try { sock.close(1001, "server-shutdown"); } catch { /* gone */ } }
  const native = transports.native;
  transports.native = null;
  if (native) { try { native.close?.(); } catch { /* gone */ } }
  clearRefs();
  eventListeners.clear();
  recentEvents.length = 0;
}

// ============================================================================
// §3 call() — request/response correlation over the active transport
// ============================================================================

const pending = new Map(); // req id -> { resolve, reject, timer }

export async function call(op, args = {}, opts = {}) {
  if (shuttingDown) throw new RpcError(ERROR_CODES.NOT_CONNECTED, "Bridge shut down", false);
  if (!pick()) {
    throw new RpcError(ERROR_CODES.NOT_CONNECTED,
      "Not connected to the browser extension. Run connect_brave first.", true);
  }
  const env = makeReq(op, args ?? {});
  const budgetMs = resolveTimeoutMs(op, args, opts);
  const outcome = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(env.id);
      reject(new RpcError(ERROR_CODES.TIMEOUT, `"${op}" timed out after ${budgetMs}ms`, true));
    }, budgetMs);
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
    const entry = pending.get(String(env.id));
    if (!entry) { log("stale/duplicate res ignored:", env.id); return; }
    clearTimeout(entry.timer);
    pending.delete(env.id);
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

// ---- Event bus --------------------------------------------------------------

const EVENT_BUFFER_MAX = 200;
const recentEvents = [];
const eventListeners = new Set();

export const onEvent = (fn) => { eventListeners.add(fn); return () => eventListeners.delete(fn); };
export const offEvent = (fn) => eventListeners.delete(fn);
export const getRecentEvents = (n = 20) => recentEvents.slice(-n);
export const drainRecentEvents = () => recentEvents.splice(0);

function ingestEvent(env) {
  const record = makeEvt(env.event, env.data); // normalizes shape, fresh local id
  record.ts = env.ts ?? record.ts;
  recentEvents.push(record);
  if (recentEvents.length > EVENT_BUFFER_MAX) recentEvents.shift();
  for (const fn of [...eventListeners]) {
    try { fn(record); } catch (e) { log("event listener failed:", e?.message || e); }
  }
}

export function waitForEvent(event, { timeoutMs = 15_000, predicate } = {}) {
  return new Promise((resolve, reject) => {
    const off = onEvent((rec) => {
      if (rec.event !== event || (predicate && !predicate(rec))) return;
      clearTimeout(timer);
      off();
      resolve(rec);
    });
    const timer = setTimeout(() => {
      off();
      reject(rpcErr(ERROR_CODES.TIMEOUT, `No "${event}" event within ${timeoutMs}ms`, true));
    }, timeoutMs);
  });
}

// ============================================================================
// §4 RefMap — read_page produces ref_N ids; click/computer consume them
// ============================================================================

export const refMap = new Map(); // "ref_N" -> { selector, role, name }
export let refCounter = 0;

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
  currentTabId = tabId ?? null;
  currentWindowId = windowId ?? null;
}

export function requireTab() {
  if (currentTabId == null) throw new Error("Not connected. Run connect_brave first.");
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
  mouse: (args) => call("input.mouse", args),
  key: (args) => call("input.key", args),
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
  if (t.selector) el = document.querySelector(t.selector);
  else if (t.text != null) {
    const needle = String(t.text).trim().toLowerCase();
    el = [...document.querySelectorAll(
      "a,button,input[type=submit],input[type=button],summary,label,[role=button],[onclick]",
    )].find((n) => ((n.innerText || n.value || "")).trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.text };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (hit && hit !== el && !el.contains(hit)) {
    return { ok: false, reason: "CLICK_BLOCKED", target: t.selector ?? t.text, coveredBy: hit.tagName.toLowerCase() };
  }
  el.click();
  return { ok: true, clicked: t.selector ?? t.text, tag: el.tagName.toLowerCase() };
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
  const nodes = document.querySelectorAll([
    "a[href]", "button", "input", "select", "textarea", "summary",
    '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
    "[onclick]", "[contenteditable=true]",
  ].join(","));
  const out = [];
  for (const el of nodes) {
    if (out.length >= limit) break;
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
    const found = [...document.querySelectorAll("body *")]
      .some((el) => !el.children.length && (el.textContent || "").trim().toLowerCase().includes(needle));
    return { ok: true, found };
  }
  return { ok: false, reason: "BAD_REQUEST", message: "target needs selector or text" };
}

function pageDetectCaptcha() {
  const kinds = [];
  const signals = [];
  const html = `${document.documentElement.outerHTML}`;
  const tests = [
    ["recaptcha", /google\.com\/recaptcha|\bgrecaptcha\b/i],
    ["hcaptcha", /hcaptcha\.com|\bhcaptcha\b/i],
    ["turnstile", /challenges\.cloudflare\.com|turnstile/i],
    ["geetest", /geetest/i],
    ["funcaptcha", /funcaptcha|arkoselabs/i],
  ];
  for (const [kind, re] of tests) {
    if (re.test(html) || window[kind === "recaptcha" ? "grecaptcha" : kind]) {
      kinds.push(kind);
      signals.push(kind);
    }
  }
  for (const f of document.querySelectorAll("iframe[src]")) {
    const m = /(recaptcha|hcaptcha|turnstile|geetest|arkoselabs)/i.exec(f.src || "");
    if (m) { kinds.push(m[1].toLowerCase()); signals.push(`iframe:${f.src.slice(0, 120)}`); }
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

  /** Poll-based wait_for replacement: selector or text until found or deadline. */
  waitFor: async (tabId, target, opts = {}) => {
    const budgetMs = Math.max(1_000, Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 15_000);
    const intervalMs = Math.max(100, opts.intervalMs ?? 500);
    const startedAt = Date.now();
    for (;;) {
      const res = await dom.exists(tabId, target);
      if (res.found) return { found: true, elapsedMs: Date.now() - startedAt };
      const remaining = startedAt + budgetMs - Date.now();
      if (remaining <= 0) {
        throw rpcErr(ERROR_CODES.TIMEOUT, `wait_for timed out after ${budgetMs}ms`, true);
      }
      await sleep(Math.min(intervalMs, remaining));
    }
  },
};
