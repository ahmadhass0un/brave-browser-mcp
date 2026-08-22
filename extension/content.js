(() => {
  'use strict';

  const MARK = '__mcpSyntheticEvent';
  const MAX_HTML_CHARS = 200000;
  const CAPTCHA_SOLVED_EVENT = 'mcp:captcha-solved';

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'META', 'LINK', 'TEMPLATE']);

  const CAPTCHA_CHECKS = [
    ['recaptcha', 'iframe[src*="recaptcha"], .g-recaptcha'],
    ['hcaptcha', 'iframe[src*="hcaptcha"], .h-captcha'],
    ['turnstile', 'iframe[src*="challenges.cloudflare"], .cf-turnstile'],
    ['cloudflare-challenge', '.cf-browser-verification, #challenge-running'],
  ];

  const INTERACTIVE_ALL = [
    'button',
    'a',
    'input',
    'select',
    'textarea',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
  ].join(', ');

  const KIND_SELECTORS = {
    all: INTERACTIVE_ALL,
    button: 'button, [role="button"], [role="tab"], input[type="button"], input[type="submit"], input[type="reset"]',
    link: 'a, [role="link"]',
    input: 'input:not([type="button"]):not([type="submit"]):not([type="reset"]), select, textarea, [contenteditable="true"], [contenteditable=""]',
  };

  const KEY_ALIASES = {
    control: 'Control', ctrl: 'Control',
    alt: 'Alt', option: 'Alt', opt: 'Alt',
    shift: 'Shift',
    meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta',
    enter: 'Enter', return: 'Enter', cr: 'Enter',
    tab: 'Tab',
    escape: 'Escape', esc: 'Escape',
    backspace: 'Backspace', bs: 'Backspace',
    delete: 'Delete', del: 'Delete',
    insert: 'Insert', ins: 'Insert',
    home: 'Home', end: 'End',
    pageup: 'PageUp', pagedown: 'PageDown',
    up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight',
    arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
    space: ' ', spacebar: ' ',
  };

  const KEY_CODES = {
    Enter: [13, 'Enter'],
    Tab: [9, 'Tab'],
    Escape: [27, 'Escape'],
    Backspace: [8, 'Backspace'],
    Delete: [46, 'Delete'],
    Insert: [45, 'Insert'],
    Home: [36, 'Home'],
    End: [35, 'End'],
    PageUp: [33, 'PageUp'],
    PageDown: [34, 'PageDown'],
    ArrowLeft: [37, 'ArrowLeft'],
    ArrowUp: [38, 'ArrowUp'],
    ArrowRight: [39, 'ArrowRight'],
    ArrowDown: [40, 'ArrowDown'],
    ' ': [32, 'Space'],
  };

  const BUTTON_MASKS = { 0: 1, 1: 4, 2: 2 };

  function fail(message) {
    const err = new Error(message);
    err.name = 'McpContentError';
    return err;
  }

  function num(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function normWs(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  function cssEscapeValue(value) {
    const str = String(value);
    if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(str);
    return str.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  }

  function cssAttrValue(value) {
    return JSON.stringify(String(value));
  }

  function makeVisibilityChecker() {
    const cache = new Map();
    const check = (el) => {
      if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
      if (cache.has(el)) return cache.get(el);
      let visible = true;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') visible = false;
      if (visible) {
        const parent = el.parentElement;
        visible = parent ? check(parent) : true;
      }
      cache.set(el, visible);
      return visible;
    };
    return check;
  }

  function findOne(selector, scopeSelector) {
    let root = document;
    if (scopeSelector) {
      root = document.querySelector(scopeSelector);
      if (!root) throw fail(`scope not found: ${scopeSelector}`);
    }
    try {
      return root.querySelector(selector);
    } catch (e) {
      throw fail(`invalid selector "${selector}": ${e && e.message ? e.message : e}`);
    }
  }

  function findTarget(args) {
    const byText = args.byText || args.by_text;
    const { selector, scope } = args || {};
    if (selector) {
      const el = findOne(selector, scope);
      if (el) return el;
      if (!byText) throw fail(`element not found: ${selector}${scope ? ` within ${scope}` : ''}`);
    }
    if (byText) return findByExactText(byText, scope);
    throw fail('provide "selector" or "byText"');
  }

  function findByExactText(text, scopeSelector) {
    const root = scopeSelector ? findOne(scopeSelector) : document.body || document.documentElement;
    if (!root) throw fail('document has no searchable root yet');
    const wanted = normWs(text);
    if (!wanted) throw fail('byText must be non-empty');
    const vis = makeVisibilityChecker();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const value = normWs(node.nodeValue);
        if (!value) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent || SKIP_TAGS.has(parent.tagName) || !vis(parent)) return NodeFilter.FILTER_REJECT;
        return value === wanted ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    const hit = walker.nextNode();
    if (!hit) throw fail(`no visible element with exact text ${JSON.stringify(wanted)}`);
    return hit.parentElement;
  }

  function selectorMatchesUnique(selector, el) {
    try {
      const hits = document.querySelectorAll(selector);
      return hits.length === 1 && hits[0] === el;
    } catch {
      return false;
    }
  }

  function structuralSelector(el) {
    const segments = [];
    let node = el;
    while (node && node.nodeType === Node.ELEMENT_NODE && segments.length < 12) {
      const tag = node.tagName.toLowerCase();
      if (node.id) {
        const idSel = '#' + cssEscapeValue(node.id);
        if (selectorMatchesUnique(idSel, node)) {
          segments.unshift(tag + idSel);
          break;
        }
      }
      let index = 1;
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) index++;
      segments.unshift(`${tag}:nth-child(${index})`);
      node = node.parentElement;
    }
    return segments.join(' > ');
  }

  function buildSelector(el) {
    if (!(el instanceof Element)) return null;
    const tag = el.tagName.toLowerCase();

    if (el.id) {
      const sel = '#' + cssEscapeValue(el.id);
      if (selectorMatchesUnique(sel, el)) return sel;
    }
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-qa']) {
      const value = el.getAttribute(attr);
      if (value) {
        const sel = `${tag}[${attr}=${cssAttrValue(value)}]`;
        if (selectorMatchesUnique(sel, el)) return sel;
      }
    }
    const name = el.getAttribute('name');
    if (name) {
      const sel = `${tag}[name=${cssAttrValue(name)}]`;
      if (selectorMatchesUnique(sel, el)) return sel;
    }
    const classes = Array.from(el.classList).filter((c) => c && c.length <= 64 && !/^\d/.test(c));
    for (let take = 1; take <= Math.min(classes.length, 3); take++) {
      const combo = classes.slice(0, take).map(cssEscapeValue).join('.');
      const sel = combo ? `${tag}.${combo}` : tag;
      if (selectorMatchesUnique(sel, el)) return sel;
    }
    if (classes.length === 0 && selectorMatchesUnique(tag, el)) return tag;
    return structuralSelector(el);
  }

  function centerOf(el) {
    const rect = el.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  }

  async function extractVisibleText(args = {}) {
    const region = typeof args.region === 'string' && args.region ? args.region : null;
    const fallbackToBody = args.fallbackToBody !== false;
    const limit = Math.max(1, Math.floor(num(args.limit, 50000)));

    const harvest = (regionSelector) => {
      let root = document.body || document.documentElement;
      if (regionSelector) {
        const scoped = document.querySelector(regionSelector);
        if (!scoped) return '';
        root = scoped;
      }
      const vis = makeVisibilityChecker();
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          const raw = node.nodeValue;
          if (!raw || !raw.trim()) return NodeFilter.FILTER_REJECT;
          const parent = node.parentElement;
          if (!parent || SKIP_TAGS.has(parent.tagName) || !vis(parent)) return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      let text = '';
      let node;
      while ((node = walker.nextNode())) {
        text += (text ? ' ' : '') + normWs(node.nodeValue);
        if (text.length >= limit) break;
      }
      return text.slice(0, limit);
    };

    let usedFallback = false;
    let text = harvest(region);
    if ((!text || !text.trim()) && region && fallbackToBody) {
      usedFallback = true;
      text = harvest(null);
    }
    return { text, truncated: text.length >= limit, fallbackUsed: usedFallback };
  }

  function captchaElements() {
    const found = [];
    for (const [, selector] of CAPTCHA_CHECKS) {
      for (const el of document.querySelectorAll(selector)) found.push(el);
    }
    return found;
  }

  function detectCaptcha() {
    for (const [type, selector] of CAPTCHA_CHECKS) {
      if (document.querySelector(selector)) return { detected: true, type };
    }
    return { detected: false, type: null };
  }

  function waitForCaptchaSolved(args = {}) {
    const timeoutMs = Math.max(0, num(args.timeoutMs, 60000));
    const vis = makeVisibilityChecker();
    return new Promise((resolve) => {
      let settled = false;
      let pollTimer = 0;
      let timeoutTimer = 0;
      const finish = (solved) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        window.removeEventListener(CAPTCHA_SOLVED_EVENT, onFinish);
        document.removeEventListener(CAPTCHA_SOLVED_EVENT, onFinish);
        resolve({ solved });
      };
      const captchaGone = () => !captchaElements().some((el) => vis(el));
      const onFinish = () => finish(true);
      window.addEventListener(CAPTCHA_SOLVED_EVENT, onFinish);
      document.addEventListener(CAPTCHA_SOLVED_EVENT, onFinish);
      if (captchaGone()) return finish(true);
      pollTimer = setInterval(() => {
        if (captchaGone()) finish(true);
      }, 1000);
      timeoutTimer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function elementLabel(el) {
    let label = '';
    try {
      label = normWs(el.innerText || el.textContent || '');
    } catch {
      label = normWs(el.textContent || '');
    }
    if (!label && el instanceof HTMLInputElement) label = normWs(el.value || el.placeholder || '');
    return label.slice(0, 120);
  }

  function describeInteractive(el) {
    const tag = el.tagName.toLowerCase();
    const item = {
      tag,
      text: elementLabel(el),
      type: el.getAttribute('type') || '',
      selector: buildSelector(el),
      ariaLabel: normWs(el.getAttribute('aria-label') || '').slice(0, 120),
      role: el.getAttribute('role') || '',
    };
    if (tag === 'a') item.href = el.href || el.getAttribute('href') || '';
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      item.value = String(el.value || '').slice(0, 120);
    }
    return item;
  }

  async function listInteractive(args = {}) {
    const kind = args.kind || 'all';
    const baseSelector = KIND_SELECTORS[kind];
    if (!baseSelector) throw fail(`unknown kind "${kind}" (expected button|link|input|all)`);
    const limit = Math.max(1, Math.floor(num(args.limit, 50)));
    const needle = typeof args.contains === 'string' ? args.contains.trim().toLowerCase() : null;

    let root = document;
    if (args.scope) {
      root = document.querySelector(args.scope);
      if (!root) throw fail(`scope not found: ${args.scope}`);
    }

    const vis = makeVisibilityChecker();
    const seen = new Set();
    const elements = [];
    for (const el of root.querySelectorAll(baseSelector)) {
      if (elements.length >= limit) break;
      if (seen.has(el)) continue;
      seen.add(el);
      if (!vis(el)) continue;
      const item = describeInteractive(el);
      if (needle) {
        const haystack = [item.text, item.ariaLabel, item.value || ''].join('\n').toLowerCase();
        if (!haystack.includes(needle)) continue;
      }
      elements.push(item);
    }
    return { count: elements.length, elements };
  }

  function attributesOf(el) {
    const out = {};
    if (el.attributes) {
      for (const attr of el.attributes) out[attr.name] = attr.value;
    }
    return out;
  }

  function serializeElement(el, maxDepth, includeHtml, depth) {
    const info = {
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      className: typeof el.className === 'string' ? el.className : '',
      attributes: attributesOf(el),
      selector: buildSelector(el),
      childCount: el.childElementCount,
      children: [],
    };
    if (depth < maxDepth) {
      for (const child of el.children) {
        info.children.push(serializeElement(child, maxDepth, includeHtml, depth + 1));
      }
    } else if (el.childElementCount > 0) {
      info.childrenTruncated = true;
    }
    if (includeHtml && depth === 0) {
      info.outerHTML = el.outerHTML.slice(0, MAX_HTML_CHARS);
      if (el.outerHTML.length > MAX_HTML_CHARS) info.htmlTruncated = true;
    }
    return info;
  }

  async function inspectDom(args = {}) {
    const el = findTarget(args);
    const maxDepth = Math.max(0, Math.floor(num(args.max_depth, 2)));
    return serializeElement(el, maxDepth, !!args.include_html, 0);
  }

  function fireMouse(el, type, pt, opts) {
    const o = opts || {};
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      detail: o.detail || 0,
      screenX: pt.x,
      screenY: pt.y,
      clientX: pt.x,
      clientY: pt.y,
      button: o.button || 0,
      buttons: o.buttons || 0,
      relatedTarget: null,
    });
    event[MARK] = true;
    return el.dispatchEvent(event);
  }

  function firePointer(el, type, pt, button, buttons) {
    if (typeof PointerEvent !== 'function') return true;
    const event = new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      pointerId: 1,
      pointerType: 'mouse',
      isPrimary: true,
      screenX: pt.x,
      screenY: pt.y,
      clientX: pt.x,
      clientY: pt.y,
      button: button || 0,
      buttons: buttons || 0,
    });
    event[MARK] = true;
    return el.dispatchEvent(event);
  }

  async function clickElement(args = {}) {
    const el = findTarget(args);
    if (!(el instanceof Element)) throw fail('target is not an element');
    const doubleClick = !!args.doubleClick;
    const button = Math.floor(num(args.button, 0));
    const mask = BUTTON_MASKS[button] !== undefined ? BUTTON_MASKS[button] : 1;

    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {}

    const pt = centerOf(el);
    let interceptedBy = null;
    const atPoint = document.elementFromPoint(pt.x, pt.y);
    if (atPoint && atPoint !== el && !el.contains(atPoint) && !atPoint.contains(el)) {
      interceptedBy = buildSelector(atPoint);
    }

    const spiedTypes = ['mousedown', 'mouseup', 'click', 'dblclick'];
    const receipts = new Set();
    const spy = (event) => {
      if (event && event[MARK]) receipts.add(event.type);
    };
    for (const type of spiedTypes) document.addEventListener(type, spy, true);

    let finalDispatch = true;
    try {
      firePointer(el, 'pointerdown', pt, button, mask);
      fireMouse(el, 'mousedown', pt, { button, buttons: mask, detail: 1 });
      fireMouse(el, 'mouseup', pt, { button, buttons: 0, detail: 1 });
      if (button === 0) {
        finalDispatch = doubleClick
          ? fireMouse(el, 'dblclick', pt, { button: 0, buttons: 0, detail: 2 })
          : fireMouse(el, 'click', pt, { button: 0, buttons: 0, detail: 1 });
      } else {
        finalDispatch = fireMouse(el, 'auxclick', pt, { button, buttons: 0, detail: 0 });
        if (button === 2) fireMouse(el, 'contextmenu', pt, { button: 2, buttons: 0, detail: 0 });
      }
    } finally {
      for (const type of spiedTypes) document.removeEventListener(type, spy, true);
    }

    const expected = doubleClick ? 'dblclick' : 'click';
    const jsClicked = button === 0 ? receipts.has(expected) : receipts.size > 0;
    const result = { clicked: finalDispatch !== false, jsClicked, interceptedBy };
    if (!jsClicked) {
      result.hint = 'no page handler acknowledged the synthetic events; if the site requires isTrusted input, escalate via chrome.debugger + Input.dispatchMouseEvent';
    } else if (interceptedBy) {
      result.hint = `an overlay (${interceptedBy}) covers the click point; the click may not land as intended`;
    }
    return result;
  }

  function nativeValueSetter(el) {
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    if (!proto) return null;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    return desc && typeof desc.set === 'function' ? desc.set : null;
  }

  function dispatchInput(el, data) {
    let event;
    try {
      event = new InputEvent('input', { bubbles: true, data, inputType: 'insertText' });
    } catch {
      event = new Event('input', { bubbles: true });
    }
    el.dispatchEvent(event);
  }

  function keyInfoFor(token) {
    const name = String(token);
    if (KEY_CODES[name]) {
      const keyCode = KEY_CODES[name][0];
      const code = KEY_CODES[name][1];
      const charCode = name === ' ' ? 32 : name === 'Enter' ? 13 : 0;
      return { key: name, code, keyCode, charCode };
    }
    const fnMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(name);
    if (fnMatch) {
      const n = Number(fnMatch[1]);
      return { key: name, code: name, keyCode: 111 + n, charCode: 0 };
    }
    if (Array.from(name).length === 1) {
      const ch = name;
      const upper = ch.toUpperCase();
      const shifted = ch !== ch.toLowerCase();
      const code = /[a-z]/i.test(ch) ? 'Key' + upper : /[0-9]/.test(ch) ? 'Digit' + ch : '';
      return { key: ch, code, keyCode: upper.charCodeAt(0), charCode: ch.charCodeAt(0), shifted };
    }
    throw fail(`unsupported key: "${name}"`);
  }

  function canonicalKeyName(rawToken) {
    const token = String(rawToken).trim();
    if (!token) throw fail('empty key token');
    if (token.length === 1) return token;
    const alias = KEY_ALIASES[token.toLowerCase()];
    if (alias) return alias;
    if (/^F([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
    throw fail(`unsupported key token: "${token}"`);
  }

  function parseKeyGroups(input) {
    if (input == null || input === '') throw fail('"keys" is required (e.g. "Control+a" or "Enter, Tab")');
    return String(input)
      .split(',')
      .map((group) => group.trim())
      .filter(Boolean)
      .map((group) => {
        const parts = group.split('+');
        if (parts.length > 1 && parts[parts.length - 1] === '') {
          parts.pop();
          parts.push('+');
        }
        return parts.map(canonicalKeyName);
      });
  }

  function sendKeyEvent(type, target, info, mods) {
    const init = {
      key: info.key,
      code: info.code || '',
      location: 0,
      ctrlKey: !!mods.ctrl,
      altKey: !!mods.alt,
      shiftKey: !!mods.shift,
      metaKey: !!mods.meta,
      repeat: false,
      isComposing: false,
      charCode: type === 'keypress' ? info.charCode || 0 : 0,
      keyCode: info.keyCode || 0,
      bubbles: true,
      cancelable: true,
      composed: true,
    };
    let event;
    try {
      event = new KeyboardEvent(type, init);
    } catch {
      event = new Event(type, { bubbles: true, cancelable: true });
    }
    return target.dispatchEvent(event);
  }

  function typeCharacter(el, ch, applyChar) {
    const info = keyInfoFor(ch);
    const mods = { ctrl: false, alt: false, meta: false, shift: !!info.shifted };
    sendKeyEvent('keydown', el, info, mods);
    if ((info.charCode || 0) >= 32) sendKeyEvent('keypress', el, info, mods);
    applyChar(ch);
    dispatchInput(el, ch);
    sendKeyEvent('keyup', el, info, mods);
  }

  async function fillField(args = {}) {
    const el = findTarget(args);
    const text = args.text == null ? '' : String(args.text);
    const initialDelay = Math.max(0, num(args.delay, 0));
    const perCharDelay = Math.max(0, num(args.delayPerChar, 0));

    if (initialDelay) await sleep(initialDelay);

    if (el instanceof HTMLSelectElement) {
      const wanted = normWs(text).toLowerCase();
      const idx = Array.from(el.options).findIndex(
        (o) => o.value === text || normWs(o.textContent).toLowerCase() === wanted
      );
      if (idx < 0) throw fail(`no <option> matches ${JSON.stringify(text)}`);
      el.selectedIndex = idx;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, value: el.value };
    }

    const editableField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable;
    if (!editableField) throw fail(`unsupported field element: ${el.tagName.toLowerCase()}`);

    if (typeof el.focus === 'function') el.focus();

    const isContentEditable = el.isContentEditable && !(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement);

    if (isContentEditable) {
      const apply = (c) => { el.textContent = (el.textContent || '') + c; };
      if (perCharDelay > 0) {
        el.textContent = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        const chars = Array.from(text);
        for (let i = 0; i < chars.length; i++) {
          typeCharacter(el, chars[i], apply);
          if (i < chars.length - 1) await sleep(perCharDelay);
        }
      } else {
        el.textContent = text;
        dispatchInput(el, text);
      }
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true };
    }

    const setter = nativeValueSetter(el);
    if (!setter) throw fail('cannot access native value setter');

    if (perCharDelay > 0) {
      setter.call(el, '');
      el.dispatchEvent(new Event('input', { bubbles: true }));
      const chars = Array.from(text);
      for (let i = 0; i < chars.length; i++) {
        typeCharacter(el, chars[i], (c) => setter.call(el, el.value + c));
        if (i < chars.length - 1) await sleep(perCharDelay);
      }
    } else {
      setter.call(el, text);
      dispatchInput(el, text);
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: true };
  }

  async function focusElement(args = {}) {
    const el = findTarget(args);
    if (typeof el.focus !== 'function') throw fail(`element cannot be focused: ${el.tagName.toLowerCase()}`);
    let focused = false;
    try {
      el.focus();
    } catch {}
    focused = document.activeElement === el;
    if (!focused) {
      try {
        el.click();
      } catch {}
      try {
        el.focus();
      } catch {}
      focused = document.activeElement === el;
    }
    return { focused, tag: el.tagName.toLowerCase() };
  }

  async function pressKeys(args = {}) {
    const groups = parseKeyGroups(args.keys != null ? args.keys : args.key);
    const times = Math.min(500, Math.max(1, Math.floor(num(args.times, 1))));
    let pressed = 0;
    for (let round = 0; round < times; round++) {
      for (const combo of groups) {
        const target = document.activeElement || document.body;
        const mainToken = combo[combo.length - 1];
        const mods = { ctrl: false, alt: false, shift: false, meta: false };
        for (const token of combo.slice(0, -1)) {
          if (token === 'Control') mods.ctrl = true;
          else if (token === 'Alt') mods.alt = true;
          else if (token === 'Shift') mods.shift = true;
          else if (token === 'Meta') mods.meta = true;
        }
        const info = keyInfoFor(mainToken);
        if (info.shifted) mods.shift = true;
        sendKeyEvent('keydown', target, info, mods);
        const printable = (info.charCode || 0) >= 32 || info.key === 'Enter';
        if (printable) sendKeyEvent('keypress', target, info, mods);
        sendKeyEvent('keyup', target, info, mods);
        pressed++;
      }
    }
    return { pressed };
  }

  async function hoverElement(args = {}) {
    const el = findTarget(args);
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch {}
    const pt = centerOf(el);
    const sequence = [
      ['pointerover', true],
      ['mouseover', true],
      ['pointerenter', false],
      ['mouseenter', false],
      ['pointermove', true],
      ['mousemove', true],
    ];
    for (const entry of sequence) {
      const type = entry[0];
      const bubbles = entry[1];
      const Ctor = type.indexOf('pointer') === 0 && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      try {
        el.dispatchEvent(new Ctor(type, {
          bubbles,
          cancelable: true,
          composed: true,
          view: window,
          screenX: pt.x,
          screenY: pt.y,
          clientX: pt.x,
          clientY: pt.y,
          button: 0,
          buttons: 0,
          detail: 0,
        }));
      } catch {}
    }
    return { hovered: true };
  }

  async function videoControl(args = {}) {
    const video = document.querySelector('video');
    if (!video) return { success: false, error: 'no <video> element found', currentTime: 0, duration: null, paused: true };
    const action = String(args.action || '').toLowerCase();
    let success = true;
    let error = null;
    try {
      switch (action) {
        case 'play':
          await video.play();
          break;
        case 'pause':
          video.pause();
          break;
        case 'seek': {
          const t = Number(args.value);
          if (!Number.isFinite(t) || t < 0) throw fail('seek needs numeric "value" (seconds)');
          video.currentTime = Number.isFinite(video.duration) && t > video.duration ? video.duration : t;
          break;
        }
        case 'volume': {
          const v = Number(args.value);
          if (!Number.isFinite(v) || v < 0 || v > 1) throw fail('volume needs "value" between 0 and 1');
          video.muted = false;
          video.volume = v;
          break;
        }
        case 'mute':
          video.muted = true;
          break;
        case 'unmute':
          video.muted = false;
          break;
        case 'fullscreen':
          if (typeof video.requestFullscreen !== 'function') throw fail('fullscreen API unavailable');
          await video.requestFullscreen();
          break;
        default:
          throw fail(`unknown action "${action}" (play|pause|seek|volume|mute|unmute|fullscreen)`);
      }
    } catch (e) {
      success = false;
      error = e && e.message ? e.message : String(e);
    }
    const round2 = (n) => Math.round(n * 100) / 100;
    return {
      success,
      error,
      currentTime: round2(video.currentTime || 0),
      duration: Number.isFinite(video.duration) ? round2(video.duration) : null,
      paused: !!video.paused,
    };
  }

  function waitForSelector(args = {}) {
    const selector = args.selector;
    if (!selector) throw fail('"selector" is required');
    const timeoutMs = Math.max(0, num(args.timeoutMs, 30000));

    let present = false;
    try {
      present = !!document.querySelector(selector);
    } catch (e) {
      throw fail(`invalid selector "${selector}": ${e && e.message ? e.message : e}`);
    }
    if (present) return Promise.resolve({ found: true, selector });

    return new Promise((resolve) => {
      let settled = false;
      let observer = null;
      let pollTimer = 0;
      let timeoutTimer = 0;
      const finish = (found) => {
        if (settled) return;
        settled = true;
        if (observer) observer.disconnect();
        clearInterval(pollTimer);
        clearTimeout(timeoutTimer);
        resolve(found ? { found: true, selector } : { found: false });
      };
      const check = () => {
        try {
          if (document.querySelector(selector)) finish(true);
        } catch {
          finish(false);
        }
      };
      try {
        observer = new MutationObserver(check);
        observer.observe(document.documentElement || document, { childList: true, subtree: true, attributes: true });
      } catch {
        observer = null;
      }
      pollTimer = setInterval(check, 200);
      timeoutTimer = setTimeout(() => finish(false), timeoutMs);
    });
  }

  function measureRect(args = {}) {
    const el = findTarget(args);
    const rect = el.getBoundingClientRect();
    const round2 = (n) => Math.round(n * 100) / 100;
    return {
      x: round2(rect.x),
      y: round2(rect.y),
      width: round2(rect.width),
      height: round2(rect.height),
      top: round2(rect.top),
      left: round2(rect.left),
      scrollX: Math.round(window.scrollX || 0),
      scrollY: Math.round(window.scrollY || 0),
    };
  }

  function getState() {
    const captcha = detectCaptcha();
    return {
      url: location.href,
      title: document.title || '',
      readyState: document.readyState,
      hasCaptcha: captcha.detected,
      captchaType: captcha.type,
      videoPresent: !!document.querySelector('video'),
    };
  }

  const OPS = {
    extractVisibleText,
    detectCaptcha,
    waitForCaptchaSolved,
    listInteractive,
    inspectDom,
    clickElement,
    fillField,
    focusElement,
    pressKeys,
    hoverElement,
    videoControl,
    waitForSelector,
    measureRect,
    getState,
  };

  async function handleOp(op, args) {
    const fn = OPS[op];
    if (!fn) throw fail(`unknown op "${op}"`);
    return fn(args || {});
  }

  if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg && msg.op) {
        handleOp(msg.op, msg.args)
          .then((result) => sendResponse({ ok: true, result }))
          .catch((e) => sendResponse({ ok: false, error: { message: e && e.message ? e.message : String(e) } }));
        return true;
      }
      return undefined;
    });
  }
})();
