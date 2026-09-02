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
  console.log("\n=== smoke ===");
  try { const r = parse(await callTool("health", {})); ok("health", !!r.json); } catch (e) { ok("health", false); }
  try { const r = parse(await callTool("connect_brave", {})); ok("connect_brave", !r.isError); } catch (e) { ok("connect_brave", false); }
  try { const r = parse(await callTool("navigate", { url: "https://example.com" })); ok("navigate example.com", !r.isError); } catch (e) { ok("navigate", false); }
  try { const r = parse(await callTool("get_page_info", {})); ok("get_page_info", r.text.includes("example.com") || !!r.json?.url); } catch (e) { ok("get_page_info", false); }
  try { const r = parse(await callTool("disconnect", {})); ok("disconnect", !r.isError); } catch (e) { ok("disconnect", false); }
  console.log(`\nTOTAL: ${passed + failed} PASSED: ${passed} FAILED: ${failed}\n`);
  server.kill(); process.exit(failed ? 1 : 0);
})().catch(e => { console.error(e); server.kill(); process.exit(1); });
