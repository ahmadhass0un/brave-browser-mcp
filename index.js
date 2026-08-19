#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync, mkdirSync, realpathSync } from "fs";
import { join, dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";
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

let _opLock = Promise.resolve();
function withLock(fn) {
  const p = _opLock.then(() => fn(), () => fn());
  _opLock = p.catch(() => {});
  return p;
}

function getCtxId(ctx) { return contextIdMap.get(ctx) || null; }
function getContext() { return contexts[currentContextIndex] || null; }
function requirePage() {
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
  try {
    const session = await page.context().newCDPSession(page);
    await session.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "" }] });
    await session.detach().catch(() => {});
  } catch (e) { log(`applyNativeColorScheme: ${e.message}`); }
}

async function applyNativeColorSchemeAll() {
  for (const ctx of contexts) {
    for (const page of ctx.pages()) await applyNativeColorScheme(page);
  }
}

async function waitForPageReady(page, timeout = 30000) {
  try {
    await page.waitForLoadState("domcontentloaded", { timeout });
    await page.waitForFunction(() => document.readyState === "complete", { timeout });
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
      const body = document.body?.innerText?.toLowerCase() || "";
      const html = document.documentElement.outerHTML.toLowerCase();
      const url = window.location.href.toLowerCase();

      if (url.includes("captcha") || url.includes("recaptcha") || url.includes("challenge")) {
        if (body.includes("prove you") || body.includes("not a robot") || body.includes("checking your browser")) {
          return { found: true, type: "URL challenge page", solved: false };
        }
      }

      if (html.includes("cloudflare") && html.includes("challenge")) {
        const cf = document.querySelector('#challenge-form, #challenge-running, #challenge-stage');
        if (cf) return { found: true, type: "Cloudflare challenge", solved: false };
        if (!body.includes("checking your browser") && !body.includes("verify you")) return { found: false, solved: true };
      }

      const recaptcha = document.querySelector('iframe[src*="recaptcha"], iframe[title*="reCAPTCHA"]');
      if (recaptcha) {
        const cb = document.querySelector('.recaptcha-checkbox, #recaptcha-anchor');
        if (cb) return { found: true, type: "reCAPTCHA", solved: cb.getAttribute('aria-checked') === 'true' };
        const bframe = document.querySelector('iframe[src*="recaptcha/bframe"]');
        if (bframe) {
          const s = window.getComputedStyle(bframe);
          if (s.display !== 'none' && s.visibility !== 'hidden') return { found: true, type: "reCAPTCHA challenge", solved: false };
        }
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

      if (body.includes("i'm not a robot") || body.includes("select all squares") || body.includes("verify you are human") || body.includes("prove you're not a robot")) {
        return { found: true, type: "CAPTCHA text", solved: false };
      }

      const containers = document.querySelectorAll('[class*="captcha"], [id*="captcha"], [class*="challenge"], [id*="challenge"]');
      for (const c of containers) {
        const s = window.getComputedStyle(c);
        if (s.display !== 'none' && s.visibility !== 'hidden' && c.offsetHeight > 0) return { found: true, type: "CAPTCHA container", solved: false };
      }

      return { found: false, solved: false };
    });
  } catch (e) {
    log(`detectCaptcha error: ${e.message}`);
    return { found: false, solved: false };
  }
}

