#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import { readFileSync as readPkg } from "fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import os from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = join(__dirname, "../../cookies");
const SCREENSHOTS_DIR = join(__dirname, "../../screenshots");
const BOOKMARKS_DIR = join(__dirname, "../../bookmarks");
const HISTORY_DIR = join(__dirname, "../../history");

for (const dir of [COOKIES_DIR, SCREENSHOTS_DIR, BOOKMARKS_DIR, HISTORY_DIR]) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
}

const pkg = JSON.parse(readPkg(join(__dirname, "package.json"), "utf-8"));

const BROWSER_PORT = 9222;

let browser = null;
let contexts = [];
let currentContextIndex = 0;
let currentPage = null;
let connectedViaCDP = false;
let cdpSession = null;
const contextMeta = new Map();
const contextIdMap = new WeakMap();
let nextContextId = 1;
let lastWindowsList = [];

let networkCapture = { active: false, requests: [], cdpSession: null, timeout: null };
let refMap = new Map();
let refCounter = 0;
let injectedScripts = new Map();
let bookmarks = [];
let browsingHistory = [];

let _opLock = Promise.resolve();
function withLock(fn) {
  const p = _opLock.then(() => fn(), () => fn());
  _opLock = p.catch(() => {});
  return p;
}

function getCtxId(ctx) { return contextIdMap.get(ctx) || null; }
function getContext() { return contexts[currentContextIndex] || null; }
function requirePage() {
  syncContexts();
  if (!currentPage) throw new Error("Not connected. Run connect_brave first.");
  return currentPage;
}
function requireBrowser() {
  if (!browser) throw new Error("Not connected. Run connect_brave first.");
  return browser;
}
function text(t) { return { content: [{ type: "text", text: String(t) }] }; }
function textErr(t) { return { content: [{ type: "text", text: String(t) }], isError: true }; }

function log(msg) { console.error(`[browser-navigator] ${msg}`); }

function sanitizeProfile(name) {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  if (!safe || safe.length > 100) throw new Error("Invalid profile name");
  return safe;
}

function safePath(dir, filename) {
  const target = resolve(dir, filename);
  const realDir = realpathSync(dir);
  if (!target.startsWith(realDir + "/") && target !== realDir) {
    throw new Error("Path traversal detected");
  }
  return target;
}

const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "about:", "blob:"]);

function safeNavigateUrl(url, { allowFile = false } = {}) {
  if (typeof url !== "string") throw new Error(`Blocked navigation: expected a string URL, got ${typeof url}`);
  const trimmed = url.trim();
  if (trimmed === "about:blank" || trimmed === "about:blank#") return trimmed;
  const colon = trimmed.indexOf(":");
  if (colon <= 0) throw new Error(`Blocked navigation: "${url}" is not an absolute URL. Include a scheme, e.g. https://example.com.`);
  const scheme = trimmed.slice(0, colon + 1).toLowerCase();
  if (ALLOWED_URL_SCHEMES.has(scheme)) return trimmed;
  if (scheme === "file:" && allowFile) return trimmed;
  const allowed = allowFile ? "http, https, about, blob, file" : "http, https, about, blob";
  throw new Error(`Blocked navigation: "${url}" uses the disallowed "${scheme}" scheme. Allowed schemes: ${allowed}.`);
}

const BLOCKED_HOSTS = new Set([
  "localhost", "localhost.localdomain", "localhost4", "localhost6",
  "0.0.0.0", "::", "::1", "169.254.169.254", "100.100.100.200",
  "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal",
]);

const BLOCKED_CIDRS = [
  [0x00000000, 8],
  [0x0a000000, 8],
  [0x64400000, 10],
  [0x64646400, 24],
  [0x7f000000, 8],
  [0xa9fe0000, 16],
  [0xac100000, 12],
  [0xc0a80000, 16],
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

function isBlockedInternalUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return false; }
  if (!["http:", "https:", "ws:", "wss:"].includes(u.protocol)) return false;
  let host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  if (/^\d{1,10}$/.test(host)) {
    const n = parseInt(host, 10);
    if (Number.isSafeInteger(n) && inBlockedCidrs(ipv4ToInt([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join(".")))) return true;
  }
  const ip = ipv4ToInt(host);
  return ip !== null && inBlockedCidrs(ip);
}

function assertSafeUrl(url) {
  if (isBlockedInternalUrl(url)) {
    throw new Error(`Blocked: ${url} points to an internal/loopback address (SSRF guard).`);
  }
  return url;
}

function extractVisibleText({ region = "", limit = 10000, fallbackToBody = true } = {}) {
  const root = region
    ? (document.querySelector(region) || (fallbackToBody ? document.body : null))
    : document.body;
  if (!root) return "";
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "IFRAME", "SVG", "TEXTAREA", "SELECT", "INPUT", "OPTION"]);
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "LI", "UL", "OL", "H1", "H2", "H3", "H4", "H5", "H6", "TR", "TH", "TD", "BR", "HR", "HEADER", "FOOTER", "ASIDE", "NAV", "MAIN", "BLOCKQUOTE", "PRE", "TABLE", "FIGCAPTION", "SUMMARY", "DL", "DT", "DD"]);
  const parts = [];
  let budget = limit;
  let visited = 0;
  const emit = (s) => { if (budget > 0 && s) { parts.push(s); budget -= s.length; } };
  const emitText = (s) => {
    if (budget <= 0) return;
    const t = s.replace(/\s+/g, " ");
    if (t) { parts.push(t); budget -= t.length; }
  };
  const walk = (node) => {
    if (budget <= 0 || ++visited > 50000) return;
    if (node.nodeType === Node.TEXT_NODE) { emitText(node.data); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (SKIP.has(tag)) return;
    if (node.hidden || node.getAttribute("aria-hidden") === "true") return;
    const cs = getComputedStyle(node);
    if (cs.display === "none" || cs.visibility === "hidden") return;
    if (tag === "BR") { emit("\n"); return; }
    const isBlock = BLOCK.has(tag);
    if (isBlock && parts.length) emit("\n");
    for (let c = node.firstChild; c; c = c.nextSibling) walk(c);
    if (isBlock && parts.length) emit("\n");
  };
  walk(root);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim().slice(0, limit);
}

const KEY_PASSPHRASE = `${os.homedir()}::browser-navigator-mcp`;

function encryptCookies(obj) {
  const salt = randomBytes(16);
  const key = scryptSync(KEY_PASSPHRASE, salt, 32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf-8"), cipher.final()]);
  return JSON.stringify({
    v: 1, alg: "aes-256-gcm", kdf: "scrypt",
    salt: salt.toString("hex"), iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"), data: data.toString("hex"),
  });
}

function decryptCookies(str) {
  let parsed;
  try { parsed = JSON.parse(str); } catch { return null; }
  if (parsed && typeof parsed === "object" && parsed.v === 1 && parsed.alg === "aes-256-gcm") {
    try {
      const key = scryptSync(KEY_PASSPHRASE, Buffer.from(parsed.salt, "hex"), 32);
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parsed.iv, "hex"));
      decipher.setAuthTag(Buffer.from(parsed.tag, "hex"));
      const pt = Buffer.concat([decipher.update(Buffer.from(parsed.data, "hex")), decipher.final()]);
      return JSON.parse(pt.toString("utf-8"));
    } catch (e) {
      log(`decryptCookies: profile undecodable (different user/machine or corrupt): ${e.message}`);
      return null;
    }
  }
  return parsed;
}

async function applyNativeColorScheme(page) {
  const session = await page.context().newCDPSession(page).catch(() => null);
  if (!session) return;
  try {
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "" }] });
  } catch (e) { log(`applyNativeColorScheme: ${e.message}`); }
  finally { await session.detach().catch(() => {}); }
}

async function applyNativeColorSchemeAll() {
  const pages = [];
  for (const ctx of contexts) for (const page of ctx.pages()) pages.push(page);
  await Promise.allSettled(pages.map(p => applyNativeColorScheme(p)));
}

let targetsCache = null;
function invalidateTargetsCache() { targetsCache = null; }

async function getTargetsBatched() {
  if (!cdpSession) return null;
  if (targetsCache) return targetsCache;
  const { targetInfos } = await cdpSession.send("Target.getTargets");
  const map = new Map();
  const byWindow = new Map();
  for (const t of targetInfos) {
    if (t.type !== "page") continue;
    map.set(t.targetId, {
      targetId: t.targetId,
      url: t.url,
      title: t.title,
      browserContextId: t.browserContextId,
      windowId: null,
    });
    if (typeof t.windowId === "number") map.get(t.targetId).windowId = t.windowId;
  }
  for (const info of map.values()) {
    if (info.windowId) continue;
    const key = info.browserContextId ?? info.targetId;
    if (!byWindow.has(key)) byWindow.set(key, []);
    byWindow.get(key).push(info);
  }
  await Promise.allSettled([...byWindow.values()].map(async (group) => {
    for (const rep of group) {
      try {
        const { windowId } = await cdpSession.send("Browser.getWindowForTarget", { targetId: rep.targetId });
        if (windowId) { for (const i of group) i.windowId = windowId; break; }
      } catch {}
    }
  }));
  targetsCache = map;
  return map;
}

function targetInfoForPage(page, targets) {
  if (!targets || !page) return null;
  const url = page.url();
  let hit = null;
  for (const info of targets.values()) {
    if (info.url === url) {
      if (hit) return null;
      hit = info;
    }
  }
  return hit;
}

async function pageWindowInfo(page) {
  try {
    const targets = await getTargetsBatched();
    if (targets) {
      const info = targetInfoForPage(page, targets);
      if (info) return { targetId: info.targetId, windowId: info.windowId };
    }
  } catch {}
  try {
    const s = await page.context().newCDPSession(page);
    try {
      const { targetInfo } = await s.send("Target.getTargetInfo");
      const { windowId } = await s.send("Browser.getWindowForTarget", { targetId: targetInfo.targetId });
      return { targetId: targetInfo.targetId, windowId };
    } finally { await s.detach().catch(() => {}); }
  } catch { return null; }
}

async function waitForPageReady(page, timeout = 30000, waitUntil = "domcontentloaded") {
  try {
    if (waitUntil === "commit") return;
    await page.waitForLoadState("domcontentloaded", { timeout });
    if (waitUntil === "load" || waitUntil === "networkidle") {
      await page.waitForFunction(() => document.readyState === "complete", { timeout }).catch(() => {});
    }
  } catch (e) {
    log(`waitForPageReady: ${e.message}`);
  }
}

function getBravePath() {
  const paths = ["/usr/bin/brave-browser", "/usr/bin/brave", "/opt/brave.com/brave/brave-browser", "/snap/bin/brave", `${process.env.HOME}/.config/BraveSoftware/Brave-Browser/brave-browser`];
  for (const p of paths) { if (existsSync(p)) return p; }
  return "brave-browser";
}

function loadCookies(profileName) {
  const safe = sanitizeProfile(profileName);
  const p = safePath(COOKIES_DIR, `${safe}.json`);
  if (existsSync(p)) {
    try {
      const cookies = decryptCookies(readFileSync(p, "utf-8"));
      if (cookies) return cookies;
      log(`loadCookies: profile "${safe}" could not be decoded; ignoring.`);
    } catch (e) { log(`loadCookies parse error: ${e.message}`); }
  }
  return null;
}

function saveCookiesFn(profileName, cookies) {
  const safe = sanitizeProfile(profileName);
  const p = safePath(COOKIES_DIR, `${safe}.json`);
  writeFileSync(p, encryptCookies(cookies), { mode: 0o600 });
}

function loadBookmarksFile() {
  const p = safePath(BOOKMARKS_DIR, "bookmarks.json");
  if (!existsSync(p)) return [];
  try { const data = JSON.parse(readFileSync(p, "utf-8")); if (Array.isArray(data)) return data; } catch (e) { log(`loadBookmarksFile: ${e.message}`); }
  return [];
}
function saveBookmarksFile() { try { writeFileSync(safePath(BOOKMARKS_DIR, "bookmarks.json"), JSON.stringify(bookmarks, null, 2)); } catch (e) { log(`saveBookmarksFile: ${e.message}`); } }
function loadHistoryFile() {
  const p = safePath(HISTORY_DIR, "history.json");
  if (!existsSync(p)) return [];
  try { const data = JSON.parse(readFileSync(p, "utf-8")); if (Array.isArray(data)) return data; } catch (e) { log(`loadHistoryFile: ${e.message}`); }
  return [];
}
function saveHistoryFile() { try { writeFileSync(safePath(HISTORY_DIR, "history.json"), JSON.stringify(browsingHistory.slice(-5000), null, 2)); } catch (e) { log(`saveHistoryFile: ${e.message}`); } }
function walkChromeBookmarkFolder(node, folder, out) {
  if (!node || typeof node !== "object") return;
  const childFolder = node.type === "folder" && node.name ? `${folder}${folder ? "/" : ""}${node.name}` : folder;
  if (Array.isArray(node.children)) { for (const child of node.children) walkChromeBookmarkFolder(child, childFolder, out); return; }
  if (typeof node.url === "string" && node.url) out.push({ url: node.url, title: node.name || "", folder });
}
bookmarks = loadBookmarksFile();
browsingHistory = loadHistoryFile();

function findContextById(ctxId) {
  return contexts.find((c) => getCtxId(c) === ctxId) || null;
}

function pruneContextMeta() {
  if (!browser) return;
  const liveIds = new Set(browser.contexts().map((c) => getCtxId(c)).filter(Boolean));
  for (const id of contextMeta.keys()) {
    if (!liveIds.has(id)) contextMeta.delete(id);
  }
}

