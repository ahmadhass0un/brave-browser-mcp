/**
 * browser-navigator — tools.js
 * Registers all 41 MCP tools on an McpServer instance.
 */

import { z } from "zod";
import * as bridge from "./bridge.js";
import { assertSafeUrl, encryptCookies, decryptCookies } from "./lib/security.js";
import { tokenize, termFreq, idf, cosineSimilarity } from "./lib/tfidf.js";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, isAbsolute } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const SHOTS_DIR = join(DATA_DIR, "screenshots");
const COOKIES_DIR = join(DATA_DIR, "cookies");

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// Page-side functions (closure-free; stringified and shipped over cs.eval)
// ---------------------------------------------------------------------------

function pageClickCoords(t) {
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
  return {
    ok: true,
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    tag: el.tagName.toLowerCase(),
    name: (el.getAttribute("aria-label") || el.innerText || el.value || "").trim().slice(0, 80) || null,
  };
}

function pageTypeChars(t, value, delayMs) {
  const el = t.selector
    ? document.querySelector(t.selector)
    : (document.activeElement && document.activeElement !== document.body ? document.activeElement : null);
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? "activeElement" };
  const fillable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
  if (!fillable) return { ok: false, reason: "BAD_REQUEST", message: `cannot type into <${el.tagName.toLowerCase()}>` };
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el.isContentEditable ? null : HTMLInputElement.prototype;
  const setValue = (v) => {
    if (proto) Object.getOwnPropertyDescriptor(proto, "value").set.call(el, v);
    else el.textContent = v;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  };
  setValue("");
  let i = 0;
  return new Promise((resolve) => {
    const step = () => {
      if (i >= value.length) {
        el.dispatchEvent(new Event("change", { bubbles: true }));
        resolve({ ok: true, filled: value.length, tag: el.tagName.toLowerCase(), mode: "per-char", delayPerChar: delayMs });
        return;
      }
      setValue(value.slice(0, i + 1));
      i += 1;
      setTimeout(step, Math.max(1, delayMs));
    };
    step();
  });
}

function pageFillActive(value) {
  const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: "activeElement" };
  const fillable = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
  if (!fillable) return { ok: false, reason: "BAD_REQUEST", message: `cannot type into <${el.tagName.toLowerCase()}>` };
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el.isContentEditable ? null : HTMLInputElement.prototype;
  if (proto) Object.getOwnPropertyDescriptor(proto, "value").set.call(el, String(value));
  else el.textContent = String(value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, filled: String(value).length, tag: el.tagName.toLowerCase() };
}

function pageFocus(t) {
  let el = null;
  if (t.selector) el = document.querySelector(t.selector);
  else if (t.text != null) {
    const needle = String(t.text).trim().toLowerCase();
    el = [...document.querySelectorAll(
      "a,button,input,select,textarea,summary,label,[tabindex],[role=button]",
    )].find((n) => ((n.innerText || n.value || n.placeholder || "")).trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.text };
  el.focus();
  return {
    ok: document.activeElement === el,
    focused: t.selector ?? t.text,
    tag: el.tagName.toLowerCase(),
    active: document.activeElement === el,
  };
}

function pagePressKey(combo, times) {
  const SPECIAL = {
    enter: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9],
    escape: ["Escape", "Escape", 27], esc: ["Escape", "Escape", 27],
    backspace: ["Backspace", "Backspace", 8], delete: ["Delete", "Delete", 46], del: ["Delete", "Delete", 46],
    space: [" ", "Space", 32], spacebar: [" ", "Space", 32],
    arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40],
    arrowleft: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39],
    up: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40],
    left: ["ArrowLeft", "ArrowLeft", 37], right: ["ArrowRight", "ArrowRight", 39],
    home: ["Home", "Home", 36], end: ["End", "End", 35],
    pageup: ["PageUp", "PageUp", 33], pagedown: ["PageDown", "PageDown", 34],
    insert: ["Insert", "Insert", 45],
  };
  const mods = { shift: false, ctrl: false, alt: false, meta: false };
  const parts = String(combo).split("+").map((p) => p.trim()).filter(Boolean);
  const keyName = parts.pop() ?? "";
  for (const p of parts) {
    const l = p.toLowerCase();
    if (l === "shift") mods.shift = true;
    else if (l === "ctrl" || l === "control") mods.ctrl = true;
    else if (l === "alt" || l === "option") mods.alt = true;
    else if (l === "meta" || l === "cmd" || l === "command") mods.meta = true;
  }
  const lower = keyName.toLowerCase();
  let key, code, keyCode;
  if (SPECIAL[lower]) [key, code, keyCode] = SPECIAL[lower];
  else if (keyName.length === 1) {
    key = keyName;
    code = /^[a-z]$/i.test(keyName) ? "Key" + keyName.toUpperCase()
      : /^[0-9]$/.test(keyName) ? "Digit" + keyName : "Unidentified";
    keyCode = keyName.toUpperCase().charCodeAt(0) || 0;
  } else { key = keyName; code = "Unidentified"; keyCode = 0; }
  const init = { ...mods, key, code, keyCode, which: keyCode, bubbles: true, cancelable: true };
  const el = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
  for (let i = 0; i < times; i++) {
    el.dispatchEvent(new KeyboardEvent("keydown", init));
    if (key.length === 1) el.dispatchEvent(new KeyboardEvent("keypress", init));
    el.dispatchEvent(new KeyboardEvent("keyup", init));
  }
  return { ok: true, key: combo, dispatched: times, focused: el.tagName.toLowerCase() };
}

function pageScroll(direction, amount, selector) {
  const dx = direction === "left" ? -amount : direction === "right" ? amount : 0;
  const dy = direction === "up" ? -amount : direction === "down" ? amount : 0;
  if (selector) {
    const el = document.querySelector(selector);
    if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: selector };
    const before = { x: el.scrollLeft, y: el.scrollTop };
    el.scrollBy(dx, dy);
    return { ok: true, target: selector, scrolled: { x: el.scrollLeft, y: el.scrollTop, before } };
  }
  const before = { x: window.scrollX, y: window.scrollY };
  window.scrollBy(dx, dy);
  return { ok: true, direction, amount, scrolled: { x: window.scrollX, y: window.scrollY, before } };
}

function pageHover(t) {
  let el = null;
  if (t.selector) el = document.querySelector(t.selector);
  else if (t.text != null) {
    const needle = String(t.text).trim().toLowerCase();
    el = [...document.querySelectorAll(
      "a,button,input,select,textarea,summary,label,[role=button],[role=menuitem],[onclick]",
    )].find((n) => ((n.innerText || n.value || n.placeholder || "")).trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.text };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const opts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, view: window };
  if (window.PointerEvent) {
    el.dispatchEvent(new PointerEvent("pointerover", opts));
    el.dispatchEvent(new PointerEvent("pointermove", opts));
  }
  el.dispatchEvent(new MouseEvent("mouseover", opts));
  el.dispatchEvent(new MouseEvent("mouseenter", { ...opts, bubbles: false }));
  el.dispatchEvent(new MouseEvent("mousemove", opts));
  return {
    ok: true, hovered: t.selector ?? t.text, tag: el.tagName.toLowerCase(),
    x: Math.round(cx), y: Math.round(cy),
  };
}

function pageInfo() {
  return {
    ok: true,
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    referrer: document.referrer || null,
    viewport: { width: innerWidth, height: innerHeight },
    scroll: {
      x: Math.round(window.scrollX),
      y: Math.round(window.scrollY),
      pageHeight: document.documentElement.scrollHeight,
    },
    selection: (String(getSelection()) || "").slice(0, 300) || null,
    interactiveCount: document.querySelectorAll("a[href],button,input,select,textarea,[role=button]").length,
  };
}

