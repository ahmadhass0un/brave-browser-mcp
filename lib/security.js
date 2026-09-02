// Port from the existing server's security guards (index.js lines 71-160 and 197-228)

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const SECRET_KEY = (() => {
  const envKey = process.env.COOKIE_ENCRYPTION_KEY;
  if (envKey !== undefined) {
    const v = String(envKey).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(v)) {
      throw new Error("[security] COOKIE_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Got length " + v.length);
    }
    return v;
  }
  // Generate a key and warn (first run)
  console.warn("[security] No COOKIE_ENCRYPTION_KEY set. Using ephemeral key (cookies won't persist across restarts).");
  return randomBytes(32);
})();

export const ALLOWED_URL_SCHEMES = new Set(["http:", "https:"]);
export const ALLOWED_NAV_SCHEMES = new Set(["http:", "https:"]);
export const ALLOWED_FETCH_SCHEMES = new Set(["http:", "https:"]);

export const BLOCKED_HOSTS = new Set([
  "localhost", "localhost.localdomain", "localhost4", "localhost6",
  "127.0.0.1", "0.0.0.0", "::", "::1", "[::1]",
  "169.254.169.254", "100.100.100.200",
  "metadata", "metadata.google.internal", "instance-data", "instance-data.ec2.internal",
]);

// IPv4 private ranges — synced with extension/background.js BLOCKED_CIDRS
const BLOCKED_CIDRS = [
  [0x00000000, 8],   // 0.0.0.0/8
  [0x0a000000, 8],   // 10/8
  [0x64400000, 10],  // 100.64/10 CGNAT
  [0x64646400, 24],  // 100.100.100/24 Alibaba metadata
  [0x7f000000, 8],   // 127/8 loopback
  [0xa9fe0000, 16],  // 169.254/16 link-local
  [0xac100000, 12],  // 172.16/12
  [0xc0a80000, 16],  // 192.168/16
];

function normalizeIpOctet(p) {
  p = String(p).trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(p)) { const v = parseInt(p, 16); return v >= 0 && v <= 255 ? v : null; }
  if (/^0[0-7]+$/.test(p) && p.length > 1) { const v = parseInt(p, 8); return v >= 0 && v <= 255 ? v : null; }
  if (!/^\d{1,3}$/.test(p)) return null;
  const v = parseInt(p, 10);
  return v <= 255 ? v : null;
}
function ipv4ToInt(ip) {
  const parts = String(ip).split(".");
  if (parts.length !== 4) {
    // handle single 32-bit decimal/hex like 0x7f000001 or 2130706433
    const s = String(ip).trim().toLowerCase();
    if (/^0x[0-9a-f]+$/.test(s)) {
      const n = parseInt(s, 16);
      if (n >= 0 && n <= 0xFFFFFFFF) return n >>> 0;
    }
    if (/^\d{1,10}$/.test(s)) {
      const n = parseInt(s, 10);
      if (n >= 0 && n <= 0xFFFFFFFF) return n >>> 0;
    }
    return null;
  }
  let n = 0;
  for (const p of parts) {
    const v = normalizeIpOctet(p);
    if (v === null) return null;
    n = (((n << 8) >>> 0) | v) >>> 0;
  }
  return n >>> 0;
}

function inBlockedCidrs(ip) {
  const n = typeof ip === "string" ? ipv4ToInt(ip) : ip;
  if (n === null || n === undefined) return false;
  for (const [base, bits] of BLOCKED_CIDRS) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((n & mask) === (base & mask)) return true;
  }
  return false;
}

function isBlockedInternalUrl(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) return true;
  if (host.startsWith("fe80:")) return true;
  if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
  // Check for decimal IPv4 obfuscation (e.g., https://2852039166)
  if (/^\d{1,10}$/.test(host)) {
    const n = parseInt(host, 10);
    if (Number.isSafeInteger(n) && n <= 0xFFFFFFFF) {
      const ip = [(n>>>24)&0xFF, (n>>>16)&0xFF, (n>>>8)&0xFF, n&0xFF].join(".");
      const dottedInt = ipv4ToInt(ip);
      if (dottedInt !== null && (inBlockedCidrs(dottedInt) || BLOCKED_HOSTS.has(ip))) return true;
    }
  }
  const ip = ipv4ToInt(host);
  if (ip !== null && inBlockedCidrs(ip)) return true;
  return false;
}

export function assertSafeUrl(urlString) {
  let parsed;
  try { parsed = new URL(urlString); } catch { throw new Error(`Invalid URL: ${urlString}`); }
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol)) {
    throw new Error(`Blocked URL scheme: ${parsed.protocol} (allowed: ${[...ALLOWED_URL_SCHEMES].join(", ")})`);
  }
  if (isBlockedInternalUrl(parsed.hostname)) {
    throw new Error(`Blocked internal URL: ${parsed.hostname}`);
  }
  return parsed;
}

const SECRET_KEY_BUF = typeof SECRET_KEY === "string" ? Buffer.from(SECRET_KEY, "hex") : SECRET_KEY;
// Cookie encryption (AES-256-GCM)
export function encryptCookies(cookies) {
  const iv = randomBytes(16);
  const cipher = createCipheriv(ALGORITHM, SECRET_KEY_BUF, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cookies), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), data: encrypted.toString("hex"), tag: tag.toString("hex") };
}

export function decryptCookies(encrypted) {
  try {
    const decipher = createDecipheriv(ALGORITHM, SECRET_KEY_BUF, Buffer.from(encrypted.iv, "hex"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted.data, "hex")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch (e) { try { console.warn("[security] decrypt failed:", e?.message || e); } catch {} return null; }
}
