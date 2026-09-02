/**
 * browser-navigator — ws-server.js
 * WebSocket listener the extension dials into (ws://127.0.0.1:9224).
 *
 * Session rules:
 *   • Single client — a newer connection evicts the previous one (close 4002)
 *   • Handshake — client must send {v:1,type:"hello",extVersion} within 3s (else 4001)
 *   • Welcome — server replies {v:1,type:"welcome",sessionId,hbMs:10000}, wires
 *     the socket into the bridge
 *   • Heartbeat — server pings every 10s; a link silent for 30s is terminated
 */

import { WebSocketServer, WebSocket } from "ws";
import { timingSafeEqual } from "node:crypto";
import { uuid } from "./lib/proto.js";
import * as bridge from "./bridge.js";

const PROTOCOL_VERSION = 1;
const HB_INTERVAL_MS = 15_000;
const HB_DEADLINE_MS = 30_000;
const HELLO_TIMEOUT_MS = 3_000;
const CLOSE_SUPERSEDED = 4002;
const CLOSE_HELLO_TIMEOUT = 4001;

const log = (...parts) => { try { console.error("[ws-server]", ...parts); } catch { /* noop */ } };

const sessions = new Set(); // every live connection, handshaked or not
let active = null;          // the handshaked socket currently wired into the bridge
const SESSIONS_MAX = 100; // §F.1 cap sessions 100 (was unbounded 10MB at 1000 scans)
const ipHits = new Map(); // §F.1 per-IP rate limit 10/s (was no limit, 15ms parse/MiB flood)
// GC stale IP entries every 30s
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of ipHits) {
    const f = v.filter(t => now - t < 1000);
    if (f.length === 0 || now - (f[f.length - 1] || 0) > 60_000) ipHits.delete(k);
    else if (f.length !== v.length) ipHits.set(k, f);
  }
  if (ipHits.size > 1000) { // LRU evict oldest if still too big
    const toDel = ipHits.size - 1000;
    let i = 0;
    for (const k of ipHits.keys()) { if (i++ >= toDel) break; ipHits.delete(k); }
  }
}, 30_000).unref?.();

/** Start the singleton WS server bound to 127.0.0.1. Returns the WebSocketServer. */
export function start(port = 9224) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port, maxPayload: 1 << 20 });
  wss.on("connection", (ws, req) => {
    const ip = req.socket.remoteAddress || "unknown";
    const now = Date.now();
    const arr = ipHits.get(ip) || [];
    const recent = arr.filter(t => now - t < 1000);
    recent.push(now);
    ipHits.set(ip, recent);
    if (recent.length > 10) {
      log(`rate limit ${ip} (${recent.length}/s) — dropping`);
      try { ws.close(1013, "rate limited"); } catch { ws.terminate(); }
      return;
    }
    if (sessions.size >= SESSIONS_MAX) {
      log(`sessions cap ${SESSIONS_MAX} reached — dropping ${ip}`);
      try { ws.close(1013, "server busy"); } catch { ws.terminate(); }
      return;
    }
    const origin = req.headers?.origin || "";
    setupSession(ws, `${req.socket.remoteAddress}:${req.socket.remotePort}`, origin);
    // Pre-hello sockets are NOT evicted here: only a validated handshake may
    // supersede the active client (evictActive), so port scans can't disrupt
    // a healthy extension link. Strays die on their own hello timer.
  });
  wss.on("error", (e) => log("server error:", e?.message || e));
  log(`listening on ws://127.0.0.1:${port}`);
  return wss;
}