function pageExtractHTML(selector) {
  const el = selector ? document.querySelector(selector) : document.documentElement;
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: selector };
  return { ok: true, html: el.outerHTML, url: location.href, title: document.title };
}

function pageCollectCandidates() {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"));
  const path = (elm) => {
    if (elm.id) return "#" + esc(elm.id);
    const parts = [];
    let cur = elm;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      const idx = same.indexOf(cur) + 1;
      parts.unshift(same.length > 1 ? `${cur.tagName.toLowerCase()}:nth-of-type(${idx})` : cur.tagName.toLowerCase());
      if (parent.id) { parts.unshift("#" + esc(parent.id)); break; }
      cur = parent;
    }
    return parts.join(" > ");
  };
  const nameOf = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.alt || el.title || "")
    .trim().replace(/\s+/g, " ").slice(0, 100) || null;
  const roleOf = (el) => {
    const role = el.getAttribute("role");
    if (role) return role;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button" || tag === "summary" || el.hasAttribute("onclick")) return "button";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (["submit", "button", "reset"].includes(t)) return "button";
      if (t === "search") return "searchbox";
      return "textbox";
    }
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (tag === "img") return "image";
    return null;
  };
  const out = [];
  for (const el of document.querySelectorAll(
    "a[href],button,input,select,textarea,summary,[role],h1,h2,h3,h4,h5,h6,img,video,audio,[onclick],[contenteditable='true'],label",
  )) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 && r.height <= 0) continue;
    const name = nameOf(el);
    const role = roleOf(el);
    if (!name && !role) continue;
    out.push({
      selector: path(el),
      tag: el.tagName.toLowerCase(),
      role,
      name,
      href: el.href || null,
      value: el.value != null && el.value !== "" ? String(el.value).slice(0, 60) : null,
      visible: r.width > 0 && r.height > 0,
    });
    if (out.length >= 800) break;
  }
  return { ok: true, candidates: out, url: location.href, title: document.title };
}

function pageLocateByText(text) {
  const needle = String(text).trim().toLowerCase();
  const el = [...document.querySelectorAll("body *")]
    .find((n) => !n.children.length && (n.textContent || "").trim().toLowerCase().includes(needle)) ?? null;
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: text };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"));
  const path = (elm) => {
    if (elm.id) return "#" + esc(elm.id);
    const parts = [];
    let cur = elm;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      const idx = same.indexOf(cur) + 1;
      parts.unshift(same.length > 1 ? `${cur.tagName.toLowerCase()}:nth-of-type(${idx})` : cur.tagName.toLowerCase());
      if (parent.id) { parts.unshift("#" + esc(parent.id)); break; }
      cur = parent;
    }
    return parts.join(" > ");
  };
  return { ok: true, selector: path(el), tag: el.tagName.toLowerCase(), text: (el.textContent || "").trim().slice(0, 120) };
}

function pageInspectDeep(t, maxDepth, includeHtml) {
  let el = null;
  if (t.selector) el = document.querySelector(t.selector);
  else if (t.text != null) {
    const needle = String(t.text).trim().toLowerCase();
    el = [...document.querySelectorAll("body *")]
      .find((n) => !n.children.length && (n.textContent || "").trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.text };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"));
  const cssPath = (elm) => {
    if (elm.id) return "#" + esc(elm.id);
    const parts = [];
    let cur = elm;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
      const same = [...parent.children].filter((c) => c.tagName === cur.tagName);
      const idx = same.indexOf(cur) + 1;
      parts.unshift(same.length > 1 ? `${cur.tagName.toLowerCase()}:nth-of-type(${idx})` : cur.tagName.toLowerCase());
      if (parent.id) { parts.unshift("#" + esc(parent.id)); break; }
      cur = parent;
    }
    return parts.join(" > ") || elm.tagName.toLowerCase();
  };
  const summarize = (n, depth) => {
    const r = n.getBoundingClientRect();
    const node = {
      tag: n.tagName.toLowerCase(),
      id: n.id || null,
      classes: typeof n.className === "string" ? n.className.split(/\s+/).filter(Boolean).slice(0, 8) : [],
      rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    };
    if (depth < maxDepth) {
      node.children = [...n.children].slice(0, 30).map((c) => summarize(c, depth + 1));
      node.childCount = n.children.length;
    }
    return node;
  };
  const r = el.getBoundingClientRect();
  const out = {
    ok: true,
    target: t.selector ?? t.text,
    tag: el.tagName.toLowerCase(),
    cssPath: cssPath(el),
    attrs: [...el.attributes].reduce((m, a) => ((m[a.name] = a.value.slice(0, 200)), m), {}),
    text: (el.innerText || "").slice(0, 500),
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    visible: r.width > 0 && r.height > 0,
  };
  if (maxDepth > 1) out.tree = summarize(el, 0);
  if (includeHtml) out.html = el.outerHTML.slice(0, 20000);
  return out;
}

function pageRectOf(selector) {
  const el = document.querySelector(selector);
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: selector };
  el.scrollIntoView({ block: "center", inline: "center" });
  const r = el.getBoundingClientRect();
  return {
    ok: true,
    x: r.left + window.scrollX,
    y: r.top + window.scrollY,
    width: r.width,
    height: r.height,
  };
}

function pageViewportCenter() {
  return { ok: true, x: Math.round(innerWidth / 2), y: Math.round(innerHeight / 2) };
}

function pageVideoExtra(action, arg) {
  const media = [...document.querySelectorAll("video,audio")]
    .filter((v) => { const r = v.getBoundingClientRect(); return r.width * r.height > 0 || v.duration > 0; });
  const v = media[0] ?? document.querySelector("video,audio");
  if (!v) return { ok: false, reason: "ELEMENT_NOT_FOUND", message: "no media element found" };
  switch (action) {
    case "set_volume":
      v.volume = Math.min(1, Math.max(0, Number(arg ?? 1)));
      break;
    case "fullscreen":
      try {
        const p = (v.requestFullscreen ? v.requestFullscreen() : v.webkitRequestFullscreen?.());
        p?.catch?.(() => {});
      } catch { /* denied */ }
      break;
    case "exit_fullscreen":
      try { document.exitFullscreen?.()?.catch?.(() => {}); } catch { /* noop */ }
      break;
    case "get_info":
      break;
    default:
      return { ok: false, reason: "BAD_REQUEST", message: `unsupported media action "${action}"` };
  }
  return {
    ok: true,
    action,
    state: {
      currentTime: v.currentTime,
      duration: Number.isFinite(v.duration) ? v.duration : null,
      paused: v.paused,
      muted: v.muted,
      volume: v.volume,
      playbackRate: v.playbackRate,
      fullscreen: !!document.fullscreenElement,
    },
  };
}

