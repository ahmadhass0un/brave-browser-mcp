import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { start as startWsServer } from './ws-server.js';
import * as bridge from './bridge.js';

const DATA_DIR = join(process.cwd(), 'data');
const BOOKMARKS_FILE = join(DATA_DIR, 'bookmarks', 'bookmarks.json');
const HISTORY_FILE = join(DATA_DIR, 'history', 'history.json');
const SHOTS_DIR = join(DATA_DIR, 'screenshots');

// Load bookmarks/history from JSON files
let bookmarks = [];
let browsingHistory = [];
function loadJson(file, fallback) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; } }
function saveJson(file, data) { writeFileSync(file, JSON.stringify(data, null, 2)); }
function loadBookmarks() { bookmarks = loadJson(BOOKMARKS_FILE, []); }
function loadHistory() { browsingHistory = loadJson(HISTORY_FILE, []); }
function addHistoryEntry(entry) {
  browsingHistory.unshift({ ...entry, timestamp: Date.now() });
  if (browsingHistory.length > 5000) browsingHistory.length = 5000;
  saveJson(HISTORY_FILE, browsingHistory);
}

// Bridge API expected by this file:
//   bridge.call(op, args)                 -> RPC to extension (op names match background.js HANDLERS)
//   bridge.requireTab()                   -> active tabId for tab-scoped ops
//   bridge.getTransport() / shutdown()
//   bridge.tabs.list(windowId?) | open(url, {active, windowId}) | activate(tabId) | close(tabId)
//   bridge.windows.list() | activate(id) | close(id)
//   Composite in-page helpers (implemented over cs.eval / input.* / dbg.cmd):
//     click, type, focus, pressKey, scroll, hover,
//     pageInfo, pageContent, readPage, listElements, inspectDom,
//     screenshot({fullPage, selector}) -> {data(base64), ...}, pdf() -> {data},
//     executeJs(code, confirm), waitFor(selector, timeoutMs),
//     detectCaptcha(), videoControl(action, value), search({query, platform, region, limit})