function setupSession(ws, peer, origin = "") {
  const session = {
    ws,
    peer,
    origin,
    welcomed: false,
    lastSeen: Date.now(),
    badFrames: 0,
    helloTimer: null,
    hbTimer: null,
    closed: false,
  };
  sessions.add(session);

  const cleanup = () => {
    if (session.closed) return;
    session.closed = true;
    clearTimeout(session.helloTimer);
    clearInterval(session.hbTimer);
    sessions.delete(session);
    if (active === ws) {
      active = null;
      bridge.setWs(null); // only clears the pointer if the bridge still holds this socket
      log(`session closed (${peer})`);
    }
  };

  // Handshake budget: hello or goodbye.
  session.helloTimer = setTimeout(() => {
    if (!session.welcomed && !session.closed) {
      log(`hello timeout (${peer})`);
      try { ws.close(CLOSE_HELLO_TIMEOUT, "hello-timeout"); } catch { ws.terminate(); }
    }
  }, HELLO_TIMEOUT_MS);

  // Liveness: envelope ping every 15s, terminate after 30s of total silence.
  session.hbTimer = setInterval(() => {
    if (session.closed) return;
    if (!session.welcomed) return; // don't ping unauthenticated sessions - helloTimer bounds 3s
    if (Date.now() - session.lastSeen > HB_DEADLINE_MS) {
      log(`heartbeat timeout (${peer}) — terminating`);
      try { ws.terminate(); } catch { /* gone */ }
      return;
    }
    try { if (typeof ws.ping === "function") ws.ping(); } catch { /* ignore */ }
    // single ws-level ping is enough; app-level ping is redundant but keep for compat - send only to welcomed
    sendTo(ws, { v: PROTOCOL_VERSION, type: "ping", id: uuid(), ts: Date.now() });
  }, HB_INTERVAL_MS);

  ws.on("message", (data) => {
    const len = data.length ?? data.byteLength ?? Buffer.byteLength(String(data));
    if (len > (1 << 20)) {
      session.badFrames += 1;
      log(`oversize frame from ${peer} (${len} bytes)`);
      if (session.badFrames > 10) try { ws.close(1009, "message too big"); } catch { ws.terminate(); }
      return;
    }
    let env = null;
    try { env = JSON.parse(data.toString()); } catch { env = null; }
    if (!env || typeof env !== "object") {
      session.badFrames += 1;
      if (session.badFrames <= 5) log(`unparseable frame from ${peer}`);
      if (session.badFrames > 10) {
        log(`too many bad frames from ${peer} — disconnecting`);
        try { ws.close(1003, "too many bad frames"); } catch { ws.terminate(); }
      }
      return;
    }
    if (!session.welcomed) {
      handleHello(session, env);
      return;
    }
    session.lastSeen = Date.now();
    routeFrame(session, env);
  });

  ws.on("pong", () => { session.lastSeen = Date.now(); }); // ws-level pongs also count
  ws.on("close", cleanup);
  ws.on("error", () => {
    try { ws.terminate(); } catch { /* gone */ }
    cleanup();
  });
}

function handleHello(session, env) {
  const valid = env.type === "hello"
    && env.v === PROTOCOL_VERSION
    && typeof env.extVersion === "string"
    && env.extVersion.length > 0
    && env.extVersion.length < 200;
  if (!valid) {
    clearTimeout(session.helloTimer);
    log(`bad handshake from ${session.peer}: ${String(JSON.stringify(env)).slice(0, 160)}`);
    try { session.ws.close(4401, "bad-hello"); } catch { session.ws.terminate(); }
    return;
  }
  // Token auth — if BROWSER_NAV_TOKEN is set, hello must carry matching token (constant-time)
  const expectedToken = process.env.BROWSER_NAV_TOKEN;
  if (expectedToken) {
    const a = Buffer.from(String(env.token || ""));
    const b = Buffer.from(expectedToken);
    let ok = a.length === b.length;
    if (ok) { try { ok = timingSafeEqual(a, b); } catch { ok = String(env.token) === expectedToken; } }
    if (!ok) {
      log(`auth failure from ${session.peer} (bad token)`);
      try { session.ws.close(4401, "unauthorized"); } catch { session.ws.terminate(); }
      return;
    }
  }
  // Origin check — block non-extension origins; allow empty (node tests) but log
  const isExtension = /^chrome-extension:\/\//.test(session.origin || "");
  const isLocalhost = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(session.origin || "");
  if (session.origin && !isExtension && !isLocalhost) {
    log(`unexpected origin ${session.origin} from ${session.peer}`);
    if (!expectedToken) {
      try { session.ws.close(4401, "bad origin"); } catch { session.ws.terminate(); }
      return;
    }
  } else if (!session.origin) {
    // node ws clients have no Origin — allow for localhost tests, but log
    // (extension always sends chrome-extension://)
  }

  session.welcomed = true;
  clearTimeout(session.helloTimer);
  evictActive(session.ws);

  active = session.ws;
  bridge.setWs(active);

  const sessionId = uuid();
  sendTo(session.ws, {
    v: PROTOCOL_VERSION,
    type: "welcome",
    sessionId,
    hbMs: HB_INTERVAL_MS,
    ts: Date.now(),
  });
  log(`welcome ${sessionId} (ext v${env.extVersion}, ${session.peer})`);
}

function evictActive(incoming) {
  if (!active || active === incoming) return;
  try { active.close(CLOSE_SUPERSEDED, "superseded"); } catch { /* gone */ }
}

function routeFrame(session, env) {
  switch (env.type) {
    case "ping": // extension-initiated heartbeat → echo back
      sendTo(session.ws, { v: PROTOCOL_VERSION, type: "pong", id: env.id });
      return;
    case "pong":
      return; // liveness already recorded via lastSeen
    case "bye":
      try { session.ws.close(1000, "bye"); } catch { /* gone */ }
      return;
    default:
      // res → pending call resolution; evt → bridge subscribers
      bridge.onTransportMessage(env);
  }
}

function sendTo(ws, frame) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
  } catch { /* close handler sorts it out */ }
}

/** Close the listener and every live session (process shutdown path). */
export function stop(wss) {
  for (const s of [...sessions]) {
    try { s.ws.close(1001, "server-shutdown"); } catch { /* gone */ }
  }
  if (wss) {
    try { wss.close(); } catch { /* noop */ }
  }
}