function pageSearchResults(platform, limit) {
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const results = [];
  const seen = new Set();

  const RULES = {
    google: {
      sel: ["#search a h3", "#rso a h3"],
      skip: /(^|\.)google\./i,
      snippet: ".VwiC3b",
    },
    bing: {
      sel: ["#b_results li.b_algo h2 a", "#b_results h2 a"],
      skip: /(^|\.)bing\.com/i,
      snippet: ".b_caption p",
    },
    duckduckgo: {
      sel: [
        "[data-testid='result'] a[data-testid='result-title-a']",
        "article[data-layout='organic'] a[data-testid='result-title-a']",
        "a.result__a",
        "article h2 a[href^='http']",
      ],
      skip: /duckduckgo\.com/i,
      snippet: "[data-result='snippet']",
    },
    brave: {
      sel: ["#results .snippet[data-type='web'] a.heading-serpresult", "#results [data-type='web'] a", ".snippet[data-type='web'] a"],
      skip: /search\.brave\.com/i,
      snippet: ".snippet-description, .desc",
    },
    youtube: {
      sel: [
        "ytd-video-renderer a#video-title",
        "ytd-grid-video-renderer a#video-title",
        "ytd-compact-video-renderer a#video-title",
        "a#video-title-link",
        "yt-lockup-view-model a",
      ],
      accept: /(youtube\.com\/(watch|shorts)|youtu\.be\/)/i,
    },
    reddit: {
      sel: [
        "shreddit-post a[slot='title']",
        "faceplate-tracker[nundle] a[slot='title']",
        "a[data-testid='post-title']",
        "a[href*='/comments/']",
      ],
      accept: /reddit\.com\/r\//i,
    },
    github: {
      sel: ["div.search-title a", "[data-testid='results-list'] div.search-title a", "a.v-align-middle"],
      skip: /github\.com\/(features|pricing|about|topics|collections|trending|sponsors|security|login|signup|marketplace)/i,
    },
    stackoverflow: {
      sel: [".s-post-summary--content-title a", ".result-link"],
      accept: /\/questions\/\d+/i,
    },
    wikipedia: {
      sel: [".mw-search-result-heading a", "li.mw-search-result a"],
      accept: /\/wiki\//i,
      skip: /(Special%3A|Wikipedia%3A|File%3A|Talk%3A|Help%3A|Category%3A|Template%3A|Portal%3A|Special:|Wikipedia:|File:|Talk:|Help:|Category:|Template:|Portal:)/i,
    },
  };

  const push = (a) => {
    if (!a || !a.href) return;
    let u;
    try { u = new URL(a.href, location.href); } catch { return; }
    if (u.protocol !== "http:" && u.protocol !== "https:") return;
    const rule = RULES[platform];
    if (rule) {
      if (rule.accept && !rule.accept.test(u.href)) return;
      if (rule.skip && rule.skip.test(u.href)) return;
    }
    const title = clean(a.getAttribute("aria-label") || a.textContent || a.title);
    if (title.length < 2) return;
    const key = u.origin + u.pathname + u.search;
    if (seen.has(key)) return;
    let snippet = null;
    const card = a.closest("div,li,article");
    if (card) {
      const node = (rule && rule.snippet ? card.querySelector(rule.snippet) : null) || card.querySelector("p");
      if (node && !node.contains(a)) snippet = clean(node.textContent).slice(0, 300) || null;
    }
    seen.add(key);
    results.push({ title: title.slice(0, 200), url: u.href.split("#")[0], snippet });
  };

  const qsa = (sel) => { try { return [...document.querySelectorAll(sel)]; } catch { return []; } };

  const rule = RULES[platform];
  let anchors = [];
  if (rule) {
    for (const s of rule.sel) {
      anchors = qsa(s);
      if (anchors.length >= Math.min(limit, 5)) break;
    }
    for (const a of anchors) {
      if (results.length >= limit) break;
      push(a);
    }
  }

  if (results.length < limit) {
    const engineSelf = /(^|\.)(google|bing\.com|duckduckgo|brave\.com|youtube|reddit|github|stackoverflow|wikipedia)/i;
    for (const a of qsa("a[href]")) {
      if (results.length >= limit) break;
      if (!(rule && rule.accept)) {
        const t = clean(a.textContent);
        if (t.length < 25) continue;
        try {
          const u = new URL(a.href, location.href);
          if (u.protocol !== "http:" && u.protocol !== "https:") continue;
          if (engineSelf.test(u.hostname)) continue;
        } catch { continue; }
      }
      push(a);
    }
  }

  return {
    ok: true,
    platform,
    count: results.length,
    results: results.slice(0, limit),
    serpTitle: document.title,
    serpUrl: location.href,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function registerTools(server, ctx) {
  const { bookmarks, browsingHistory, addHistoryEntry, saveBookmarks, saveHistory, wsPort } = ctx;

  const json = (r) => ({
    content: [{ type: "text", text: typeof r === "string" ? r : JSON.stringify(r, null, 2) }],
  });

  const guard = (fn) => async (args = {}) => {
    try {
      return await fn(args);
    } catch (e) {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ok: false, error: e?.message || String(e), code: e?.code ?? null }, null, 2),
        }],
        isError: true,
      };
    }
  };

  const tab = (id) => (id != null ? id : bridge.requireTab());

  const val = (res) => {
    const v = res && typeof res === "object" && "value" in res ? res.value : res;
    if (v && typeof v === "object" && v.ok === false) {
      throw new Error(v.message || `${v.reason || "DOM op failed"}${v.target ? `: ${v.target}` : ""}`);
    }
    return v ?? {};
  };

  const evalV = async (tabId, fn, args = [], opts = {}) => val(await bridge.dom.eval(tabId, fn, args, opts));

  const scopeSel = (selector, scope) =>
    (scope && scope.trim() ? `${scope.trim()} ${selector}` : selector);

  const resolveTarget = ({ selector, by_text, scope, ref } = {}) => {
    if (ref != null) {
      const info = bridge.resolveRef(ref);
      if (!info?.selector) throw new Error(`Unknown ref "${ref}" — run read_page to refresh refs`);
      return { selector: info.selector };
    }
    if (selector) return { selector: scopeSel(selector, scope) };
    if (by_text != null) return { text: by_text };
    return null;
  };

  const resolveOut = (savePath, ext) => {
    let p = savePath
      ? (isAbsolute(savePath) ? savePath : join(SHOTS_DIR, savePath))
      : join(SHOTS_DIR, `${ext}_${Date.now()}.${ext}`);
    if (!p.toLowerCase().endsWith(`.${ext}`)) p += `.${ext}`;
    mkdirSync(dirname(p), { recursive: true });
    return p;
  };

  async function performClick(tabId, opts = {}) {
    const {
      selector, byText, ref, scope, button = "left",
      clickCount = 1, trusted = true, x, y,
    } = opts;

    const target = (x == null || y == null)
      ? resolveTarget({ selector, by_text: byText, scope, ref })
      : null;

    let pt = (x != null && y != null) ? { ok: true, x, y } : null;
    if (!pt) {
      if (!target) throw new Error("click needs selector, by_text, ref, or x/y coordinates");
      pt = await evalV(tabId, pageClickCoords, [target]);
    }

    if (trusted) {
      try {
        await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
          { type: "mouseMoved", x: pt.x, y: pt.y, button, clickCount: 0, pointerType: "mouse" }, { timeoutMs: 8000 });
        await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
          { type: "mousePressed", x: pt.x, y: pt.y, button, clickCount, pointerType: "mouse" });
        await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
          { type: "mouseReleased", x: pt.x, y: pt.y, button, clickCount, pointerType: "mouse" });
        return {
          ok: true, mode: "cdp-trusted", x: pt.x, y: pt.y, button, clickCount,
          target: target?.selector ?? target?.text ?? null, tag: pt.tag ?? null, name: pt.name ?? null,
        };
      } catch (e) {
        if (!target) throw e;
        const fb = await bridge.dom.clickElement(tabId, target);
        return { ...fb, mode: "dom-fallback", trustedError: e?.message || String(e) };
      }
    }
    if (!target) return { ok: true, mode: "coords-only", x: pt.x, y: pt.y };
    return bridge.dom.clickElement(tabId, target);
  }

  async function performType(tabId, { selector, text, delay = 0, delayPerChar = 0, scope, ref } = {}) {
    if (delay > 0) await sleep(delay);
    const value = String(text ?? "");
    let sel = selector;
    if (ref != null) {
      const info = bridge.resolveRef(ref);
      if (!info?.selector) throw new Error(`Unknown ref "${ref}" — run read_page to refresh refs`);
      sel = info.selector;
    }
    if (delayPerChar > 0) {
      return evalV(tabId, pageTypeChars, [{ selector: sel ? scopeSel(sel, scope) : null }, value, delayPerChar]);
    }
    if (!sel) return evalV(tabId, pageFillActive, [value]);
    return bridge.dom.fillField(tabId, { selector: scopeSel(sel, scope) }, value);
  }

  async function performScroll(tabId, { direction = "down", amount = 800, selector, scope } = {}) {
    return evalV(tabId, pageScroll, [direction, amount, selector ? scopeSel(selector, scope) : null]);
  }

  async function performHover(tabId, { selector, by_text, scope, ref, x, y } = {}) {
    if (x != null && y != null) {
      await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
        { type: "mouseMoved", x, y, button: "none", clickCount: 0, pointerType: "mouse" });
      return { ok: true, mode: "cdp-trusted", x, y };
    }
    const target = resolveTarget({ selector, by_text, scope, ref });
    if (!target) throw new Error("hover needs selector, by_text, ref, or x/y coordinates");
    return evalV(tabId, pageHover, [target]);
  }

  async function performPressKey(tabId, { key, times = 1, selector } = {}) {
    if (selector) await evalV(tabId, pageFocus, [{ selector }]);
    return evalV(tabId, pagePressKey, [key, times]);
  }

  async function capturePng(tabId, { fullPage = false, selector, savePath } = {}) {
    const params = { format: "png", captureBeyondViewport: !!fullPage, optimizeForSpeed: true };
    if (selector) {
      const r = await evalV(tabId, pageRectOf, [selector]);
      params.clip = { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 };
    }
    const shot = await bridge.dbg.command(tabId, "Page.captureScreenshot", params);
    if (!shot?.data) throw new Error("Browser returned no screenshot data");
    const buf = Buffer.from(shot.data, "base64");
    const out = resolveOut(savePath, "png");
    writeFileSync(out, buf);
    return { savedTo: out, bytes: buf.length, format: "png", fullPage: !!fullPage, clippedTo: selector ?? null };
  }

  async function exportPdf(tabId, { savePath } = {}) {
    const pdf = await bridge.dbg.command(tabId, "Page.printToPDF",
      { printBackground: true, preferCSSPageSize: true });
    if (!pdf?.data) throw new Error("Browser returned no PDF data");
    const buf = Buffer.from(pdf.data, "base64");
    const out = resolveOut(savePath, "pdf");
    writeFileSync(out, buf);
    return { savedTo: out, bytes: buf.length, format: "pdf" };
  }

  const redactSecrets = (text) => text.replace(
    /((?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|authorization|cookie)"?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^,\s}\]]+)/gi,
    '$1"[REDACTED]"',
  );

  const unwrapList = (res, key = "cookies") =>
    Array.isArray(res?.[key]) ? res[key] : Array.isArray(res) ? res : [];

  async function snapshotCookies(filter = {}) {
    const list = unwrapList(await bridge.cookies.all(filter));
    mkdirSync(COOKIES_DIR, { recursive: true });
    const out = join(COOKIES_DIR, `cookies_${Date.now()}.json.enc`);
    writeFileSync(out, JSON.stringify(encryptCookies(list)));
    return { file: out, count: list.length };
  }

  // -------------------------------------------------------------------------
  // Tools 1–41
  // -------------------------------------------------------------------------

  // 1. connect_brave
  server.tool("connect_brave", "Connect to the browser via the extension and report its state", {},
    guard(async () => {
      const state = await bridge.browser.state();
      bridge.drainRecentEvents(); // stale events from a previous session are noise
      if (state?.activeTabId != null) {
        bridge.setCurrentTab(state.activeTabId, state.windowId ?? null);
      }
      return json({
        connected: true,
        transport: bridge.transportName(),
        wsPort,
        ...state,
        currentTabId: bridge.currentTabId,
        next_step: "Run read_page to get clickable ref_N ids for the active tab.",
      });
    }));

  // 2. disconnect
  server.tool("disconnect", "Drop the connection to the browser (the browser itself keeps running)", {},
    guard(async () => {
      bridge.shutdown();
      return json({ ok: true, disconnected: true });
    }));

  // 3. navigate
  server.tool("navigate", "Navigate a tab to a URL and wait for it to settle", {
    url: z.string().url(),
    wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).default("load"),
    timeout_ms: z.number().int().min(1000).max(120000).default(30000),
    tab_id: z.number().int().optional(),
    background: z.boolean().default(false),
  }, guard(async ({ url, wait_until, timeout_ms, tab_id, background }) => {
    assertSafeUrl(url);
    if (background && tab_id == null) {
      const opened = await bridge.tabs.open(url, { active: false });
      addHistoryEntry({ url, title: opened?.title || url, tabId: opened?.tabId ?? null });
      return json({ ok: true, openedInBackground: true, ...opened });
    }
    const result = await bridge.nav.goto(url, {
      tabId: tab_id, waitUntil: wait_until, timeoutMs: timeout_ms,
    });
    addHistoryEntry({ url, title: result?.title || url, tabId: tab_id ?? bridge.currentTabId });
    return json(result);
  }));

  // 4. navigate_history
  server.tool("navigate_history", "Go back or forward in the active tab's session history", {
    direction: z.enum(["back", "forward"]).default("back"),
    steps: z.number().int().min(1).max(50).default(1),
  }, guard(async ({ direction, steps }) => {
    const tabId = bridge.requireTab();
    const delta = direction === "back" ? -steps : steps;
    const result = await evalV(tabId,
      "(d) => { history.go(d); return new Promise((res) => setTimeout(() => res({ url: location.href, title: document.title }), 400)); }",
      [delta]);
    addHistoryEntry({ url: result.url || "", title: result.title || "", tabId });
    return json(result);
  }));

  // 5. click
  server.tool("click", "Click an element by selector, visible text, or ref_N from read_page (trusted CDP click with DOM fallback)", {
    selector: z.string().optional(),
    double_click: z.boolean().default(false),
    button: z.enum(["left", "right", "middle"]).default("left"),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    ref: z.string().optional(),
    trusted: z.boolean().default(true),
  }, guard(async ({ selector, double_click, button, by_text, scope, ref, trusted }) => {
    const result = await performClick(tab(), {
      selector, byText: by_text, scope, ref, button,
      clickCount: double_click ? 2 : 1, trusted,
    });
    return json(result);
  }));

  // 6. type
  server.tool("type", "Type text into an input/textarea/contenteditable (optionally char-by-char)", {
    selector: z.string().optional(),
    text: z.string(),
    delay: z.number().int().min(0).max(60000).default(0),
    delay_per_char: z.number().int().min(0).max(1000).default(0),
    scope: z.string().optional(),
    ref: z.string().optional(),
  }, guard(async ({ selector, text, delay, delay_per_char, scope, ref }) => {
    const result = await performType(tab(), {
      selector, text, delay, delayPerChar: delay_per_char, scope, ref,
    });
    return json(result);
  }));

  // 7. focus_element
  server.tool("focus_element", "Move keyboard focus to an element (needed before press_key on custom widgets)", {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
  }, guard(async ({ selector, by_text, scope }) => {
    const target = resolveTarget({ selector, by_text, scope });
    if (!target) throw new Error("focus_element needs selector or by_text");
    return json(await evalV(tab(), pageFocus, [target]));
  }));

  // 8. press_key
  server.tool("press_key", 'Send keyboard keys ("Enter", "Control+a"); repeats the sequence `times` times', {
    key: z.string(),
    times: z.number().int().min(1).max(100).default(1),
    selector: z.string().optional(),
  }, guard(async ({ key, times, selector }) => {
    return json(await performPressKey(tab(), { key, times, selector }));
  }));

  // 9. scroll
  server.tool("scroll", "Scroll the page or an element (use down repeatedly for infinite scroll)", {
    direction: z.enum(["up", "down", "left", "right"]).default("down"),
    amount: z.number().int().min(1).max(100000).default(800),
    selector: z.string().optional(),
  }, guard(async ({ direction, amount, selector }) => {
    return json(await performScroll(tab(), { direction, amount, selector }));
  }));

  // 10. get_page_info
  server.tool("get_page_info", "Get the current page's URL, title, loading status, scroll state, interactivity, and CAPTCHA presence", {
    tab_id: z.number().int().optional(),
  }, guard(async ({ tab_id }) => {
    const tabId = tab(tab_id);
    const info = await evalV(tabId, pageInfo, []);
    const captcha = await bridge.dom.detectCaptcha(tabId).catch(() => null);
    return json({
      tabId,
      ...info,
      captcha: captcha ? { detected: captcha.detected, kind: captcha.kind ?? null } : null,
    });
  }));

  // 11. get_page_content
  server.tool("get_page_content", "Extract readable text or raw HTML from the page or an element", {
    format: z.enum(["text", "html"]).default("text"),
    limit: z.number().int().min(100).max(200000).default(10000),
    selector: z.string().optional(),
  }, guard(async ({ format, limit, selector }) => {
    const tabId = tab();
    if (format === "html") {
      const res = await evalV(tabId, pageExtractHTML, [selector ?? null]);
      return json({
        format: "html", selector: selector ?? null, url: res.url, title: res.title,
        truncated: res.html.length > limit,
        content: res.html.slice(0, limit),
      });
    }
    const res = await bridge.dom.extractVisibleText(tabId, selector ?? null);
    return json({
      format: "text", selector: selector ?? null, url: res.url, title: res.title,
      truncated: (res.text || "").length > limit,
      content: (res.text || "").slice(0, limit),
    });
  }));

  // 12. read_page
  server.tool("read_page", "Build an accessibility snapshot of the page with stable ref_N ids for click/type targeting", {
    filter: z.enum(["interactive", "all"]).default("interactive"),
    max_refs: z.number().int().min(10).max(1000).default(150),
  }, guard(async ({ filter, max_refs }) => {
    const tabId = tab();

    const tree = await bridge.dbg.command(tabId, "Accessibility.getFullAXTree", {});
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    const ordered = [];
    const seen = new Set();
    const visit = (n) => {
      if (!n || seen.has(n.nodeId)) return;
      seen.add(n.nodeId);
      ordered.push(n);
      for (const cid of n.childIds ?? []) visit(byId.get(cid));
    };
    for (const n of nodes) {
      if (!n.parentId || !byId.has(n.parentId)) visit(n);
    }
    for (const n of nodes) visit(n);

    const INTERACTIVE = new Set([
      "button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio",
      "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "slider",
      "spinbutton", "switch", "option", "treeitem",
    ]);
    const STRUCTURAL = new Set([
      "heading", "image", "list", "listitem", "table", "row", "cell",
      "columnheader", "rowheader", "dialog", "alert", "navigation", "main",
      "form", "banner", "contentinfo", "article", "figure", "status",
    ]);
    const wanted = filter === "all"
      ? new Set([...INTERACTIVE, ...STRUCTURAL])
      : INTERACTIVE;

    const interesting = [];
    for (const n of ordered) {
      if (n.ignored) continue;
      const role = n.role?.value;
      if (!role || !wanted.has(role)) continue;
      interesting.push({
        role,
        name: n.name?.value ?? null,
        value: n.value?.value != null ? String(n.value.value).slice(0, 120) : null,
        description: n.description?.value ?? null,
      });
      if (interesting.length >= max_refs * 3) break;
    }

    const { candidates, url, title } = await evalV(tabId, pageCollectCandidates, []);
    const norm = (s) => (s ?? "").toString().trim().toLowerCase().replace(/\s+/g, " ");
    const ROLE_ALIASES = { searchbox: "textbox", menubar: "menuitem", treeitem: "option" };

    bridge.clearRefs();
    const refs = [];
    const used = new Set();
    const lines = [];

    for (const ax of interesting) {
      if (refs.length >= max_refs) break;
      const axName = norm(ax.name);
      let match = -1;
      if (axName) {
        match = candidates.findIndex((c, i) => !used.has(i)
          && c.role === ax.role && c.name && norm(c.name) === axName);
        if (match === -1) {
          match = candidates.findIndex((c, i) => !used.has(i)
            && c.role === ax.role && c.name
            && (norm(c.name).includes(axName) || axName.includes(norm(c.name))));
        }
      }
      if (match === -1) {
        const alias = ROLE_ALIASES[ax.role];
        match = candidates.findIndex((c, i) => !used.has(i)
          && (c.role === alias || (!alias && c.tag === "input")) && axName && norm(c.name) === axName);
      }
      if (match === -1) {
        lines.push(`(no-ref)  ${ax.role.padEnd(10)} ${ax.name ? `"${ax.name}"` : "(unnamed)"}`);
        continue;
      }
      used.add(match);
      const cand = candidates[match];
      const refId = bridge.registerRef({ selector: cand.selector, role: ax.role, name: ax.name });
      refs.push({
        ref: refId, role: ax.role, name: ax.name, value: ax.value ?? cand.value ?? null,
        selector: cand.selector, href: cand.href ?? null,
      });
      let line = `${refId.padEnd(8)} ${ax.role.padEnd(10)} ${ax.name ? `"${ax.name}"` : "(unnamed)"}`;
      if (ax.value) line += ` [value: ${ax.value}]`;
      if (cand.href) line += ` -> ${String(cand.href).slice(0, 90)}`;
      lines.push(line);
    }

    return json({
      url, title, filter,
      axNodes: nodes.length,
      refCount: refs.length,
      omitted: Math.max(0, interesting.length - refs.length),
      refs,
      summary: lines.join("\n"),
      usage: "Pass ref (e.g. \"ref_3\") to click/type, or use the selector directly.",
    });
  }));

  // 13. list_elements
  server.tool("list_elements", "List elements of a kind (links, buttons, inputs...) with names and reusable selectors", {
    kind: z.enum(["link", "button", "input", "select", "textarea", "image", "heading"]),
    contains: z.string().optional(),
    scope: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }, guard(async ({ kind, contains, scope, limit }) => {
    const tabId = tab();
    let elements;
    let pageTitle;
    let pageUrl;

    if (kind === "image" || kind === "heading") {
      const res = await evalV(tabId, pageCollectCandidates, []);
      pageTitle = res.title;
      pageUrl = res.url;
      elements = res.candidates.filter((c) =>
        (kind === "image" ? c.tag === "img" : /^h[1-6]$/.test(c.tag)))
        .map((c) => ({ tag: c.tag, name: c.name, selector: c.selector, href: c.href, visible: c.visible }));
    } else {
      const res = await bridge.dom.listInteractive(tabId, { limit: 500 });
      pageTitle = res.title;
      pageUrl = res.url;
      const KIND_PREDICATE = {
        link: (e) => e.tag === "a" || e.role === "link",
        button: (e) => e.tag === "button" || e.role === "button"
          || (e.tag === "input" && ["submit", "button", "reset"].includes(e.type)),
        input: (e) => e.tag === "input" || ["textbox", "searchbox", "spinbutton"].includes(e.role),
        select: (e) => e.tag === "select" || e.role === "combobox",
        textarea: (e) => e.tag === "textarea",
      };
      elements = res.elements.filter(KIND_PREDICATE[kind]);
    }

    const needle = contains ? contains.trim().toLowerCase() : null;
    if (needle) {
      elements = elements.filter((e) =>
        (e.name || "").toLowerCase().includes(needle)
        || (e.href || "").toLowerCase().includes(needle));
    }

    return json({
      kind, scope: scope ?? null, url: pageUrl, title: pageTitle,
      count: Math.min(elements.length, limit),
      total: elements.length,
      elements: elements.slice(0, limit),
    });
  }));

  // 14. inspect_dom
  server.tool("inspect_dom", "Inspect an element's tag, attributes, css path, subtree, and (optionally) HTML", {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    max_depth: z.number().int().min(1).max(10).default(3),
    include_html: z.boolean().default(false),
  }, guard(async ({ selector, by_text, scope, max_depth, include_html }) => {
    let target = resolveTarget({ selector, by_text, scope });
    if (!target) throw new Error("inspect_dom needs selector or by_text");
    if (target.text != null) {
      const loc = await evalV(tab(), pageLocateByText, [target.text]); // resolve text -> reusable selector
      target = { selector: loc.selector };
    }
    return json(await evalV(tab(), pageInspectDeep, [target, max_depth, include_html]));
  }));

  // 15. screenshot
  server.tool("screenshot", "Capture a PNG of the page (full page) or one element; saved under data/screenshots", {
    full_page: z.boolean().default(false),
    selector: z.string().optional(),
    save_path: z.string().optional(),
  }, guard(async ({ full_page, selector, save_path }) => {
    return json(await capturePng(tab(), { fullPage: full_page, selector, savePath: save_path }));
  }));

  // 16. pdf_export
  server.tool("pdf_export", "Save the current page as PDF (A4, backgrounds on); saved under data/screenshots", {
    save_path: z.string().optional(),
  }, guard(async ({ save_path }) => {
    return json(await exportPdf(tab(), { savePath: save_path }));
  }));

  // 17. execute_js
  server.tool("execute_js", "Run JavaScript in the page and return its result. Use `return` for a value; secrets in output are redacted unless redact=false. DANGER: requires confirm=true", {
    code: z.string(),
    confirm: z.boolean().default(false),
    redact: z.boolean().default(true),
    tab_id: z.number().int().optional(),
  }, guard(async ({ code, confirm, redact, tab_id }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: "Refused: execute_js is destructive. Re-run with confirm=true to proceed." }] };
    }
    const trimmed = code.trim();
    const looksLikeFn = /^(async\s+function\b|function\b|async\s*\(|\(|[A-Za-z_$][\w$]*\s*=>)/.test(trimmed);
    const source = looksLikeFn ? trimmed : `async () => {\n${code}\n}`;
    const result = await evalV(tab(tab_id), source);
    const text = JSON.stringify(result, null, 2) ?? "undefined";
    return { content: [{ type: "text", text: redact ? redactSecrets(text) : text }] };
  }));

  // 18. inject_script
  server.tool("inject_script", "Register a named persistent script that replays on every navigation", {
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    code: z.string(),
    run_now: z.boolean().default(true),
  }, guard(async ({ name, code, run_now }) => {
    await bridge.injected.register(name, code);
    const replay = run_now
      ? await bridge.injected.replay().catch((e) => ({ error: e?.message || String(e) }))
      : null;
    return json({ ok: true, registered: name, replaysOnNavigation: true, replayNow: replay });
  }));

  // 19. send_to_injected
  server.tool("send_to_injected", "Send JSON data to an injected script and await its reply", {
    name: z.string(),
    data: z.unknown().optional(),
    timeout_ms: z.number().int().min(500).max(60000).default(5000),
  }, guard(async ({ name, data, timeout_ms }) => {
    return json(await bridge.injected.send(name, data ?? null, { timeoutMs: timeout_ms }));
  }));

  // 20. wait_for
  server.tool("wait_for", "Poll the DOM until a CSS selector or visible text appears (or timeout)", {
    selector: z.string().optional(),
    text: z.string().optional(),
    ref: z.string().optional(),
    interval_ms: z.number().int().min(100).max(5000).default(500),
    timeout_ms: z.number().int().min(500).max(120000).default(10000),
  }, guard(async ({ selector, text, ref, interval_ms, timeout_ms }) => {
    let target;
    if (ref != null) {
      const info = bridge.resolveRef(ref);
      if (!info?.selector) throw new Error(`Unknown ref "${ref}" — run read_page to refresh refs`);
      target = { selector: info.selector };
    } else if (selector) target = selector;
    else if (text != null) target = { text };
    else throw new Error("wait_for needs selector, text, or ref");
    return json(await bridge.dom.waitFor(tab(), target, { timeoutMs: timeout_ms, intervalMs: interval_ms }));
  }));

  // 21. wait_for_load
  server.tool("wait_for_load", "Wait for the page to reach a load state", {
    until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).default("load"),
    timeout_ms: z.number().int().min(1000).max(300000).default(30000),
  }, guard(async ({ until, timeout_ms }) => {
    return json(await bridge.nav.waitReady({ until, timeoutMs: timeout_ms }));
  }));

  // 22. tabs
  server.tool("tabs", "List, open, switch, close, or inspect tabs", {
    action: z.enum(["list", "open", "switch", "close", "info"]),
    url: z.string().url().optional(),
    tab_id: z.number().int().optional(),
    window_id: z.number().int().optional(),
    active: z.boolean().default(true),
    background: z.boolean().default(false),
  }, guard(async ({ action, url, tab_id, window_id, active, background }) => {
    assertSafeUrl(url ?? "https://example.invalid");
    let result;
    switch (action) {
      case "list":
        result = await bridge.tabs.list(window_id);
        break;
      case "open": {
        if (!url) throw new Error('tabs action=open requires "url"');
        result = await bridge.tabs.open(url, { active: !background, windowId: window_id });
        if (result?.tabId != null && !background) {
          bridge.setCurrentTab(result.tabId, result.windowId ?? null);
        }
        break;
      }
      case "switch": {
        if (tab_id == null) throw new Error('tabs action=switch requires "tab_id"');
        result = await bridge.tabs.activate(tab_id);
        if (result?.windowId != null) bridge.setCurrentTab(tab_id, result.windowId);
        else bridge.setCurrentTab(tab_id, null);
        break;
      }
      case "close":
        if (tab_id == null) throw new Error('tabs action=close requires "tab_id"');
        result = await bridge.tabs.close(tab_id);
        break;
      case "info":
        result = await bridge.tabs.info(tab(tab_id));
        break;
    }
    return json(result);
  }));

  // 23. windows
  server.tool("windows", "List browser windows, focus one, or close one", {
    action: z.enum(["list", "focus", "close"]).default("list"),
    window_id: z.number().int().optional(),
  }, guard(async ({ action, window_id }) => {
    let result;
    switch (action) {
      case "list":
        result = await bridge.windows.list();
        break;
      case "focus":
        if (window_id == null) throw new Error('windows action=focus requires "window_id"');
        result = await bridge.windows.activate(window_id);
        break;
      case "close":
        if (window_id == null) throw new Error('windows action=close requires "window_id"');
        result = await bridge.windows.close(window_id);
        break;
    }
    return json(result);
  }));

  // 24. detect_captcha
  server.tool("detect_captcha", "Check whether the current page shows a CAPTCHA (recaptcha/hcaptcha/turnstile/geetest/funcaptcha)", {},
    guard(async () => {
      const res = await bridge.dom.detectCaptcha(tab());
      return json(res.detected
        ? { ...res, hint: "Run wait_for_captcha after the user solves it." }
        : res);
    }));

  // 25. wait_for_captcha
  server.tool("wait_for_captcha", "Wait up to timeout_ms for the user to solve the page's CAPTCHA", {
    timeout_ms: z.number().int().min(1000).max(180000).default(60000),
  }, guard(async ({ timeout_ms }) => {
    return json(await bridge.captcha.wait({ timeoutMs: timeout_ms }));
  }));

  // 26. video_control
  server.tool("video_control", "Control HTML5 video/audio playback: play, pause, toggle, mute, unmute, seek, set_speed, set_volume, fullscreen, exit_fullscreen, get_info", {
    action: z.enum(["play", "pause", "toggle", "mute", "unmute", "seek", "set_speed", "set_volume", "fullscreen", "exit_fullscreen", "get_info"]),
    value: z.union([z.number(), z.string()]).optional(),
  }, guard(async ({ action, value }) => {
    const tabId = tab();
    const BRIDGE_ACTIONS = new Set(["play", "pause", "toggle", "mute", "unmute"]);
    if (BRIDGE_ACTIONS.has(action)) {
      return json(await bridge.dom.videoControl(tabId, action, null));
    }
    if (action === "seek") {
      return json(await bridge.dom.videoControl(tabId, "seek", Number(value ?? 0)));
    }
    if (action === "set_speed") {
      return json(await bridge.dom.videoControl(tabId, "rate", Number(value ?? 1)));
    }
    return json(await evalV(tabId, pageVideoExtra, [action, value ?? null]));
  }));

  // 27. search
  const SEARCH_URLS = {
    google: (q, region) => `https://www.google.com/search?q=${q}${region ? `&gl=${region}` : ""}`,
    bing: (q, region) => `https://www.bing.com/search?q=${q}${region ? `&mkt=${region}` : ""}`,
    duckduckgo: (q, region) => `https://duckduckgo.com/?q=${q}${region ? `&kl=${region}` : ""}`,
    brave: (q, region) => `https://search.brave.com/search?q=${q}${region ? `&country=${region}` : ""}`,
    youtube: (q) => `https://www.youtube.com/results?search_query=${q}`,
    reddit: (q) => `https://www.reddit.com/search/?q=${q}`,
    github: (q) => `https://github.com/search?type=repositories&q=${q}`,
    stackoverflow: (q) => `https://stackoverflow.com/search?q=${q}`,
    wikipedia: (q) => `https://en.wikipedia.org/w/index.php?search=${q}`,
  };
  server.tool("search", "Run a web search in the active tab and return the top results", {
    query: z.string(),
    platform: z.enum(["google", "bing", "duckduckgo", "brave", "youtube", "reddit", "github", "stackoverflow", "wikipedia"]).default("google"),
    region: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }, guard(async ({ query, platform, region, limit }) => {
    const enc = encodeURIComponent(query);
    const url = SEARCH_URLS[platform](enc, region);
    assertSafeUrl(url);
    await bridge.nav.goto(url, { waitUntil: "load" });
    await sleep(800); // SPA shells paint results after load fires
    const res = await evalV(tab(), pageSearchResults, [platform, limit]);
    addHistoryEntry({ url, title: `Search [${platform}]: ${query}`, tabId: bridge.currentTabId });
    return json({ query, platform, region: region ?? null, ...res });
  }));

  // 28. search_tabs
  server.tool("search_tabs", "Search across all open tabs by title or URL (TF-IDF ranked)", {
    query: z.string(),
    limit: z.number().int().min(1).max(100).default(20),
  }, guard(async ({ query, limit }) => {
    const { tabs: openTabs } = await bridge.tabs.list();
    const docs = (openTabs || []).map((t) => ({
      id: t.id,
      windowId: t.windowId ?? null,
      active: !!t.active,
      title: t.title || "",
      url: t.url || "",
      tokens: [...tokenize(t.title || ""), ...tokenize((t.url || "").replace(/[/:?#&=._~+-]+/g, " "))],
    }));
    if (!docs.length) return json([]);
    const qTokens = tokenize(query);
    if (!qTokens.length) throw new Error(`Query produced no searchable terms: "${query}"`);
    const weights = idf(docs.map((d) => d.tokens));
    const weighted = (tf) => {
      const out = new Map();
      for (const [term, freq] of tf) out.set(term, freq * (1 + (weights.get(term) || 0)));
      return out;
    };
    const qVec = weighted(termFreq(qTokens));
    const qLower = query.toLowerCase();
    const scored = docs.map((d, i) => {
      const substringHit = d.title.toLowerCase().includes(qLower) || d.url.toLowerCase().includes(qLower);
      return {
        id: d.id,
        windowId: d.windowId,
        active: d.active,
        title: d.title,
        url: d.url,
        score: +(cosineSimilarity(qVec, weighted(termFreq(d.tokens))) + (substringHit ? 0.25 : 0)).toFixed(4),
      };
    })
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return json(scored.length ? scored : `No open tabs matching "${query}".`);
  }));

  // 29. network_start
  server.tool("network_start", "Start capturing HTTP traffic on the active tab via CDP", {
    max_time: z.number().int().min(1000).max(600000).default(30000),
    include_static: z.boolean().default(false),
  }, guard(async ({ max_time, include_static }) => {
    return json(await bridge.net.start({ maxTimeMs: max_time, includeStatic: include_static }));
  }));

  // 30. network_stop
  server.tool("network_stop", "Stop network capture and return everything captured so far", {}, guard(async () => {
    return json(await bridge.net.stop());
  }));

  // 31. network_list
  server.tool("network_list", "Peek at captured requests without stopping capture", {}, guard(async () => {
    return json(await bridge.net.peek());
  }));

  // 32. network_request
  server.tool("network_request", "Send an HTTP request through the browser profile (cookies/session apply)", {
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
    timeout_ms: z.number().int().min(1000).max(300000).default(20000),
  }, guard(async ({ url, method, headers, body, timeout_ms }) => {
    assertSafeUrl(url);
    return json(await bridge.http.request({ url, method, headers, body, timeoutMs: timeout_ms }));
  }));

  // 33. cookies
  server.tool("cookies", "Get cookies (filter by domain/name), set cookies, delete/clear (auto-backup first), export/import encrypted snapshots", {
    action: z.enum(["get", "set", "delete", "clear", "export", "import"]).default("get"),
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string().default(""),
      url: z.string().optional(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      http_only: z.boolean().optional(),
      same_site: z.enum(["no_restriction", "lax", "strict", "unspecified"]).optional(),
      expiration_date: z.number().optional(),
    })).optional(),
    domain: z.string().optional(),
    name: z.string().optional(),
    file: z.string().optional(),
  }, guard(async ({ action, cookies, domain, name, file }) => {
    switch (action) {
      case "get": {
        const filter = {};
        if (domain != null) filter.domain = domain;
        if (name != null) filter.name = name;
        const list = unwrapList(await bridge.cookies.all(filter));
        return json({
          count: list.length,
          truncated: list.length > 500,
          cookies: list.slice(0, 500).map(({ value, ...rest }) => rest),
        });
      }
      case "set": {
        if (!cookies?.length) throw new Error('cookies action=set requires a "cookies" array');
        let set = 0;
        const errors = [];
        for (const c of cookies) {
          try {
            await bridge.cookies.set(c);
            set += 1;
          } catch (e) {
            errors.push({ name: c.name, error: e?.message || String(e) });
          }
        }
        return json({ ok: errors.length === 0, set, attempted: cookies.length, errors });
      }
      case "delete":
      case "clear": {
        if (action === "delete" && !name) throw new Error('cookies action=delete requires "name" (use clear to wipe a whole domain)');
        const filter = domain ? { domain } : {};
        const targets = unwrapList(await bridge.cookies.all(filter))
          .filter((c) => !name || c.name === name);
        const backup = await snapshotCookies(filter); // safety net before destroying state
        let cleared = 0;
        for (const c of targets) {
          const scheme = c.secure ? "https" : "http";
          const host = String(c.domain || "").replace(/^\./, "");
          const cookieUrl = `${scheme}://${host}${c.path || "/"}`;
          try {
            await bridge.cookies.set({
              name: c.name,
              value: "",
              url: cookieUrl,
              expirationDate: Math.floor(Date.now() / 1000) - 1,
            });
            cleared += 1;
          } catch { /* leave it */ }
        }
        return json({ ok: true, action, cleared, attempted: targets.length, backup });
      }
      case "export": {
        const snap = await snapshotCookies(domain ? { domain } : {});
        return json({ ok: true, exported: snap.count, savedTo: snap.file, note: "values are AES-256-GCM encrypted at rest" });
      }
      case "import": {
        let p = file
          ? (isAbsolute(file) ? file : join(COOKIES_DIR, file))
          : readdirSync(COOKIES_DIR).filter((f) => f.endsWith(".json.enc")).sort().map((f) => join(COOKIES_DIR, f)).pop();
        if (!p) throw new Error(`No snapshot found in ${COOKIES_DIR}. Run cookies export first or pass "file".`);
        const payload = decryptCookies(JSON.parse(readFileSync(p, "utf8")));
        if (!Array.isArray(payload)) throw new Error(`Could not decrypt ${p} (wrong COOKIE_ENCRYPTION_KEY?)`);
        let restored = 0;
        for (const c of payload) {
          try {
            await bridge.cookies.set(c);
            restored += 1;
          } catch { /* skip */ }
        }
        return json({ ok: true, imported: payload.length, restored, from: p });
      }
      default:
        throw new Error(`Unknown cookies action: ${action}`);
    }
  }));

  // 34. bookmark_add
  server.tool("bookmark_add", "Add a bookmark (updates title/tags if the URL already exists)", {
    url: z.string().url(),
    title: z.string(),
    tags: z.array(z.string()).default([]),
  }, guard(async ({ url, title, tags }) => {
    const normTags = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];
    const existing = bookmarks.find((b) => b.url === url);
    if (existing) {
      Object.assign(existing, { title, tags: normTags });
      saveBookmarks?.();
      return json({ ok: true, updated: true, id: existing.id, url, tags: normTags });
    }
    const entry = {
      id: `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      url, title, tags: normTags, createdAt: Date.now(),
    };
    bookmarks.push(entry);
    saveBookmarks?.();
    return json({ ok: true, created: true, id: entry.id, url, tags: normTags });
  }));

  // 35. bookmark_delete
  server.tool("bookmark_delete", "Delete a bookmark by id (or by exact URL)", {
    id: z.string().optional(),
    url: z.string().optional(),
  }, guard(async ({ id, url }) => {
    if (!id && !url) throw new Error("bookmark_delete needs id or url");
    const idx = bookmarks.findIndex((b) => (id ? b.id === id : b.url === url));
    if (idx === -1) return json({ ok: false, deleted: false, message: `Bookmark ${id || url} not found.` });
    const [removed] = bookmarks.splice(idx, 1);
    saveBookmarks?.();
    return json({ ok: true, deleted: true, id: removed.id, url: removed.url });
  }));

  // 36. bookmark_search
  server.tool("bookmark_search", "Search bookmarks by keyword and/or tags", {
    query: z.string().default(""),
    tags: z.array(z.string()).default([]),
    limit: z.number().int().min(1).max(200).default(50),
  }, guard(async ({ query, tags, limit }) => {
    let results = bookmarks;
    const q = query.trim().toLowerCase();
    if (q) {
      results = results.filter((b) =>
        b.title.toLowerCase().includes(q)
        || b.url.toLowerCase().includes(q)
        || (b.tags || []).some((t) => t.includes(q)));
    }
    const wantedTags = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (wantedTags.length) {
      results = results.filter((b) => (b.tags || []).some((t) => wantedTags.includes(t)));
    }
    results = [...results].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    return json(results.length ? results.slice(0, limit) : "No bookmarks found.");
  }));

  // 37. bookmark_list
  server.tool("bookmark_list", "List all saved bookmarks", {}, guard(async () => {
    return json(bookmarks.length ? bookmarks : "No bookmarks saved.");
  }));

  // 38. history_search
  server.tool("history_search", "Search recorded navigation history (most recent first)", {
    query: z.string().default(""),
    hours: z.number().int().min(1).max(168).default(24),
    limit: z.number().int().min(1).max(500).default(50),
  }, guard(async ({ query, hours, limit }) => {
    const cutoff = Date.now() - hours * 3600000;
    let results = browsingHistory.filter((h) => h.timestamp > cutoff);
    const q = query.trim().toLowerCase();
    if (q) {
      results = results.filter((h) =>
        (h.title || "").toLowerCase().includes(q)
        || h.url.toLowerCase().includes(q));
    }
    return json(results.length ? results.slice(0, limit) : "No history found.");
  }));

  // 39. hover
  server.tool("hover", "Hover over an element to reveal hover menus, tooltips, or submenus", {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    ref: z.string().optional(),
  }, guard(async ({ selector, by_text, scope, ref }) => {
    return json(await performHover(tab(), { selector, by_text, scope, ref }));
  }));

  // 40. computer — unified dispatcher over the same primitives
  server.tool("computer", "Unified interaction: click, double_click, right_click, move, type, fill, key, scroll, hover, wait, navigate, screenshot", {
    action: z.enum(["click", "double_click", "right_click", "move", "type", "fill", "key", "scroll", "hover", "wait", "navigate", "screenshot"]),
    selector: z.string().optional(),
    by_text: z.string().optional(),
    ref: z.string().optional(),
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    key: z.string().optional(),
    url: z.string().url().optional(),
    button: z.enum(["left", "right", "middle"]).default("left"),
    scroll_direction: z.enum(["up", "down", "left", "right"]).default("down"),
    scroll_amount: z.number().int().min(1).max(100000).default(800),
    delay: z.number().int().min(0).max(120000).default(0),
  }, guard(async (a) => {
    const tabId = bridge.requireTab();
    switch (a.action) {
      case "click":
      case "double_click":
      case "right_click":
        return json(await performClick(tabId, {
          selector: a.selector,
          byText: a.by_text,
          ref: a.ref,
          x: a.x,
          y: a.y,
          button: a.action === "right_click" ? "right" : a.button,
          clickCount: a.action === "double_click" ? 2 : 1,
        }));
      case "move":
      case "hover": {
        if (a.x == null && a.y == null && !a.selector && a.by_text == null && a.ref == null) {
          const center = await evalV(tabId, pageViewportCenter, []);
          await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
            { type: "mouseMoved", x: center.x, y: center.y, button: "none", clickCount: 0, pointerType: "mouse" });
          return json({ ok: true, mode: "cdp-trusted", x: center.x, y: center.y });
        }
        return json(await performHover(tabId, {
          selector: a.selector, by_text: a.by_text, ref: a.ref, x: a.x, y: a.y,
        }));
      }
      case "type":
      case "fill":
        return json(await performType(tabId, {
          selector: a.selector,
          ref: a.ref,
          text: a.text || "",
          delayPerChar: a.action === "type" ? a.delay : 0,
        }));
      case "key":
        return json(await performPressKey(tabId, { key: a.key || "Enter", times: 1, selector: a.selector }));
      case "scroll":
        return json(await performScroll(tabId, { direction: a.scroll_direction, amount: a.scroll_amount }));
      case "wait": {
        const ms = a.delay || 1000;
        await sleep(ms);
        return json({ ok: true, waitedMs: ms });
      }
      case "navigate": {
        if (!a.url) throw new Error('computer action=navigate requires "url"');
        assertSafeUrl(a.url);
        return json(await bridge.nav.goto(a.url, { waitUntil: "load", timeoutMs: 30000 }));
      }
      case "screenshot":
        return json(await capturePng(tabId, { fullPage: false, selector: a.selector }));
      default:
        throw new Error(`Unknown computer action: ${a.action}`);
    }
  }));

  // 41. health
  server.tool("health", "Server status, connection transport, store sizes, live refs, and uptime", {}, guard(async () => {
    const state = await bridge.browser.state().catch(() => null);
    return json({
      server: "browser-navigator v2.0.0",
      connected: !!state,
      transport: bridge.transportName(),
      wsPort,
      uptimeSec: Math.round(process.uptime()),
      browser: state
        ? {
          windows: state.windowCount ?? null,
          tabs: state.tabCount ?? null,
          activeTabId: state.activeTabId ?? null,
          extVersion: state.extVersion ?? null,
        }
        : null,
      currentTabId: bridge.currentTabId,
      liveRefs: bridge.refMap.size,
      bookmarks: bookmarks.length,
      historyEntries: browsingHistory.length,
    });
  }));
}