function syncContexts() {
  if (!connectedViaCDP || !browser) return;
  const live = browser.contexts();
  const liveSet = new Set(live);
  contexts = contexts.filter(c => liveSet.has(c));
  for (const ctx of live) {
    if (!contexts.includes(ctx)) {
      const id = getCtxId(ctx) || `ctx_${nextContextId++}`;
      if (!getCtxId(ctx)) contextIdMap.set(ctx, id);
      if (!contextMeta.has(id)) contextMeta.set(id, { isIncognito: false });
      contexts.push(ctx);
    }
  }
  pruneContextMeta();
  if (currentContextIndex >= contexts.length) currentContextIndex = Math.max(0, contexts.length - 1);
  const ctx = getContext();
  if (ctx) {
    const pages = ctx.pages();
    if (pages.length > 0 && !pages.includes(currentPage)) currentPage = pages[0];
    else if (pages.length === 0) currentPage = null;
  } else {
    currentPage = null;
  }
}

function recoverCurrentPage() {
  syncContexts();
  const current = getContext();
  if (current && current.pages().length > 0) return currentPage;
  for (let i = 0; i < contexts.length; i++) {
    const pages = contexts[i].pages();
    if (pages.length > 0) {
      currentContextIndex = i;
      return (currentPage = pages[0]);
    }
  }
  return (currentPage = null);
}

async function detectCaptcha() {
  if (!currentPage) return { found: false, solved: false };
  try {
    return await currentPage.evaluate(() => {
      const url = window.location.href.toLowerCase();
      const bodyText = () => (document.body?.textContent || "").toLowerCase();

      if (url.includes("captcha") || url.includes("recaptcha") || url.includes("challenge")) {
        const body = bodyText();
        if (body.includes("prove you") || body.includes("not a robot") || body.includes("checking your browser")) {
          return { found: true, type: "URL challenge page", solved: false };
        }
      }

      const cf = document.querySelector('#challenge-form, #challenge-running, #challenge-stage');
      if (cf) return { found: true, type: "Cloudflare challenge", solved: false };
      const hasCloudflare = document.querySelector('script[src*="challenges.cloudflare.com"], script[src*="cloudflare"]');
      if (hasCloudflare) {
        const body = bodyText();
        if (!body.includes("checking your browser") && !body.includes("verify you")) {
          return { found: false, solved: true };
        }
      }

      const recaptcha = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]');
      if (recaptcha) {
        const cb = document.querySelector('.recaptcha-checkbox, #recaptcha-anchor');
        if (cb) return { found: true, type: "reCAPTCHA", solved: cb.getAttribute('aria-checked') === 'true' };
        const bframe = document.querySelector('iframe[src*="recaptcha/bframe"]');
        if (bframe && bframe.offsetWidth > 0) return { found: true, type: "reCAPTCHA challenge", solved: false };
        return { found: true, type: "reCAPTCHA", solved: false };
      }

      const hcaptcha = document.querySelector('iframe[src*="hcaptcha"], .h-captcha');
      if (hcaptcha) {
        const cb = document.querySelector('#checkbox');
        if (cb) return { found: true, type: "hCaptcha", solved: cb.classList.contains('checked') };
        return { found: true, type: "hCaptcha", solved: false };
      }

      const turnstile = document.querySelector('iframe[src*="turnstile"], [class*="cf-turnstile"]');
      if (turnstile) {
        const token = document.querySelector('input[name="cf-turnstile-response"]');
        if (token?.value) return { found: true, type: "Cloudflare Turnstile", solved: true };
        return { found: true, type: "Cloudflare Turnstile", solved: false };
      }

      const body = bodyText();
      if (body.includes("i'm not a robot") || body.includes("select all squares") || body.includes("verify you are human") || body.includes("prove you're not a robot")) {
        return { found: true, type: "CAPTCHA text", solved: false };
      }

      const containers = document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="challenge"], [id*="challenge"]');
      for (const c of containers) {
        if (c.tagName === 'A' || c.closest('h1,h2,h3,h4,h5,h6')) continue;
        if (c.offsetWidth > 0 && c.offsetHeight > 0) return { found: true, type: "CAPTCHA container", solved: false };
      }

      return { found: false, solved: false };
    });
  } catch (e) {
    log(`detectCaptcha error: ${e.message}`);
    return { found: false, solved: false };
  }
}

async function waitForCaptchaSolved(timeoutMs = 30000) {
  if (!currentPage) return { solved: false, seconds: 0 };
  const startTime = Date.now();
  const solved = await currentPage.evaluate((timeout) => {
    return new Promise((resolve) => {
      let observer = null;
      const cleanup = () => { if (observer) { try { observer.disconnect(); } catch {} observer = null; } };
      const timer = setTimeout(() => { cleanup(); resolve(false); }, timeout);

      const resolved = () => {
        const recaptcha = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]');
        if (recaptcha) {
          const cb = document.querySelector('.recaptcha-checkbox, #recaptcha-anchor');
          if (cb) return cb.getAttribute('aria-checked') === 'true';
          return false;
        }
        const hcaptcha = document.querySelector('iframe[src*="hcaptcha"], .h-captcha');
        if (hcaptcha) {
          const cb = document.querySelector('#checkbox');
          if (cb) return cb.classList.contains('checked');
          return false;
        }
        const turnstile = document.querySelector('iframe[src*="turnstile"], [class*="cf-turnstile"]');
        if (turnstile) return !!document.querySelector('input[name="cf-turnstile-response"]')?.value;
        if (document.querySelector('#challenge-form, #challenge-running, #challenge-stage')) return false;
        const containers = document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="challenge"], [id*="challenge"]');
        for (const c of containers) {
          if (c.tagName === 'A' || c.closest('h1,h2,h3,h4,h5,h6')) continue;
          if (c.offsetWidth > 0 && c.offsetHeight > 0) return false;
        }
        return true;
      };

      const finish = (val) => { clearTimeout(timer); cleanup(); resolve(val); };
      if (resolved()) return finish(true);
      try {
        observer = new MutationObserver(() => { if (resolved()) finish(true); });
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "aria-checked", "style"] });
      } catch { return finish(resolved()); }
    });
  }, timeoutMs).catch(() => false);
  return { solved, seconds: Math.round((Date.now() - startTime) / 1000) };
}

async function autoWaitForCaptcha() {
  const info = await detectCaptcha();
  if (!info?.found || info.solved) return info?.found ? `${info.type} [SOLVED]` : null;
  const result = await waitForCaptchaSolved(30000);
  if (!result.solved) return `${info.type} [TIMEOUT]`;
  return `${info.type} solved in ${result.seconds}s`;
}

function cleanup() {
  try {
    if (cdpSession) { cdpSession.detach().catch(() => {}); cdpSession = null; }
  } catch {}
  if (browser) {
    if (!connectedViaCDP) browser.close().catch(() => {});
    browser = null;
  }
  connectedViaCDP = false;
  contexts = [];
  currentContextIndex = 0;
  currentPage = null;
  contextMeta.clear();
  targetsCache = null;
}

process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });

const server = new McpServer({ name: "browser-navigator", version: pkg.version });

async function ensureSharedContexts() {
  const live = browser.contexts();
  if (live.length > 0) return live;
  if (connectedViaCDP && cdpSession) {
    try {
      await cdpSession.send("Target.createTarget", { url: "about:blank" });
      for (let i = 0; i < 50 && browser.contexts().length === 0; i++) {
        await new Promise(r => setTimeout(r, 100));
      }
    } catch (e) { log(`ensureSharedContexts: ${e.message}`); }
    const after = browser.contexts();
    if (after.length > 0) return after;
  }
  log("ensureSharedContexts: no contexts available; returning empty");
  return [];
}

async function finalizeConnection() {
  cdpSession = await browser.newBrowserCDPSession();
  contexts = await ensureSharedContexts();
  for (const ctx of contexts) {
    const id = getCtxId(ctx) || `ctx_${nextContextId++}`;
    if (!getCtxId(ctx)) contextIdMap.set(ctx, id);
    if (!contextMeta.has(id)) contextMeta.set(id, { isIncognito: false });
  }
  pruneContextMeta();
  invalidateTargetsCache();
  currentContextIndex = 0;
  if (contexts.length === 0) { currentPage = null; return; }
  currentPage = contexts[0].pages()[0] || await contexts[0].newPage();
  await applyNativeColorSchemeAll();
}

async function connectToBrave() {
  let debugPortAvailable = false;
  try { const r = await fetch(`http://localhost:${BROWSER_PORT}/json/version`, { signal: AbortSignal.timeout(3000) }); debugPortAvailable = r.ok; } catch {}

  if (debugPortAvailable) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${BROWSER_PORT}`);
      connectedViaCDP = true;
      try {
        await finalizeConnection();
      } catch (e) {
        cleanup();
        return { ok: false, message: `Failed to initialize connection: ${e.message}` };
      }
      return { ok: true, message: "Connected to Brave on port " + BROWSER_PORT };
    } catch (e) { return { ok: false, message: `Failed to connect: ${e.message}` }; }
  }

  let braveRunning = false;
  try {
    const { stdout } = await promisify(execFile)("pgrep", ["-fa", "brave-browser"], { timeout: 5000 });
    braveRunning = stdout.trim().length > 0;
  } catch {
    try {
      const { stdout } = await promisify(execFile)("pgrep", ["-fa", "brave"], { timeout: 5000 });
      braveRunning = stdout.trim().length > 0;
    } catch {}
  }

  if (braveRunning) {
    return { ok: false, message: "Brave is running but without debug port enabled. Tell the user to close Brave manually, then call connect_brave again." };
  }

  const bravePath = getBravePath();
  if (!existsSync(bravePath)) {
    return { ok: false, message: "Brave browser not found. Install Brave or start it manually." };
  }
  const child = spawn(bravePath, [`--remote-debugging-port=${BROWSER_PORT}`, "--remote-debugging-address=127.0.0.1", "--remote-allow-origins=http://127.0.0.1,http://localhost", "--force-dark-mode"], { detached: true, stdio: "ignore" });
  child.on("error", (err) => log(`Failed to launch Brave: ${err.message}`));
  child.unref();

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { const r = await fetch(`http://localhost:${BROWSER_PORT}/json/version`); if (r.ok) { debugPortAvailable = true; break; } } catch {}
  }
  if (!debugPortAvailable) return { ok: false, message: "Failed to launch Brave with debug port. Please try again." };

  browser = await chromium.connectOverCDP(`http://localhost:${BROWSER_PORT}`);
  connectedViaCDP = true;
  try {
    await finalizeConnection();
  } catch (e) {
    cleanup();
    return { ok: false, message: `Failed to initialize connection: ${e.message}` };
  }
  return { ok: true, message: "Launched Brave with debug port on port " + BROWSER_PORT };
}

