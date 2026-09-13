/**
 * browser-navigator — tools.js
 * Registers all 43 MCP tools on an McpServer instance. v2.0.14 CSP-safe.
 */

import { z } from "zod";
import * as bridge from "./bridge.js";
import { assertSafeUrl, encryptCookies, decryptCookies } from "./lib/security.js";
import { tokenize, termFreq, idf, cosineSimilarity } from "./lib/tfidf.js";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname, isAbsolute, resolve, sep } from "node:path";

const DATA_DIR = join(process.cwd(), "data");
const SHOTS_DIR = join(DATA_DIR, "screenshots");
const COOKIES_DIR = join(DATA_DIR, "cookies");

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// Page-side functions (closure-free; stringified and shipped over cs.eval)
// ---------------------------------------------------------------------------

function pageClickCoords(t) {
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
  let root = document;
  if (t.scope) {
    root = document.querySelector(t.scope);
    if (!root) return { ok: false, reason: "ELEMENT_NOT_FOUND", message: `scope not found: ${t.scope}` };
  }
  if (t.selector) el = root.querySelector(t.selector);
  else if (t.byText != null || t.text != null) {
    const needle = String(t.byText ?? t.text).trim().toLowerCase();
    el = [...root.querySelectorAll(
      "a,button,input,select,textarea,summary,label,[tabindex],[role=button]",
    )].find((n) => ((n.innerText || n.value || n.placeholder || "")).trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.byText ?? t.text };
  el.focus();
  return {
    ok: document.activeElement === el,
    focused: t.selector ?? t.byText ?? t.text,
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
  let root = document;
  if (t.scope) {
    root = document.querySelector(t.scope);
    if (!root) return { ok: false, reason: "ELEMENT_NOT_FOUND", message: `scope not found: ${t.scope}` };
  }
  if (t.selector) el = root.querySelector(t.selector);
  else if (t.byText != null || t.text != null) {
    const needle = String(t.byText ?? t.text).trim().toLowerCase();
    el = [...root.querySelectorAll(
      "a,button,input,select,textarea,summary,label,[role=button],[role=menuitem],[onclick]",
    )].find((n) => ((n.innerText || n.value || n.placeholder || "")).trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.byText ?? t.text };
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
    ok: true, hovered: t.selector ?? t.byText ?? t.text, tag: el.tagName.toLowerCase(),
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
  const html = el.outerHTML || "";
  const MAX = 500_000;
  return { ok: true, html: html.slice(0, MAX), truncated: html.length > MAX, url: location.href, title: document.title };
}

// NOTE: esc/path helpers are duplicated across pageCollectCandidates, pageLocateByText
// and pageInspectDeep intentionally — each page* function is stringified and
// shipped via cs.eval, so they must be closure-free and cannot share helpers.
function pageCollectCandidates() {
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"));
  // §F.1 fix: path filter 48k ops — avoid [...parent.children].filter array alloc per level
  const nthOfType = (elm) => {
    const tag = elm.tagName;
    let idx = 1, sameCount = 1;
    for (let sib = elm.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === tag) { idx++; sameCount++; }
    for (let sib = elm.nextElementSibling; sib; sib = sib.nextElementSibling) if (sib.tagName === tag) sameCount++;
    return { idx, sameCount };
  };
  const path = (elm) => {
    if (elm.id) return "#" + esc(elm.id);
    const parts = [];
    let cur = elm;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
      const { idx, sameCount } = nthOfType(cur);
      parts.unshift(sameCount > 1 ? `${cur.tagName.toLowerCase()}:nth-of-type(${idx})` : cur.tagName.toLowerCase());
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
  let foundEl = null;
  try {
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const txt = (n.nodeValue || "").trim().toLowerCase();
      if (!txt.includes(needle)) continue;
      const parent = n.parentElement;
      if (!parent) continue;
      if (parent.children.length !== 0) continue;
      foundEl = parent;
      break;
    }
  } catch { foundEl = null; }
  if (!foundEl) {
    foundEl = [...document.querySelectorAll("body *")]
      .find((n) => !n.children.length && (n.textContent || "").trim().toLowerCase().includes(needle)) ?? null;
  }
  const el = foundEl;
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: text };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"));
  const nthOfType2 = (elm) => {
    const tag = elm.tagName;
    let idx = 1, sameCount = 1;
    for (let sib = elm.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === tag) { idx++; sameCount++; }
    for (let sib = elm.nextElementSibling; sib; sib = sib.nextElementSibling) if (sib.tagName === tag) sameCount++;
    return { idx, sameCount };
  };
  const path = (elm) => {
    if (elm.id) return "#" + esc(elm.id);
    const parts = [];
    let cur = elm;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
      const { idx, sameCount } = nthOfType2(cur);
      parts.unshift(sameCount > 1 ? `${cur.tagName.toLowerCase()}:nth-of-type(${idx})` : cur.tagName.toLowerCase());
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
    // §F.1 fix: QSA body* 10k scan — use TreeWalker like pageLocateByText
    const root = document.body || document.documentElement;
    let found = null;
    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        const txt = (n.nodeValue || "").trim().toLowerCase();
        if (!txt.includes(needle)) continue;
        const parent = n.parentElement;
        if (!parent || parent.children.length !== 0) continue;
        found = parent; break;
      }
    }
    el = found ?? [...document.querySelectorAll("body *")]
      .find((n) => !n.children.length && (n.textContent || "").trim().toLowerCase().includes(needle)) ?? null;
  }
  if (!el) return { ok: false, reason: "ELEMENT_NOT_FOUND", target: t.selector ?? t.text };
  const esc = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/([^\w-])/g, "\\$1"));
  const nthDeep = (elm) => {
    const tag = elm.tagName;
    let idx = 1, sameCount = 1;
    for (let sib = elm.previousElementSibling; sib; sib = sib.previousElementSibling) if (sib.tagName === tag) { idx++; sameCount++; }
    for (let sib = elm.nextElementSibling; sib; sib = sib.nextElementSibling) if (sib.tagName === tag) sameCount++;
    return { idx, sameCount };
  };
  const cssPath = (elm) => {
    if (elm.id) return "#" + esc(elm.id);
    const parts = [];
    let cur = elm;
    while (cur && cur.nodeType === 1 && parts.length < 6) {
      const parent = cur.parentElement;
      if (!parent) { parts.unshift(cur.tagName.toLowerCase()); break; }
      const { idx, sameCount } = nthDeep(cur);
      parts.unshift(sameCount > 1 ? `${cur.tagName.toLowerCase()}:nth-of-type(${idx})` : cur.tagName.toLowerCase());
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
  try { el.scrollIntoView({ block: "center", inline: "center" }); } catch {}
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { ok: false, reason: "ELEMENT_NOT_FOUND", message: `Element ${selector} has no size` };
  return {
    ok: true,
    x: r.left,
    y: r.top,
    width: Math.max(1, Math.min(r.width, 8000)),
    height: Math.max(1, Math.min(r.height, 8000)),
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
    // F.3: cap fallback scan to 500 anchors (was 5k → 80-250ms)
    const fallbackAnchors = qsa("a[href]").slice(0, 500);
    for (const a of fallbackAnchors) {
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
          text: JSON.stringify({ ok: false, error: e?.message || String(e), code: e?.code ?? null, retriable: !!e?.retriable }, null, 2),
        }],
        isError: true,
      };
    }
  };

  const tab = (id) => {
    if (id != null) return id;
    if (bridge.currentTabId != null) return bridge.currentTabId;
    throw new Error("Not connected. Run connect_brave first.");
  };

  // Helper to ensure we have a tab, with auto-recovery
  async function ensureTab() {
    if (bridge.currentTabId != null) return bridge.currentTabId;
    try {
      const state = await bridge.browser.state();
      if (state?.activeTabId != null) {
        bridge.setCurrentTab(state.activeTabId, state?.activeWindowId);
        return state.activeTabId;
      }
    } catch {}
    throw new Error("Not connected. Run connect_brave first.");
  }

  const val = (res) => {
    const v = res && typeof res === "object" && "value" in res ? res.value : res;
    if (v && typeof v === "object" && v.ok === false) {
      throw new Error(v.message || `${v.reason || "DOM op failed"}${v.target ? `: ${v.target}` : ""}`);
    }
    return v ?? {};
  };

  const evalV = async (tabId, fn, args = [], opts = {}) => val(await bridge.dom.eval(tabId, fn, args, opts));

  // CSP-safe wrapper: try content.js (ISOLATED, no eval string) first, fallback to cs.eval
  const contentExec = async (tabId, op, args) => val(await bridge.content.exec(tabId, op, args));
  const tryContentThenEval = async (tabId, op, opArgs, fallbackFn, fallbackArgs) => {
    try { return await contentExec(tabId, op, opArgs); }
    catch { return await evalV(tabId, fallbackFn, fallbackArgs); }
  };

  const scopeSel = (selector, scope) =>
    (scope && scope.trim() ? `${scope.trim()} ${selector}` : selector);

  const resolveTarget = ({ selector, by_text, scope, ref } = {}) => {
    if (ref != null) {
      const info = bridge.resolveRef(ref);
      if (!info?.selector) throw new Error(`Unknown ref "${ref}" — run read_page to refresh refs`);
      return { selector: info.selector };
    }
    if (selector) return { selector: scopeSel(selector, scope) };
    if (by_text != null) return { byText: by_text, ...(scope ? { scope } : {}) };
    return null;
  };

  const resolveOut = (savePath, ext) => {
    let p = savePath
      ? (isAbsolute(savePath) ? savePath : join(SHOTS_DIR, savePath))
      : join(SHOTS_DIR, `${ext}_${Date.now()}.${ext}`);
    if (!p.toLowerCase().endsWith(`.${ext}`)) p += `.${ext}`;
    const resolved = resolve(p);
    const base = resolve(SHOTS_DIR);
    if (resolved !== base && !resolved.startsWith(base + sep)) {
      throw new Error(`Path traversal blocked: ${savePath} resolves outside ${SHOTS_DIR}`);
    }
    try {
      mkdirSync(dirname(resolved), { recursive: true, mode: 0o700 });
    } catch (e) {
      console.error(`[tools] mkdir failed for ${dirname(resolved)}:`, e?.message || e);
      throw new Error(`Failed to create directory ${dirname(resolved)}: ${e?.message || e}`);
    }
    return resolved;
  };

  // Display label for a resolved target (selector / byText / text)
  const targetLabel = (t) => t?.selector ?? t?.byText ?? t?.text ?? null;

  async function performClick(tabId, opts = {}) {
    const {
      selector, byText, ref, scope, button = "left",
      clickCount = 1, trusted = true, x, y,
    } = opts;

    const hasCoords = x != null && y != null;
    const target = !hasCoords
      ? resolveTarget({ selector, by_text: byText, scope, ref })
      : null;

    // Coords path: go straight to trusted CDP input (games, canvas, coordinate clicks)
    if (hasCoords) {
      if (trusted) {
        await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
          { type: "mouseMoved", x, y, button: "none", clickCount: 0, pointerType: "mouse" }, { timeoutMs: 8000 });
        await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
          { type: "mousePressed", x, y, button, clickCount, pointerType: "mouse" });
        await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
          { type: "mouseReleased", x, y, button, clickCount, pointerType: "mouse" });
        return { ok: true, mode: "cdp-trusted", x, y, button, clickCount };
      }
      return { ok: true, mode: "coords-only", x, y };
    }

    if (!target) throw new Error("click needs selector, by_text, ref, or x/y coordinates");

    // CSP-safe fast path: content.js clickElement (ISOLATED, no eval string)
    if (target) {
      try {
        const r = await contentExec(tabId, "clickElement", target);
        if (r && r.clicked !== false) return { ok: true, mode: "content", ...r, target: targetLabel(target) };
      } catch {}
    }

    // Resolve element center coords — content.js measureRect first (CSP-safe), eval fallback
    let pt = null;
    try {
      const t = target.selector ? { selector: target.selector } : { byText: target.byText };
      const rect = await contentExec(tabId, "measureRect", t);
      if (rect && rect.width > 0) pt = { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2), tag: null, name: null };
    } catch {}
    if (!pt) {
      try { pt = await evalV(tabId, pageClickCoords, [target]); }
      catch { throw new Error(`click target not found: ${targetLabel(target)}`); }
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
          target: targetLabel(target), tag: pt.tag ?? null, name: pt.name ?? null,
        };
      } catch (e) {
        const fb = await bridge.dom.clickElement(tabId, target);
        return { ...fb, mode: "dom-fallback", trustedError: e?.message || String(e) };
      }
    }
    return bridge.dom.clickElement(tabId, target);
  }

  /** Trusted keyboard via CDP Input.dispatchKeyEvent — required for canvas games,
   *  cross-origin iframes (Poki), and sites rejecting synthetic events. */
  async function performTrustedKey(tabId, key, times = 1) {
    const SPECIAL = {
      enter: ["Enter", "Enter", 13], tab: ["Tab", "Tab", 9],
      escape: ["Escape", "Escape", 27], backspace: ["Backspace", "Backspace", 8],
      delete: ["Delete", "Delete", 46],
      arrowup: ["ArrowUp", "ArrowUp", 38], arrowdown: ["ArrowDown", "ArrowDown", 40],
      arrowleft: ["ArrowLeft", "ArrowLeft", 37], arrowright: ["ArrowRight", "ArrowRight", 39],
      up: ["ArrowUp", "ArrowUp", 38], down: ["ArrowDown", "ArrowDown", 40],
      left: ["ArrowLeft", "ArrowLeft", 37], right: ["ArrowRight", "ArrowRight", 39],
      space: [" ", "Space", 32],
    };
    const parts = String(key).split("+").map((p) => p.trim()).filter(Boolean);
    const keyName = parts.pop() ?? "";
    const mods = parts.reduce((m, p) => {
      const l = p.toLowerCase();
      if (l === "shift") m.shift = 1;
      else if (l === "ctrl" || l === "control") m.ctrl = 1;
      else if (l === "alt" || l === "option") m.alt = 1;
      else if (l === "meta" || l === "cmd" || l === "command") m.meta = 1;
      return m;
    }, {});
    const lower = keyName.toLowerCase();
    let k, code, vk;
    if (SPECIAL[lower]) [k, code, vk] = SPECIAL[lower];
    else if (keyName.length === 1) {
      k = keyName;
      code = /^[a-z]$/i.test(keyName) ? "Key" + keyName.toUpperCase() : /^[0-9]$/.test(keyName) ? "Digit" + keyName : "Unidentified";
      vk = keyName.toUpperCase().charCodeAt(0) || 0;
      if (/[A-Z]/.test(keyName)) mods.shift = 1;
    } else { k = keyName; code = "Unidentified"; vk = 0; }
    for (let i = 0; i < times; i++) {
      await bridge.dbg.command(tabId, "Input.dispatchKeyEvent",
        { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (mods.ctrl||0)|(mods.shift||0)|(mods.alt||0)|(mods.meta||0) });
      if (k.length === 1) {
        await bridge.dbg.command(tabId, "Input.dispatchKeyEvent",
          { type: "char", key: k, code, text: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (mods.ctrl||0)|(mods.shift||0)|(mods.alt||0)|(mods.meta||0) });
      }
      await bridge.dbg.command(tabId, "Input.dispatchKeyEvent",
        { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: (mods.ctrl||0)|(mods.shift||0)|(mods.alt||0)|(mods.meta||0) });
    }
    return { pressed: times, key, mode: "cdp-trusted" };
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
    // CSP-safe: try content.js fillField first
    try {
      const target = sel ? { selector: scopeSel(sel, scope) } : null;
      if (target) return await contentExec(tabId, "fillField", { ...target, text: value });
      else {
        // no selector -> try content fill with active element fallback via eval
        throw new Error("no selector");
      }
    } catch {}
    if (delayPerChar > 0) {
      return evalV(tabId, pageTypeChars, [{ selector: sel ? scopeSel(sel, scope) : null }, value, delayPerChar]);
    }
    if (!sel) return evalV(tabId, pageFillActive, [value]);
    return bridge.dom.fillField(tabId, { selector: scopeSel(sel, scope) }, value);
  }

  async function performScroll(tabId, { direction = "down", amount = 800, selector, scope } = {}) {
    try { return await contentExec(tabId, "scrollPage", { direction, amount, selector: selector ? scopeSel(selector, scope) : null }); }
    catch { return evalV(tabId, pageScroll, [direction, amount, selector ? scopeSel(selector, scope) : null]); }
  }

  async function performHover(tabId, { selector, by_text, scope, ref, x, y } = {}) {
    if (x != null && y != null) {
      await bridge.dbg.command(tabId, "Input.dispatchMouseEvent",
        { type: "mouseMoved", x, y, button: "none", clickCount: 0, pointerType: "mouse" });
      return { ok: true, mode: "cdp-trusted", x, y };
    }
    const target = resolveTarget({ selector, by_text, scope, ref });
    if (!target) throw new Error("hover needs selector, by_text, ref, or x/y coordinates");
    try { return await contentExec(tabId, "hoverElement", target); }
    catch { return evalV(tabId, pageHover, [target]); }
  }

  async function performPressKey(tabId, { key, times = 1, selector } = {}) {
    try {
      if (selector) await contentExec(tabId, "focusElement", { selector });
      return await contentExec(tabId, "pressKeys", { keys: key, times });
    } catch {
      if (selector) await evalV(tabId, pageFocus, [{ selector }]);
      return evalV(tabId, pagePressKey, [key, times]);
    }
  }

  async function capturePng(tabId, { fullPage = false, selector, savePath } = {}) {
    const params = { format: "png", captureBeyondViewport: !!fullPage, optimizeForSpeed: true };
    if (selector) {
      let r;
      try {
        r = await contentExec(tabId, "measureRect", { selector });
      } catch {
        r = await evalV(tabId, pageRectOf, [selector]);
      }
      if (!r.width || !r.height) throw new Error(`Element ${selector} has no size`);
      params.clip = { x: Math.round(r.x), y: Math.round(r.y), width: r.width, height: r.height, scale: 1 };
      if (params.clip.width <= 0 || params.clip.height <= 0) throw new Error(`Invalid clip for ${selector}`);
    }
    const shot = await bridge.dbg.command(tabId, "Page.captureScreenshot", params);
    if (!shot?.data) throw new Error("Browser returned no screenshot data");
    const buf = Buffer.from(shot.data, "base64");
    const out = resolveOut(savePath, "png");
    try {
      writeFileSync(out, buf, { mode: 0o600 });
    } catch (e) {
      console.error(`[tools] writeFile failed for ${out}:`, e?.message || e);
      throw new Error(`Failed to write screenshot to ${out}: ${e?.message || e}`);
    }
    return { savedTo: out, bytes: buf.length, format: "png", fullPage: !!fullPage, clippedTo: selector ?? null };
  }

  async function exportPdf(tabId, { savePath } = {}) {
    const pdf = await bridge.dbg.command(tabId, "Page.printToPDF",
      { printBackground: true, preferCSSPageSize: true });
    if (!pdf?.data) throw new Error("Browser returned no PDF data");
    const buf = Buffer.from(pdf.data, "base64");
    const out = resolveOut(savePath, "pdf");
    try {
      writeFileSync(out, buf, { mode: 0o600 });
    } catch (e) {
      console.error(`[tools] writeFile failed for ${out}:`, e?.message || e);
      throw new Error(`Failed to write PDF to ${out}: ${e?.message || e}`);
    }
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
    try {
      mkdirSync(COOKIES_DIR, { recursive: true, mode: 0o700 });
    } catch (e) {
      console.error(`[tools] mkdir failed for ${COOKIES_DIR}:`, e?.message || e);
      throw new Error(`Failed to create cookies dir: ${e?.message || e}`);
    }
    // rotate: keep last 20
    try {
      const files = readdirSync(COOKIES_DIR).filter(f => f.endsWith(".json.enc")).sort();
      if (files.length >= 20) {
        for (const f of files.slice(0, files.length - 19)) {
          try { unlinkSync(join(COOKIES_DIR, f)); } catch {}
        }
      }
    } catch {}
    const out = join(COOKIES_DIR, `cookies_${Date.now()}_${Math.random().toString(36).slice(2,6)}.json.enc`);
    try {
      const payload = JSON.stringify(encryptCookies(list));
      if (payload.length > 1_000_000) throw new Error("snapshot too large");
      writeFileSync(out, payload, { mode: 0o600 });
    } catch (e) {
      console.error(`[tools] writeFile failed for ${out}:`, e?.message || e);
      throw new Error(`Failed to write cookies snapshot to ${out}: ${e?.message || e}`);
    }
    return { file: out, count: list.length };
  }

  // -------------------------------------------------------------------------
  // Tools 1–41
  // -------------------------------------------------------------------------

  // 1. connect_brave
  server.tool("connect_brave", "FIRST CALL: establish WebSocket to the Brave extension (ws://127.0.0.1:9224) and return live browser state. Call before any tab/page tools. No args. Returns windowCount, tabCount, activeTabId, activeWindowId, transport, sessionId, and next_step hint (run read_page). Retries automatically if extension not yet ready. NOTE: for tests/automation, open a fresh tab via tabs {action:\"open\", url:\"https://example.com\"} and use tab_id for all subsequent calls to avoid hijacking the user's active tab.", {},
    guard(async () => {
      const state = await bridge.browser.state();
      bridge.drainRecentEvents(); // stale events from a previous session are noise
      if (state?.activeTabId != null) {
        bridge.setCurrentTab(state.activeTabId, state.activeWindowId ?? null);
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
  server.tool("disconnect", "Disconnect the MCP transport (extension stays connected to browser). Use to reset pending calls, clear refMap, and force next call to re-handshake. No args. Returns ok. Browser tabs remain open.", {},
    guard(async () => {
      bridge.reset();
      return json({ ok: true, disconnected: true });
    }));

  // 3. navigate — P0.2 adds width/height viewport passthrough (keep BN perf, no extra hops)
  server.tool("navigate", "Navigate a tab to a URL and wait until it settles. Requires connect_brave first. Args: url (https:// only, SSRF-blocked), wait_until (commit|domcontentloaded|load|networkidle, default load), timeout_ms 1s-120s, tab_id optional (defaults to active tab), background (true opens new background tab), width/height (viewport resize 100-8000). Returns tabId/url/title/status/elapsedMs. Auto-saves to history. ISOLATION: for tests/automation always use background:true or tabs {action:\"open\"} + tab_id to avoid hijacking the user's active tab.", {
    url: z.string().url(),
    wait_until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).default("load"),
    timeout_ms: z.number().int().min(1000).max(120000).default(30000),
    tab_id: z.number().int().optional(),
    background: z.boolean().default(false),
    width: z.number().int().min(100).max(8000).optional(),
    height: z.number().int().min(100).max(8000).optional(),
  }, guard(async ({ url, wait_until, timeout_ms, tab_id, background, width, height }) => {
    assertSafeUrl(url);
    // Resolve tab_id: explicit > currentTabId > active tab from extension
    let resolvedTabId = tab_id;
    if (resolvedTabId == null) {
      resolvedTabId = bridge.currentTabId;
      if (resolvedTabId == null) {
        // Try to get active tab from extension
        try {
          const state = await bridge.browser.state();
          resolvedTabId = state?.activeTabId;
          if (resolvedTabId != null) bridge.setCurrentTab(resolvedTabId, state?.activeWindowId);
        } catch {}
      }
    }
    if (resolvedTabId == null) throw new Error("Not connected. Run connect_brave first.");
    if (background) {
      const opened = await bridge.tabs.open(url, { active: false });
      const openedTab = opened?.tab;
      addHistoryEntry({ url, title: openedTab?.title || url, tabId: openedTab?.id ?? null });
      return json({ ok: true, openedInBackground: true, ...opened });
    }
    const result = await bridge.nav.goto(url, {
      tabId: resolvedTabId, waitUntil: wait_until, timeoutMs: timeout_ms,
      ...(Number.isFinite(width) ? { width } : {}),
      ...(Number.isFinite(height) ? { height } : {}),
      background,
    });
    addHistoryEntry({ url, title: result?.title || url, tabId: resolvedTabId });
    return json(result);
  }));

  // 4. navigate_history — CSP-safe: tabs.goBack/goForward via history.navigate, content fallback, cs.eval last
  server.tool("navigate_history", "Navigate session history like browser Back/Forward. Requires active tab. Args: direction (back|forward, default back), steps 1-50. Uses history.go() then 400ms settle. Returns new url/title. Saved to history.", {
    direction: z.enum(["back", "forward"]).default("back"),
    steps: z.number().int().min(1).max(50).default(1),
  }, guard(async ({ direction, steps }) => {
    const tabId = await ensureTab();
    const delta = direction === "back" ? -steps : steps;
    let result;
    try {
      result = await bridge.history.navigate(tabId, delta);
    } catch {}
    if (!result) {
      try {
        result = await contentExec(tabId, "navigateHistory", { delta });
      } catch {
        result = await evalV(tabId,
          "(d) => { history.go(d); return new Promise((res) => setTimeout(() => res({ url: location.href, title: document.title }), 400)); }",
          [delta]);
      }
    }
    addHistoryEntry({ url: result.url || "", title: result.title || "", tabId });
    return json(result);
  }));

  // 5. click — coords x/y go straight to trusted CDP; selector path uses content.js then CDP
  server.tool("click", "Click an element — trusted CDP dispatchMouseEvent with DOM fallback. Use after read_page for ref_N or directly via CSS selector. Args: selector (CSS), by_text (exact visible text), ref (ref_3 from read_page), scope (parent selector), x/y (viewport coords, skips selector), button (left|right|middle), double_click (bool), trusted (true uses CDP isTrusted). Returns mode (cdp-trusted|content|dom-fallback), jsClicked, interceptedBy. For file inputs use type instead. Games/canvas: pass x/y for trusted input.", {
    selector: z.string().optional(),
    double_click: z.boolean().default(false),
    button: z.enum(["left", "right", "middle"]).default("left"),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    ref: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    trusted: z.boolean().default(true),
  }, guard(async ({ selector, double_click, button, by_text, scope, ref, x, y, trusted }) => {
    const result = await performClick(tab(), {
      selector, byText: by_text, scope, ref, button,
      clickCount: double_click ? 2 : 1, trusted, x, y,
    });
    return json(result);
  }));

  // 6. type
  server.tool("type", "Type/fill text into an input, textarea, or contenteditable. Prefers CSP-safe content.js then CDP. Args: selector or ref/scope, text (required), delay (initial ms 0-60000), delay_per_char (0-1000 for human-like typing), scope. Handles checkbox/radio via checked, select via option matching. Dispatches input/change. Returns filled length/tag.", {
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
  server.tool("focus_element", "Focus an element so subsequent press_key goes to the right target. Args: selector or by_text + scope. Uses el.focus() with click fallback. Returns focused bool, tag, activeElement check. Call before press_key on custom widgets/editors.", {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
  }, guard(async ({ selector, by_text, scope }) => {
    const target = resolveTarget({ selector, by_text, scope });
    if (!target) throw new Error("focus_element needs selector or by_text");
    // CSP-safe content.js focusElement first (supports byText + scope), eval fallback
    try { return json(await contentExec(tab(), "focusElement", target)); }
    catch { return json(await evalV(tab(), pageFocus, [target])); }
  }));

  // 8. press_key — trusted: true routes through CDP Input.dispatchKeyEvent (isTrusted,
  // required for canvas games / cross-origin iframes like Poki); default content.js synthetic
  server.tool("press_key", 'Send keyboard shortcut/keys to the focused element (or selector). Args: key (e.g. "Enter", "Tab", "Escape", "Control+a", "Shift+Tab", "Meta+c", "ArrowLeft"), times 1-100 repeats, selector optional (will focus first), trusted bool (true = CDP isTrusted events, use for games/canvas/iframes). Supports modifiers Control/Ctrl, Alt, Shift, Meta/Cmd. Returns pressed count. For typing text, prefer type."', {
    key: z.string(),
    times: z.number().int().min(1).max(100).default(1),
    selector: z.string().optional(),
    trusted: z.boolean().default(false),
  }, guard(async ({ key, times, selector, trusted }) => {
    if (trusted) return json(await performTrustedKey(tab(), key, times));
    return json(await performPressKey(tab(), { key, times, selector }));
  }));

  // 9. scroll
  server.tool("scroll", "Scroll page or scrollable element. Args: direction (up|down|left|right, default down), amount 1-100000px (default 800), selector optional (element selector to scroll inside). Returns before/after scrollX/Y. Call repeatedly for infinite scroll / lazy-load pages.", {
    direction: z.enum(["up", "down", "left", "right"]).default("down"),
    amount: z.number().int().min(1).max(100000).default(800),
    selector: z.string().optional(),
  }, guard(async ({ direction, amount, selector }) => {
    return json(await performScroll(tab(), { direction, amount, selector }));
  }));

  // 10. get_page_info (CSP-safe: content.js first)
  server.tool("get_page_info", "Quick page snapshot: URL, title, readyState, viewport, scroll, referrer, interactiveCount, and captcha detection (recaptcha/hcaptcha/turnstile). Tries content.js first (CSP-safe), falls back to eval. Optional tab_id. Use to verify navigation succeeded or check for bot challenge before acting.", {
    tab_id: z.number().int().optional(),
  }, guard(async ({ tab_id }) => {
    const tabId = tab(tab_id);
    let info;
    try {
      const st = await contentExec(tabId, "getState", {});
      info = { url: st.url, title: st.title, readyState: st.readyState, viewport: null, scroll: null, selection: null, interactiveCount: 0, referrer: null };
    } catch { info = await evalV(tabId, pageInfo, []); }
    let captcha = null;
    try { const c = await contentExec(tabId, "detectCaptcha", {}); captcha = { detected: c.detected, kind: c.type ?? null }; }
    catch { try { const c2 = await bridge.dom.detectCaptcha(tabId); captcha = c2 ? { detected: c2.detected, kind: c2.kind ?? null } : null; } catch { captcha = null; } }
    return json({ tabId, ...info, captcha });
  }));

  // 11. get_page_content
  server.tool("get_page_content", "Extract page content as clean text or raw HTML. Args: format (text|html, default text), limit 100-200000 chars, selector optional (null = whole page, prefers <main>). Text uses TreeWalker+visibility filter (excludes nav/aside). HTML is outerHTML truncated. Returns url/title/content/truncated flag.", {
    format: z.enum(["text", "html"]).default("text"),
    limit: z.number().int().min(100).max(200000).default(10000),
    selector: z.string().optional(),
  }, guard(async ({ format, limit, selector }) => {
    const tabId = await ensureTab();
    if (format === "html") {
      let res;
      try {
        const st = await contentExec(tabId, "getState", {});
        const htmlRes = await contentExec(tabId, "inspectDom", { selector: selector || "html", max_depth: 1, include_html: true });
        res = { url: st.url, title: st.title, html: htmlRes.outerHTML || "" };
      } catch { res = await evalV(tabId, pageExtractHTML, [selector ?? null]); }
      return json({
        format: "html", selector: selector ?? null, url: res.url, title: res.title,
        truncated: res.html.length > limit,
        content: res.html.slice(0, limit),
      });
    }
    let res;
    try {
      const txt = await contentExec(tabId, "extractVisibleText", { region: selector ?? null, limit, fallbackToBody: true });
      const st = await contentExec(tabId, "getState", {});
      res = { url: st.url, title: st.title, text: txt.text || "" };
    } catch {
      res = await bridge.dom.extractVisibleText(tabId, selector ?? null);
    }
    return json({
      format: "text", selector: selector ?? null, url: res.url, title: res.title,
      truncated: (res.text || "").length > limit,
      content: (res.text || "").slice(0, limit),
    });
  }));

  // 12. read_page
  server.tool("read_page", "Core discovery: build AXTree snapshot + DOM candidates → stable ref_N ids for AI targeting. Requires connect_brave. Args: filter (interactive|all, default interactive), max_refs 10-1000. Clears old refs, returns url/title, refCount, omitted, refs[{ref,role,name,selector,href}], and summary lines like \"ref_3 button \"Submit\"\". Pass ref to click/type/hover/wait_for. Call after each navigation.", {
    filter: z.enum(["interactive", "all"]).default("interactive"),
    max_refs: z.number().int().min(10).max(1000).default(150),
  }, guard(async ({ filter, max_refs }) => {
    const tabId = await ensureTab();

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

    let candidates, url, title;
    try {
      const li = await contentExec(tabId, "listInteractive", { kind: "all", limit: 800 });
      const st2 = await contentExec(tabId, "getState", {});
      candidates = (li.elements || []).map(e => ({
        selector: e.selector, tag: e.tag, role: e.role || null, name: e.text || e.ariaLabel || null,
        href: e.href || null, value: e.value || null, visible: true,
      }));
      url = st2.url; title = st2.title;
    } catch {
      const res = await evalV(tabId, pageCollectCandidates, []);
      candidates = res.candidates; url = res.url; title = res.title;
    }
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
  server.tool("list_elements", "List elements by kind with reusable selectors. Args: kind (all|link|button|input|select|textarea|image|heading), contains (substring filter on name/href), scope (parent CSS), limit 1-500. Tries content.js listInteractive then bridge fallback. Returns elements[{tag,role,name,href,selector}]. Use to find specific links/buttons without full AX snapshot.", {
    kind: z.enum(["all", "link", "button", "input", "select", "textarea", "image", "heading"]),
    contains: z.string().optional(),
    scope: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }, guard(async ({ kind, contains, scope, limit }) => {
    const tabId = await ensureTab();
    let elements;
    let pageTitle;
    let pageUrl;

    if (kind === "image" || kind === "heading") {
      let res;
      try {
        const li = await contentExec(tabId, "listInteractive", { kind: "all", limit: 800 });
        const st = await contentExec(tabId, "getState", {});
        res = { title: st.title, url: st.url, candidates: (li.elements||[]).map(e=>({tag:e.tag,name:e.text||e.ariaLabel,selector:e.selector,href:e.href,visible:true})) };
      } catch { res = await evalV(tabId, pageCollectCandidates, []); }
      pageTitle = res.title;
      pageUrl = res.url;
      elements = res.candidates.filter((c) =>
        (kind === "image" ? c.tag === "img" : /^h[1-6]$/.test(c.tag)))
        .map((c) => ({ tag: c.tag, name: c.name, selector: c.selector, href: c.href, visible: c.visible }));
    } else {
      let res;
      try {
        const li = await contentExec(tabId, "listInteractive", { kind, limit: 500 });
        const st = await contentExec(tabId, "getState", {});
        res = { title: st.title, url: st.url, elements: (li.elements||[]).map(e=>({tag:e.tag, role:e.role, name:e.text||e.ariaLabel, href:e.href, type:e.type, selector:e.selector})) };
        pageTitle = res.title; pageUrl = res.url;
        elements = res.elements;
      } catch {
        const r2 = await bridge.dom.listInteractive(tabId, { limit: 500 });
        pageTitle = r2.title; pageUrl = r2.url;
        const KIND_PREDICATE = {
          all: () => true,
          link: (e) => e.tag === "a" || e.role === "link",
          button: (e) => e.tag === "button" || e.role === "button" || (e.tag === "input" && ["submit", "button", "reset"].includes(e.type)),
          input: (e) => e.tag === "input" || ["textbox", "searchbox", "spinbutton"].includes(e.role),
          select: (e) => e.tag === "select" || e.role === "combobox",
          textarea: (e) => e.tag === "textarea",
        };
        elements = r2.elements.filter(KIND_PREDICATE[kind] || (() => true));
      }
    }

    const needle = contains ? contains.trim().toLowerCase() : null;
    if (needle) {
      elements = elements.filter((e) =>
        (e.name || "").toLowerCase().includes(needle)
        || (e.href || "").toLowerCase().includes(needle));
    }
    if (scope && scope.trim()) {
      const scopeSel = scope.trim();
      elements = elements.filter((e) => e.selector && (e.selector === scopeSel || e.selector.startsWith(scopeSel + " ") || e.selector.startsWith(scopeSel + ">") || e.selector.includes(scopeSel)));
    }

    return json({
      kind, scope: scope ?? null, url: pageUrl, title: pageTitle,
      count: Math.min(elements.length, limit),
      total: elements.length,
      elements: elements.slice(0, limit),
    });
  }));

  // 14. inspect_dom — CSP-safe: content.js inspectDom first, cs.eval fallback for non-injected pages
  server.tool("inspect_dom", "Deep inspect single element: tag, id, classes, attributes (truncated), cssPath, rect, visible, child subtree, optional HTML. Args: selector or by_text + scope, max_depth 1-10, include_html bool. Resolves by_text → selector first. Returns tree + html. Use to debug selector or inspect hidden attributes.", {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    max_depth: z.number().int().min(1).max(10).default(3),
    include_html: z.boolean().default(false),
  }, guard(async ({ selector, by_text, scope, max_depth, include_html }) => {
    const target = resolveTarget({ selector, by_text, scope });
    if (!target) throw new Error("inspect_dom needs selector or by_text");
    // Prefer CSP-safe content.js path (isolated world, no eval string → bypasses page CSP + MV3 'unsafe-eval')
    try {
      if (target.byText != null) {
        return json(await contentExec(tab(), "inspectDom", { byText: target.byText, scope: target.scope ?? undefined, max_depth, include_html }));
      }
      if (target.selector) {
        return json(await contentExec(tab(), "inspectDom", { selector: target.selector, max_depth, include_html }));
      }
    } catch {}
    // Fallback to cs.eval for pages without content script (chrome://, pdf)
    if (target.byText != null) {
      const loc = await evalV(tab(), pageLocateByText, [target.byText]);
      return json(await evalV(tab(), pageInspectDeep, [{ selector: loc.selector }, max_depth, include_html]));
    }
    return json(await evalV(tab(), pageInspectDeep, [target, max_depth, include_html]));
  }));

  // 15. screenshot
  server.tool("screenshot", "Screenshot to PNG via CDP Page.captureScreenshot. Args: full_page bool, selector optional (clip to element rect, viewport-relative), save_path optional (inside data/screenshots, traversal-blocked). Writes 0o600. Returns savedTo path, bytes, clippedTo. If selector has zero size, throws.", {
    full_page: z.boolean().default(false),
    selector: z.string().optional(),
    save_path: z.string().optional(),
  }, guard(async ({ full_page, selector, save_path }) => {
    return json(await capturePng(tab(), { fullPage: full_page, selector, savePath: save_path }));
  }));

  // 16. pdf_export
  server.tool("pdf_export", "Save page as PDF via CDP Page.printToPDF (A4, printBackground:true, preferCSSPageSize). Args: save_path optional. Writes 0o600. Returns savedTo, bytes. Use for archiving or offline analysis.", {
    save_path: z.string().optional(),
  }, guard(async ({ save_path }) => {
    return json(await exportPdf(tab(), { savePath: save_path }));
  }));

  // 17. execute_js — CSP-safe: content.js evaluateJs → debugger Runtime.evaluate (bypasses MV3 unsafe-eval), cs.eval last
  server.tool("execute_js", "Execute arbitrary JavaScript in page ISOLATED world and return JSON result. DANGER — requires confirm=true. Args: code string max 20000 (wrap with return for value, or async () => ... auto-detected), confirm bool must be true, redact bool (default true hides passwords/tokens), tab_id optional. Returns stringified result. Bypasses page CSP. Use for custom DOM queries or site-specific hacks.", {
    code: z.string().max(20000),
    confirm: z.boolean().default(false),
    redact: z.boolean().default(true),
    tab_id: z.number().int().optional(),
  }, guard(async ({ code, confirm, redact, tab_id }) => {
    if (!confirm) {
      return { content: [{ type: "text", text: "Refused: execute_js is destructive. Re-run with confirm=true to proceed." }] };
    }
    try {
      const r = await contentExec(tab(tab_id), "evaluateJs", { code });
      const text = r.text != null ? r.text : JSON.stringify(r.value ?? r, null, 2) ?? "undefined";
      return { content: [{ type: "text", text: redact ? redactSecrets(text) : text }] };
    } catch {}
    try {
      const r = await bridge.js.evaluate(tab(tab_id), code);
      const text = r.text != null ? r.text : JSON.stringify(r.value ?? r, null, 2) ?? "undefined";
      return { content: [{ type: "text", text: redact ? redactSecrets(text) : text }] };
    } catch {}
    const trimmed = code.trim();
    const looksLikeFn = /^(async\s+function\b|function\b|async\s*\(|\(|[A-Za-z_$][\w$]*\s*=>)/.test(trimmed);
    const source = looksLikeFn ? trimmed : `async () => (${code})`;
    const result = await evalV(tab(tab_id), source);
    const text = JSON.stringify(result, null, 2) ?? "undefined";
    return { content: [{ type: "text", text: redact ? redactSecrets(text) : text }] };
  }));

  // 18. inject_script
  server.tool("inject_script", "Register persistent MAIN-world script that auto-replays on every navigation (survives reloads). Args: name [A-Za-z0-9_-]{1,64}, code string max 20000 (runs via indirect eval in page global), run_now bool (replay immediately). Stored in chrome.storage.session. Use to install helpers, monkey-patches, or event hooks. Returns registered total + replayNow result.", {
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    code: z.string().max(20000),
    run_now: z.boolean().default(true),
  }, guard(async ({ name, code, run_now }) => {
    await bridge.injected.register(name, code);
    const replay = run_now
      ? await bridge.injected.replay().catch((e) => ({ error: e?.message || String(e) }))
      : null;
    return json({ ok: true, registered: name, replaysOnNavigation: true, replayNow: replay });
  }));

  // 19. send_to_injected
  server.tool("send_to_injected", "Message a registered injected script and await its reply (CustomEvent mcp-inject:<name> → reply). Args: name, data (any JSON-serializable), timeout_ms 500-60000. Ensures runtime, dispatches with nonce, waits for replyEvent. Use for bidirectional JS communication. Returns {name, data: reply detail} or INJECTED_TIMEOUT.", {
    name: z.string(),
    data: z.unknown().optional(),
    timeout_ms: z.number().int().min(500).max(60000).default(5000),
  }, guard(async ({ name, data, timeout_ms }) => {
    return json(await bridge.injected.send(name, data ?? null, { timeoutMs: timeout_ms }));
  }));

  // 20. wait_for — CSP-safe: content.js waitForSelector first, cs.eval fallback
  server.tool("wait_for", "Wait for element to appear (MutationObserver, no polling). Args: selector or text or ref (ref_N from read_page), interval_ms 100-5000 (ignored, kept for compat), timeout_ms 500-120000. Returns found bool, elapsedMs, or TIMEOUT error. Use before clicking dynamically loaded content. Note: text must be leaf-node exact-ish.", {
    selector: z.string().optional(),
    text: z.string().optional(),
    ref: z.string().optional(),
    interval_ms: z.number().int().min(100).max(5000).default(500),
    timeout_ms: z.number().int().min(500).max(120000).default(10000),
  }, guard(async ({ selector, text, ref, interval_ms, timeout_ms }) => {
    let target;
    let selectorStr = null;
    if (ref != null) {
      const info = bridge.resolveRef(ref);
      if (!info?.selector) throw new Error(`Unknown ref "${ref}" — run read_page to refresh refs`);
      target = { selector: info.selector };
      selectorStr = info.selector;
    } else if (selector) {
      target = selector;
      selectorStr = selector;
    } else if (text != null) target = { text };
    else throw new Error("wait_for needs selector, text, or ref");
    // Prefer CSP-safe content.js path for selector-based waits (bypasses MV3 unsafe-eval block)
    if (selectorStr) {
      try {
        const c = await contentExec(tab(), "waitForSelector", { selector: selectorStr, timeoutMs: timeout_ms });
        return json({ ok: true, found: !!c.found, selector: selectorStr, elapsedMs: 0, via: "content" });
      } catch {}
    }
    return json(await bridge.dom.waitFor(tab(), target, { timeoutMs: timeout_ms, intervalMs: interval_ms }));
  }));

  // 21. wait_for_load
  server.tool("wait_for_load", "Wait for tab load state via background waitTabSettled (tabs.onUpdated + readyState). Args: until (commit|domcontentloaded|load|networkidle, default load), timeout_ms 1s-300s. Returns tabId/url/status/title. Use after navigate or for SPA transitions.", {
    until: z.enum(["commit", "domcontentloaded", "load", "networkidle"]).default("load"),
    timeout_ms: z.number().int().min(1000).max(300000).default(30000),
  }, guard(async ({ until, timeout_ms }) => {
    return json(await bridge.nav.waitReady({ until, timeoutMs: timeout_ms }));
  }));

  // 22. tabs
  server.tool("tabs", "Manage tabs: list (all or by windowId), open (url required, active/background + windowId/index), switch (tab_id), close (tab_id), info (tab_id). Auto-validates URL (SSRF-blocked). Open/switch updates bridge currentTabId. Returns tab info (id,windowId,url,title,status,active). Use list before switch/navigate to pick right tab.", {
    action: z.enum(["list", "open", "switch", "close", "info"]),
    url: z.string().url().optional(),
    tab_id: z.number().int().optional(),
    window_id: z.number().int().optional(),
    active: z.boolean().default(true),
    background: z.boolean().default(false),
  }, guard(async ({ action, url, tab_id, window_id, active, background }) => {
    if (action === "open") {
      if (!url) throw new Error('tabs action=open requires "url"');
      assertSafeUrl(url);
    } else if (url) {
      assertSafeUrl(url);
    }
    let result;
    switch (action) {
      case "list":
        result = await bridge.tabs.list(window_id);
        break;
      case "open": {
        if (!url) throw new Error('tabs action=open requires "url"');
        result = await bridge.tabs.open(url, { active: !background, windowId: window_id });
        const openedTab = result?.tab;
        if (openedTab?.id != null && !background) {
          bridge.setCurrentTab(openedTab.id, openedTab.windowId ?? null);
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
  server.tool("windows", "Manage windows: list (populated tabs), focus (window_id), close (window_id). Returns windows[{id,focused,type,state,tabs}]. Use to switch focus before tab ops or to detect popups.", {
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

  // 24. detect_captcha — CSP-safe: content.js detectCaptcha first, cs.eval fallback
  server.tool("detect_captcha", "Detect CAPTCHA presence via selector checks (no heavy outerHTML). Returns detected bool, kind (recaptcha|hcaptcha|turnstile|geetest|funcaptcha|unknown), signals, frameCount. Quick CSP-friendly version of content.js detect. Check before automated form submit.", {},
    guard(async () => {
      try {
        const c = await contentExec(tab(), "detectCaptcha", {});
        const res = { ok: true, detected: !!c.detected, kind: c.type ?? null, signals: [], frameCount: 0 };
        return json(res.detected ? { ...res, hint: "Run wait_for_captcha after the user solves it." } : res);
      } catch {}
      const res = await bridge.dom.detectCaptcha(tab());
      return json(res.detected
        ? { ...res, hint: "Run wait_for_captcha after the user solves it." }
        : res);
    }));

  // 25. wait_for_captcha
  server.tool("wait_for_captcha", "Block until human solves CAPTCHA: delegates to content.js waitForCaptchaSolved (visibility checks + mcp:captcha-solved event) in 8s slices. Args: timeout_ms 1s-180s. Returns solved bool, kind, elapsedMs, or CAPTCHA_WAIT_TIMEOUT. Requires user interaction — notify user to solve.", {
    timeout_ms: z.number().int().min(1000).max(180000).default(60000),
  }, guard(async ({ timeout_ms }) => {
    return json(await bridge.captcha.wait({ timeoutMs: timeout_ms }));
  }));

  // 26. video_control — CSP-safe: content.js videoControl first, cs.eval fallback for legacy pageVideoExtra
  server.tool("video_control", "Control largest visible <video>/<audio> on page. Args: action (play|pause|toggle|mute|unmute|seek|set_speed|set_volume|fullscreen|exit_fullscreen|get_info), value (seconds for seek 0-duration, 0-1 for volume, playbackRate for speed). Returns state {currentTime,duration,paused,muted,volume,playbackRate}. Note: seek clamps, play may fail if autoplay blocked.", {
    action: z.enum(["play", "pause", "toggle", "mute", "unmute", "seek", "set_speed", "set_volume", "fullscreen", "exit_fullscreen", "get_info"]),
    value: z.union([z.number(), z.string()]).optional(),
  }, guard(async ({ action, value }) => {
    const tabId = await ensureTab();
    const CONTENT_MAP = { play: "play", pause: "pause", toggle: "pause", mute: "mute", unmute: "unmute", seek: "seek", set_volume: "volume", set_speed: "rate", fullscreen: "fullscreen" };
    if (action in CONTENT_MAP) {
      try {
        const cAction = CONTENT_MAP[action];
        const cValue = action === "seek" ? Number(value ?? 0) : action === "set_volume" ? Number(value ?? 1) : action === "set_speed" ? Number(value ?? 1) : undefined;
        const r = await contentExec(tabId, "videoControl", cValue != null ? { action: cAction, value: cValue } : { action: cAction });
        return json(r);
      } catch {}
    }
    if (action === "get_info") {
      try {
        const st = await contentExec(tabId, "getState", {});
        return json({ ok: true, videoPresent: !!st.videoPresent, hasVideo: !!st.videoPresent });
      } catch {}
    }
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
  server.tool("search", "Search the web via the active tab (navigates there). Args: query 1-500 chars (required), platform (google|bing|duckduckgo|brave|youtube|reddit|github|stackoverflow|wikipedia), region optional (country code), limit 1-50. Encodes region, uses platform-specific SERP selectors (not hard-coded X selector), waits 2s sentinel. Returns results[{title,url,snippet}], serpTitle/Url, count. Auto-saves to history. ISOLATION: hijacks active tab — for tests use background tab via navigate+extractSearchResults or open a new tab first.", {
    query: z.string().min(1).max(500),
    platform: z.enum(["google", "bing", "duckduckgo", "brave", "youtube", "reddit", "github", "stackoverflow", "wikipedia"]).default("google"),
    region: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }, guard(async ({ query, platform, region, limit }) => {
    const enc = encodeURIComponent(query);
    const rg = region ? encodeURIComponent(region) : undefined;
    const url = SEARCH_URLS[platform](enc, rg);
    assertSafeUrl(url);
    await bridge.nav.goto(url, { waitUntil: "load" });
    const SENTINEL = { google: '#search', bing: '#b_results', duckduckgo: '[data-testid="result"]', brave: '#results', youtube: 'ytd-video-renderer', reddit: 'shreddit-post', github: '.search-title', wikipedia: '.mw-search-result', default: 'a[href]' };
    const sel = SENTINEL[platform] || SENTINEL.default;
    try {
      await contentExec(tab(), "waitForSelector", { selector: sel, timeoutMs: 2000 });
    } catch {
      await bridge.dom.waitFor(tab(), sel, { timeoutMs: 2000 }).catch(() => {});
    }
    let res;
    try {
      res = await contentExec(tab(), "extractSearchResults", { platform, limit });
    } catch {
      res = await evalV(tab(), pageSearchResults, [platform, limit]);
    }
    addHistoryEntry({ url, title: `Search [${platform}]: ${query}`, tabId: bridge.currentTabId });
    return json({ query, platform, region: region ?? null, ...res });
  }));

  // 28. search_tabs — F.3: idf WeakMap cache 5s TTL (avoid 2-5ms per query for 50 tabs)
  let _idfCache = { docsKey: null, idf: null, ts: 0 };
  server.tool("search_tabs", "Semantic search across open tabs by title+URL (TF-IDF + substring boost). Args: query string (tokenized, stopwords removed), limit 1-100. Caches idf 5s. Returns ranked [{id,windowId,active,title,url,score}] or \"No open tabs matching\". Use to find right tab instead of manually listing.", {
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
    const docsKey = docs.length + ":" + docs.map(d => d.id).join(",");
    const now = Date.now();
    let weights = null;
    if (_idfCache.docsKey === docsKey && _idfCache.idf && (now - _idfCache.ts) < 5000) {
      weights = _idfCache.idf;
    } else {
      weights = idf(docs.map((d) => d.tokens));
      _idfCache = { docsKey, idf: weights, ts: now };
    }
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
  server.tool("network_start", "Start CDP network capture (Network+Fetch). Args: max_time 1s-600s, include_static bool (default false filters css/js/img). Holds debugger ref for window. Returns capturing, tabId, startedAt. Call network_list/peek or network_stop to get results. Supersedes previous capture.", {
    max_time: z.number().int().min(1000).max(600000).default(30000),
    include_static: z.boolean().default(false),
  }, guard(async ({ max_time, include_static }) => {
    return json(await bridge.net.start({ maxTimeMs: max_time, includeStatic: include_static }));
  }));

  // 30. network_stop
  server.tool("network_stop", "Stop network capture, disable Fetch/Network, release debugger, sort by ts. Returns capturing:false, count, requests[{requestId,url,method,status,mimeType,resourceType,fromCache,state,bodyPreview,truncated}]. Compare before/after to find API calls.", {}, guard(async () => {
    return json(await bridge.net.stop());
  }));

  // 31. network_list
  server.tool("network_list", "Peek snapshot of ongoing capture without stopping (last 20). Returns capturing, count, requests tail. Use for live debugging while page loads. Empty if no capture started.", {}, guard(async () => {
    return json(await bridge.net.peek());
  }));

  // 32. network_request
  server.tool("network_request", "Fetch via browser profile (credentials:include, rides cookies). Args: url (https only, SSRF-blocked, no data:), method GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS, headers record<string> (Host/content-length blocked, \r\n rejected), body string max 200k, timeout_ms 1s-300s. Handles redirects manually (5 hops, re-validates). Streams body cap 200k. Returns status/statusText/ok/url/headers/body/truncated.", {
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]).default("GET"),
    headers: z.record(z.string().max(512)).optional(),
    body: z.string().max(200000).optional(),
    timeout_ms: z.number().int().min(1000).max(300000).default(20000),
  }, guard(async ({ url, method, headers, body, timeout_ms }) => {
    assertSafeUrl(url);
    if (headers) {
      for (const [k,v] of Object.entries(headers)) {
        if (/[\r\n\0]/.test(k+v) || /^(host|content-length)$/i.test(k)) throw new Error(`blocked header ${k}`);
      }
    }
    return json(await bridge.http.request({ url, method, headers, body, timeoutMs: timeout_ms }));
  }));

  // 33. handle_dialog — P0.2 ported from mcp-chrome MIT dialog.ts
  server.tool("handle_dialog", "Handle JavaScript dialog (alert/confirm/prompt). Args: action (accept|dismiss), promptText optional (for prompt), tab_id optional (active tab). Uses CDP Page.enable + handleJavaScriptDialog with debugger ref. Returns handled, action. Throws if no dialog is open.", {
    action: z.enum(["accept", "dismiss"]),
    promptText: z.string().optional(),
    tab_id: z.number().int().optional(),
  }, guard(async ({ action, promptText, tab_id }) => {
    return json(await bridge.dialog.handle({ action, promptText, tabId: tab_id ?? (await ensureTab()) }));
  }));

  // 34. handle_download — P0.2 ported from mcp-chrome MIT download.ts (polls chrome.downloads)
  server.tool("handle_download", "Poll chrome.downloads until file completes. Args: filenameContains substring (matches basename or url), timeout_ms 1s-300s. Polls 500ms, checks state complete vs interrupted. Returns found, id, filename, url, fileSize. Requires downloads permission.", {
    filenameContains: z.string().optional(),
    timeout_ms: z.number().int().min(1000).max(300000).default(60000),
  }, guard(async ({ filenameContains, timeout_ms }) => {
    return json(await bridge.download.wait({ filenameContains, timeoutMs: timeout_ms }));
  }));

  // 35. cookies
  server.tool("cookies", "Cookie manager (AES-256-GCM encrypted snapshots). Args: action (get|set|delete|clear|export|import), cookies array (for set), domain/name/file filters. get returns truncated list (values redacted). set validates url/domain. delete/clear auto-backups to data/cookies + rotates 20. export saves encrypted, import decrypts. Returns counts + backup paths.", {
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
        {
          const resolved = resolve(p);
          const base = resolve(COOKIES_DIR);
          if (resolved !== base && !resolved.startsWith(base + sep)) {
            throw new Error(`Path traversal blocked: ${file} resolves outside ${COOKIES_DIR}`);
          }
          p = resolved;
        }
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
  server.tool("bookmark_add", "Save bookmark to data/bookmarks.json. Args: url (required), title (required), tags string[] (lowercased deduped). Upserts by exact url. Returns created/updated, id, url, tags. Use to remember important pages for later bookmark_search.", {
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
  server.tool("bookmark_delete", "Remove bookmark by id or exact url. Args: id optional, url optional (one required). Returns deleted bool, id/url. No-op if not found.", {
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
  server.tool("bookmark_search", "Search saved bookmarks by keyword (title/url/tags substring) and/or tags (must include). Args: query string, tags string[], limit 1-200. Sorted by createdAt desc. Returns matches or \"No bookmarks found.\".", {
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
  server.tool("bookmark_list", "List all saved bookmarks sorted by createdAt desc. No args. Returns array or \"No bookmarks saved.\".", {}, guard(async () => {
    return json(bookmarks.length ? bookmarks : "No bookmarks saved.");
  }));

  // 38. history_search
  server.tool("history_search", "Search navigation history (data/history.json, capped 5000). Args: query string, hours 1-168 (default 24h cutoff), limit 1-500. Filters by title/url then slices most recent. Returns matches or \"No history found.\".", {
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
  server.tool("hover", "Hover to reveal tooltips/menus. Args: selector/by_text/scope/ref or x/y coords (dispatches mouseMoved at coords). Tries content.js scrollIntoView + pointer/mouse sequence, falls back to eval pageHover. Returns hovered bool, x/y. Call before clicking hover-only controls.", {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    ref: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
  }, guard(async ({ selector, by_text, scope, ref, x, y }) => {
    return json(await performHover(tab(), { selector, by_text, scope, ref, x, y }));
  }));

  // 42. computer — unified dispatcher over the same primitives (P0.1: fill ref→selector scopeSel, hover cdp, viewport)
  server.tool("computer", "Unified dispatcher — single tool for most interactions (mirrors computer-use). Args: action (click|double_click|right_click|move|type|fill|key|scroll|hover|wait|navigate|screenshot), plus per-action fields: selector/by_text/scope/ref, text (for type/fill), x/y, key, url, button, scroll_direction/amount, delay (for type), width/height/background (for navigate). Routes via performClick/Type/Hover etc. Returns same as individual tools. Prefer for agent loops.", {
    action: z.enum(["click", "double_click", "right_click", "move", "type", "fill", "key", "scroll", "hover", "wait", "navigate", "screenshot"]),
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
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
    width: z.number().int().min(100).max(8000).optional(),
    height: z.number().int().min(100).max(8000).optional(),
    background: z.boolean().optional(),
  }, guard(async (a) => {
    const tabId = await ensureTab();
    switch (a.action) {
      case "click":
      case "double_click":
      case "right_click":
        return json(await performClick(tabId, {
          selector: a.selector,
          byText: a.by_text,
          scope: a.scope,
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
          selector: a.selector, by_text: a.by_text, scope: a.scope, ref: a.ref, x: a.x, y: a.y,
        }));
      }
      case "type":
      case "fill":
        return json(await performType(tabId, {
          selector: a.selector,
          scope: a.scope,
          ref: a.ref,
          text: a.text || "",
          delayPerChar: a.action === "type" ? a.delay : 0,
        }));
      case "key":
        return json(await performTrustedKey(tabId, a.key || "Enter", 1));
      case "scroll":
        return json(await performScroll(tabId, { direction: a.scroll_direction, amount: a.scroll_amount, selector: a.selector, scope: a.scope }));
      case "wait": {
        const ms = a.delay || 1000;
        await sleep(ms);
        return json({ ok: true, waitedMs: ms });
      }
      case "navigate": {
        if (!a.url) throw new Error('computer action=navigate requires "url"');
        assertSafeUrl(a.url);
        return json(await bridge.nav.goto(a.url, { waitUntil: "load", timeoutMs: 30000, width: a.width, height: a.height, background: a.background }));
      }
      case "screenshot":
        return json(await capturePng(tabId, { fullPage: false, selector: a.selector }));
      default:
        throw new Error(`Unknown computer action: ${a.action}`);
    }
  }));

  // 41. health
  server.tool("health", "Server health probe: no browser needed. Returns server v2.0.14, connected bool, transport (websocket|null), wsPort, uptimeSec, browser {windows,tabs,activeTabId,extVersion}, currentTabId, liveRefs (refMap size), bookmarks/history counts. Call anytime to check readiness.", {}, guard(async () => {
    const state = await bridge.browser.state().catch(() => null);
    return json({
      server: "browser-navigator v2.0.14",
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
