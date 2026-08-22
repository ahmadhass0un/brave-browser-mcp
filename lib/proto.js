/**
 * browser-navigator — lib/proto.js
 * Envelope codec and shared error vocabulary (mirrors extension/background.js §4).
 *
 * Envelope types (JSON text frames, v:1):
 *   req   { v:1, type:"req",  id:uuid, ts, op:string, args:{} }
 *   res   { v:1, type:"res",  id:string, ok:true,  result:{} }
 *         { v:1, type:"res",  id:string, ok:false, error:{code,message,retriable,data?} }
 *   evt   { v:1, type:"evt",  id:uuid, event:string, ts, data:{} }
 *   ping  { v:1, type:"ping", id?, ts? }  → answered with pong echoing the id
 *   pong  { v:1, type:"pong", id? }
 */

import { randomUUID } from "node:crypto";

export const PROTOCOL_VERSION = 1;

export const ERROR_CODES = Object.freeze({
  BAD_REQUEST: "BAD_REQUEST",
  UNSUPPORTED_OP: "UNSUPPORTED_OP",
  NOT_CONNECTED: "NOT_CONNECTED",
  RESTRICTED_TARGET: "RESTRICTED_TARGET",
  DEBUGGER_DETACHED: "DEBUGGER_DETACHED",
  NAV_FAILED: "NAV_FAILED",
  NAV_TIMEOUT: "NAV_TIMEOUT",
  ELEMENT_NOT_FOUND: "ELEMENT_NOT_FOUND",
  CLICK_BLOCKED: "CLICK_BLOCKED",
  INJECTED_NO_SCRIPT: "INJECTED_NO_SCRIPT",
  INJECTED_TIMEOUT: "INJECTED_TIMEOUT",
  CAPTCHA_WAIT_TIMEOUT: "CAPTCHA_WAIT_TIMEOUT",
  TIMEOUT: "TIMEOUT",
  TRANSPORT_LOST: "TRANSPORT_LOST",
  INTERNAL: "INTERNAL",
});

/** Typed error carried across call() boundaries; serializes into res.error. */
export class RpcError extends Error {
  constructor(code, message, retriable = false, data = undefined) {
    super(message);
    this.name = "RpcError";
    this.code = code || ERROR_CODES.INTERNAL;
    this.retriable = !!retriable;
    if (data !== undefined) this.data = data;
  }
}

export const rpcErr = (code, message, retriable = false, data = undefined) =>
  new RpcError(code, message, retriable, data);

export const uuid = () => randomUUID();

export const makeReq = (op, args = {}) => ({
  v: PROTOCOL_VERSION, type: "req", id: uuid(), ts: Date.now(), op, args: args ?? {},
});

export const makeRes = (id, result) => ({
  v: PROTOCOL_VERSION, type: "res", id, ts: Date.now(), ok: true, result: result ?? {},
});

export const makeErr = (id, code, message, retriable = false, data = undefined) => {
  const error = {
    code: code || ERROR_CODES.INTERNAL,
    message: String(message || "error"),
    retriable: !!retriable,
  };
  if (data !== undefined) error.data = data;
  return { v: PROTOCOL_VERSION, type: "res", id, ts: Date.now(), ok: false, error };
};

export const makeEvt = (event, data = {}) => ({
  v: PROTOCOL_VERSION, type: "evt", id: uuid(), event, ts: Date.now(), data: data ?? {},
});

const REQUIRED_FIELDS = {
  req: ["id", "op"],
  res: ["id", "ok"],
  evt: ["id", "event"],
  hello: ["extVersion"],
  welcome: ["sessionId"],
};

/** Structural check: v===1, recognized type, and the fields that type requires. */
export function validateEnvelope(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  if (obj.v !== PROTOCOL_VERSION) return false;
  const t = obj.type;
  if (typeof t !== "string") return false;
  if (t === "ping" || t === "pong" || t === "bye") return true;
  const required = REQUIRED_FIELDS[t];
  if (!required) return false;
  return required.every((k) => obj[k] !== undefined && obj[k] !== null && obj[k] !== "");
}
