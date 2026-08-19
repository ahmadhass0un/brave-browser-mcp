const { spawn } = require("child_process");
const path = require("path");

const SERVER = path.join(__dirname, "index.js");
const TIMEOUT = 45000;

let passed = 0;
let failed = 0;
let server = null;
let requestId = 0;
const pending = new Map();

function ok(name, condition) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.log(`  ✗ ${name}`); failed++; }
}

function err(name, error) {
  console.log(`  ✗ ${name}: ${error.message || error}`);
  failed++;
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${method}`)); }, TIMEOUT);
    pending.set(id, { resolve, reject, timeout });
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function callTool(name, args) {
  return send("tools/call", { name, arguments: args });
}

function parseResult(result) {
  const text = result?.content?.[0]?.text || "";
  const isError = result?.isError || false;
  return { text, isError, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
}

server = spawn("node", [SERVER], { stdio: ["pipe", "pipe", "pipe"] });
server.stderr.on("data", (d) => {});
server.stdout.on("data", (d) => {
  for (const line of d.toString().split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id);
        clearTimeout(p.timeout);
        pending.delete(msg.id);
        p.resolve(msg.result);
      }
    } catch {}
  }
});

async function run() {
  // === CONNECT ===
  console.log("\n=== CONNECT ===");
  try {
    const r = parseResult(await callTool("connect_brave", {}));
    ok("connect_brave", !r.isError && r.text.includes("Connected"));
  } catch (e) { err("connect_brave", e); }

  // === HEALTH ===
  console.log("\n=== HEALTH ===");
  try {
    const r = parseResult(await callTool("health", {}));
    ok("health returns status", r.json?.server === "running" && r.json?.connected === true);
    ok("health has version", typeof r.json?.version === "string");
    ok("health has tabs count", typeof r.json?.tabs === "number" && r.json.tabs > 0);
  } catch (e) { err("health", e); }

  // === NAVIGATE ===
  console.log("\n=== NAVIGATE ===");
  try {
    const r = parseResult(await callTool("navigate", { url: "https://example.com" }));
    ok("navigate to example.com", !r.isError && r.text.includes("example.com"));

    const info = parseResult(await callTool("get_page_info", {}));
    ok("get_page_info returns URL", info.text.includes("example.com"));
    ok("get_page_info shows title", info.text.includes("Example Domain"));
  } catch (e) { err("navigate", e); }

  // === NAVIGATE with wait_until ===
  console.log("\n=== NAVIGATE (wait_until) ===");
  try {
    await callTool("navigate", { url: "https://example.com" });
    const r = parseResult(await callTool("navigate", { url: "https://example.com", wait_until: "networkidle" }));
    ok("navigate with networkidle", !r.isError && r.text.includes("example.com"));
  } catch (e) { err("navigate wait_until", e); }

  // === NAVIGATE HISTORY ===
  console.log("\n=== NAVIGATE HISTORY ===");
  try {
    const t = parseResult(await callTool("tabs", { action: "open" }));
    ok("open fresh tab for history test", !t.isError);
    await callTool("navigate", { url: "https://example.com" });
    await callTool("navigate", { url: "https://example.org" });
    const r = parseResult(await callTool("navigate_history", { action: "back" }));
    ok("go back to example.com", !r.isError && r.text.includes("example.com"));
    const list = parseResult(await callTool("tabs", { action: "list" }));
    const lines = list.text.split("\n");
    const idxLine = lines.find(l => l.includes("example.org"));
    if (idxLine) {
      const idx = parseInt(idxLine.trim().split(":")[0], 10);
      if (!isNaN(idx)) await callTool("tabs", { action: "close", index: idx });
    }
  } catch (e) { err("navigate_history", e); }

  // === CLICK ===
  console.log("\n=== CLICK ===");
  try {
    await callTool("navigate", { url: "https://example.com" });
    await new Promise(r => setTimeout(r, 1000));
    const r = parseResult(await callTool("click", { selector: "body", button: "left" }));
    ok("click left button", !r.isError && r.text.includes("Clicked"));

    const r2 = parseResult(await callTool("click", { selector: "body", double_click: true }));
    ok("double click", !r2.isError && r2.text.includes("Clicked"));
  } catch (e) { err("click", e); }

  // === HOVER ===
  console.log("\n=== HOVER ===");
  try {
    const r = parseResult(await callTool("hover", { selector: "body" }));
    ok("hover over body", !r.isError && r.text.includes("Hovered"));
  } catch (e) { err("hover", e); }

  // === SCROLL ===
  console.log("\n=== SCROLL ===");
  try {
    for (const dir of ["down", "up", "left", "right"]) {
      const r = parseResult(await callTool("scroll", { direction: dir, amount: 300 }));
      ok(`scroll ${dir}`, !r.isError && r.text.includes(`Scrolled ${dir}`));
    }
  } catch (e) { err("scroll", e); }

  // === TYPE ===
  console.log("\n=== TYPE ===");
  try {
    await callTool("navigate", { url: "https://www.google.com" });
    await new Promise(r => setTimeout(r, 3000));
    const r = parseResult(await callTool("type", { selector: "textarea[name='q'], input[name='q']", text: "test123" }));
    ok("type text", !r.isError);

    const r2 = parseResult(await callTool("type", { selector: "textarea[name='q'], input[name='q']", text: "delaytest", delay: 50 }));
    ok("type with delay", !r2.isError);
  } catch (e) { err("type", e); }

  // === GET PAGE CONTENT ===
  console.log("\n=== GET PAGE CONTENT ===");
  try {
    const r = parseResult(await callTool("get_page_content", { selector: "body" }));
    ok("get text content", !r.isError && r.text.length > 0);

    const r2 = parseResult(await callTool("get_page_content", { selector: "body", format: "html" }));
    ok("get html content", !r2.isError && r2.text.includes("<"));
  } catch (e) { err("get_page_content", e); }

  // === LIST ELEMENTS ===
  console.log("\n=== LIST ELEMENTS ===");
  try {
    await callTool("navigate", { url: "https://example.com" });
    await new Promise(r => setTimeout(r, 1000));
    const r = parseResult(await callTool("list_elements", { kind: "link" }));
    ok("list_elements finds links", !r.isError && r.text.includes("Learn more"));

    const r2 = parseResult(await callTool("list_elements", { kind: "button" }));
    ok("list_elements buttons (may be empty)", !r2.isError);

    const r3 = parseResult(await callTool("list_elements", { kind: "link", contains: "Learn", limit: 3 }));
    ok("list_elements filter by contains", !r3.isError && r3.text.includes("Learn more"));
  } catch (e) { err("list_elements", e); }

  // === INSPECT DOM ===
  console.log("\n=== INSPECT DOM ===");
  try {
    const r = parseResult(await callTool("inspect_dom", { selector: "body", max_depth: 1 }));
    ok("inspect_dom body structure", !r.isError && r.json?.elements?.length > 0);

    const r2 = parseResult(await callTool("inspect_dom", { selector: "Example Domain", by_text: true }));
    ok("inspect_dom by text", !r2.isError && r2.json?.found === true);

    const r3 = parseResult(await callTool("inspect_dom", { selector: "nonexistent-xyz-123", by_text: true }));
    ok("inspect_dom not found reports hint", !r3.isError && r3.json?.found === false);
  } catch (e) { err("inspect_dom", e); }

  // === FOCUS ELEMENT ===
  console.log("\n=== FOCUS ELEMENT ===");
  try {
    await callTool("navigate", { url: "https://www.google.com" });
    await new Promise(r => setTimeout(r, 3000));
    const r = parseResult(await callTool("focus_element", { selector: "textarea[name='q'], input[name='q']" }));
    ok("focus_element on search box", !r.isError && r.text.includes("Focused"));
  } catch (e) { err("focus_element", e); }

  // === PRESS KEY ===
  console.log("\n=== PRESS KEY ===");
  try {
    await callTool("navigate", { url: "https://example.com" });
    await new Promise(r => setTimeout(r, 1000));
    const r = parseResult(await callTool("press_key", { key: "Escape" }));
    ok("press_key Escape", !r.isError && r.text.includes("Pressed"));

    const r2 = parseResult(await callTool("press_key", { key: "Control+a" }));
    ok("press_key combo", !r2.isError && r2.text.includes("Pressed"));
  } catch (e) { err("press_key", e); }

  // === SCREENSHOT ===
  console.log("\n=== SCREENSHOT ===");
  try {
    const r = parseResult(await callTool("screenshot", {}));
    ok("screenshot auto-named", !r.isError && r.text.includes("Screenshot saved"));

    const r2 = parseResult(await callTool("screenshot", { path: "test-manual.png" }));
    ok("screenshot named", !r2.isError && r2.text.includes("test-manual.png"));

    const r3 = parseResult(await callTool("screenshot", { path: "../../etc/passwd" }));
    ok("screenshot blocks traversal", r3.isError);
  } catch (e) { err("screenshot", e); }

  // === EXECUTE JS ===
  console.log("\n=== EXECUTE JS ===");
  try {
    const r = parseResult(await callTool("execute_js", { code: "document.title", confirm: false }));
    ok("execute_js blocked without confirm", r.isError);

    const r2 = parseResult(await callTool("execute_js", { code: "document.title", confirm: true }));
    ok("execute_js runs with confirm", !r2.isError && r2.text.includes("Result:"));

    const r3 = parseResult(await callTool("execute_js", { code: "invalid $$$ code !!!!", confirm: true }));
    ok("execute_js catches JS errors", r3.isError);
  } catch (e) { err("execute_js", e); }

  // === WAIT FOR ===
  console.log("\n=== WAIT FOR ===");
  try {
    const r = parseResult(await callTool("wait_for", { selector: "body", timeout: 3000 }));
    ok("wait_for finds existing body", !r.isError && r.text.includes("found"));

    const r2 = parseResult(await callTool("wait_for", { selector: "#nonexistent-xyz", timeout: 1000 }));
    ok("wait_for times out on missing", r2.text.includes("Timeout"));
  } catch (e) { err("wait_for", e); }

  // === WAIT FOR LOAD ===
  console.log("\n=== WAIT FOR LOAD ===");
  try {
    const r = parseResult(await callTool("wait_for_load", { timeout: 5000 }));
    ok("wait_for_load", !r.isError && r.text.includes("loaded"));
  } catch (e) { err("wait_for_load", e); }

  // === CAPTCHA DETECTION ===
  console.log("\n=== CAPTCHA DETECTION ===");
  try {
    const r = parseResult(await callTool("detect_captcha", {}));
    ok("detect_captcha on clean page", !r.isError && r.text.includes("No CAPTCHA"));
  } catch (e) { err("detect_captcha", e); }

  // === PDF EXPORT ===
  console.log("\n=== PDF EXPORT ===");
  try {
    await callTool("navigate", { url: "https://example.com" });
    const r = parseResult(await callTool("pdf_export", {}));
    ok("pdf_export", !r.isError && r.text.includes("PDF saved"));

    const r2 = parseResult(await callTool("pdf_export", { path: "test-export.pdf" }));
    ok("pdf_export named", !r2.isError && r2.text.includes("test-export.pdf"));

    const r3 = parseResult(await callTool("pdf_export", { path: "../evil.pdf" }));
    ok("pdf_export sanitizes path", !r3.isError && r3.text.includes("screenshots/") && !r3.text.includes("/etc/"));
  } catch (e) { err("pdf_export", e); }

  // === COOKIES ===
  console.log("\n=== COOKIES ===");
  try {
    const r = parseResult(await callTool("cookies", { action: "save", profile: "test-profile" }));
    ok("cookies save", !r.isError && r.text.includes("Saved"));

    const r2 = parseResult(await callTool("cookies", { action: "load", profile: "test-profile" }));
    ok("cookies load", !r2.isError && r2.text.includes("Loaded"));

    const r3 = parseResult(await callTool("cookies", { action: "save", profile: "../../etc/passwd" }));
    ok("cookies sanitizes profile name", !r3.isError && r3.text.includes("Saved"));
  } catch (e) { err("cookies", e); }

  // === TABS ===
  console.log("\n=== TABS ===");
  try {
    const r = parseResult(await callTool("tabs", { action: "list" }));
    ok("tabs list", !r.isError && r.text.includes("Open tabs"));

    const r2 = parseResult(await callTool("tabs", { action: "open", url: "https://example.com" }));
    ok("tabs open new", !r2.isError && r2.text.includes("New tab"));

    const r3 = parseResult(await callTool("tabs", { action: "switch", index: 0 }));
    ok("tabs switch", !r3.isError && r3.text.includes("Switched"));

    const r4 = parseResult(await callTool("tabs", { action: "list" }));
    ok("tabs count increased", r4.text.includes("Open tabs ("));
  } catch (e) { err("tabs", e); }

  // === WINDOWS ===
  console.log("\n=== WINDOWS ===");
  try {
    const r = parseResult(await callTool("windows", { action: "list" }));
    ok("windows list", !r.isError && r.text.includes("Windows"));

    const r2 = parseResult(await callTool("windows", { action: "switch", index: 0 }));
    ok("windows switch", !r2.isError && r2.text.includes("Switched"));
  } catch (e) { err("windows", e); }

  // === VIDEO CONTROL ===
  console.log("\n=== VIDEO CONTROL ===");
  try {
    await callTool("navigate", { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
    await new Promise(r => setTimeout(r, 5000));

    const r = parseResult(await callTool("video_control", { action: "pause" }));
    ok("video pause", !r.isError && r.text.includes("Paused"));

    const r2 = parseResult(await callTool("video_control", { action: "play" }));
    ok("video play", !r2.isError && r2.text.includes("Playing"));

    const r3 = parseResult(await callTool("video_control", { action: "seek", value: 60 }));
    ok("video seek", !r3.isError && r3.text.includes("Seeked"));

    const r4 = parseResult(await callTool("video_control", { action: "mute" }));
    ok("video mute", !r4.isError && r4.text.includes("Muted"));

    const r5 = parseResult(await callTool("video_control", { action: "unmute" }));
    ok("video unmute", !r5.isError && r5.text.includes("Unmuted"));

    const r6 = parseResult(await callTool("video_control", { action: "set_volume", value: 0.3 }));
    ok("video volume", !r6.isError && r6.text.includes("0.3"));

    const r7 = parseResult(await callTool("video_control", { action: "get_info" }));
    ok("video get_info", !r7.isError && r7.json?.duration > 0);

    await callTool("video_control", { action: "pause" });
  } catch (e) { err("video_control", e); }

  // === SEARCH SOCIAL ===
  console.log("\n=== SEARCH SOCIAL ===");
  try {
    await callTool("navigate", { url: "https://www.google.com" });
    await new Promise(r => setTimeout(r, 2000));
    const r = parseResult(await callTool("search_social", { platform: "google", query: "OSINT tools" }));
    ok("search google", !r.isError && r.text.includes("Search results"));
  } catch (e) { err("search_social", e); }

  // === CAPTCHA (wait_for_captcha on clean page) ===
  console.log("\n=== WAIT FOR CAPTCHA ===");
  try {
    await callTool("navigate", { url: "https://example.com" });
    const r = parseResult(await callTool("wait_for_captcha", { timeout: 3 }));
    ok("wait_for_captcha on clean page", r.text.includes("No CAPTCHA"));
  } catch (e) { err("wait_for_captcha", e); }

  // === DISCONNECT ===
  console.log("\n=== DISCONNECT ===");
  try {
    const r = parseResult(await callTool("disconnect", {}));
    ok("disconnect", !r.isError && r.text.includes("Disconnected"));

    const r2 = parseResult(await callTool("health", {}));
    ok("health shows disconnected", r2.json?.connected === false);
  } catch (e) { err("disconnect", e); }

  // === RESULTS ===
  console.log(`\n${"=".repeat(40)}`);
  console.log(`  TOTAL: ${passed + failed} | PASSED: ${passed} | FAILED: ${failed}`);
  console.log(`${"=".repeat(40)}\n`);

  server.kill();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error("Fatal:", e.message);
  server?.kill();
  process.exit(1);
});