server.tool("connect_brave", "Connect to Brave browser. Attaches to existing tabs. If Brave is running without a debug port it will NOT kill it — ask the user to close Brave manually and retry. Only auto-launches Brave when nothing is running. Returns open tab and window count.", {
  profile: z.string().optional().default("default").describe("Browser profile name (informational only)"),
}, async ({ profile }) => {
  try {
    if (!browser?.isConnected()) {
      const result = await connectToBrave();
      if (!result.ok) return textErr(`Error: ${result.message}`);
    }
    syncContexts();
    const tabCount = contexts.reduce((n, ctx) => n + ctx.pages().length, 0);
    let out = `Connected to Brave\nOpen tabs: ${tabCount}`;
    if (cdpSession) {
      try {
        const targets = await getTargetsBatched();
        const winIds = new Set();
        if (targets) for (const t of targets.values()) if (t.windowId) winIds.add(t.windowId);
        out += `\nWindows: ${winIds.size}`;
        if (winIds.size > 1) out += `\nMultiple windows detected. Use 'windows list' to see them and 'windows switch' to change windows.`;
      } catch { out += `\nWindows: ${contexts.length}`; }
    } else {
      out += `\nWindows: ${contexts.length}`;
    }
    if (currentPage) out += `\nCurrent tab: ${currentPage.url()}`;
    return text(out);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("disconnect", "Disconnect the MCP from the browser. Browser windows and tabs stay open for manual use. Safe to call when done with a session.", {}, async () => {
  try {
    if (cdpSession) { await cdpSession.detach().catch(() => {}); cdpSession = null; }
    if (browser && !connectedViaCDP) await browser.close();
    browser = null; connectedViaCDP = false; contexts = []; currentContextIndex = 0; currentPage = null; contextMeta.clear();
    return text("Disconnected from browser");
  } catch (e) { return textErr(`Error disconnecting: ${e.message}`); }
});

function stopNetworkCapture() {
  if (networkCapture.timeout) { clearTimeout(networkCapture.timeout); networkCapture.timeout = null; }
  const session = networkCapture.cdpSession;
  const requests = networkCapture.requests;
  networkCapture.active = false; networkCapture.requests = []; networkCapture.cdpSession = null;
  if (session) {
    try { session.removeAllListeners("Fetch.requestPaused"); } catch {}
    try { session.removeAllListeners("Network.responseReceived"); } catch {}
    try { session.removeAllListeners("Network.loadingFinished"); } catch {}
    try { session.send("Fetch.disable").catch(() => {}); } catch {}
    try { session.send("Network.disable").catch(() => {}); } catch {}
    try { session.detach().catch(() => {}); } catch {}
  }
  return requests;
}

server.tool("navigate", "Navigate the current tab to a URL. Waits for the page to load, then automatically detects CAPTCHAs and waits up to 120s for the user to solve them. Use wait_until='networkidle' for pages with heavy JS, 'load' for full resources, or 'domcontentloaded' (default) for speed. Set background=true to navigate without changing which tab is focused/active.", {
  url: z.string().describe("Full URL to navigate to (e.g. https://example.com)"),
  wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().default("domcontentloaded").describe("When to consider navigation complete: load=all resources, domcontentloaded=HTML parsed (default), networkidle=no network for 500ms, commit=initial response"),
  timeout: z.number().min(1000).max(120000).optional().default(30000).describe("Max time in ms before navigation is abandoned (default 30000)"),
  background: z.boolean().optional().default(false).describe("If true, navigate without switching/activating tabs (active tab stays unchanged)"),
}, async ({ url, wait_until, timeout, background }) => {
  try {
    let page;
    if (background) {
      syncContexts();
      page = currentPage && getContext()?.pages().includes(currentPage) ? currentPage : null;
      if (!page) throw new Error("Not connected. Run connect_brave first.");
    } else {
      page = requirePage();
    }
    assertSafeUrl(url);
    const safeUrl = safeNavigateUrl(url);
    await page.goto(safeUrl, { waitUntil: wait_until, timeout });
    if (wait_until === "load" || wait_until === "networkidle") {
      await waitForPageReady(page, timeout, wait_until);
    }
    browsingHistory.push({ url: safeUrl, title: await page.title().catch(() => ""), timestamp: new Date().toISOString() });
    saveHistoryFile();
    let result = `Navigated to: ${safeUrl}\nTitle: ${await page.title()}${background ? "\n(background: active tab unchanged)" : ""}`;
    const captchaResult = await autoWaitForCaptcha();
    if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
    return text(result);
  } catch (e) { return textErr(`Error navigating: ${e.message}`); }
});

server.tool("navigate_history", "Go back or forward in the current tab's history. Auto-detects CAPTCHAs after navigating. Fails gracefully if there is no history entry in that direction. Uses the browser's history API and polls for the URL change, so it returns fast even when pages restore from the back/forward cache (which never fire load events).", {
  action: z.enum(["back", "forward"]).describe("Direction: back to previous page, forward to next page"),
}, async ({ action }) => {
  try {
    const page = requirePage();
    const beforeUrl = page.url();
    const target = action === "back" ? "Back" : "Forward";
    const { length: histLen } = await page.evaluate(() => ({ length: history.length }));
    if (action === "back" && histLen <= 1) return text(`No history entry to go back. Already at the first page in history (URL unchanged: ${beforeUrl}).`);
    await page.evaluate((dir) => { try { history[dir](); } catch {} }, action === "back" ? "back" : "forward");
    let changed = false;
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 150));
      if (page.url() !== beforeUrl) { changed = true; break; }
    }
    if (!changed) {
      const after = await page.evaluate(() => history.length);
      if (action === "forward" && after === histLen) return text(`No history entry to go forward. Already at the last page in history (URL unchanged: ${beforeUrl}).`);
      if (action === "back" && after === histLen) return text(`No history entry to go back. Already at the beginning of history (URL unchanged: ${beforeUrl}).`);
    }
    await waitForPageReady(page, 5000, "domcontentloaded");
    let result = `${target} to: ${page.url()}`;
    const captchaResult = await autoWaitForCaptcha();
    if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
    return text(result);
  } catch (e) { return textErr(`Error navigating: ${e.message}`); }
});

server.tool("click", "Click an element on the current page. By default uses a CSS selector; set by_text=true to match by visible text OR aria-label instead. Use ref from read_page for reliable targeting. Supports double-click and left/right/middle mouse buttons. If a real mouse click is blocked, it retries with a JavaScript click.", {
  selector: z.string().optional().describe("CSS selector (e.g. '#submit', '.btn') OR visible text / aria-label when by_text=true. Omit when ref is provided"),
  ref: z.string().optional().describe("Element ref (ref_N) from read_page; takes precedence over selector"),
  by_text: z.boolean().optional().default(false).describe("True: match by visible text content or aria-label instead of CSS selector"),
  scope: z.string().optional().describe("CSS selector of a container to search within (e.g. '[role=dialog]' for the currently open dialog)"),
  double_click: z.boolean().optional().default(false).describe("Perform a double-click instead of a single click"),
  button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button to use (left by default)"),
}, async ({ selector, ref, by_text, scope, double_click, button }) => {
  const page = requirePage();
  const scoped = scope ? page.locator(scope).first() : null;
  try {
    if (ref) {
      const entry = refMap.get(ref);
      if (!entry) return textErr(`Unknown ref "${ref}". Refs reset on every read_page call and on navigation — call read_page again.`);
      selector = entry.selector || (entry.role && entry.name ? `role=${entry.role}[name="${String(entry.name).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]` : null);
      if (!selector) return textErr(`Ref ${ref} (${entry.role}) has no CSS selector or aria name to locate it.`);
    }
    if (!selector) return textErr("Provide either 'selector' or 'ref'.");
    await waitForPageReady(page, 5000, "load");
    let clicked = false;
    let jsClicked = false;
    let found = false;
    if (by_text) {
      const loc = (scoped || page).getByText(selector, { exact: true }).first();
      const alt = (scoped || page).locator(`[aria-label="${selector.replace(/"/g, '\\"')}"]`).first();
      const locCount = await loc.count();
      const altCount = await alt.count();
      const el = locCount > 0 ? loc : alt;
      found = locCount > 0 || altCount > 0;
      if (found) {
        try {
          if (double_click) await el.dblclick({ force: true, button, timeout: 5000 });
          else await el.click({ force: true, button, timeout: 5000 });
          clicked = true;
        } catch {
          const ok = await el.evaluate((n) => { n.click(); return n.isConnected; }).catch(() => false);
          if (ok) jsClicked = true;
        }
      }
    } else {
      const el = (scoped || page).locator(selector).first();
      found = await el.count() > 0;
      if (found) {
        try {
          if (double_click) await el.dblclick({ force: true, button, timeout: 3000 });
          else await el.click({ force: true, button, timeout: 3000 });
          clicked = true;
        } catch {
          const ok = await el.evaluate((n) => { n.click(); return n.isConnected; }).catch(() => false);
          if (ok) jsClicked = true;
        }
      }
      if (!clicked && !jsClicked) {
        const didJs = await page.evaluate(([sel, scp]) => {
          const root = scp ? document.querySelector(scp) : document;
          if (!root) return false;
          const el = root.querySelector(sel);
          if (el) { el.click(); return true; }
          return false;
        }, [selector, scope || null]);
        if (didJs) jsClicked = true;
      }
    }
    if (!found) {
      return textErr(`Element not found: ${selector}${scope ? ` inside "${scope}"` : ""}. Use list_elements to see what's on the page, or inspect_dom to explore the structure.`);
    }
    if (!clicked && !jsClicked) {
      return textErr(`Element found but click failed: ${selector}${scope ? ` inside "${scope}"` : ""}. Real mouse click was blocked or no-op, and the JS click() fallback also failed.`);
    }
    let result = `Clicked${ref ? ` [${ref}]` : ""}: ${selector}`;
    if (jsClicked && !clicked) result += " (via JS click fallback)";
    const captchaResult = await autoWaitForCaptcha();
    if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
    return text(result);
  } catch (e) {
    let hint = "";
    try {
      const diag = await page.evaluate(([sel, scp]) => {
        const root = scp ? document.querySelector(scp) : document;
        if (!root) return null;
        let el = null;
        try { el = root.querySelector(sel); } catch {}
        if (!el) el = [...root.querySelectorAll("button, [role='button'], a")].find(b => (b.innerText || "").trim() === sel || b.getAttribute("aria-label") === sel) || null;
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        if (!top) return null;
        if (el.contains(top) || top.contains(el)) return null;
        return `<${top.tagName.toLowerCase()}${top.className ? ` class="${String(top.className).slice(0, 80)}"` : ""}> "${(top.innerText || top.getAttribute("aria-label") || "").trim().slice(0, 60)}"`;
      }, [selector, scope || null]);
      if (diag) hint = `\nHint: ${diag} is intercepting this click. Try press_key(Escape) to dismiss dialogs, focus_element + keyboard, or click a different element first.`;
    } catch {}
    return textErr(`Error clicking: ${e.message}${hint}`);
  }
});

server.tool("type", "Type text into an input field or text area on the current page. With delay=0 it fills the field instantly; with delay>0 it types character-by-character (useful to look human and trigger JS autocomplete). Can press Enter after typing. Use scope to type into a field inside an open dialog or container.", {
  selector: z.string().describe("CSS selector of the input field or textarea (e.g. '#username', 'input[name=\"q\"]')"),
  text: z.string().describe("Text to type into the field"),
  press_enter: z.boolean().optional().default(false).describe("Press Enter after typing (e.g. to submit a search)"),
  delay: z.number().min(0).max(500).optional().default(0).describe("Delay between keystrokes in ms. 0 = instant fill. Use e.g. 50-100 for human-like typing (max 500)"),
  scope: z.string().optional().describe("CSS selector of a container to search within (e.g. '[role=dialog]' for the currently open dialog)"),
}, async ({ selector, text: t, press_enter, delay, scope }) => {
  try {
    const page = requirePage();
    const loc = scope ? page.locator(scope).first().locator(selector) : page.locator(selector);
    if (delay > 0) await loc.pressSequentially(t, { delay });
    else await loc.fill(t);
    if (press_enter) await loc.press("Enter");
    await loc.waitFor({ state: "attached", timeout: 2000 }).catch(() => {});
    return text(`Typed: ${t}`);
  } catch (e) { return textErr(`Error typing: ${e.message}`); }
});

server.tool("focus_element", "Move keyboard focus to an element by CSS selector or visible text. Many widgets only accept keyboard input once focused — e.g. GitHub tag/chip inputs, comboboxes, and custom dropdowns. After focusing, use press_key (e.g. Backspace/Delete to remove a chip, ArrowDown+Enter to pick a menu item). Use scope to focus inside an open dialog or container. If the element is not natively focusable (e.g. a plain <a> or <span>), this clicks it first to transfer focus.", {
  selector: z.string().describe("CSS selector OR visible text when by_text=true"),
  by_text: z.boolean().optional().default(false).describe("True: match by visible text content instead of CSS selector"),
  scope: z.string().optional().describe("CSS selector of a container to search within (e.g. '[role=dialog]' for the currently open dialog)"),
}, async ({ selector, by_text, scope }) => {
  try {
    const page = requirePage();
    const scoped = scope ? page.locator(scope).first() : null;
    let loc = by_text ? (scoped || page).getByText(selector).first() : (scoped || page).locator(selector).first();
    const count = await loc.count();
    if (!count) return textErr(`Element not found: ${selector}${scope ? ` inside "${scope}"` : ""}. Use list_elements or inspect_dom to find it.`);
    await loc.scrollIntoViewIfNeeded().catch(() => {});
    let focused = false;
    try { await loc.focus(); focused = true; } catch {}
    if (!focused) {
      await loc.click({ force: true, timeout: 3000 }).catch(() => {});
    }
    await page.waitForTimeout(200);
    const activeInfo = await page.evaluate(() => {
      const el = document.activeElement;
      return el ? `${el.tagName.toLowerCase()}: "${(el.innerText || el.getAttribute("aria-label") || el.getAttribute("value") || "").trim().slice(0, 60)}"` : "none";
    });
    const isTarget = await loc.evaluate((el) => el === document.activeElement || el.contains(document.activeElement) || document.activeElement?.contains(el)).catch(() => false);
    return text(`Focused: ${selector}\nActive element: ${activeInfo}\nTarget has focus: ${isTarget ? "yes" : "no — target may need keyboard navigation (Tab/ArrowDown) or the widget manages focus internally"}`);
  } catch (e) { return textErr(`Error focusing: ${e.message}`); }
});

server.tool("press_key", "Send keyboard keys to the focused element or the page. Use for shortcuts (Control+a), submitting forms (Enter), tabbing between fields (Tab), dismissing dialogs/modals (Escape), navigating menus (ArrowDown/ArrowUp + Enter), and removing tag/chip tokens (focus the chip with focus_element, then Backspace or Delete). Accepts comma-separated keys pressed in sequence, and repeats the whole sequence with times.", {
  key: z.string().describe("Key or combo, e.g. 'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'ArrowDown', 'ArrowUp', 'Control+a', 'F11'. Sequence example: 'Tab,Tab,Enter'"),
  times: z.number().int().min(1).max(50).optional().default(1).describe("Repeat the full key sequence this many times (default 1, max 50)"),
}, async ({ key, times }) => {
  try {
    const page = requirePage();
    const keys = key.split(",").map(k => k.trim()).filter(Boolean);
    if (!keys.length) return textErr("Provide at least one key to press");
    for (let i = 0; i < times; i++) {
      for (const k of keys) await page.keyboard.press(k);
    }
    await page.waitForTimeout(300);
    return text(`Pressed: ${keys.join(", ")}${times > 1 ? ` x${times}` : ""}`);
  } catch (e) { return textErr(`Error pressing key: ${e.message}`); }
});

server.tool("scroll", "Scroll the current page. Use down repeatedly to load content on infinite-scroll pages (social media, search results).", {
  direction: z.enum(["up", "down", "left", "right"]).describe("Scroll direction"),
  amount: z.number().optional().default(500).describe("Distance in pixels to scroll (default 500)"),
}, async ({ direction, amount }) => {
  try {
    const page = requirePage();
    if (direction === "up" || direction === "down") {
      await page.mouse.wheel(0, direction === "down" ? amount : -amount);
    } else {
      await page.mouse.wheel(direction === "right" ? amount : -amount, 0);
    }
    await new Promise(r => setTimeout(r, 200));
    return text(`Scrolled ${direction} ${amount}px`);
  } catch (e) { return textErr(`Error scrolling: ${e.message}`); }
});