export async function main() {
  loadBookmarks();
  loadHistory();

  const wsPort = parseInt(process.env.BROWSER_NAV_WS_PORT || '9224');
  startWsServer(wsPort);

  const server = new McpServer({
    name: 'browser-navigator',
    version: '2.0.0',
  });

  const json = (r) => ({ content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }] });
  const activeTab = (id) => id || bridge.requireTab();
  const resolvePath = (savePath, ext) =>
    savePath ? (savePath.startsWith('/') ? savePath : join(SHOTS_DIR, savePath))
             : join(SHOTS_DIR, `${ext}_${Date.now()}.${ext}`);
  const writeBinary = async (result, savePath, ext) => {
    if (!result?.data) return json(result);
    const outPath = resolvePath(savePath, ext);
    writeFileSync(outPath, Buffer.from(result.data, 'base64'));
    return { content: [{ type: 'text', text: `${ext.toUpperCase()} saved to ${outPath}` }] };
  };

  // Tool 1: connect_brave — verify the extension link is alive
  server.tool('connect_brave', 'Connect to the browser via extension and report its state', {}, async () => {
    const state = await bridge.call('browser.state', {});
    return { content: [{ type: 'text', text: `Connected to browser.\nOpen windows: ${state.windowCount}\nOpen tabs: ${state.tabCount}\nActive tab: ${state.activeTabId}\nServer: ws://127.0.0.1:${wsPort}\nExtension: v${state.extVersion || 'unknown'}\nTransport: ${bridge.getTransport()}` }] };
  });

  // Tool 2: disconnect — drop the WS/native session (browser keeps running)
  server.tool('disconnect', 'Disconnect from the browser', {}, async () => {
    bridge.shutdown();
    return { content: [{ type: 'text', text: 'Disconnected.' }] };
  });

  // Tool 3: navigate
  server.tool('navigate', 'Navigate a tab to a URL and wait for it to settle', {
    url: z.string().url(),
    wait_until: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).default('load'),
    timeout_ms: z.number().int().min(1000).max(120000).default(30000),
    tab_id: z.number().int().optional(),
    background: z.boolean().default(false),
  }, async ({ url, wait_until, timeout_ms, tab_id, background }) => {
    const tabId = activeTab(tab_id);
    const result = await bridge.call('nav.goto', { tabId, url, waitUntil: wait_until, timeoutMs: timeout_ms, background });
    addHistoryEntry({ url, title: result.title || url, tabId });
    return json(result);
  });

  // Tool 4: navigate_history
  server.tool('navigate_history', "Go back or forward in the active tab's history", {
    direction: z.enum(['back', 'forward']).default('back'),
    steps: z.number().int().min(1).max(50).default(1),
  }, async ({ direction, steps }) => {
    const delta = direction === 'back' ? -steps : steps;
    const result = await bridge.call('cs.eval', {
      tabId: bridge.requireTab(),
      func: '(d) => { history.go(d); return new Promise((res) => setTimeout(() => res({ url: location.href, title: document.title }), 400)); }',
      args: [delta],
    });
    addHistoryEntry({ url: result.url || '', title: result.title || '' });
    return json(result);
  });

  // Tool 5: click
  server.tool('click', 'Click an element by selector, visible text, or ref from read_page', {
    selector: z.string().optional(),
    double_click: z.boolean().default(false),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    ref: z.string().optional(),
    trusted: z.boolean().default(true),
  }, async ({ selector, double_click, button, by_text, scope, ref, trusted }) =>
    json(await bridge.click({ selector, doubleClick: double_click, button, byText: by_text, scope, ref, trusted })));

  // Tool 6: type
  server.tool('type', 'Type text into an input or textarea, optionally character-by-character', {
    selector: z.string().optional(),
    text: z.string(),
    delay: z.number().int().min(0).max(60000).default(0),
    delay_per_char: z.number().int().min(0).max(1000).default(0),
    scope: z.string().optional(),
    ref: z.string().optional(),
  }, async ({ selector, text, delay, delay_per_char, scope, ref }) =>
    json(await bridge.type({ selector, text, delay, delayPerChar: delay_per_char, scope, ref })));

  // Tool 7: focus_element
  server.tool('focus_element', 'Move keyboard focus to an element (needed before press_key on custom widgets)', {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
  }, async ({ selector, by_text, scope }) => json(await bridge.focus({ selector, byText: by_text, scope })));

  // Tool 8: press_key
  server.tool('press_key', 'Send keyboard keys ("Enter", "Control+a"); repeats the sequence times times', {
    key: z.string(),
    times: z.number().int().min(1).max(100).default(1),
    selector: z.string().optional(),
  }, async ({ key, times, selector }) => json(await bridge.pressKey({ key, times, selector })));

  // Tool 9: scroll
  server.tool('scroll', 'Scroll the page or an element (use down repeatedly for infinite scroll)', {
    direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
    amount: z.number().int().min(1).max(100000).default(800),
    selector: z.string().optional(),
  }, async ({ direction, amount, selector }) => json(await bridge.scroll({ direction, amount, selector })));

  // Tool 10: get_page_info
  server.tool('get_page_info', "Get the current page's URL, title, loading status, and CAPTCHA presence", {
    tab_id: z.number().int().optional(),
  }, async ({ tab_id }) => json(await bridge.pageInfo(activeTab(tab_id))));

  // Tool 11: get_page_content
  server.tool('get_page_content', 'Extract readable text or raw HTML from the page or an element', {
    format: z.enum(['text', 'html']).default('text'),
    limit: z.number().int().min(100).max(200000).default(10000),
    selector: z.string().optional(),
  }, async ({ format, limit, selector }) => json(await bridge.pageContent({ format, limit, selector })));

  // Tool 12: read_page
  server.tool('read_page', 'Build an accessibility tree of the page with stable refs (ref_N) for click/type targeting', {
    filter: z.enum(['interactive', 'all']).default('interactive'),
    max_refs: z.number().int().min(10).max(1000).default(150),
  }, async ({ filter, max_refs }) => json(await bridge.readPage({ filter, maxRefs: max_refs })));

  // Tool 13: list_elements
  server.tool('list_elements', 'List elements of a kind (links, buttons, inputs...) with text and reusable selectors', {
    kind: z.enum(['link', 'button', 'input', 'select', 'textarea', 'image', 'heading']),
    contains: z.string().optional(),
    scope: z.string().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }, async ({ kind, contains, scope, limit }) => json(await bridge.listElements({ kind, contains, scope, limit })));

  // Tool 14: inspect_dom
  server.tool('inspect_dom', "Inspect an element's tag, attributes, css path, and children to understand complex UIs", {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
    max_depth: z.number().int().min(1).max(10).default(3),
    include_html: z.boolean().default(false),
  }, async ({ selector, by_text, scope, max_depth, include_html }) =>
    json(await bridge.inspectDom({ selector, byText: by_text, scope, maxDepth: max_depth, includeHtml: include_html })));

  // Tool 15: screenshot
  server.tool('screenshot', 'Capture a PNG of the page (full page) or one element; saved under data/screenshots', {
    full_page: z.boolean().default(false),
    selector: z.string().optional(),
    save_path: z.string().optional(),
  }, async ({ full_page, selector, save_path }) => {
    const shot = await bridge.screenshot({ fullPage: full_page, selector });
    return writeBinary(shot, save_path, 'png');
  });

  // Tool 16: pdf_export
  server.tool('pdf_export', 'Save the current page as PDF (A4, backgrounds on); saved under data/screenshots', {
    save_path: z.string().optional(),
  }, async ({ save_path }) => {
    const pdf = await bridge.pdf();
    return writeBinary(pdf, save_path, 'pdf');
  });

  // Tool 17: execute_js
  server.tool('execute_js', 'Run JavaScript in the page and return its value (use return for a result). DANGER: requires confirm=true', {
    code: z.string(),
    confirm: z.boolean().default(false),
  }, async ({ code, confirm }) => {
    if (!confirm) return { content: [{ type: 'text', text: 'Refused: execute_js is destructive. Re-run with confirm=true to proceed.' }] };
    return json(await bridge.executeJs(code, confirm));
  });

  // Tool 18: inject_script
  server.tool('inject_script', 'Register a named persistent script that replays on every navigation', {
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    code: z.string(),
  }, async ({ name, code }) => json(await bridge.call('injected.register', { name, code })));

  // Tool 19: send_to_injected
  server.tool('send_to_injected', 'Send JSON data to an injected script and await its reply', {
    name: z.string(),
    data: z.any().optional(),
    timeout_ms: z.number().int().min(500).max(60000).default(5000),
  }, async ({ name, data, timeout_ms }) =>
    json(await bridge.call('injected.send', { tabId: bridge.requireTab(), name, data, timeoutMs: timeout_ms })));

  // Tool 20: wait_for
  server.tool('wait_for', 'Wait until a CSS selector exists in the DOM', {
    selector: z.string(),
    timeout_ms: z.number().int().min(500).max(120000).default(10000),
  }, async ({ selector, timeout_ms }) => json(await bridge.waitFor(selector, timeout_ms)));

  // Tool 21: wait_for_load
  server.tool('wait_for_load', 'Wait for the page to reach a load state', {
    until: z.enum(['commit', 'domcontentloaded', 'load', 'networkidle']).default('load'),
    timeout_ms: z.number().int().min(1000).max(300000).default(30000),
  }, async ({ until, timeout_ms }) =>
    json(await bridge.call('nav.waitReady', { tabId: bridge.requireTab(), until, timeoutMs: timeout_ms })));

  // Tool 22: tabs
  server.tool('tabs', 'List, open, switch, or close tabs', {
    action: z.enum(['list', 'open', 'switch', 'close']),
    url: z.string().optional(),
    tab_id: z.number().int().optional(),
    window_id: z.number().int().optional(),
    active: z.boolean().default(true),
    background: z.boolean().default(false),
  }, async ({ action, url, tab_id, window_id, active, background }) => {
    let result;
    switch (action) {
      case 'list': result = await bridge.tabs.list(window_id); break;
      case 'open': result = await bridge.tabs.open(url, { active: !background, windowId: window_id }); break;
      case 'switch': result = await bridge.tabs.activate(tab_id); break;
      case 'close': result = await bridge.tabs.close(tab_id); break;
    }
    return json(result);
  });

  // Tool 23: windows
  server.tool('windows', 'List browser windows, focus one, or close one', {
    action: z.enum(['list', 'focus', 'close']).default('list'),
    window_id: z.number().int().optional(),
  }, async ({ action, window_id }) => {
    let result;
    switch (action) {
      case 'list': result = await bridge.windows.list(); break;
      case 'focus': result = await bridge.windows.activate(window_id); break;
      case 'close': result = await bridge.windows.close(window_id); break;
    }
    return json(result);
  });

  // Tool 24: detect_captcha
  server.tool('detect_captcha', 'Check whether the current page shows a CAPTCHA and whether it is solved', {}, async () =>
    json(await bridge.detectCaptcha()));

  // Tool 25: wait_for_captcha
  server.tool('wait_for_captcha', "Wait up to timeout_ms for the user to solve the page's CAPTCHA", {
    timeout_ms: z.number().int().min(1000).max(180000).default(60000),
  }, async ({ timeout_ms }) =>
    json(await bridge.call('captcha.wait', { tabId: bridge.requireTab(), timeoutMs: timeout_ms })));

  // Tool 26: video_control
  server.tool('video_control', 'Control HTML5 video/audio playback: play, pause, toggle, mute, unmute, seek, set_speed, set_volume, fullscreen, exit_fullscreen, get_info', {
    action: z.enum(['play', 'pause', 'toggle', 'mute', 'unmute', 'seek', 'set_speed', 'set_volume', 'fullscreen', 'exit_fullscreen', 'get_info']),
    value: z.union([z.number(), z.string()]).optional(),
  }, async ({ action, value }) => json(await bridge.videoControl(action, value)));

  // Tool 27: search
  server.tool('search', 'Run a web search in the active tab and return the top results', {
    query: z.string(),
    platform: z.enum(['google', 'bing', 'duckduckgo', 'brave', 'youtube', 'reddit', 'github', 'stackoverflow', 'wikipedia']).default('google'),
    region: z.string().optional(),
    limit: z.number().int().min(1).max(50).default(10),
  }, async ({ query, platform, region, limit }) => {
    const result = await bridge.search({ query, platform, region, limit });
    addHistoryEntry({ url: result.url || '', title: `Search [${platform}]: ${query}` });
    return json(result);
  });

  // Tool 28: search_tabs
  server.tool('search_tabs', 'Search across all open tabs by title or URL', {
    query: z.string(),
    limit: z.number().int().min(1).max(100).default(20),
  }, async ({ query, limit }) => {
    const { tabs: openTabs } = await bridge.tabs.list();
    const q = query.toLowerCase();
    const matches = (openTabs || [])
      .map((t) => ({ id: t.id, title: t.title || '', url: t.url || '', score: ((t.title || '').toLowerCase().includes(q) ? 2 : 0) + ((t.url || '').toLowerCase().includes(q) ? 1 : 0) }))
      .filter((t) => t.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
    return json(matches.length ? matches : `No open tabs matching "${query}".`);
  });

  // Tool 29: network_start
  server.tool('network_start', 'Start capturing HTTP traffic on the active tab via CDP', {
    max_time: z.number().int().min(1000).max(600000).default(30000),
    include_static: z.boolean().default(false),
  }, async ({ max_time, include_static }) =>
    json(await bridge.call('net.start', { tabId: bridge.requireTab(), maxTimeMs: max_time, includeStatic: include_static })));

  // Tool 30: network_stop
  server.tool('network_stop', 'Stop network capture and return everything captured so far', {}, async () =>
    json(await bridge.call('net.stop', {})));

  // Tool 31: network_list
  server.tool('network_list', 'Peek at captured requests without stopping capture', {}, async () =>
    json(await bridge.call('net.peek', {})));

  // Tool 32: network_request
  server.tool('network_request', 'Send an HTTP request through the browser profile (cookies/session apply)', {
    url: z.string().url(),
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']).default('GET'),
    headers: z.record(z.string()).optional(),
    body: z.string().optional(),
  }, async ({ url, method, headers, body }) =>
    json(await bridge.call('http.request', { url, method, headers, body })));

  // Tool 33: cookies
  server.tool('cookies', "Get cookies (filter by domain/name), set cookies, delete one, or clear by domain", {
    action: z.enum(['get', 'set', 'clear', 'delete']).default('get'),
    cookies: z.array(z.object({
      name: z.string(),
      value: z.string().default(''),
      url: z.string().optional(),
      domain: z.string().optional(),
      path: z.string().optional(),
      secure: z.boolean().optional(),
      http_only: z.boolean().optional(),
      same_site: z.enum(['no_restriction', 'lax', 'strict', 'unspecified']).optional(),
      expiration_date: z.number().optional(),
    })).optional(),
    domain: z.string().optional(),
    name: z.string().optional(),
  }, async ({ action, cookies, domain, name }) => {
    let result;
    switch (action) {
      case 'get':
        result = await bridge.call('cookie.all', { domain, name });
        break;
      case 'set': {
        const out = [];
        for (const c of cookies || []) out.push(await bridge.call('cookie.set', { cookie: c }));
        result = { set: out.length };
        break;
      }
      default: { // clear | delete — expire matching cookies via cookie.set
        const { cookies: found } = await bridge.call('cookie.all', domain ? { domain } : {});
        const targets = found.filter((c) => !name || c.name === name);
        let cleared = 0;
        for (const c of targets) {
          const scheme = c.secure ? 'https' : 'http';
          const host = (c.domain || '').replace(/^\./, '');
          const cookieUrl = `${scheme}://${host}${c.path || '/'}`;
          await bridge.call('cookie.set', {
            cookie: { name: c.name, value: '', url: cookieUrl, expirationDate: Math.floor(Date.now() / 1000) - 1 },
          }).then(() => cleared++).catch(() => {});
        }
        result = { cleared, attempted: targets.length };
      }
    }
    return json(result);
  });

  // Tool 34: bookmark_add
  server.tool('bookmark_add', 'Add a bookmark (updates if same URL exists)', {
    url: z.string().url(),
    title: z.string(),
    tags: z.array(z.string()).default([]),
  }, async ({ url, title, tags }) => {
    const existing = bookmarks.find((b) => b.url === url);
    if (existing) {
      Object.assign(existing, { title, tags });
      saveJson(BOOKMARKS_FILE, bookmarks);
      return { content: [{ type: 'text', text: `Bookmark updated: ${existing.id}` }] };
    }
    const id = `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    bookmarks.push({ id, url, title, tags, createdAt: Date.now() });
    saveJson(BOOKMARKS_FILE, bookmarks);
    return { content: [{ type: 'text', text: `Bookmark saved: ${id}` }] };
  });

  // Tool 35: bookmark_delete
  server.tool('bookmark_delete', 'Delete a bookmark by id', {
    id: z.string(),
  }, async ({ id }) => {
    const before = bookmarks.length;
    bookmarks = bookmarks.filter((b) => b.id !== id);
    if (bookmarks.length === before) return { content: [{ type: 'text', text: `Bookmark ${id} not found.` }] };
    saveJson(BOOKMARKS_FILE, bookmarks);
    return { content: [{ type: 'text', text: `Deleted bookmark ${id}.` }] };
  });

  // Tool 36: bookmark_search
  server.tool('bookmark_search', 'Search bookmarks by keyword and/or tags', {
    query: z.string().default(''),
    tags: z.array(z.string()).default([]),
  }, async ({ query, tags }) => {
    let results = bookmarks;
    if (query) results = results.filter((b) => b.title.toLowerCase().includes(query.toLowerCase()) || b.url.toLowerCase().includes(query.toLowerCase()));
    if (tags.length) results = results.filter((b) => tags.some((t) => b.tags.includes(t)));
    return json(results.length ? results.slice(0, 50) : 'No bookmarks found.');
  });

  // Tool 37: bookmark_list
  server.tool('bookmark_list', 'List all saved bookmarks', {}, async () =>
    json(bookmarks.length ? bookmarks : 'No bookmarks saved.'));

  // Tool 38: history_search
  server.tool('history_search', 'Search recorded navigation history (most recent first)', {
    query: z.string().default(''),
    hours: z.number().int().min(1).max(168).default(24),
    limit: z.number().int().min(1).max(500).default(50),
  }, async ({ query, hours, limit }) => {
    const cutoff = Date.now() - hours * 3600000;
    let results = browsingHistory.filter((h) => h.timestamp > cutoff);
    if (query) results = results.filter((h) => (h.title || '').toLowerCase().includes(query.toLowerCase()) || h.url.toLowerCase().includes(query.toLowerCase()));
    return json(results.length ? results.slice(0, limit) : 'No history found.');
  });

  // Tool 39: hover
  server.tool('hover', 'Hover over an element to reveal hover menus, tooltips, or submenus', {
    selector: z.string().optional(),
    by_text: z.string().optional(),
    scope: z.string().optional(),
  }, async ({ selector, by_text, scope }) => json(await bridge.hover({ selector, byText: by_text, scope })));

  // Tool 40: computer — unified dispatcher over the same primitives
  server.tool('computer', 'Unified interaction: click, double_click, right_click, move, type, fill, key, scroll, hover, wait, navigate, screenshot', {
    action: z.enum(['click', 'double_click', 'right_click', 'move', 'type', 'fill', 'key', 'scroll', 'hover', 'wait', 'navigate', 'screenshot']),
    selector: z.string().optional(),
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    key: z.string().optional(),
    url: z.string().url().optional(),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    scroll_direction: z.enum(['up', 'down', 'left', 'right']).default('down'),
    scroll_amount: z.number().int().min(1).max(100000).default(800),
    delay: z.number().int().min(0).max(120000).default(0),
  }, async (a) => {
    const tabId = bridge.requireTab();
    switch (a.action) {
      case 'click':
      case 'double_click':
      case 'right_click':
        return json(await bridge.click({
          selector: a.selector, x: a.x, y: a.y,
          doubleClick: a.action === 'double_click',
          button: a.action === 'right_click' ? 'right' : a.button,
        }));
      case 'move':
      case 'hover':
        return json(await bridge.hover({ selector: a.selector, x: a.x, y: a.y }));
      case 'type':
      case 'fill':
        return json(await bridge.type({ selector: a.selector, text: a.text || '', delayPerChar: a.action === 'fill' ? 0 : a.delay }));
      case 'key':
        return json(await bridge.pressKey({ key: a.key || 'Enter', times: 1 }));
      case 'scroll':
        return json(await bridge.scroll({ direction: a.scroll_direction, amount: a.scroll_amount }));
      case 'wait':
        await new Promise((r) => setTimeout(r, a.delay || 1000));
        return json({ waitedMs: a.delay || 1000 });
      case 'navigate':
        return json(await bridge.call('nav.goto', { tabId, url: a.url, waitUntil: 'load', timeoutMs: 30000 }));
      case 'screenshot': {
        const shot = await bridge.screenshot({ fullPage: false, selector: a.selector });
        return writeBinary(shot, null, 'png');
      }
      default:
        return { content: [{ type: 'text', text: `Unknown computer action: ${a.action}` }] };
    }
  });

  // Tool 41: health
  server.tool('health', 'Server status, connection transport, store sizes, and live tab counts', {}, async () => {
    const state = await bridge.call('browser.state', {}).catch(() => null);
    const info = {
      server: 'browser-navigator v2.0.0',
      transport: bridge.getTransport(),
      connected: !!state,
      windows: state?.windowCount || 0,
      tabs: state?.tabCount || 0,
      activeTab: state?.activeTabId || null,
      bookmarks: bookmarks.length,
      history: browsingHistory.length,
    };
    return json(info);
  });

  // Connect via stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`browser-navigator MCP server v2.0.0 started (stdio + ws:${wsPort}), ${bookmarks.length} bookmarks, ${browsingHistory.length} history entries`);
}
