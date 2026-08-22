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
import { uuid } from "./lib/proto.js";
import * as bridge from "./bridge.js";

const PROTOCOL_VERSION = 1;
const HB_INTERVAL_MS = 10_000;
const HB_DEADLINE_MS = 30_000;
const HELLO_TIMEOUT_MS = 3_000;
const CLOSE_SUPERSEDED = 4002;
const CLOSE_HELLO_TIMEOUT = 4001;

const log = (...parts) => { try { console.log("[ws-server]", ...parts); } catch { /* noop */ } };

const sessions = new Set(); // every live connection, handshaked or not
let active = null;          // the handshaked socket currently wired into the bridge

/** Start the singleton WS server bound to 127.0.0.1. Returns the WebSocketServer. */
export function start(port = 9224) {
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  wss.on("connection", (ws, req) => {
    setupSession(ws, `${req.socket.remoteAddress}:${req.socket.remotePort}`);
    // Pre-hello sockets are NOT evicted here: only a validated handshake may
    // supersede the active client (evictActive), so port scans can't disrupt
    // a healthy extension link. Strays die on their own hello timer.
  });
  wss.on("error", (e) => log("server error:", e?.message || e));
  log(`listening on ws://127.0.0.1:${port}`);
  return wss;
}

function setupSession(ws, peer) {
  const session = {
    ws,
    peer,
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

  // Liveness: envelope ping every 10s, terminate after 30s of total silence.
  session.hbTimer = setInterval(() => {
    if (session.closed) return;
    if (Date.now() - session.lastSeen > HB_DEADLINE_MS) {
      log(`heartbeat timeout (${peer}) — terminating`);
      try { ws.terminate(); } catch { /* gone */ }
      return;
    }
    sendTo(ws, { v: PROTOCOL_VERSION, type: "ping", id: uuid(), ts: Date.now() });
  }, HB_INTERVAL_MS);

  ws.on("message", (data) => {
    session.lastSeen = Date.now();
    let env = null;
    try { env = JSON.parse(data.toString()); } catch { env = null; }
    if (!env || typeof env !== "object") {
      session.badFrames += 1;
      if (session.badFrames <= 5) log(`unparseable frame from ${peer}`);
      return;
    }
    if (!session.welcomed) {
      handleHello(session, env);
      return;
    }
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
    && env.extVersion.length > 0;
  if (!valid) {
    log(`bad handshake from ${session.peer}: ${JSON.stringify(env)?.slice(0, 160)}`);
    try { session.ws.close(CLOSE_HELLO_TIMEOUT, "bad-hello"); } catch { session.ws.terminate(); }
    return;
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
