const { spawn } = require("child_process");
const path = require("path");
const SERVER = path.join(__dirname, "index.js");
const TIMEOUT = 15000;
let passed = 0, failed = 0, server, rid = 0;
const pending = new Map();
const ok = (n, c) => { console.log(c ? `  ✓ ${n}` : `  ✗ ${n}`); c ? passed++ : failed++; };
const send = (method, params) => new Promise((res, rej) => {
  const id = ++rid; const t = setTimeout(() => { pending.delete(id); rej(new Error(method + " timeout")); }, TIMEOUT);
  pending.set(id, { resolve: res, reject: rej, timeout: t });
  server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
});
const callTool = (name, args) => send("tools/call", { name, arguments: args });
const parse = r => {
  const text = r?.content?.[0]?.text || "";
  let json = null; try { json = JSON.parse(text); } catch {}
  return { text, json, isError: !!r?.isError };
};
server = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
server.stdout.on("data", d => { for (const line of d.toString().split("\n")) { if (!line.trim()) continue; try { const m = JSON.parse(line); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); clearTimeout(p.timeout); pending.delete(m.id); p.resolve(m.result); } } catch {} } });
server.stderr.on("data", () => {});
(async () => {
  console.log("\n=== smoke (isolated tab) ===");
  let smokeTabId = null;
  try { const r = parse(await callTool("health", {})); ok("health", !!r.json); } catch (e) { ok("health", false); }
  // retry connect_brave (extension probes /health every 2s when server was down)
  let connected = false;
  for (let i=0;i<6;i++) {
    try { const r = parse(await callTool("connect_brave", {})); if (!r.isError) { ok("connect_brave", true); connected=true; break; } if (i===5) ok("connect_brave", false); else await new Promise(r=>setTimeout(r,1500)); } catch (e) { if (i===5) ok("connect_brave", false); else await new Promise(r=>setTimeout(r,1500)); }
  }
  if (!connected) { console.log(`\nTOTAL: ${passed + failed} PASSED: ${passed} FAILED: ${failed}\n`); server.kill(); process.exit(1); }
  // Isolation: open a fresh background tab for smoke tests so we don't hijack the user's active tab
  try {
    const r = parse(await callTool("tabs", { action: "open", url: "https://example.com" }));
    smokeTabId = r.json?.tab?.id || r.json?.id || null;
    ok("tabs open isolated smoke tab", !r.isError && !!smokeTabId);
  } catch (e) { ok("tabs open isolated smoke tab", false); }
  try {
    const args = smokeTabId ? { url: "https://example.com", tab_id: smokeTabId } : { url: "https://example.com" };
    const r = parse(await callTool("navigate", args)); ok("navigate example.com (isolated)", !r.isError);
  } catch (e) { ok("navigate", false); }
  try {
    const args = smokeTabId ? { tab_id: smokeTabId } : {};
    const r = parse(await callTool("get_page_info", args)); ok("get_page_info (isolated)", r.text.includes("example.com") || !!r.json?.url);
  } catch (e) { ok("get_page_info", false); }
  // cleanup isolated tab
  if (smokeTabId) { try { await callTool("tabs", { action: "close", tab_id: smokeTabId }); } catch {} }
  try { const r = parse(await callTool("disconnect", {})); ok("disconnect", !r.isError); } catch (e) { ok("disconnect", false); }
  console.log(`\nTOTAL: ${passed + failed} PASSED: ${passed} FAILED: ${failed}\n`);
  server.kill(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