server.tool("get_page_info", "Get the current page's URL, title, and loading status, plus whether a CAPTCHA is present. Call this after navigating to confirm the page actually loaded what you expect.", {}, async () => {
  try {
    const page = requirePage();
    const [url, title, readyState] = [page.url(), await page.title(), await page.evaluate(() => document.readyState)];
    const status = readyState === "complete" ? "ready" : readyState === "interactive" ? "loading (DOM ready)" : "loading";
    let result = `URL: ${url}\nTitle: ${title}\nStatus: ${status}\nReadyState: ${readyState}`;
    const captcha = await detectCaptcha();
    if (captcha?.found) {
      result += `\nCAPTCHA: ${captcha.type} [${captcha.solved ? "SOLVED" : "UNSOLVED"}]`;
    } else {
      result += `\nCAPTCHA: None detected`;
    }
    return text(result);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("get_page_content", "Extract readable text or raw HTML from the current page (or a specific element via selector). Output is truncated to 10000 characters — for longer content extract from a more specific selector or scroll first.", {
  selector: z.string().optional().default("body").describe("CSS selector of the element to extract (default: whole page body)"),
  format: z.enum(["text", "html"]).optional().default("text").describe("text = visible text, html = raw markup"),
}, async ({ selector, format }) => {
  try {
    const page = requirePage();
    const el = page.locator(selector);
    if (format === "html") {
      return text(await el.evaluate((n) => (n?.innerHTML || "").slice(0, 10000)));
    }
    const region = selector === "body" ? 'main, article, #content, [role="main"]' : selector;
    return text(await page.evaluate(extractVisibleText, {
      region,
      limit: 10000,
      fallbackToBody: selector === "body",
    }));
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("list_elements", "List the interactive elements (buttons, links, inputs, selects, menus, checkboxes) currently on the page, with their visible text and a CSS selector you can reuse. Use this to discover what is clickable/typeable instead of guessing selectors — essential on complex UIs like dialogs, modals, and dropdowns. Can filter by element kind or by text, and scope the search to a container (e.g. an open dialog) with scope.", {
  kind: z.enum(["all", "button", "link", "input", "select", "textarea"]).optional().default("all").describe("Which kind of element to list (default: all interactive)"),
  contains: z.string().optional().describe("Only show elements whose text, value, placeholder, or aria-label contains this string"),
  scope: z.string().optional().describe("CSS selector of a container to limit the search to (e.g. '[role=dialog]' for the currently open dialog)"),
  limit: z.number().optional().default(30).describe("Max number of elements to return (default 30)"),
}, async ({ kind, contains, scope, limit }) => {
  try {
    const page = requirePage();
    const result = await page.evaluate(({ kind, contains, scope, limit }) => {
      const map = {
        button: "button, [role='button'], input[type='button'], input[type='submit']",
        link: "a[href]",
        input: "input, textarea, select",
        select: "select",
        textarea: "textarea",
        all: "button, a[href], input, textarea, select, [role='button'], [role='checkbox'], [role='radio'], [role='tab'], [role='menuitem'], [role='switch'], [role='link']",
      };
      let root = document;
      if (scope) {
        try { root = document.querySelector(scope) || document; } catch {}
      }
      const els = [...root.querySelectorAll(map[kind] || map.all)];
      const out = [];
      const seen = new Set();
      for (const el of els) {
        const label = (el.innerText || el.value || el.placeholder || el.getAttribute("aria-label") || el.getAttribute("title") || "").trim().slice(0, 80);
        if (contains) {
          const hay = (label + " " + (el.textContent || "")).toLowerCase();
          if (!hay.includes(contains.toLowerCase())) continue;
        }
        if (out.length >= limit) break;
        const parts = [];
        let n = el;
        while (n && n.nodeType === 1 && n !== root && parts.length < 5) {
          let s = n.tagName.toLowerCase();
          if (n.id) s += `#${n.id}`;
          const parent = n.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter(c => c.tagName === n.tagName);
            if (siblings.length > 1) s += `:nth-of-type(${siblings.indexOf(n) + 1})`;
          }
          parts.unshift(s);
          n = parent;
        }
        const sel = parts.join(" > ");
        if (seen.has(sel)) continue;
        seen.add(sel);
        out.push({
          kind: el.tagName.toLowerCase() + (el.getAttribute("type") ? `[type="${el.getAttribute("type")}"]` : ""),
          text: label,
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          disabled: el.disabled === true || el.getAttribute("aria-disabled") === "true",
          selector: sel,
          in_scope: root !== document,
        });
      }
      return out;
    }, { kind, contains, scope, limit });
    if (!result.length) return text(`No matching elements found${scope ? ` inside "${scope}"` : ""}. Try list_elements(kind="all") to see everything, or use inspect_dom to explore the page structure.`);
    const lines = result.map((e, i) => `${i}: <${e.kind}>${e.disabled ? " [disabled]" : ""}${e.visible ? "" : " [hidden]"} "${e.text}" -> ${e.selector}`).join("\n");
    return text(`Interactive elements (${result.length})${scope ? ` in ${scope}` : ""}:\n${lines}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("inspect_dom", "Inspect an element's structure and attributes to understand how a complex UI is built (dialogs, dropdowns, token chips, menus, custom widgets). Given a CSS selector or visible text, returns the element's tag, attributes, class names, a reusable CSS path, and its child elements up to max_depth. Use this BEFORE interacting when you are unsure how an element works or when clicks fail. Use scope to inspect elements inside an open dialog or container.", {
  selector: z.string().describe("CSS selector OR exact visible text when by_text=true"),
  by_text: z.boolean().optional().default(false).describe("True: match by exact visible text content instead of CSS selector"),
  scope: z.string().optional().describe("CSS selector of a container to limit the search to (e.g. '[role=dialog]' for the currently open dialog)"),
  max_depth: z.number().optional().default(2).describe("How many levels of child elements to include (default 2)"),
  include_html: z.boolean().optional().default(false).describe("Also return the element's raw outerHTML (first 2000 chars)"),
}, async ({ selector, by_text, scope, max_depth, include_html }) => {
  try {
    const page = requirePage();
    const result = await page.evaluate(({ selector, by_text, scope, max_depth, include_html }) => {
      function pathOf(el, root) {
        const parts = [];
        let n = el;
        while (n && n.nodeType === 1 && n !== root && parts.length < 5) {
          let s = n.tagName.toLowerCase();
          if (n.id) s += `#${n.id}`;
          const parent = n.parentElement;
          if (parent) {
            const siblings = [...parent.children].filter(c => c.tagName === n.tagName);
            if (siblings.length > 1) s += `:nth-of-type(${siblings.indexOf(n) + 1})`;
          }
          parts.unshift(s);
          n = parent;
        }
        return parts.join(" > ");
      }
      function describe(el, depth, root) {
        if (!el || el.nodeType !== 1 || depth > max_depth) return null;
        const attrs = {};
        for (const a of el.attributes) {
          const name = a.name.toLowerCase();
          if (["id", "class", "role", "aria-label", "aria-checked", "aria-expanded", "aria-selected", "aria-current", "aria-disabled", "placeholder", "name", "type", "value", "href", "title", "data-testid", "tabindex"].includes(name)) attrs[name] = a.value;
        }
        const node = { tag: el.tagName.toLowerCase(), attrs, text: (el.innerText || "").trim().slice(0, 80), selector: pathOf(el, root) };
        if (include_html && depth === 0) node.html = el.outerHTML.slice(0, 2000);
        if (el.children.length && depth < max_depth) {
          node.children = [...el.children].slice(0, 15).map(c => describe(c, depth + 1, root)).filter(Boolean);
        }
        return node;
      }
      let root = document;
      if (scope) {
        try { root = document.querySelector(scope) || document; } catch {}
      }
      let els = [];
      if (by_text) {
        const target = selector.trim();
        const matches = (el) => {
          const t = (el.textContent || "").trim();
          return t === target || t.startsWith(target + "\n") || t.startsWith(target + " (");
        };
        const all = [...root.querySelectorAll("*")].filter(matches);
        if (all.length) {
          const focusable = all.filter(el => el.hasAttribute("tabindex") || el.getAttribute("role") || el.tagName === "BUTTON" || el.tagName === "A");
          els = (focusable.length ? focusable : all).slice(0, 5);
        }
      } else {
        try { els = [...root.querySelectorAll(selector)].slice(0, 5); } catch {}
      }
      if (!els.length) return { found: false, hint: by_text ? `No element with that exact text${scope ? ` inside "${scope}"` : ""}. Use list_elements or get_page_content to find the right text.` : `No element matches that selector${scope ? ` inside "${scope}"` : ""}. Try list_elements to discover what is on the page.` };
      return { found: true, scope: scope || "document", count: els.length, elements: els.map(el => describe(el, 0, root)) };
    }, { selector, by_text, scope, max_depth, include_html });
    return text(JSON.stringify(result, null, 2));
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("screenshot", "Capture a PNG screenshot of the current page (full page) or a specific element. The file is saved under the screenshots directory; the returned path tells you where. Provide only a filename, not a full path.", {
  selector: z.string().optional().describe("CSS selector of the element to screenshot (omit to capture the full page)"),
  path: z.string().optional().describe("Output filename only, e.g. 'report.png' (omit for an auto-named file)"),
}, async ({ selector, path }) => {
  try {
    const page = requirePage();
    let savePath;
    if (path) {
      savePath = safePath(SCREENSHOTS_DIR, path.replace(/[^a-zA-Z0-9._-]/g, "_"));
    } else {
      savePath = join(SCREENSHOTS_DIR, `screenshot-${Date.now()}.png`);
    }
    if (selector) await page.locator(selector).screenshot({ path: savePath });
    else await page.screenshot({ path: savePath, fullPage: true });
    return text(`Screenshot saved to: ${savePath}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("execute_js", "Run arbitrary JavaScript in the current page and return the last expression's value. DANGER: set confirm=true to acknowledge. Credential-bearing APIs (cookies, localStorage/sessionStorage, cross-origin network) are stubbed/blocked and the result is redacted. Output is truncated at 50000 chars. Prefer other tools (get_page_content, screenshot) when they suffice.", {
  code: z.string().max(5000).describe("JavaScript to run in the page context. Return a value to have it echoed back. Max 5000 chars"),
  confirm: z.boolean().describe("Must be true. Acknowledges that this executes arbitrary code in the browser context"),
}, async ({ code, confirm }) => {
  if (!confirm) return textErr("execute_js requires confirm=true. This runs arbitrary JavaScript in the browser context.");
  try {
    const PROLOGUE = String.raw`
      (() => {
        try {
          Object.defineProperty(Document.prototype, "cookie", { get(){ return ""; }, set(){}, configurable: true });
          Object.defineProperty(document, "cookie", { get(){ return ""; }, set(){}, configurable: true });
          const stub = { get length(){ return 0; }, clear(){}, getItem(){ return null; }, key(){ return null; }, removeItem(){}, setItem(){} };
          Object.defineProperty(window, "localStorage", { value: stub, configurable: true });
          Object.defineProperty(window, "sessionStorage", { value: stub, configurable: true });
          Object.defineProperty(Navigator.prototype, "sendBeacon", { value(){ return false; }, configurable: true });
          window.WebSocket = class { constructor(){ throw new TypeError("WebSocket blocked"); } };
          const sameOrigin = (u) => { try { return new URL(String(u), location.href).origin === location.origin; } catch { return false; } };
          const origFetch = window.fetch.bind(window);
          window.fetch = (url, opts) => sameOrigin(url) ? origFetch(url, opts)
            : Promise.reject(new TypeError("fetch blocked: non-localhost request"));
          const OrigXHR = window.XMLHttpRequest;
          class SafeXHR extends OrigXHR { open(m, url, ...r) { if (!sameOrigin(url)) throw new TypeError("XHR blocked: non-localhost request"); return super.open(m, url, ...r); } }
          window.XMLHttpRequest = SafeXHR;
          const Img = window.Image;
          window.Image = class extends Img { set src(v) { if (!sameOrigin(v)) throw new TypeError("beacon blocked"); super.src = v; } };
        } catch (e) {}
      })();
    `;
    const raw = await requirePage().evaluate(({ prologue, userCode }) => {
      if (!window.__jsGuardInstalled) {
        try { (0, eval)(prologue); window.__jsGuardInstalled = true; } catch {}
      }
      return eval(userCode);
    }, { prologue: PROLOGUE, userCode: code });
    const normalized = raw === undefined ? "undefined" : raw;
    let out;
    try { out = JSON.stringify(normalized, null, 2); } catch { return textErr("Result is not JSON-serializable; only primitive/array/object values are returned."); }
    if (out === undefined) return textErr("Result is not serializable (functions/undefined are not returned).");
    const redactSecret = (s) => s
      .replace(/(\\?["'])([^"'\\]*(?:token|secret|auth|credential|cookie|session|password|csrf|jwt|api[_-]?key)[^"'\\]*)\1\s*:\s*\1([^"'\\]{4,})\1/gi, '"$2": "[redacted]"')
      .replace(/(\\?["'])?[Ss]et-Cookie["']?\s*:\s*["'][^"']{2,}["']/g, '"Set-Cookie": "[redacted]"')
      .replace(/["']Authorization["']\s*:\s*["'][^"']+["']/gi, '"Authorization": "[redacted]"');
    out = redactSecret(out);
    if (typeof raw === "string") {
      const redactedRaw = redactSecret(raw);
      if (redactedRaw !== raw) {
        const re = JSON.stringify(redactedRaw, null, 2);
        if (re !== out) out = re;
      }
    }
    if (out.length > 50000) return text(`Result (truncated): ${out.substring(0, 50000)}...`);
    return text(`Result: ${out}`);
  } catch (e) { return textErr(`JS error: ${e.message}`); }
});

server.tool("wait_for", "Wait until an element matching a CSS selector appears in the DOM. Useful after clicking or navigating when content loads dynamically. Returns whether the element was found or the wait timed out.", {
  selector: z.string().describe("CSS selector to wait for"),
  timeout: z.number().optional().default(10000).describe("Max wait time in ms (default 10000)"),
}, async ({ selector, timeout }) => {
  try { await requirePage().locator(selector).first().waitFor({ timeout }); return text(`Element found: ${selector}`); }
  catch (e) {
    if (e?.name === "TimeoutError") return textErr(`Timeout waiting for: ${selector}`);
    return textErr(`wait_for failed: ${e?.message || e}`);
  }
});

server.tool("wait_for_load", "Wait for the current page to reach the 'load' state (all resources loaded). Use before extracting content from heavy or slow-loading pages.", {
  timeout: z.number().optional().default(30000).describe("Max wait time in ms (default 30000)"),
}, async ({ timeout }) => {
  try { await requirePage().waitForLoadState("load", { timeout }); return text("Page fully loaded"); }
  catch (e) {
    if (e?.name === "TimeoutError") return textErr(`Timeout: ${e.message}`);
    return textErr(`wait_for_load failed: ${e?.message || e}`);
  }
});

server.tool("tabs", "Manage tabs in the current window. Actions: list (see all tabs with indexes), open (new tab, optionally with a URL), switch (make a tab active), close (close a tab; the last tab cannot be closed). Set background=true to open a tab without focusing it.", {
  action: z.enum(["list", "open", "switch", "close"]).describe("What to do: list tabs, open a new one, switch to an existing one, or close one"),
  url: z.string().optional().describe("URL to load in the new tab (only for action='open')"),
  index: z.number().optional().describe("Tab index as shown by 'list' (required for switch/close)"),
  background: z.boolean().optional().default(false).describe("Only for action='open': create the tab without activating/focusing it (active tab stays unchanged)"),
}, async ({ action, url, index, background }) => {
  try {
    return await withLock(async () => {
      syncContexts();
      invalidateTargetsCache();
      const ctx = getContext();
      if (!ctx) return textErr("Not connected. Run connect_brave first.");

      const pagesInCurrentWindow = async () => {
        const all = ctx.pages();
        if (!currentPage) return all;
        const current = await pageWindowInfo(currentPage);
        if (!current?.windowId) return all;
        const infos = await Promise.all(all.map(p => pageWindowInfo(p)));
        const filtered = all.filter((p, i) => infos[i]?.windowId === current.windowId);
        return filtered.length > 0 ? filtered : all;
      };

      if (action === "list") {
        const pages = await pagesInCurrentWindow();
        const tabs = pages.map(async (p, i) => {
          let title = "";
          try { title = await p.title(); } catch { title = ""; }
          return `${i}: ${p.url()}${title ? ` - ${title}` : ""}${p === currentPage ? " <- active" : ""}`;
        });
        const lines = await Promise.all(tabs);
        let out = `Open tabs in current window (${pages.length}):\n${lines.join("\n")}`;
        const allPages = ctx.pages();
        const otherWindows = allPages.length - pages.length;
        if (otherWindows > 0) out += `\n\nOther windows contain ${otherWindows} more tab${otherWindows !== 1 ? "s" : ""}. Use 'windows list' to see all windows and 'windows switch' to change windows.`;
        return text(out);
      }
      if (action === "open") {
        if (background) {
          if (!cdpSession) return textErr("Error: background open requires a CDP session (run connect_brave first)");
          let bgPage = null;
          try {
            const { targetId } = await cdpSession.send("Target.createTarget", { url: "about:blank", newWindow: false });
            for (let i = 0; i < 50 && !bgPage; i++) {
              for (const p of ctx.pages()) {
                const pinfo = await pageWindowInfo(p);
                if (pinfo?.targetId === targetId) { bgPage = p; break; }
              }
              if (!bgPage) await new Promise(r => setTimeout(r, 100));
            }
          } catch (e) { log(`tabs open background: ${e.message}`); }
          if (!bgPage) return textErr("Error: created background target but could not attach to it");
          try {
            if (url) { assertSafeUrl(url); await bgPage.goto(safeNavigateUrl(url), { waitUntil: "domcontentloaded", timeout: 30000 }); await waitForPageReady(bgPage); }
          } catch (e) { await bgPage.close().catch(() => {}); throw e; }
          await applyNativeColorScheme(bgPage);
          return text(`New tab opened in background${url ? `: ${url}` : ""} (active tab unchanged)\nTitle: ${await bgPage.title()}`);
        }
        let page = null;
        if (currentPage && cdpSession) {
          try {
            const info = await pageWindowInfo(currentPage);
            if (info?.targetId) {
              await cdpSession.send("Target.activateTarget", { targetId: info.targetId });
              const { targetId } = await cdpSession.send("Target.createTarget", { url: "about:blank", newWindow: false });
              for (let i = 0; i < 50 && !page; i++) {
                for (const p of ctx.pages()) {
                  const pinfo = await pageWindowInfo(p);
                  if (pinfo?.targetId === targetId) { page = p; break; }
                }
                if (!page) await new Promise(r => setTimeout(r, 100));
              }
            }
          } catch (e) { log(`tabs open same-window: ${e.message}`); }
        }
        if (!page) page = await ctx.newPage();
        try {
          if (url) { assertSafeUrl(url); await page.goto(safeNavigateUrl(url), { waitUntil: "domcontentloaded", timeout: 30000 }); await waitForPageReady(page); }
        } catch (e) { await page.close().catch(() => {}); throw e; }
        await applyNativeColorScheme(page);
        currentPage = page;
        let result = `New tab opened${url ? `: ${url}` : ""}\nTitle: ${await page.title()}`;
        const captchaResult = await autoWaitForCaptcha();
        if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
        return text(result);
      }
      if (action === "switch") {
        const pages = await pagesInCurrentWindow();
        if (index === undefined || index < 0 || index >= pages.length) return textErr(`Invalid index. Available: 0-${pages.length - 1}`);
        currentPage = pages[index];
        await currentPage.bringToFront();
        return text(`Switched to tab ${index}: ${currentPage.url()}`);
      }
      if (action === "close") {
        const pages = await pagesInCurrentWindow();
        if (pages.length <= 1) return textErr("Cannot close the last tab");
        if (index === undefined || index < 0 || index >= pages.length) return textErr(`Invalid index. Available: 0-${pages.length - 1}`);
        const page = pages[index];
        if (currentPage === page) { currentPage = pages[index > 0 ? index - 1 : 1]; await currentPage.bringToFront(); }
        await page.close();
        return text(`Closed tab`);
      }
    });
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("windows", "Manage browser windows. Actions: list (show every window with its tabs and which one is active), switch (make a different window active), close (close a window and its tabs; the last window cannot be closed).", {
  action: z.enum(["list", "switch", "close"]).describe("What to do: list windows, switch to one, or close one"),
  index: z.number().optional().describe("Window index as shown by 'list' (required for switch/close)"),
}, async ({ action, index }) => {
  try {
    return await withLock(async () => {
      requireBrowser();
      syncContexts();
      invalidateTargetsCache();

      const allWindows = [];

      async function targetIdOfPage(page) {
        try {
          const targets = await getTargetsBatched();
          if (targets) {
            const info = targetInfoForPage(page, targets);
            if (info) return info.targetId;
          }
        } catch {}
        try {
          const s = await page.context().newCDPSession(page);
          try {
            const info = await s.send("Target.getTargetInfo");
            return info.targetInfo.targetId;
          } finally { await s.detach().catch(() => {}); }
        } catch { return null; }
      }

      async function pageByTargetId(targetId) {
        if (!targetId) return null;
        const targets = await getTargetsBatched().catch(() => null);
        for (const ctx of contexts) {
          for (const p of ctx.pages()) {
            const info = targets && targetInfoForPage(p, targets);
            const id = info ? info.targetId : await targetIdOfPage(p);
            if (id === targetId) return { page: p, ctx, ctxIndex: contexts.indexOf(ctx) };
          }
        }
        return null;
      }

      async function getWindowsFromPort(port) {
          try {
            let windowMap = new Map();
            const targets = await getTargetsBatched();
            if (targets) {
              for (const t of targets.values()) {
                const id = t.windowId || "unknown";
                if (!windowMap.has(id)) windowMap.set(id, { tabs: [], windowId: id });
                windowMap.get(id).tabs.push({ url: t.url, title: t.title, id: t.targetId });
              }
            } else {
              const wsTargets = await fetch(`http://localhost:${port}/json`).then(r => r.json()).catch(() => []);
              const pages = wsTargets.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
              for (const t of pages) {
                const unknownId = "unknown";
                if (!windowMap.has(unknownId)) windowMap.set(unknownId, { tabs: [], windowId: unknownId });
                windowMap.get(unknownId).tabs.push({ url: t.url, title: t.title, id: t.id });
              }
            }

            for (const [, win] of windowMap) {
              allWindows.push(win);
            }
          } catch (e) { log(`getWindowsFromPort: ${e.message}`); }
        }

        await getWindowsFromPort(BROWSER_PORT);

        if (action === "list") {
        if (allWindows.length === 0) return text("No windows detected. Run connect_brave first.");
        lastWindowsList = allWindows.slice();

        let currentWindowId = null;
        if (currentPage) {
          const curInfo = await pageWindowInfo(currentPage);
          if (curInfo?.windowId) currentWindowId = curInfo.windowId;
        }
        const lines = allWindows.map((w, i) => {
          const byId = currentWindowId != null && w.windowId === currentWindowId;
          const marker = (byId || (currentWindowId == null && w.tabs.some(t => t.url === currentPage?.url()))) ? " <- active" : "";
          const tabCount = w.tabs.length;
          const tabList = w.tabs.map((t, j) => `    ${j}: ${t.url}${t.title ? ` - ${t.title}` : ""}`).join("\n");
          return `Window ${i}${marker} (${tabCount} tab${tabCount !== 1 ? 's' : ''}):\n${tabList}`;
        });

        return text(`Windows (${allWindows.length}):\n${lines.join("\n")}`);
      }

      if (action === "switch") {
        if (allWindows.length === 0) return textErr("No windows detected. Run connect_brave first.");
        if (index === undefined || index < 0 || index >= allWindows.length) return textErr(`Invalid index. Available: 0-${allWindows.length - 1}`);
        lastWindowsList = allWindows.slice();
        const win = allWindows[index];
        let switched = false;
        for (const tab of win.tabs) {
          const hit = await pageByTargetId(tab.id);
          if (hit) {
            currentContextIndex = hit.ctxIndex;
            currentPage = hit.page;
            await applyNativeColorScheme(currentPage);
            await currentPage.bringToFront();
            switched = true;
            break;
          }
        }
        if (!switched) {
          const tab = win.tabs[0];
          if (!tab) return textErr(`Window ${index} has no tabs.`);
          const fallback = contexts.find(c => c.pages().some(p => p.url() === tab.url));
          if (fallback) {
            currentContextIndex = contexts.indexOf(fallback);
            currentPage = fallback.pages().find(p => p.url() === tab.url) || fallback.pages()[0];
            await applyNativeColorScheme(currentPage);
            await currentPage.bringToFront();
          } else {
            let picked = null;
            if (win.windowId && win.windowId !== "unknown") {
              for (const ctx of contexts) {
                for (const p of ctx.pages()) {
                  const info = await pageWindowInfo(p);
                  if (info?.windowId === win.windowId) { picked = { ctx, page: p }; break; }
                }
                if (picked) break;
              }
              if (!picked) return textErr(`Could not switch to window ${index} (windowId ${win.windowId}): its tabs are not attached to any Playwright context and cannot be activated.`);
            } else {
              const ctx = contexts.find(c => c.pages().length > 0);
              const page = ctx && ctx.pages()[0];
              if (!page) return textErr(`Could not switch to window ${index}: window id is unknown and no page was found in any context.`);
              picked = { ctx, page };
            }
            currentContextIndex = contexts.indexOf(picked.ctx);
            currentPage = picked.page;
            await applyNativeColorScheme(currentPage);
            await currentPage.bringToFront();
          }
        }
        return text(`Switched to window ${index}: ${currentPage.url()}`);
      }

      if (action === "close") {
        if (allWindows.length === 0) return textErr("No windows detected. Run connect_brave first.");
        if (index === undefined || index < 0 || index >= allWindows.length) return textErr(`Invalid index. Available: 0-${allWindows.length - 1}`);
        if (allWindows.length <= 1) return textErr("Cannot close the last window");
        lastWindowsList = allWindows.slice();
        const win = allWindows[index];
        const closedPages = [];
        for (const tab of win.tabs) {
          const hit = await pageByTargetId(tab.id);
          if (hit) { await hit.page.close().catch(() => {}); closedPages.push(hit); }
        }
        if (closedPages.length === 0) {
          const tab = win.tabs[0];
          const fallback = tab && contexts.find(c => c.pages().some(p => p.url() === tab.url));
          if (fallback) {
            for (const p of fallback.pages().filter(p => p.url() === tab.url)) await p.close().catch(() => {});
          }
        }
        lastWindowsList.splice(index, 1);
        const recovered = recoverCurrentPage();
        if (!recovered) {
          if (contexts.length === 0) return textErr("All windows closed. No pages remaining. Run connect_brave to reconnect.");
          return textErr("All pages are closed. Open a new tab to continue automation.");
        }
        return text(`Closed window ${index}. Now on window ${Math.min(index, lastWindowsList.length - 1)}`);
      }
    });
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("detect_captcha", "Check whether the current page shows a CAPTCHA and whether it is solved. If an UNSOLVED CAPTCHA is found, STOP automation and ask the user to solve it manually in the browser — this tool cannot solve CAPTCHAs.", {}, async () => {
  try {
    requirePage();
    const info = await detectCaptcha();
    if (info?.found) {
      const status = info.solved ? "SOLVED" : "UNSOLVED";
      const action = info.solved ? "CAPTCHA solved. You can continue." : "STOP AUTOMATION. Ask user to solve this CAPTCHA manually.";
      return text(`CAPTCHA DETECTED: ${info.type} [${status}]\n\n${action}`);
    }
    return text("No CAPTCHA detected");
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("wait_for_captcha", "Wait for the current page's CAPTCHA to be solved by the user. Event-driven via a MutationObserver inside the page (disconnects on solve), so it wastes almost no CPU while waiting. Use after detect_captcha finds an unsolved CAPTCHA — wait for the user to solve it, then continue automation.", {
  timeout: z.number().min(1).max(30).optional().default(30).describe("Max seconds to wait for the CAPTCHA to be solved (default 30, cap 30)"),
}, async ({ timeout }) => {
  try {
    const page = requirePage();
    const info = await detectCaptcha();
    if (!info?.found) return text("No CAPTCHA detected on this page");
    if (info.solved) return text(`CAPTCHA solved (${info.type}) in 0s`);
    const result = await waitForCaptchaSolved(timeout * 1000);
    if (result.solved) return text(`CAPTCHA solved (${info.type}) in ${result.seconds}s`);
    return text(`Timeout: CAPTCHA not solved within ${timeout}s`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("video_control", "Control playback on any HTML5 video player (YouTube, etc.). Actions: play, pause, toggle, mute, unmute, fullscreen, exit_fullscreen, seek (needs value in seconds), set_volume (needs value 0-1), get_info (returns duration, current time, paused, muted, volume).", {
  action: z.enum(["play", "pause", "toggle", "mute", "unmute", "fullscreen", "exit_fullscreen", "seek", "set_volume", "get_info"]).describe("Video action to perform"),
  value: z.number().optional().describe("For seek: seconds to seek to. For set_volume: volume level 0-1"),
}, async ({ action, value }) => {
  try {
    const page = requirePage();
    const js = (fn, arg) => page.evaluate(fn, arg);
    const hasVideo = await js(() => !!document.querySelector("video"));
    if (!hasVideo) return textErr("No video element found on this page");

    switch (action) {
      case "play": await js(() => { const v = document.querySelector("video"); if(v) v.play(); }); return text("Playing");
      case "pause": await js(() => { const v = document.querySelector("video"); if(v) v.pause(); }); return text("Paused");
      case "toggle": await js(() => { const v = document.querySelector("video"); if(v) v.paused ? v.play() : v.pause(); }); return text("Toggled");
      case "mute": await js(() => { const v = document.querySelector("video"); if(v) v.muted = true; }); return text("Muted");
      case "unmute": await js(() => { const v = document.querySelector("video"); if(v) v.muted = false; }); return text("Unmuted");
      case "fullscreen": await js(() => { const v = document.querySelector("video"); if(v && v.requestFullscreen) v.requestFullscreen(); else if(v && v.webkitRequestFullscreen) v.webkitRequestFullscreen(); }); return text("Fullscreen");
      case "exit_fullscreen": await js(() => { if(document.exitFullscreen) document.exitFullscreen(); else if(document.webkitExitFullscreen) document.webkitExitFullscreen(); }); return text("Exited fullscreen");
      case "seek":
        if (value === undefined) return textErr("Need value for seek (seconds)");
        await js((t) => { const v = document.querySelector("video"); if(v) v.currentTime = t; }, value);
        return text(`Seeked to ${value}s`);
      case "set_volume":
        if (value === undefined) return textErr("Need value for volume (0-1)");
        await js((vol) => { const v = document.querySelector("video"); if(v) v.volume = Math.max(0, Math.min(1, vol)); }, value);
        return text(`Volume set to ${value}`);
      case "get_info":
        return text(JSON.stringify(await js(() => { const v = document.querySelector("video"); return v ? { duration: v.duration, currentTime: v.currentTime, paused: v.paused, muted: v.muted, volume: v.volume } : null; })));
    }
  } catch (e) { return textErr(`Video control error: ${e.message}`); }
});

server.tool("search", "Search popular websites and social media platforms in the current tab and returns visible text of the results (truncated to 8000 chars). Engines: google, bing, duckduckgo, yahoo, brave, yandex, perplexity. Social: twitter, instagram (hashtag), facebook, linkedin, tiktok, reddit. Video: youtube. Dev: github, stackoverflow. Reference: wikipedia.", {
  platform: z.enum(["google", "bing", "duckduckgo", "yahoo", "brave", "yandex", "perplexity", "twitter", "instagram", "facebook", "linkedin", "tiktok", "reddit", "youtube", "github", "stackoverflow", "wikipedia"]).describe("Platform or search engine to search on"),
  query: z.string().describe("Search query — for instagram use a hashtag without the # symbol"),
}, async ({ platform, query }) => {
  try {
    const page = requirePage();
    const q = encodeURIComponent(query);
    const urls = {
      google:      `https://www.google.com/search?q=${q}`,
      bing:        `https://www.bing.com/search?q=${q}`,
      duckduckgo:  `https://duckduckgo.com/?q=${q}`,
      yahoo:       `https://search.yahoo.com/search?p=${q}`,
      brave:       `https://search.brave.com/search?q=${q}`,
      yandex:      `https://yandex.com/search/?text=${q}`,
      perplexity:  `https://www.perplexity.ai/search?q=${q}`,
      twitter:     `https://twitter.com/search?q=${q}&src=typed_query`,
      instagram:   `https://www.instagram.com/explore/tags/${encodeURIComponent(query.replace(/#/g, ""))}/`,
      facebook:    `https://www.facebook.com/search/top?q=${q}`,
      linkedin:    `https://www.linkedin.com/search/results/all/?keywords=${q}`,
      tiktok:      `https://www.tiktok.com/search?q=${q}`,
      reddit:      `https://www.reddit.com/search/?q=${q}`,
      youtube:     `https://www.youtube.com/results?search_query=${q}`,
      github:      `https://github.com/search?q=${q}&type=repositories`,
      stackoverflow: `https://stackoverflow.com/search?q=${q}`,
      wikipedia:   `https://en.wikipedia.org/w/index.php?search=${q}`,
    };
    assertSafeUrl(urls[platform]);
    await page.goto(safeNavigateUrl(urls[platform]), { waitUntil: "domcontentloaded", timeout: 30000 });
    const selectors = {
      google: '#search, #rso',
      bing: '#b_results',
      duckduckgo: '#links, #web_content',
      yahoo: '#web',
      brave: '#results',
      yandex: '#search-results',
      perplexity: '[data-testid="answer"]',
      tiktok: '[class*="DivItemContainer"], [class*="video-feed"]',
      youtube: 'ytd-video-renderer, ytd-channel-renderer',
      github: '#results, .results',
      stackoverflow: '#answers, .search-results',
    };
    try { await page.locator(selectors[platform] || '[role="main"], main, #results').first().waitFor({ timeout: 10000 }); } catch {}
    const region = selectors[platform] || '[role="main"], main, #results';
    let result = `Search results for "${query}" on ${platform}:\n\n${await page.evaluate(extractVisibleText, { region, limit: 8000, fallbackToBody: true })}`;
    const captchaResult = await autoWaitForCaptcha();
    if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
    return text(result);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("cookies", "Persist browser cookies for session reuse. save stores the current window's cookies under a named profile; load restores them (e.g. to keep login sessions alive between runs). Cookies are obfuscated at rest with a key derived from the local user + package name — not cryptographic protection. Stored under the cookies directory.", {
  action: z.enum(["save", "load"]).describe("save = store current cookies, load = restore saved cookies"),
  profile: z.string().describe("Profile name to save to or load from (alphanumeric, dots, dashes, underscores only)"),
}, async ({ action, profile }) => {
  try {
    const ctx = getContext();
    if (!ctx) return textErr("Not connected. Run connect_brave first.");
    if (action === "save") {
      const cookies = await ctx.cookies();
      saveCookiesFn(profile, cookies);
      return text(`Saved ${cookies.length} cookies for profile: ${sanitizeProfile(profile)}`);
    }
    const cookies = loadCookies(profile);
    if (!cookies) return text(`No saved cookies found for profile: ${sanitizeProfile(profile)}`);
    await ctx.addCookies(cookies);
    return text(`Loaded ${cookies.length} cookies for profile: ${sanitizeProfile(profile)}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("hover", "Move the mouse cursor over an element to reveal hover menus, tooltips, or submenus (e.g. dropdowns that only show on hover). Matches by CSS selector or visible text.", {
  selector: z.string().describe("CSS selector OR visible text to hover over when by_text=true"),
  by_text: z.boolean().optional().default(false).describe("True: match by visible text content instead of CSS selector"),
}, async ({ selector, by_text }) => {
  try {
    const page = requirePage();
    if (by_text) await page.getByText(selector).first().hover({ timeout: 5000 });
    else await page.locator(selector).first().hover({ timeout: 5000 });
    await page.waitForTimeout(500);
    return text(`Hovered: ${selector}`);
  } catch (e) { return textErr(`Error hovering: ${e.message}`); }
});

server.tool("pdf_export", "Save the current page as a PDF (A4, with margins and background colors) for archiving or sharing. Provide only a filename; the file is stored under the screenshots directory and the returned path tells you where.", {
  path: z.string().optional().describe("Output filename only, e.g. 'report.pdf' (omit for an auto-named file; .pdf is appended if missing)"),
}, async ({ path }) => {
  try {
    const page = requirePage();
    let savePath;
    if (path) {
      savePath = safePath(SCREENSHOTS_DIR, path.replace(/[^a-zA-Z0-9._-]/g, "_"));
      if (!savePath.endsWith(".pdf")) savePath += ".pdf";
    } else {
      savePath = join(SCREENSHOTS_DIR, `page-${Date.now()}.pdf`);
    }
    await page.pdf({ path: savePath, format: "A4", margin: { top: "20mm", right: "15mm", bottom: "20mm", left: "15mm" }, printBackground: true });
    return text(`PDF saved to: ${savePath}`);
  } catch (e) { return textErr(`Error exporting PDF: ${e.message}`); }
});


const STATIC_EXT_RE = /\.(css|js|png|jpe?g|gif|svg|woff2?|ico|map)(\?|#|$)/i;

server.tool("network_start", "Start capturing HTTP requests/responses on the current tab via CDP (Fetch + Network domains). Static resources skipped unless include_static=true. Auto-stops after max_time ms.", {
  max_time: z.number().min(1000).max(600000).optional().default(30000).describe("Auto-stop after this many ms (default 30000, max 600000)"),
  include_static: z.boolean().optional().default(false).describe("Also capture static resources (.css/.js/.png/.jpg/.gif/.svg/.woff/.woff2/.ico/.map)"),
}, async ({ max_time, include_static }) => {
  try {
    const page = requirePage();
    if (networkCapture.active) stopNetworkCapture();
    const session = await page.context().newCDPSession(page);
    networkCapture.active = true; networkCapture.requests = []; networkCapture.cdpSession = session;
    await session.send("Fetch.enable", { patterns: [{ requestStage: "Request" }] });
    await session.send("Network.enable");
    session.on("Fetch.requestPaused", async (event) => {
      const { requestId, request } = event;
      try {
        if (!include_static && STATIC_EXT_RE.test(request.url)) { await session.send("Fetch.continueRequest", { requestId }).catch(() => {}); return; }
        networkCapture.requests.push({ requestId, url: request.url, method: request.method, headers: request.headers || {}, postData: typeof request.postData === "string" ? request.postData : null, timestamp: Date.now() });
        await session.send("Fetch.continueRequest", { requestId }).catch(() => {});
      } catch {}
    });
    session.on("Network.responseReceived", (event) => {
      const req = networkCapture.requests.find((r) => r.requestId === event.requestId);
      if (req) { req.status = event.response.status; req.mimeType = event.response.mimeType; req.responseHeaders = event.response.headers || {}; req.timing = event.response.timing || null; }
    });
    session.on("Network.loadingFinished", async (event) => {
      const req = networkCapture.requests.find((r) => r.requestId === event.requestId);
      if (!req) return;
      try { const { body } = await session.send("Network.getResponseBody", { requestId: event.requestId }); req.bodyLength = body ? body.length : 0; req.bodyPreview = body ? String(body).slice(0, 500) : ""; } catch {}
    });
    networkCapture.timeout = setTimeout(() => { try { const n = stopNetworkCapture().length; log(`network_start: auto-stopped after ${max_time}ms (${n} requests)`); } catch {} }, max_time);
    return text(`Network capture started on ${page.url()} (auto-stop in ${max_time}ms). Use network_stop to collect.`);
  } catch (e) { return textErr(`Error starting capture: ${e.message}`); }
});

server.tool("network_stop", "Stop active network capture and return all captured requests as JSON with summary.", {}, async () => {
  try {
    const requests = stopNetworkCapture();
    const sb = {}; for (const r of requests) { const k = r.status != null ? String(r.status) : "pending"; sb[k] = (sb[k] || 0) + 1; }
    return text(JSON.stringify({ total: requests.length, statusBreakdown: sb, requests }, null, 2));
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("network_list", "Peek at captured requests without stopping. Returns count and last 20 (url, method, status).", {}, async () => {
  try {
    requirePage();
    const last = networkCapture.requests.slice(-20).map((r) => ({ url: r.url, method: r.method, status: r.status ?? null }));
    return text(JSON.stringify({ active: networkCapture.active, count: networkCapture.requests.length, last20: last }, null, 2));
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("network_request", "Send a custom HTTP request through the browser (like fetch) and return full response: status, headers, body (truncated to 50000). Cookies/session apply.", {
  url: z.string().describe("Full URL (http/https)"),
  method: z.string().optional().default("GET").describe("HTTP method"),
  headers: z.record(z.string()).optional().describe("Request headers object"),
  body: z.string().optional().describe("Request body string"),
}, async ({ url, method, headers, body }) => {
  try {
    assertSafeUrl(url); const safeUrl = safeNavigateUrl(url); const page = requirePage();
    const result = await page.evaluate(async ({ url, method, headers, body }) => {
      try {
        const res = await fetch(url, { method, headers: headers || undefined, body: body ?? undefined, credentials: "include" });
        let t = ""; try { t = await res.text(); } catch {}
        return { ok: true, status: res.status, statusText: res.statusText, headers: Object.fromEntries(res.headers.entries()), body: t };
      } catch (e) { return { ok: false, error: e?.message || String(e) }; }
    }, { url: safeUrl, method, headers: headers || null, body: body ?? null });
    if (!result.ok) return textErr(`Fetch failed: ${result.error}`);
    result.body = String(result.body || "").slice(0, 50000);
    return text(JSON.stringify(result, null, 2));
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

const F2_INTERACTIVE_ROLES = new Set(["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "option", "tab", "slider", "switch", "searchbox", "spinbutton", "menuitemcheckbox", "menuitemradio", "treeitem"]);
const F2_NOISE_ROLES = new Set(["inlinetextbox", "linebreak"]);
const F2_STATE_KEYS = ["disabled", "focused", "expanded", "selected", "checked", "pressed", "required", "invalid", "readonly", "modal", "level"];
function f2AxValue(v) { if (v == null) return undefined; return Object.prototype.hasOwnProperty.call(v, "value") ? v.value : v; }
async function f2BuildSelectors(cdp, backendIds) {
  const out = new Map(); if (!backendIds.size) return out;
  let root; try { ({ root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true })); } catch { return out; }
  const byNodeId = new Map(); const byBackend = new Map();
  (function visit(n) { byNodeId.set(n.nodeId, n); if (n.backendNodeId != null && !byBackend.has(n.backendNodeId)) byBackend.set(n.backendNodeId, n); for (const c of [...(n.children || []), ...(n.shadowRoots || []), ...(n.templateContents || []), ...(n.contentDocument ? [n.contentDocument] : []), ...(n.pseudoElements || [])]) visit(c); })(root);
  const esc = (s) => String(s).replace(/([^a-zA-Z0-9_\u00A0-\uFFFF-])/g, "\\$1");
  const pathFor = (startId) => { const parts = []; let n = byNodeId.get(startId); let hops = 0; while (n && n.nodeType === 1 && parts.length < 5 && hops++ < 64) { let s = String(n.nodeName || "").toLowerCase(); if (!s || s.startsWith("#")) break; const attrs = n.attributes || []; let idVal = null; for (let i = 0; i < attrs.length; i += 2) if (attrs[i] === "id") idVal = attrs[i + 1]; if (idVal) { parts.unshift(`#${esc(idVal)}`); break; } const parent = n.parentId != null ? byNodeId.get(n.parentId) : null; if (parent) { const sameTag = (parent.children || []).filter((c) => c.nodeType === 1 && c.nodeName === n.nodeName); if (sameTag.length > 1) s += `:nth-of-type(${sameTag.indexOf(n) + 1})`; } parts.unshift(s); n = parent; } return parts.join(" > "); };
  for (const bid of backendIds) { const dn = byBackend.get(bid); if (!dn) continue; const sel = pathFor(dn.nodeId); if (sel) out.set(bid, sel); }
  return out;
}
server.tool("read_page", "Build an accessibility tree of the current page with stable ref IDs (ref_1, ref_2, ...). Returns indented text tree + refs array with role, name, CSS selector. Use filter='interactive' for only clickable/typeable elements. Use refs with click tool's ref param.", {
  filter: z.enum(["all", "interactive"]).optional().default("all").describe("'all' = all labeled nodes; 'interactive' = only buttons, links, fields, menus, tabs"),
  tab_id: z.string().optional().describe("Target tab whose URL contains this substring"),
}, async ({ filter, tab_id }) => {
  let session = null;
  try {
    syncContexts(); let page;
    if (tab_id) { const pages = contexts.flatMap((c) => c.pages()); page = pages.find((p) => p.url().includes(tab_id)); if (!page) return textErr(`No tab with URL containing "${tab_id}".`); }
    else { page = requirePage(); }
    session = await page.context().newCDPSession(page);
    const { nodes } = await session.send("Accessibility.getFullAXTree");
    const axById = new Map(nodes.map((n) => [n.nodeId, n])); const childrenOf = new Map(); const roots = [];
    for (const n of nodes) { if (n.parentId && axById.has(n.parentId)) { if (!childrenOf.has(n.parentId)) childrenOf.set(n.parentId, []); childrenOf.get(n.parentId).push(n); } else roots.push(n); }
    refMap.clear(); refCounter = 0;
    const lines = []; const included = []; const byBackend = new Map(); const MAX_NODES = 3000;
    const walk = (node, depth) => {
      if (lines.length >= MAX_NODES) return;
      const role = String(f2AxValue(node.role) || "").toLowerCase(); const name = String(f2AxValue(node.name) ?? "").trim(); const desc = String(f2AxValue(node.description) ?? "").trim();
      const kids = childrenOf.get(node.nodeId) || [];
      if (!role || node.ignored || F2_NOISE_ROLES.has(role)) { for (const k of kids) walk(k, depth); return; }
      const states = {}; for (const p of node.properties || []) { const pn = String(p.name); if (F2_STATE_KEYS.includes(pn)) states[pn] = f2AxValue(p.value); }
      const unlabeledGeneric = (role === "generic" || role === "none" || role === "presentation") && !name && !desc;
      const doInclude = filter === "interactive" ? F2_INTERACTIVE_ROLES.has(role) : !unlabeledGeneric;
      if (doInclude) {
        refCounter += 1; const ref = `ref_${refCounter}`;
        const entry = { ref, role, name, description: desc || undefined, states, backendDOMNodeId: node.backendDOMNodeId, selector: undefined };
        refMap.set(ref, entry); included.push(entry);
        if (typeof entry.backendDOMNodeId === "number") { if (!byBackend.has(entry.backendDOMNodeId)) byBackend.set(entry.backendDOMNodeId, []); byBackend.get(entry.backendDOMNodeId).push(entry); }
        const flags = []; if (states.disabled === true) flags.push("disabled"); if (states.focused === true) flags.push("focused"); if (states.checked === true || states.checked === "mixed") flags.push(`checked=${states.checked === true ? "true" : "mixed"}`); if (states.selected === true) flags.push("selected"); if (typeof states.expanded === "boolean") flags.push(`expanded=${states.expanded}`); if (states.required === true) flags.push("required"); if (states.invalid === true) flags.push("invalid");
        lines.push(`${"  ".repeat(Math.min(depth, 24))}[${ref}] ${role}${name ? ` "${name.slice(0, 120)}"` : ""}${flags.length ? ` [${flags.join(", ")}]` : ""}${desc ? ` — ${desc.slice(0, 100)}` : ""}`);
      }
      for (const k of kids) walk(k, depth + 1);
    };
    for (const r of roots) walk(r, 0);
    const selectors = await f2BuildSelectors(session, new Set(byBackend.keys()));
    for (const [bid, sel] of selectors) for (const entry of byBackend.get(bid)) entry.selector = sel;
    const refs = included.map(({ ref, role, name, selector }) => selector ? { ref, role, name, selector } : { ref, role, name });
    return text(JSON.stringify({ url: page.url(), title: await page.title().catch(() => ""), pageContent: lines.join("\n").slice(0, 60000), refMapCount: refMap.size, refs }, null, 2));
  } catch (e) { return textErr(`Error reading page: ${e.message}`); }
  finally { if (session) await session.detach().catch(() => {}); }
});

const F3_STOPWORDS = new Set(["the", "a", "an", "is", "are", "was", "were", "to", "of", "in", "for", "on", "at", "by", "with", "from", "this", "that", "it", "as", "or", "and", "not"]);
function f3Tokenize(text) { return String(text || "").toLowerCase().split(/[^a-z]+/).filter(w => w && !F3_STOPWORDS.has(w)); }
function f3ExtractSnippets(text, terms, maxSnippets = 3, snippetLen = 200) {
  const sentences = String(text || "").split(/(?<=[.!?])\s+|\n+/).map(s => s.trim()).filter(Boolean);
  const snippets = []; for (const s of sentences) { const lower = s.toLowerCase(); if (!terms.some(t => lower.includes(t))) continue; snippets.push(s.length > snippetLen ? s.slice(0, snippetLen) + "…" : s); if (snippets.length >= maxSnippets) break; } return snippets;
}
function simpleTfIdf(query, docs) {
  const qTerms = f3Tokenize(query); if (!qTerms.length || !docs.length) return [];
  const N = docs.length; const docTerms = docs.map(d => f3Tokenize(d.text));
  const df = new Map(); for (const terms of docTerms) for (const t of new Set(terms)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log((1 + N) / (1 + (df.get(t) || 0))) + 1;
  const vectorize = (tokens) => { const tf = new Map(); for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1); const v = new Map(); let norm = 0; for (const [t, c] of tf) { const w = c * idf(t); v.set(t, w); norm += w * w; } return { v, norm: Math.sqrt(norm) }; };
  const q = vectorize(qTerms); if (!q.norm) return [];
  return docs.map((d, i) => { const { v, norm } = vectorize(docTerms[i]); let dot = 0; for (const [t, w] of q.v) { const dv = v.get(t); if (dv) dot += w * dv; } return { score: Math.max(0, Math.min(1, dot / (q.norm * norm))), meta: d.meta, snippets: f3ExtractSnippets(d.text, qTerms) }; }).filter(r => r.score > 0).sort((a, b) => b.score - a.score);
}
server.tool("search_tabs", "Search across ALL open tabs using TF-IDF cosine similarity. Extracts visible text, ranks tabs, returns top matches with URL, title, score (0-1), and matching sentence snippets.", {
  query: z.string().describe("Search query"),
  max_results: z.number().int().min(1).max(20).optional().default(5).describe("Max tabs to return (default 5)"),
}, async ({ query, max_results }) => {
  try {
    syncContexts(); const pages = contexts.flatMap(c => { try { return c.pages(); } catch { return []; } });
    if (!pages.length) return textErr("No open tabs. Run connect_brave first.");
    const docs = [];
    await Promise.all(pages.map(async (page, tabIndex) => { try { const content = await page.evaluate(extractVisibleText, { limit: 3000 }); if (content?.trim()) { const title = await page.title().catch(() => ""); docs.push({ text: content, meta: { tab_index: tabIndex, url: page.url(), title } }); } } catch {} }));
    if (!docs.length) return textErr("Could not extract content from any tab.");
    const ranked = simpleTfIdf(query, docs).slice(0, max_results);
    if (!ranked.length) return text(`No tabs match "${query}".`);
    const lines = ranked.map(r => [`Tab ${r.meta.tab_index}: ${r.meta.url}${r.meta.title ? ` - ${r.meta.title}` : ""}`, `Score: ${r.score.toFixed(3)}`, ...(r.snippets.length ? r.snippets.map(s => `> ${s}`) : ["(no snippets)"])].join("\n"));
    return text(`Indexed ${docs.length} tab(s); top ${ranked.length} for "${query}":\n\n${lines.join("\n\n")}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("computer", "Unified interaction: left/right/double/triple click, drag, scroll, type, key combos, fill, hover, wait, screenshot. Targets by CSS selector, viewport coordinates ({x,y}), or ref (ref_N) from read_page.", {
  action: z.enum(["left_click", "right_click", "double_click", "triple_click", "left_click_drag", "scroll", "type", "key", "fill", "hover", "wait", "screenshot"]).describe("Interaction to perform"),
  selector: z.string().optional().describe("CSS selector"),
  text: z.string().optional().describe("Text for type/fill/key"),
  value: z.string().optional().describe("Value for fill"),
  coordinates: z.object({ x: z.number(), y: z.number() }).optional().describe("Target {x,y}"),
  start_coordinates: z.object({ x: z.number(), y: z.number() }).optional().describe("Start {x,y} for drag"),
  ref: z.string().optional().describe("ref_N from read_page"),
  scroll_direction: z.enum(["up", "down", "left", "right"]).optional().default("down"),
  scroll_amount: z.number().int().min(1).max(30).optional().default(3),
  delay: z.number().min(0).max(1000).optional().default(0),
  duration: z.number().min(0).max(30).optional().default(1),
  key: z.string().optional().describe("Key combo, e.g. 'Control+a'"),
}, async ({ action, selector, text: t, value, coordinates, start_coordinates, ref, scroll_direction, scroll_amount, delay, duration, key }) => {
  try {
    const page = requirePage();
    const resolveLocator = () => {
      if (ref) { const entry = refMap.get(ref); if (!entry) throw new Error(`Unknown ref '${ref}'. Call read_page first.`); return page.locator(entry.selector || entry.role).first(); }
      if (selector) return page.locator(selector).first(); return null;
    };
    let out;
    switch (action) {
      case "left_click": case "right_click": case "double_click": case "triple_click": {
        const btn = action === "right_click" ? "right" : "left"; const cc = action === "double_click" ? 2 : action === "triple_click" ? 3 : 1;
        if (coordinates) { await page.mouse.move(coordinates.x, coordinates.y); await page.mouse.click(coordinates.x, coordinates.y, { button: btn, clickCount: cc }); out = `${action}: (${coordinates.x}, ${coordinates.y})`; }
        else { const loc = resolveLocator(); if (!loc) return textErr(`${action} requires selector, ref, or coordinates`); await loc.click({ button: btn, clickCount: cc, timeout: 5000 }); out = `${action}: ${ref || selector}`; } break;
      }
      case "left_click_drag": {
        if (!start_coordinates || !coordinates) return textErr("Requires start_coordinates and coordinates");
        await page.mouse.move(start_coordinates.x, start_coordinates.y); await page.mouse.down();
        await page.mouse.move(coordinates.x, coordinates.y, { steps: Math.max(5, Math.round((duration ?? 1) * 10)) }); await page.mouse.up();
        out = `Dragged (${start_coordinates.x},${start_coordinates.y}) -> (${coordinates.x},${coordinates.y})`; break;
      }
      case "scroll": {
        const px = 400; const dx = scroll_direction === "left" ? -px * scroll_amount : scroll_direction === "right" ? px * scroll_amount : 0; const dy = scroll_direction === "up" ? -px * scroll_amount : px * scroll_amount;
        if (coordinates) await page.mouse.move(coordinates.x, coordinates.y); else { const loc = resolveLocator(); if (loc) await loc.hover({ timeout: 3000 }).catch(() => {}); }
        await page.mouse.wheel(dx, dy); out = `Scrolled ${scroll_direction} ${scroll_amount} ticks`; break;
      }
      case "type": { if (!t) return textErr("type requires text"); const loc = resolveLocator(); if (loc) await loc.pressSequentially(t, { delay }); else await page.keyboard.type(t, { delay }); out = `Typed: ${t}`; break; }
      case "key": { const combo = key || t; if (!combo) return textErr("key requires key"); await page.keyboard.press(combo); out = `Pressed: ${combo}`; break; }
      case "fill": { const v = value ?? t; if (v == null) return textErr("fill requires value"); const loc = resolveLocator(); if (!loc) return textErr("fill requires selector or ref"); await loc.fill(v); out = `Filled: ${v}`; break; }
      case "hover": { if (coordinates) { await page.mouse.move(coordinates.x, coordinates.y); out = `Hovered: (${coordinates.x},${coordinates.y})`; } else { const loc = resolveLocator(); if (!loc) return textErr("hover requires selector, ref, or coordinates"); await loc.hover({ timeout: 5000 }); out = `Hovered: ${ref || selector}`; } break; }
      case "wait": { const secs = Math.min(Math.max(duration ?? 1, 0), 30); await page.waitForTimeout(secs * 1000); out = `Waited ${secs}s`; break; }
      case "screenshot": { const b64 = String(await page.screenshot({ encoding: "base64" })); out = `Screenshot (${b64.length} chars):\n${b64.slice(0, 3000)}${b64.length > 3000 ? "\n...[truncated]" : ""}`; break; }
    }
    const cr = await autoWaitForCaptcha(); if (cr) out += `\nCAPTCHA: ${cr}`;
    return text(out);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("inject_script", "Inject a persistent content script into the current tab that re-runs on every navigation. Scripts run in isolated world 'mcp_injected'. Use send_to_injected to communicate.", {
  script: z.string().describe("JavaScript code to inject"),
  name: z.string().describe("Unique identifier for this script"),
}, async ({ script, name }) => {
  try {
    const page = requirePage(); const session = await page.context().newCDPSession(page);
    try {
      await session.send("Page.enable"); const prev = injectedScripts.get(name);
      if (prev?.scriptId) await session.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: prev.scriptId }).catch(() => {});
      const { identifier } = await session.send("Page.addScriptToEvaluateOnNewDocument", { source: script, worldName: "mcp_injected", runImmediately: false });
      const imm = await session.send("Runtime.evaluate", { expression: script, worldName: "mcp_injected", returnByValue: true }).catch(() => null);
      if (imm?.exceptionDetails) log(`inject_script "${name}" immediate failed: ${imm.exceptionDetails.exception?.description || imm.exceptionDetails.text}`);
      injectedScripts.set(name, { scriptId: identifier, worldName: "mcp_injected" });
      return text(`Injected "${name}" (scriptId: ${identifier}). Persists across navigations.${imm?.exceptionDetails ? " Note: immediate eval threw (see log)." : ""}`);
    } finally { await session.detach().catch(() => {}); }
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("send_to_injected", "Send a message to an injected script and await reply. Script should dispatch CustomEvent 'mcp-response-<name>' with detail=response. Waits 5000ms.", {
  name: z.string().describe("Script name from inject_script"),
  data: z.string().optional().describe("Data as event.detail"),
}, async ({ name, data }) => {
  try {
    const entry = injectedScripts.get(name); if (!entry) return textErr(`No script "${name}". Run inject_script first.`);
    const page = requirePage();
    const expr = `(async () => new Promise((resolve) => { const R=${JSON.stringify(`mcp-response-${name}`)}; function fin(v){clearTimeout(t);window.removeEventListener(R,h);resolve(v)} function h(e){fin(e.detail===undefined?null:e.detail)} const t=setTimeout(()=>fin({__timeout:true}),5000); window.addEventListener(R,h); window.dispatchEvent(new CustomEvent(${JSON.stringify(`mcp-message-${name}`)},{detail:${JSON.stringify(data ?? null)}})); }))().catch(e=>({__error:String(e&&e.message||e)}))`;
    const session = await page.context().newCDPSession(page);
    try {
      const res = await session.send("Runtime.evaluate", { expression: expr, worldName: entry.worldName || "mcp_injected", awaitPromise: true, returnByValue: true });
      if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || "eval failed");
      const v = res.result?.value;
      if (v?.__timeout) return textErr(`Timeout: "${name}" did not respond in 5000ms`);
      if (v?.__error) return textErr(`"${name}" error: ${v.__error}`);
      if (v == null) return text(`(no response from "${name}")`);
      return text(typeof v === "string" ? v : JSON.stringify(v, null, 2));
    } finally { await session.detach().catch(() => {}); }
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("bookmark_add", "Add a bookmark to the local store (persisted to bookmarks.json). Updates if same URL exists.", {
  url: z.string().describe("URL to bookmark"),
  title: z.string().describe("Display title"),
  folder: z.string().optional().default("").describe("Optional folder name"),
}, async ({ url, title, folder }) => {
  try {
    const existing = bookmarks.find((b) => b.url === url);
    if (existing) { existing.title = title; existing.folder = folder || existing.folder || ""; saveBookmarksFile(); return text(`Updated: ${title} (${url})`); }
    bookmarks.push({ url, title, folder: folder || "", added_at: new Date().toISOString() }); saveBookmarksFile();
    return text(`Added: ${title} (${url})${folder ? ` in "${folder}"` : ""}\nTotal: ${bookmarks.length}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("bookmark_delete", "Delete bookmark(s) by exact URL or title match (case-insensitive).", {
  url: z.string().optional().describe("Exact URL to delete"),
  title: z.string().optional().describe("Exact title to delete"),
}, async ({ url, title }) => {
  try {
    if (!url && !title) return textErr("Provide url or title");
    const n = (s) => String(s || "").toLowerCase(); const before = bookmarks.length;
    bookmarks = bookmarks.filter((b) => !(url && n(b.url) === n(url)) && !(title && n(b.title) === n(title)));
    const removed = before - bookmarks.length;
    if (!removed) return textErr(`No match. Use bookmark_search first.`);
    saveBookmarksFile(); return text(`Deleted ${removed}. Remaining: ${bookmarks.length}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("bookmark_search", "Search bookmarks by keyword (case-insensitive title/URL match). Omit query to list all.", {
  query: z.string().optional().default("").describe("Search keyword"),
  max_results: z.number().int().min(1).max(500).optional().default(50),
}, async ({ query, max_results }) => {
  try {
    const q = query.trim().toLowerCase();
    const matches = bookmarks.filter((b) => !q || String(b.title || "").toLowerCase().includes(q) || String(b.url || "").toLowerCase().includes(q));
    if (!matches.length) return text(q ? `No matches for "${query}"` : "No bookmarks saved.");
    const shown = matches.slice(0, max_results);
    return text(`Matches (${shown.length}${matches.length > shown.length ? ` of ${matches.length}` : ""}):\n${shown.map((b, i) => `${i}: [${b.folder || "-"}] ${b.title} -> ${b.url}`).join("\n")}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("bookmark_list", "List all bookmarks. Set import_chrome=true to merge from Chrome/Brave profile first.", {
  folder: z.string().optional().describe("Filter by folder"),
  import_chrome: z.boolean().optional().default(false).describe("Import from Chrome/Brave Bookmarks file first"),
}, async ({ folder, import_chrome }) => {
  try {
    let imported = 0;
    if (import_chrome) {
      const candidates = [join(os.homedir(), ".config", "BraveSoftware", "Brave-Browser", "Default", "Bookmarks"), join(os.homedir(), ".config", "google-chrome", "Default", "Bookmarks")];
      const file = candidates.find((c) => existsSync(c));
      if (!file) return textErr("No Chrome/Brave Bookmarks file found");
      const parsed = JSON.parse(readFileSync(file, "utf-8")); const found = [];
      for (const root of Object.values(parsed.roots || {})) walkChromeBookmarkFolder(root, "", found);
      const known = new Set(bookmarks.map((b) => b.url));
      for (const b of found) { if (known.has(b.url)) continue; bookmarks.push({ url: b.url, title: b.title, folder: b.folder, added_at: new Date().toISOString() }); known.add(b.url); imported++; }
      if (imported) saveBookmarksFile();
    }
    const f = folder ? String(folder).toLowerCase() : null;
    const matches = bookmarks.filter((b) => !f || String(b.folder || "").toLowerCase() === f);
    if (!matches.length) return text(`${imported ? `Imported ${imported}. ` : ""}No bookmarks${f ? ` in "${folder}"` : ""}.`);
    return text(`${imported ? `Imported ${imported}. ` : ""}All (${matches.length}):\n${matches.map((b, i) => `${i}: [${b.folder || "-"}] ${b.title} -> ${b.url}`).join("\n")}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("history_search", "Search browsing history recorded by navigate calls (persisted in history.json). Matches URL/title case-insensitively. Most recent first.", {
  query: z.string().optional().default("").describe("Keyword to match"),
  start_time: z.string().optional().describe("ISO timestamp; only after this"),
  end_time: z.string().optional().describe("ISO timestamp; only before this"),
  max_results: z.number().int().min(1).max(1000).optional().default(100),
}, async ({ query, start_time, end_time, max_results }) => {
  try {
    let startMs = null, endMs = null;
    if (start_time) { const t = Date.parse(start_time); if (Number.isNaN(t)) return textErr(`Invalid start_time`); startMs = t; }
    if (end_time) { const t = Date.parse(end_time); if (Number.isNaN(t)) return textErr(`Invalid end_time`); endMs = t; }
    const q = query.trim().toLowerCase();
    const matches = browsingHistory.filter((h) => {
      if (q && !String(h.url || "").toLowerCase().includes(q) && !String(h.title || "").toLowerCase().includes(q)) return false;
      const ts = Date.parse(h.timestamp); if (startMs !== null && !(Number.isNaN(ts) ? false : ts >= startMs)) return false;
      if (endMs !== null && !(Number.isNaN(ts) ? false : ts <= endMs)) return false; return true;
    }).reverse();
    if (!matches.length) return text(q || start_time || end_time ? `No history matching "${query}"` : "History empty. Navigate somewhere first.");
    const shown = matches.slice(0, max_results);
    return text(`History (${shown.length}${matches.length > shown.length ? ` of ${matches.length}` : ""}):\n${shown.map((h, i) => `${i}: [${h.timestamp}] ${h.title || "(no title)"} -> ${h.url}`).join("\n")}`);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("health", "Check that the server is running and whether the browser is connected. Returns server version, connection state, open window/tab counts, and the active tab's URL and title.", {}, async () => {
  try {
    syncContexts();
    const connected = !!browser?.isConnected();
    let activeTab = null;
    if (currentPage) {
      try { activeTab = { url: currentPage.url(), title: await currentPage.title().catch(() => "unknown") }; }
      catch { activeTab = null; }
    }
    const status = {
      server: "running",
      version: pkg.version,
      connected,
      windows: contexts.length,
      tabs: contexts.reduce((n, c) => { try { return n + c.pages().length; } catch { return n; } }, 0),
      activeTab,
    };
    return text(JSON.stringify(status, null, 2));
  } catch (e) { return text(JSON.stringify({ server: "running", version: pkg.version, connected: false, error: e.message }, null, 2)); }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`server running (v${pkg.version})`);
}

main().catch(console.error);