async function autoWaitForCaptcha() {
  const info = await detectCaptcha();
  if (!info?.found || info.solved) return info?.found ? `${info.type} [SOLVED]` : null;
  const startTime = Date.now();
  while (Date.now() - startTime < 120000) {
    await new Promise(r => setTimeout(r, 1000));
    const check = await detectCaptcha();
    if (!check?.found || check.solved) return `${info.type} solved in ${Math.round((Date.now() - startTime) / 1000)}s`;
  }
  return `${info.type} [TIMEOUT]`;
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

async function finalizeConnection() {
  cdpSession = await browser.newBrowserCDPSession();
  contexts = browser.contexts().length > 0 ? browser.contexts() : [await browser.newContext()];
  for (const ctx of contexts) {
    const id = getCtxId(ctx) || `ctx_${nextContextId++}`;
    if (!getCtxId(ctx)) contextIdMap.set(ctx, id);
    if (!contextMeta.has(id)) contextMeta.set(id, { isIncognito: false });
  }
  currentContextIndex = 0;
  currentPage = contexts[0].pages()[0] || await contexts[0].newPage();
  await applyNativeColorSchemeAll();
}

async function connectToBrave() {
  let debugPortAvailable = false;
  try { const r = await fetch(`http://localhost:${BROWSER_PORT}/json/version`); debugPortAvailable = r.ok; } catch {}

  if (debugPortAvailable) {
    try {
      browser = await chromium.connectOverCDP(`http://localhost:${BROWSER_PORT}`);
      connectedViaCDP = true;
      await finalizeConnection();
      return { ok: true, message: "Connected to Brave on port " + BROWSER_PORT };
    } catch (e) { return { ok: false, message: `Failed to connect: ${e.message}` }; }
  }

  let braveRunning = false;
  try {
    const ps = execSync("pgrep -fa brave-browser || pgrep -fa brave || true", { encoding: "utf-8", timeout: 5000 }).trim();
    braveRunning = ps.length > 0;
  } catch {}

  if (braveRunning) {
    return { ok: false, message: "Brave is running but without debug port enabled. Tell the user to close Brave manually, then call connect_brave again." };
  }

  spawn(getBravePath(), [`--remote-debugging-port=${BROWSER_PORT}`, "--force-dark-mode"], { detached: true, stdio: "ignore" }).unref();

  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, 1000));
    try { const r = await fetch(`http://localhost:${BROWSER_PORT}/json/version`); if (r.ok) { debugPortAvailable = true; break; } } catch {}
  }
  if (!debugPortAvailable) return { ok: false, message: "Failed to launch Brave with debug port. Please try again." };

  browser = await chromium.connectOverCDP(`http://localhost:${BROWSER_PORT}`);
  connectedViaCDP = true;
  await finalizeConnection();
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
    return text(`Connected to Brave\nOpen tabs: ${tabCount}\nWindows: ${contexts.length}`);
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
  timeout: z.number().optional().default(30000).describe("Max time in ms before navigation is abandoned (default 30000)"),
}, async ({ url, wait_until, timeout }) => {
  try {
    const page = requirePage();
    await page.goto(url, { waitUntil: wait_until, timeout });
    await waitForPageReady(page, timeout);
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
    await page.evaluate((dir) => { try { history[dir](); } catch {} }, action === "back" ? "back" : "forward");
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 300));
      if (page.url() !== beforeUrl) break;
    }
    await new Promise(r => setTimeout(r, 1000));
    let result = `${action === "back" ? "Back" : "Forward"} to: ${page.url()}`;
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
          await el.evaluate((n) => n.click()).catch(() => {});
          clicked = true;
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
          await el.evaluate((n) => n.click()).catch(() => {});
          clicked = true;
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
  delay: z.number().optional().default(0).describe("Delay between keystrokes in ms. 0 = instant fill. Use e.g. 50-100 for human-like typing"),
  scope: z.string().optional().describe("CSS selector of a container to search within (e.g. '[role=dialog]' for the currently open dialog)"),
}, async ({ selector, text: t, press_enter, delay, scope }) => {
  try {
    const page = requirePage();
    const loc = scope ? page.locator(scope).first().locator(selector) : page.locator(selector);
    if (delay > 0) await loc.pressSequentially(t, { delay });
    else await loc.fill(t);
    if (press_enter) await loc.press("Enter");
    await page.waitForTimeout(1000);
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
  times: z.number().optional().default(1).describe("Repeat the full key sequence this many times (default 1)"),
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
    await page.waitForTimeout(1000);
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
      return text((await el.innerHTML()).substring(0, 10000));
    }
    return text((await el.innerText()).substring(0, 10000));
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
  catch { return text(`Timeout waiting for: ${selector}`); }
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

      if (action === "list") {
        const pages = ctx.pages();
        const tabs = pages.map((p, i) => `${i}: ${p.url()}${p === currentPage ? " <- active" : ""}`).join("\n");
        return text(`Open tabs (${pages.length}):\n${tabs}`);
      }
      if (action === "open") {
        const page = await ctx.newPage();
        if (url) { await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }); await waitForPageReady(page); }
        await applyNativeColorScheme(page);
        currentPage = page;
        let result = `New tab opened${url ? `: ${url}` : ""}\nTitle: ${await page.title()}`;
        const captchaResult = await autoWaitForCaptcha();
        if (captchaResult) result += `\nCAPTCHA: ${captchaResult}`;
        return text(result);
      }
      if (action === "switch") {
        const pages = ctx.pages();
        if (index === undefined || index < 0 || index >= pages.length) return textErr(`Invalid index. Available: 0-${pages.length - 1}`);
        currentPage = pages[index];
        await currentPage.bringToFront();
        return text(`Switched to tab ${index}: ${currentPage.url()}`);
      }
      if (action === "close") {
        const pages = ctx.pages();
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

      if (action === "list") {
        const allWindows = [];

        async function getWindowsFromPort(port) {
          try {
            const targets = await fetch(`http://localhost:${port}/json`).then(r => r.json()).catch(() => []);
            const pages = targets.filter(t => t.type === "page" && t.webSocketDebuggerUrl);
            const windowMap = new Map();

            for (const t of pages) {
              let ws = null;
              try {
                const result = await new Promise((resolve, reject) => {
                  ws = new WebSocket(t.webSocketDebuggerUrl);
                  const timeout = setTimeout(() => { try { ws?.close(); } catch {} reject("timeout"); }, 3000);
                  ws.on("open", () => {
                    ws.send(JSON.stringify({ id: 1, method: "Browser.getWindowForTarget" }));
                  });
                  ws.on("message", (data) => {
                    try {
                      const msg = JSON.parse(data.toString());
                      if (msg.id === 1) {
                        clearTimeout(timeout);
                        try { ws?.close(); } catch {}
                        resolve(msg.result);
                      }
                    } catch {}
                  });
                  ws.on("error", () => { clearTimeout(timeout); reject("error"); });
                  ws.on("close", () => { clearTimeout(timeout); });
                });

                if (result?.windowId) {
                  if (!windowMap.has(result.windowId)) windowMap.set(result.windowId, { tabs: [], windowId: result.windowId });
                  windowMap.get(result.windowId).tabs.push({ url: t.url, title: t.title, id: t.id });
                }
              } catch {
                try { ws?.close(); } catch {}
                const unknownId = "unknown";
                if (!windowMap.has(unknownId)) windowMap.set(unknownId, { tabs: [], windowId: unknownId });
                windowMap.get(unknownId).tabs.push({ url: t.url, title: t.title, id: t.id });
              }
            }

            for (const [, win] of windowMap) {
              allWindows.push(win);
            }
          } catch {}
        }

        await getWindowsFromPort(BROWSER_PORT);

        if (allWindows.length === 0) return text("No windows detected. Run connect_brave first.");

        const lines = allWindows.map((w, i) => {
          const marker = w.tabs.some(t => t.url === currentPage?.url()) ? " <- active" : "";
          const tabCount = w.tabs.length;
          const tabList = w.tabs.map((t, j) => `    ${j}: ${t.url}${t.title ? ` - ${t.title}` : ""}`).join("\n");
          return `Window ${i}${marker} (${tabCount} tab${tabCount !== 1 ? 's' : ''}):\n${tabList}`;
        });

        return text(`Windows (${allWindows.length}):\n${lines.join("\n")}`);
      }

      if (action === "switch") {
        if (index === undefined || index < 0 || index >= contexts.length) return textErr(`Invalid index. Available: 0-${contexts.length - 1}`);
        currentContextIndex = index;
        const pages = contexts[index].pages();
        currentPage = pages.length > 0 ? pages[0] : await contexts[index].newPage();
        await applyNativeColorScheme(currentPage);
        await currentPage.bringToFront();
        return text(`Switched to window ${index}: ${currentPage.url()}`);
      }

      if (action === "close") {
        if (contexts.length <= 1) return textErr("Cannot close the last window");
        if (index === undefined || index < 0 || index >= contexts.length) return textErr(`Invalid index. Available: 0-${contexts.length - 1}`);
        const ctx = contexts[index];
        const ctxId = getCtxId(ctx);
        for (const page of ctx.pages()) await page.close().catch(() => {});
        await ctx.close().catch(() => {});
        contexts.splice(index, 1);
        if (ctxId) contextMeta.delete(ctxId);
        if (currentContextIndex >= contexts.length) currentContextIndex = contexts.length - 1;
        else if (currentContextIndex > index) currentContextIndex--;
        const activeCtx = getContext();
        currentPage = activeCtx ? activeCtx.pages()[0] || null : contexts[0]?.pages()[0] || null;
        return text(`Closed window ${index}. Now on window ${currentContextIndex}`);
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

server.tool("wait_for_captcha", "Poll every 1 second for the current page's CAPTCHA to be solved by the user. Use after detect_captcha finds an unsolved CAPTCHA — wait for the user to solve it, then continue automation.", {
  timeout: z.number().optional().default(120).describe("Max seconds to wait for the CAPTCHA to be solved (default 120)"),
}, async ({ timeout }) => {
  try {
    const page = requirePage();
    const startTime = Date.now();
    const maxMs = timeout * 1000;
    while (Date.now() - startTime < maxMs) {
      const info = await detectCaptcha();
      if (!info?.found) return text("No CAPTCHA detected on this page");
      if (info.solved) return text(`CAPTCHA solved (${info.type}) in ${Math.round((Date.now() - startTime) / 1000)}s`);
      await new Promise(r => setTimeout(r, 1000));
    }
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
      instagram: `https://www.instagram.com/explore/tags/${encodeURIComponent(query.replace("#", ""))}/`,
      facebook: `https://www.facebook.com/search/top?q=${encodeURIComponent(query)}`,
      linkedin: `https://www.linkedin.com/search/results/all/?keywords=${encodeURIComponent(query)}`,
      tiktok: `https://www.tiktok.com/search?q=${encodeURIComponent(query)}`,
      youtube: `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`,
    };
    await page.goto(urls[platform], { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(3000);
    const selectors = { google: '#search, #rso', tiktok: '[class*="DivItemContainer"], [class*="video-feed"]', youtube: 'ytd-video-renderer, ytd-channel-renderer' };
    try { await page.locator(selectors[platform] || '[role="main"], main, #results').first().waitFor({ timeout: 10000 }); } catch {}
    let result = `Search results for "${query}" on ${platform}:\n\n${(await page.locator("body").innerText()).substring(0, 8000)}`;
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
  const status = {
    server: "running",
    version: pkg.version,
    connected: !!browser?.isConnected(),
    windows: contexts.length,
    tabs: contexts.reduce((n, c) => n + c.pages().length, 0),
    activeTab: currentPage ? { url: currentPage.url(), title: await currentPage.title().catch(() => "unknown") } : null,
  };
  return text(JSON.stringify(status, null, 2));
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`server running (v${pkg.version})`);
}

main().catch(console.error);
