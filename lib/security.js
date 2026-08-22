// Port from the existing server's security guards (index.js lines 71-160 and 197-228)

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const SECRET_KEY = process.env.COOKIE_ENCRYPTION_KEY || (() => {
  // Generate a key and warn (first run)
  console.warn("[security] No COOKIE_ENCRYPTION_KEY set. Using ephemeral key (cookies won't persist across restarts).");
  return randomBytes(32);
})();

export const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "data:", "blob:", "file:"]);

export const BLOCKED_HOSTS = new Set([
  "localhost", "127.0.0.1", "0.0.0.0", "[::1]",
  "169.254.169.254", // AWS metadata
  "metadata.google.internal", // GCP metadata
]);

// IPv4 private ranges
function ipv4ToInt(ip) {
  const parts = ip.split(".").map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inBlockedCidrs(ip) {
  const n = ipv4ToInt(ip);
  // 10.0.0.0/8
  if ((n >>> 24) === 10) return true;
  // 172.16.0.0/12
  if ((n >>> 20) === 0xAC1) return true;
  // 192.168.0.0/16
  if ((n >>> 16) === 0xC0A8) return true;
  // 169.254.0.0/16 (link-local)
  if ((n >>> 16) === 0xA9FE) return true;
  return false;
}

function isBlockedInternalUrl(hostname) {
  if (BLOCKED_HOSTS.has(hostname)) return true;
  // Check for decimal IPv4 obfuscation (e.g., https://2852039166)
  if (/^\d+$/.test(hostname)) {
    const n = parseInt(hostname, 10);
    if (n <= 0xFFFFFFFF) {
      const ip = [(n>>>24)&0xFF, (n>>>16)&0xFF, (n>>>8)&0xFF, n&0xFF].join(".");
      if (inBlockedCidrs(ip) || BLOCKED_HOSTS.has(ip)) return true;
    }
  }
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

// Cookie encryption (AES-256-GCM)
export function encryptCookies(cookies) {
  const iv = randomBytes(16);
  const key = typeof SECRET_KEY === "string" ? Buffer.from(SECRET_KEY, "hex") : SECRET_KEY;
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(cookies), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: iv.toString("hex"), data: encrypted.toString("hex"), tag: tag.toString("hex") };
}

export function decryptCookies(encrypted) {
  try {
    const key = typeof SECRET_KEY === "string" ? Buffer.from(SECRET_KEY, "hex") : SECRET_KEY;
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, "hex"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted.data, "hex")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch { return null; }
}
