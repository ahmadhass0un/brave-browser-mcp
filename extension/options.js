'use strict';

const DEFAULTS = Object.freeze({
  wsUrl: 'ws://127.0.0.1:9224',
  pairingToken: '',
  preferNative: false,
});

const STATUS_LABELS = {
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  disconnected: 'Disconnected',
};

const $ = (id) => document.getElementById(id);
const els = {
  wsUrl: $('ws-url'),
  token: $('pairing-token'),
  preferNative: $('prefer-native'),
  dot: $('status-dot'),
  label: $('status-label'),
  reconnectBtn: $('reconnect-btn'),
  errorBox: $('error-box'),
  errorText: $('error-text'),
  saveNote: $('save-note'),
  browserInfo: $('browser-info'),
  extVersion: $('ext-version'),
};

let saveTimer = null;
let noteTimer = null;

/* ---------- settings ---------- */

async function loadSettings() {
  const stored = await chrome.storage.local.get(DEFAULTS);
  els.wsUrl.value = stored.wsUrl;
  els.token.value = stored.pairingToken;
  els.preferNative.checked = Boolean(stored.preferNative);
}

function saveSettings() {
  const wsUrl = els.wsUrl.value.trim() || DEFAULTS.wsUrl;
  const pairingToken = els.token.value.trim();
  chrome.storage.local.set({ wsUrl, pairingToken, preferNative: els.preferNative.checked }, () => {
    if (!chrome.runtime.lastError) flashSaved();
  });
}

function queueSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 350); // debounce; background redials via storage.onChanged
}

function flashSaved() {
  els.saveNote.textContent = 'Saved';
  els.saveNote.style.opacity = '1';
  clearTimeout(noteTimer);
  noteTimer = setTimeout(() => { els.saveNote.style.opacity = '0'; }, 1200);
}

/* ---------- status ---------- */

function renderStatus(status = 'disconnected', error = '', transport = '') {
  const state = STATUS_LABELS.hasOwnProperty(status) ? status : 'disconnected';
  els.dot.className = `dot ${state}`;
  els.label.textContent =
    STATUS_LABELS[state] + (state === 'connected' && transport === 'native' ? ' · native messaging' : '');
  if (error) {
    els.errorText.textContent = error;
    els.errorBox.hidden = false;
  } else {
    els.errorBox.hidden = true;
  }
}

function requestStatus() {
  try {
    chrome.runtime.sendMessage({ type: 'getStatus' }, (res) => {
      if (chrome.runtime.lastError) {
        renderStatus('disconnected', 'Background service worker did not respond: ' + chrome.runtime.lastError.message);
        return;
      }
      if (res && res.ok !== false) renderStatus(res.status, res.error, res.transport);
    });
  } catch (err) {
    renderStatus('disconnected', String(err));
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'statusChanged') {
    renderStatus(msg.status, msg.error, msg.transport);
  }
});

els.reconnectBtn.addEventListener('click', () => {
  els.reconnectBtn.disabled = true;
  els.label.textContent = 'Reconnecting…';
  try {
    chrome.runtime.sendMessage({ type: 'reconnect' }, () => void chrome.runtime.lastError);
  } catch (_) { /* background unavailable */ }
  setTimeout(() => { // re-enable regardless of reply
    els.reconnectBtn.disabled = false;
    requestStatus();
  }, 1500);
});

/* ---------- browser info ---------- */

const esc = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function detectBrowser() {
  const ua = navigator.userAgent;
  let name = 'Chromium';
  if (/Edg\//.test(ua)) name = 'Microsoft Edge';
  else if (/OPR\//.test(ua)) name = 'Opera';
  else if (navigator.brave && navigator.brave.isBrave) name = 'Brave';
  else if (/Chrome\//.test(ua)) name = 'Chrome';
  const version = (ua.match(/(?:Chrome|Edg|OPR)\/([\d.]+)/) || [])[1] || 'unknown';
  return { name, version };
}

function renderBrowserInfo() {
  const { name, version } = detectBrowser();
  const platform = navigator.userAgentData?.platform || navigator.platform || 'unknown';
  const rows = [
    ['Browser', `${name} ${version.split('.')[0]}`],
    ['Full version', version],
    ['Extension', `Browser Navigator v${chrome.runtime.getManifest().version}`],
    ['Platform', platform],
    ['Languages', navigator.languages.join(', ')],
  ];
  els.browserInfo.innerHTML = rows
    .map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(String(v))}</dd>`)
    .join('');
}

/* ---------- init & storage sync ---------- */

(async function init() {
  els.extVersion.textContent = chrome.runtime.getManifest().version;
  await loadSettings();
  requestStatus();
  renderBrowserInfo();

  els.wsUrl.addEventListener('input', queueSave);
  els.wsUrl.addEventListener('change', saveSettings);
  els.token.addEventListener('input', queueSave);
  els.token.addEventListener('change', saveSettings);
  els.preferNative.addEventListener('change', saveSettings);

  // Keep UI in sync if values are normalized elsewhere.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    for (const key of ['wsUrl', 'pairingToken', 'preferNative']) {
      if (!(key in changes)) continue;
      clearTimeout(saveTimer); // avoid echo loop with our own pending save
      if (key === 'wsUrl' && changes.wsUrl.newValue !== els.wsUrl.value) {
        els.wsUrl.value = changes.wsUrl.newValue ?? DEFAULTS.wsUrl;
      } else if (key === 'pairingToken' && changes.pairingToken.newValue !== els.token.value) {
        els.token.value = changes.pairingToken.newValue ?? '';
      } else if (key === 'preferNative' && changes.preferNative.newValue !== els.preferNative.checked) {
        els.preferNative.checked = Boolean(changes.preferNative.newValue);
      }
    }
  });
})();
