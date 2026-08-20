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
import WebSocket from "ws";
import { readFileSync as readPkg } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const COOKIES_DIR = join(__dirname, "../../cookies");
const SCREENSHOTS_DIR = join(__dirname, "../../screenshots");

for (const dir of [COOKIES_DIR, SCREENSHOTS_DIR]) {
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

async function pageWindowInfo(page) {
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
    if (waitUntil !== "load" && waitUntil !== "networkidle") {
      await page.waitForFunction(() => document.readyState === "complete", { timeout: Math.min(3000, timeout) }).catch(() => {});
    } else {
      await page.waitForFunction(() => document.readyState === "complete", { timeout });
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
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch (e) { log(`loadCookies parse error: ${e.message}`); }
  }
  return null;
}

function saveCookiesFn(profileName, cookies) {
  const safe = sanitizeProfile(profileName);
  const p = safePath(COOKIES_DIR, `${safe}.json`);
  writeFileSync(p, JSON.stringify(cookies, null, 2), { mode: 0o600 });
}

function findContextById(ctxId) {
  return contexts.find((c) => getCtxId(c) === ctxId) || null;
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

async function waitForCaptchaSolved(timeoutMs = 120000) {
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
  const result = await waitForCaptchaSolved(120000);
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
  const child = spawn(bravePath, [`--remote-debugging-port=${BROWSER_PORT}`, "--force-dark-mode"], { detached: true, stdio: "ignore" });
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
        const { targetInfos } = await cdpSession.send("Target.getTargets");
        const winIds = new Set();
        for (const t of targetInfos.filter(x => x.type === "page")) {
          try { const { windowId } = await cdpSession.send("Browser.getWindowForTarget", { targetId: t.targetId }); winIds.add(windowId); } catch {}
        }
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

server.tool("navigate", "Navigate the current tab to a URL. Waits for the page to load, then automatically detects CAPTCHAs and waits up to 120s for the user to solve them. Use wait_until='networkidle' for pages with heavy JS, 'load' for full resources, or 'domcontentloaded' (default) for speed.", {
  url: z.string().describe("Full URL to navigate to (e.g. https://example.com)"),
  wait_until: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional().default("domcontentloaded").describe("When to consider navigation complete: load=all resources, domcontentloaded=HTML parsed (default), networkidle=no network for 500ms, commit=initial response"),
  timeout: z.number().min(1000).max(120000).optional().default(30000).describe("Max time in ms before navigation is abandoned (default 30000)"),
}, async ({ url, wait_until, timeout }) => {
  try {
    const page = requirePage();
    await page.goto(url, { waitUntil: wait_until, timeout });
    await waitForPageReady(page, timeout, wait_until);
    let result = `Navigated to: ${url}\nTitle: ${await page.title()}`;
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
    }
    await waitForPageReady(page, 5000, "domcontentloaded");
    let result = `${target} to: ${page.url()}`;
    const captchaResult = await autoWaitForCaptcha();
    if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
    return text(result);
  } catch (e) { return textErr(`Error navigating: ${e.message}`); }
});

server.tool("click", "Click an element on the current page. By default uses a CSS selector; set by_text=true to match by visible text OR aria-label instead. Supports double-click and left/right/middle mouse buttons. If a real mouse click is blocked (e.g. by a dialog backdrop or overlay), it retries with a JavaScript click, and the error message hints at what element is intercepting the click. Use scope to click inside an open dialog or container.", {
  selector: z.string().describe("CSS selector (e.g. '#submit', '.btn', 'a[href*=\"/login\"]') OR visible text / aria-label when by_text=true"),
  by_text: z.boolean().optional().default(false).describe("True: match by visible text content or aria-label instead of CSS selector"),
  scope: z.string().optional().describe("CSS selector of a container to search within (e.g. '[role=dialog]' for the currently open dialog)"),
  double_click: z.boolean().optional().default(false).describe("Perform a double-click instead of a single click"),
  button: z.enum(["left", "right", "middle"]).optional().default("left").describe("Mouse button to use (left by default)"),
}, async ({ selector, by_text, scope, double_click, button }) => {
  const page = requirePage();
  const scoped = scope ? page.locator(scope).first() : null;
  try {
    await waitForPageReady(page);
    let clicked = false;
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
          if (ok) clicked = true;
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
          if (ok) clicked = true;
        }
      }
      if (!clicked) {
        const didJs = await page.evaluate(([sel, scp]) => {
          const root = scp ? document.querySelector(scp) : document;
          if (!root) return false;
          const el = root.querySelector(sel);
          if (el) { el.click(); return true; }
          return false;
        }, [selector, scope || null]);
        if (didJs) clicked = true;
      }
    }
    if (!found && !clicked) {
      return textErr(`Element not found: ${selector}${scope ? ` inside "${scope}"` : ""}. Use list_elements to see what's on the page, or inspect_dom to explore the structure.`);
    }
    await waitForPageReady(page);
    let result = `Clicked: ${selector}`;
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
    return text(await el.evaluate((n) => (n?.innerText || "").slice(0, 10000)));
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
          return t === target || t.startsWith(target + "\n") || t.startsWith(target + " (") || t.startsWith(target + " (") || t.startsWith(target + " (");
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

server.tool("execute_js", "Run arbitrary JavaScript in the current page and return the last expression's value. DANGER: can read cookies, localStorage, and make network requests — set confirm=true to acknowledge. Output is truncated at 50000 chars. Prefer other tools (get_page_content, screenshot) when they suffice.", {
  code: z.string().max(5000).describe("JavaScript to run in the page context. Return a value to have it echoed back. Max 5000 chars"),
  confirm: z.boolean().describe("Must be true. Acknowledges that this executes arbitrary code with access to the page's cookies and data"),
}, async ({ code, confirm }) => {
  if (!confirm) return textErr("execute_js requires confirm=true. This runs arbitrary JavaScript in the browser context.");
  try {
    const result = await requirePage().evaluate(code);
    const output = JSON.stringify(result, null, 2);
    if (output.length > 50000) return text(`Result (truncated): ${output.substring(0, 50000)}...`);
    return text(`Result: ${output}`);
  } catch (e) { return textErr(`JS error: ${e.message}`); }
});

server.tool("wait_for", "Wait until an element matching a CSS selector appears in the DOM. Useful after clicking or navigating when content loads dynamically. Returns whether the element was found or the wait timed out.", {
  selector: z.string().describe("CSS selector to wait for"),
  timeout: z.number().optional().default(10000).describe("Max wait time in ms (default 10000)"),
}, async ({ selector, timeout }) => {
  try { await requirePage().locator(selector).first().waitFor({ timeout }); return text(`Element found: ${selector}`); }
  catch { return textErr(`Timeout waiting for: ${selector}`); }
});

server.tool("wait_for_load", "Wait for the current page to reach the 'load' state (all resources loaded). Use before extracting content from heavy or slow-loading pages.", {
  timeout: z.number().optional().default(30000).describe("Max wait time in ms (default 30000)"),
}, async ({ timeout }) => {
  try { await requirePage().waitForLoadState("load", { timeout }); return text("Page fully loaded"); }
  catch (e) { return textErr(`Timeout: ${e.message}`); }
});

server.tool("tabs", "Manage tabs in the current window. Actions: list (see all tabs with indexes), open (new tab, optionally with a URL), switch (make a tab active), close (close a tab; the last tab cannot be closed).", {
  action: z.enum(["list", "open", "switch", "close"]).describe("What to do: list tabs, open a new one, switch to an existing one, or close one"),
  url: z.string().optional().describe("URL to load in the new tab (only for action='open')"),
  index: z.number().optional().describe("Tab index as shown by 'list' (required for switch/close)"),
}, async ({ action, url, index }) => {
  try {
    return await withLock(async () => {
      syncContexts();
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
        const tabs = pages.map((p, i) => {
          const title = (() => { try { return p.title(); } catch { return Promise.resolve(""); } })();
          return title.then(t => `${i}: ${p.url()}${t ? ` - ${t}` : ""}${p === currentPage ? " <- active" : ""}`);
        });
        const lines = await Promise.all(tabs);
        let out = `Open tabs in current window (${pages.length}):\n${lines.join("\n")}`;
        const allPages = ctx.pages();
        const otherWindows = allPages.length - pages.length;
        if (otherWindows > 0) out += `\n\nOther windows contain ${otherWindows} more tab${otherWindows !== 1 ? "s" : ""}. Use 'windows list' to see all windows and 'windows switch' to change windows.`;
        return text(out);
      }
      if (action === "open") {
        const page = await ctx.newPage();
        try {
          if (url) { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); await waitForPageReady(page); }
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

      const allWindows = [];

      async function targetIdOfPage(page) {
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
        for (const ctx of contexts) {
          for (const p of ctx.pages()) {
            const id = await targetIdOfPage(p);
            if (id === targetId) return { page: p, ctx, ctxIndex: contexts.indexOf(ctx) };
          }
        }
        return null;
      }

      async function getWindowsFromPort(port) {
          try {
            let windowMap = new Map();
            if (cdpSession) {
              const { targetInfos } = await cdpSession.send("Target.getTargets");
              const tabs = targetInfos.filter(t => t.type === "page");
              const results = await Promise.allSettled(tabs.map(t =>
                cdpSession.send("Browser.getWindowForTarget", { targetId: t.targetId })
                  .then(({ windowId }) => ({ t, windowId }))
                  .catch(() => ({ t, windowId: null }))
              ));
              for (const r of results) {
                const { t, windowId } = r.status === "fulfilled" ? r.value : { t: null, windowId: null };
                if (!t) continue;
                if (windowId) {
                  if (!windowMap.has(windowId)) windowMap.set(windowId, { tabs: [], windowId });
                  windowMap.get(windowId).tabs.push({ url: t.url, title: t.title, id: t.targetId });
                } else {
                  const unknownId = "unknown";
                  if (!windowMap.has(unknownId)) windowMap.set(unknownId, { tabs: [], windowId: unknownId });
                  windowMap.get(unknownId).tabs.push({ url: t.url, title: t.title, id: t.targetId });
                }
              }
            } else {
              const targets = await fetch(`http://localhost:${port}/json`).then(r => r.json()).catch(() => []);
              const pages = targets.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
              const version = await fetch(`http://localhost:${port}/json/version`).then(r => r.json()).catch(() => null);
              const wsUrl = version?.webSocketDebuggerUrl;
              if (!wsUrl) throw new Error("no browser websocket");
              const ws = new WebSocket(wsUrl);
              let nextId = 1;
              const pending = new Map();
              await new Promise((resolve, reject) => {
                const to = setTimeout(() => reject(new Error("ws timeout")), 3000);
                ws.on("open", () => { clearTimeout(to); resolve(); });
                ws.on("error", (e) => { clearTimeout(to); reject(e); });
              });
              ws.on("message", (data) => {
                try {
                  const msg = JSON.parse(data.toString());
                  if (msg.id && pending.has(msg.id)) {
                    pending.get(msg.id)(msg);
                    pending.delete(msg.id);
                  }
                } catch {}
              });
              const send = (method, params) => new Promise((resolve, reject) => {
                const id = nextId++;
                const to = setTimeout(() => { pending.delete(id); reject(new Error("cdp timeout")); }, 3000);
                pending.set(id, (msg) => { clearTimeout(to); msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result); });
                ws.send(JSON.stringify({ id, method, params }));
              });
              try {
                for (const t of pages) {
                  try {
                    const { windowId } = await send("Browser.getWindowForTarget", { targetId: t.id });
                    if (windowId) {
                      if (!windowMap.has(windowId)) windowMap.set(windowId, { tabs: [], windowId });
                      windowMap.get(windowId).tabs.push({ url: t.url, title: t.title, id: t.id });
                    }
                  } catch {
                    const unknownId = "unknown";
                    if (!windowMap.has(unknownId)) windowMap.set(unknownId, { tabs: [], windowId: unknownId });
                    windowMap.get(unknownId).tabs.push({ url: t.url, title: t.title, id: t.id });
                  }
                }
              } finally {
                try { ws.close(); } catch {}
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

        const lines = allWindows.map((w, i) => {
          const marker = w.tabs.some(t => t.url === currentPage?.url()) ? " <- active" : "";
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
            const shared = await ensureSharedContexts();
            if (shared.length === 0) return textErr("No browser context available to open a tab in.");
            contexts = shared;
            currentContextIndex = 0;
            currentPage = contexts[0].pages()[0] || null;
            if (!currentPage) {
              currentPage = await contexts[0].newPage();
              await currentPage.goto(tab.url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => {});
            }
            await applyNativeColorScheme(currentPage);
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
        syncContexts();
        lastWindowsList.splice(index, 1);
        const activeCtx = getContext();
        currentPage = activeCtx ? activeCtx.pages()[0] || null : contexts[0]?.pages()[0] || null;
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
  timeout: z.number().min(1).max(600).optional().default(120).describe("Max seconds to wait for the CAPTCHA to be solved (default 120, max 600)"),
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

server.tool("search_social", "Search a social media platform or search engine in the current tab and return the visible text of the results page (truncated to 8000 chars). Platforms: google, twitter, instagram (hashtag), facebook, linkedin, tiktok, youtube.", {
  platform: z.enum(["google", "twitter", "instagram", "facebook", "linkedin", "tiktok", "youtube"]).describe("Platform to search on"),
  query: z.string().describe("Search query — for instagram use a hashtag without the # symbol"),
}, async ({ platform, query }) => {
  try {
    const page = requirePage();
    const urls = {
      google: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      twitter: `https://twitter.com/search?q=${encodeURIComponent(query)}&src=typed_query`,
      instagram: `https://www.instagram.com/explore/tags/${encodeURIComponent(query.replace(/#/g, ""))}/`,
      facebook: `https://www.facebook.com/search/top?q=${encodeURIComponent(query)}`,
      linkedin: `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query)}`,
      tiktok: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`,
      youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    };
    await page.goto(urls[platform], { waitUntil: "domcontentloaded", timeout: 30000 });
    const selectors = { google: '#search, #rso', tiktok: '[class*="DivItemContainer"], [class*="video-feed"]', youtube: 'ytd-video-renderer, ytd-channel-renderer' };
    try { await page.locator(selectors[platform] || '[role="main"], main, #results').first().waitFor({ timeout: 10000 }); } catch {}
    let result = `Search results for "${query}" on ${platform}:\n\n${(await page.locator("body").evaluate((n) => (n?.innerText || "").slice(0, 8000)))}`;
    const captchaResult = await autoWaitForCaptcha();
    if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
    return text(result);
  } catch (e) { return textErr(`Error: ${e.message}`); }
});

server.tool("cookies", "Persist browser cookies for session reuse. save stores the current window's cookies under a named profile; load restores them (e.g. to keep login sessions alive between runs). Cookies are stored locally under the cookies directory.", {
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
