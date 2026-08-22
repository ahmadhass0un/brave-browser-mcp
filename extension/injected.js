/**
 * browser-navigator — injected.js (persistent page-context runtime)
 *
 * NOT declared in manifest.json. Executed on demand by the background service
 * worker via chrome.scripting.executeScript (see ensureRunner()). Works in
 * whichever world it is injected into (background currently uses MAIN).
 *
 * Responsibilities
 *   1. Persistent script registry: named scripts are stored and can be
 *      replayed after navigations (runtime.replayAll()).
 *   2. Bridges reachable over two transports:
 *
 *      A) CustomEvent — used by background's __mcpSendInjected():
 *           request : dispatchEvent(new CustomEvent("mcp-inject:" + name,
 *                             { detail: { data: payload, nonce, replyEvent } }))
 *           reply   : dispatchEvent(new CustomEvent(replyEvent, { detail }))
 *         (also accepted: bare "mcp-inject" events carrying detail.name, and
 *          fixed-name events mcp-execute-js / mcp-detect-captcha /
 *          mcp-video-control with the same detail conventions)
 *
 *      B) window.postMessage — flat envelopes, same-window only:
 *           request : { type: "mcp-inject:<name>" | "mcp-execute-js" |
 *                             "mcp-detect-captcha" | "mcp-video-control" |
 *                             "mcp-ping" | "mcp-list-scripts" | "mcp-unregister",
 *                       code?, action?, name?, selector?, time?, seconds?,
 *                       rate?, volume?, replyEvent?, timeoutMs?, ... }
 *           reply   : { type: <replyEvent>, data: payload }
 *
 *      Reply payloads are uniform:  { value } on success (plus optional
 *      `truncated: true`) or { __error, __errorName?, __stack? } on failure,
 *      optionally with extra context fields (e.g. video state).
 *
 * Channels implemented
 *   mcp-inject:<name>    register + execute a named script (kept for replay);
 *                        code is evaluated expression-first ("document.title"
 *                        yields its value) with function-body fallback
 *                        ("return foo()"). Async results awaited up to
 *                        timeoutMs (default 5000).
 *   mcp-execute-js       one-shot evaluation; NOT added to the registry.
 *   mcp-detect-captcha   heuristic CAPTCHA fingerprinting → structured report.
 *   mcp-video-control    control the most relevant <video> element.
 *   mcp-ping             liveness probe → { pong, version, scripts, href }.
 *   mcp-list-scripts     names of registered scripts.
 *   mcp-unregister       remove one script from the registry.
 *
 * Security note: these channels intentionally allow code execution by whoever
 * reaches them. Same-window origin checks are enforced where possible, but
 * pages can post to their own window too; op-level authorization belongs in
 * the background worker (SSRF/target guards live there, not here).
 */

(function () {
  "use strict";

  // ==========================================================================
  // §1 Constants & small utilities
  // ==========================================================================

  var RUNTIME_KEY = "__mcpInjectedRuntime";
  var RUNTIME_VERSION = "1.1.0";
  var INJECT_PREFIX = "mcp-inject:";
  var RESPONSE_PREFIX = "mcp-response-"; // default reply prefix (postMessage path)
  var MARKER = "__mcpRuntime"; // set on our own outbound envelopes to stop loops
  var DEFAULT_TIMEOUT_MS = 5000;
  var MIN_TIMEOUT_MS = 50;
  var MAX_TIMEOUT_MS = 300000;
  var MAX_RESULT_CHARS = 262144; // keep replies well under bridge limits
  var NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

  /** postMessage that never throws (structured-clone failures, frozen realms). */
  function safePost(msg) {
    try {
      msg[MARKER] = true;
      window.postMessage(msg, "*");
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Announce liveness on both transports so late-started listeners find us. */
  function signalReady(reason) {
    safePost({ type: "mcp-runtime-ready", version: RUNTIME_VERSION, reason: reason || "" });
    try {
      window.dispatchEvent(new CustomEvent("mcp-runtime-ready", {
        detail: { version: RUNTIME_VERSION, reason: reason || "" },
      }));
    } catch (_) { /* page may have tampered with CustomEvent */ }
  }

  // ---- Multiple-injection guard -------------------------------------------
  // ensureRunner() re-executes this file before every injected.send and after
  // every navigation; without this guard each pass would stack duplicate
  // listeners and answer every request twice. On repeat injection we simply
  // refresh the readiness signal and bail out.
  if (window[RUNTIME_KEY]) {
    signalReady("already-running");
    return;
  }

  function clampTimeout(ms, dflt) {
    var n = Number(ms);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.floor(n)));
  }

  function toText(v) {
    if (v == null) return String(v);
    if (typeof v === "string") return v;
    if (v instanceof Error) return v.message || v.name;
    try { return JSON.stringify(v); } catch (_) { return String(v); }
  }

  /** Uniform failure payload understood by every consumer of this runtime. */
  function errorPayload(err) {
    var e = err instanceof Error ? err : new Error(toText(err));
    var p = { __error: e.message || String(e) };
    if (e.name && e.name !== "Error") p.__errorName = e.name;
    if (e.stack) p.__stack = String(e.stack).slice(0, 2048);
    return p;
  }

  // ==========================================================================
  // §2 Result serialization
  // ==========================================================================

  /**
   * Reduce arbitrary values to a string suitable for crossing postMessage /
   * JSON bridges. Handles circular structures, bigint/symbol/function values,
   * Errors and DOM nodes; caps output length (truncated flag set when cut).
   */
  function serializeValue(value) {
    var seen = new WeakSet(); // approximation: shared subobjects also read as circular

    function describeNode(node) {
      try {
        if (node.nodeType === 1) {
          return "<" + String(node.nodeName || "element").toLowerCase() +
            (node.id ? "#" + node.id : "") + ">";
        }
        if (node.nodeType === 3) {
          return "#text(" + String(node.nodeValue || "").slice(0, 64) + ")";
        }
        return node.nodeName || "#node" + node.nodeType;
      } catch (_) {
        return "[Node]";
      }
    }

    function replacer(_key, val) {
      if (typeof val === "bigint") return val.toString() + "n";
      if (typeof val === "function") return "[Function: " + (val.name || "anonymous") + "]";
      if (val instanceof Error) return { name: val.name, message: val.message };
      if (typeof Node !== "undefined" && val instanceof Node) return describeNode(val);
      if (val !== null && typeof val === "object") {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      return val;
    }

    var out;
    if (typeof value === "string") out = value;
    else if (value === undefined) out = "undefined";
    else if (typeof Node !== "undefined" && value instanceof Node) out = describeNode(value);
    else if (typeof value === "number") out = Number.isFinite(value) ? JSON.stringify(value) : String(value);
    else if (typeof value === "boolean") out = String(value);
    else if (typeof value === "function" || typeof value === "symbol") out = String(value);
    else if (typeof value === "bigint") out = value.toString() + "n";
    else {
      try {
        var json = JSON.stringify(value, replacer);
        out = json === undefined ? String(value) : json;
      } catch (_) {
        try { out = String(value); } catch (_e) { out = Object.prototype.toString.call(value); }
      }
    }

    out = String(out);
    if (out.length > MAX_RESULT_CHARS) {
      return { value: out.slice(0, MAX_RESULT_CHARS) + "...[truncated]", truncated: true };
    }
    return { value: out, truncated: false };
  }

  // ==========================================================================
  // §3 User-code engine (shared by inject / execute-js)
  // ==========================================================================

  /**
   * Expression-first compilation: bare expressions yield their value, while
   * multi-statement sources fall back to plain function-body semantics
   * (mirrors __mcpEval in background.js).
   */
  function compileUserCode(code) {
    try {
      return new Function('"use strict";\nreturn (\n' + code + "\n);");
    } catch (_) {
      return new Function('"use strict";\n' + code);
    }
  }

  /** Race a promise against a deadline without leaking the timer. */
  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error("Execution timed out after " + ms + "ms"));
      }, ms);
      Promise.resolve(promise).then(
        function (v) { clearTimeout(timer); resolve(v); },
        function (e) {
          clearTimeout(timer);
          reject(e instanceof Error ? e : new Error(toText(e)));
        },
      );
    });
  }

  /** Compile + run + enforce timeout. SyntaxError propagates to the caller. */
  function executeUserCode(code, timeoutMs) {
    var fn = compileUserCode(code);
    return withTimeout(Promise.resolve().then(fn), timeoutMs);
  }

  // ==========================================================================
  // §4 Script registry
  // ==========================================================================

  var runtime = {
    version: RUNTIME_VERSION,
    scripts: new Map(), // name -> source code

    /**
     * Store source under `name` and run it immediately.
     * Resolves to { ok:true, name, result } | { ok:false, name, error }.
     * The source stays registered even when execution fails or times out,
     * so replayAll() still picks it up later.
     */
    register: function (name, codeFnSource) {
      name = String(name);
      if (!NAME_RE.test(name)) {
        return Promise.resolve({ ok: false, name: name, error: "Invalid script name (must match " + NAME_RE + ")" });
      }
      var code = String(codeFnSource == null ? "" : codeFnSource);
      runtime.scripts.set(name, code);
      return executeUserCode(code, DEFAULT_TIMEOUT_MS).then(
        function (result) {
          return { ok: true, name: name, result: serializeValue(result).value };
        },
        function (err) {
          return { ok: false, name: name, error: errorPayload(err).__error };
        },
      );
    },

    /** Re-run every registered script. Resolves to { [name]: outcome }. */
    replayAll: function () {
      var jobs = [];
      runtime.scripts.forEach(function (_code, name) {
        jobs.push(runtime.register(name, runtime.scripts.get(name)));
      });
      return Promise.all(jobs).then(function (outcomes) {
        var results = {};
        outcomes.forEach(function (o) {
          results[o.name] = o.ok ? { ok: true, result: o.result } : { ok: false, error: o.error };
        });
        return results;
      });
    },

    unregister: function (name) { return runtime.scripts.delete(String(name)); },
    has: function (name) { return runtime.scripts.has(String(name)); },
    list: function () {
      var names = [];
      runtime.scripts.forEach(function (_code, name) { names.push(name); });
      return names;
    },
    clear: function () { runtime.scripts.clear(); },
  };

  // ==========================================================================
  // §5 Transport plumbing
  // ==========================================================================

  /**
   * Merge envelope-style details ({ data:{...}, nonce, replyEvent }) and flat
   * arg objects into one request record used by all handlers.
   */
  function normalizeRequest(kind, raw, channel, defaultReply) {
    var src = raw && typeof raw === "object" ? raw : {};
    var inner = src.data && typeof src.data === "object" && !Array.isArray(src.data) ? src.data : {};

    var args = {};
    Object.keys(inner).forEach(function (k) { args[k] = inner[k]; });
    Object.keys(src).forEach(function (k) {
      if (k === "type" || k === "data" || k === MARKER) return;
      args[k] = src[k]; // explicit top-level fields win over inner payload
    });

    var replyEvent = typeof args.replyEvent === "string" ? args.replyEvent : "";
    return {
      kind: kind,
      channel: channel,
      args: args,
      name: typeof args.name === "string" ? args.name : "",
      code: typeof args.code === "string" ? args.code : "",
      action: typeof args.action === "string" ? args.action : "",
      replyEvent: replyEvent || defaultReply || "",
      nonce: typeof args.nonce === "string" ? args.nonce : "",
      timeoutMs: clampTimeout(args.timeoutMs, DEFAULT_TIMEOUT_MS),
    };
  }

  /** Deliver a payload over the transport the request arrived on. */
  function reply(req, payload) {
    if (!req.replyEvent) return; // fire-and-forget request
    if (req.channel === "event") {
      try {
        window.dispatchEvent(new CustomEvent(req.replyEvent, { detail: payload }));
      } catch (_) {
        safePost({ type: req.replyEvent, data: payload }); // last-resort fallback
      }
    } else {
      safePost({ type: req.replyEvent, data: payload });
    }
  }

  /** Run user code for a request and deliver { value } / { __error }. */
  function runAndReply(req, code) {
    executeUserCode(code, req.timeoutMs).then(
      function (result) {
        var s = serializeValue(result);
        var payload = { value: s.value };
        if (s.truncated) payload.truncated = true;
        reply(req, payload);
      },
      function (err) {
        reply(req, errorPayload(err));
      },
    );
  }

  // ==========================================================================
  // §6 CAPTCHA detection
  // ==========================================================================

  var CAPTCHA_SIGNATURES = [
    { kind: "recaptcha", selectors: [
      ".g-recaptcha", "#recaptcha", ".grecaptcha-badge", "#g-recaptcha-response",
      'iframe[src*="/recaptcha/"]', 'iframe[src*="recaptcha/api"]', 'iframe[title*="recaptcha" i]',
    ] },
    { kind: "hcaptcha", selectors: [
      ".h-captcha", "[data-hcaptcha-widget-id]", 'iframe[src*="hcaptcha.com"]', 'iframe[title*="hcaptcha" i]',
    ] },
    { kind: "turnstile", selectors: [
      ".cf-turnstile", 'input[name^="cf-turnstile"]', 'iframe[src*="challenges.cloudflare.com"]',
    ] },
    { kind: "cloudflare-interstitial", selectors: [
      "#challenge-form", "#challenge-stage", "#challenge-running", "#cf-challenge-running",
      "#challenge-error-text", "#cf-please-wait", 'form[action*="challenges.cloudflare"]',
    ] },
    { kind: "funcaptcha", selectors: [
      "#funcaptcha", 'iframe[src*="funcaptcha"]', 'iframe[src*="arkoselabs"]', "#game-core-frame",
    ] },
    { kind: "geetest", selectors: ['iframe[src*="geetest"]', '[class*="geetest"]'] },
    { kind: "aws-waf", selectors: ['iframe[src*="awswaf"]', "#captcha-container"] },
    { kind: "keycaptcha", selectors: ['iframe[src*="keycaptcha"]'] },
    { kind: "mtcaptcha", selectors: [".mtcaptcha", 'iframe[src*="mtcaptcha"]'] },
  ];

  var CAPTCHA_TEXT_RE =
    /\bcaptchas?\b|verify you are human|verifying you are human|are you a robot|i['\u2019]?m not a robot|prove you are human|security check|checking your browser|attention required|unusual traffic/i;
  var CAPTCHA_TITLE_RE =
    /just a moment|attention required|checking your browser|security check|access denied|verify you are human|\bcaptcha\b/i;
  var CHALLENGE_FRAME_SRC_RE =
    /recaptcha|hcaptcha|challenges\.cloudflare|funcaptcha|arkoselabs|geetest|awswaf|mtcaptcha|keycaptcha/i;

  /** Heuristic fingerprint scan; every probe individually fault-isolated. */
  function detectCaptcha() {
    var evidence = [];
    var kinds = {};
    function add(kind, source, detail) {
      kinds[kind] = true;
      evidence.push({ kind: kind, source: source, detail: String(detail).slice(0, 200) });
    }

    // 1) Known widget markup / challenge frames
    CAPTCHA_SIGNATURES.forEach(function (sig) {
      sig.selectors.forEach(function (sel) {
        try {
          var hits = document.querySelectorAll(sel);
          if (hits.length) add(sig.kind, "dom", sel + " x" + hits.length);
        } catch (_) { /* invalid selector — never fatal */ }
      });
    });

    // 2) Cross-origin challenge iframes regardless of widget wrappers
    try {
      var frames = document.querySelectorAll("iframe");
      for (var f = 0; f < frames.length && f < 60; f++) {
        var src = frames[f].getAttribute("src") || "";
        if (src && CHALLENGE_FRAME_SRC_RE.test(src)) add("frame-challenge", "iframe-src", src);
      }
    } catch (_) { /* noop */ }

    // 3) Interstitial titles
    try {
      if (document.title && CAPTCHA_TITLE_RE.test(document.title)) add("page-title", "title", document.title);
    } catch (_) { /* noop */ }

    // 4) Visible body text keywords (bounded to avoid layout blowups)
    try {
      var text = document.body ? String(document.body.innerText || "") : "";
      if (text.length > 20000) text = text.slice(0, 20000);
      var m = CAPTCHA_TEXT_RE.exec(text);
      if (m) {
        var at = Math.max(0, m.index - 40);
        add("text-hint", "body-text", text.slice(at, m.index + m[0].length + 40).replace(/\s+/g, " ").trim());
      }
    } catch (_) { /* noop */ }

    var hasStrong = evidence.some(function (e) {
      return e.source === "dom" || e.source === "iframe-src";
    });
    var weakOnly = evidence.length > 0 && !hasStrong;

    return {
      detected: evidence.length > 0,
      kinds: Object.keys(kinds),
      confidence: hasStrong ? "high" : weakOnly ? "low" : "none",
      evidence: evidence.slice(0, 20),
      url: location.href,
      title: document.title || "",
      ts: Date.now(),
    };
  }

  // ==========================================================================
  // §7 Video control
  // ==========================================================================

  var VIDEO_ACTIONS =
    "play, pause, toggle, seek, forward, rewind, setspeed, setvolume, mute, unmute, " +
    "togglemute, fullscreen, pip, info, status, list";

  function clampNum(v, min, max) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : NaN;
  }

  function numArg(a, keys) {
    for (var i = 0; i < keys.length; i++) {
      var raw = a[keys[i]];
      var n = typeof raw === "number" ? raw : (typeof raw === "string" && raw.trim() !== "" ? parseFloat(raw) : NaN);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  /**
   * Most relevant <video>: visible beats hidden, playing beats idle, then by
   * on-screen area. Optional CSS selector narrows the candidate pool.
   */
  function pickVideo(selector) {
    var vids;
    try { vids = Array.prototype.slice.call(document.querySelectorAll(selector || "video")); }
    catch (_) { return null; }

    var best = null;
    var bestScore = -Infinity;
    vids.forEach(function (v) {
      var visible = false;
      var area = 0;
      try {
        var r = v.getBoundingClientRect();
        var st = window.getComputedStyle(v);
        visible = r.width > 1 && r.height > 1 &&
          st.display !== "none" && st.visibility !== "hidden" &&
          parseFloat(st.opacity || "1") > 0.01;
        area = r.width * r.height;
      } catch (_) { /* detached node etc. */ }
      var score = (visible ? 2e12 : 0) + (!v.paused && !v.ended ? 1e9 : 0) + area;
      if (score > bestScore) { bestScore = score; best = v; }
    });
    return best;
  }

  /** Full playback state; extraError attaches action failures to the snapshot. */
  function videoSnapshot(v, extraError) {
    var snap = {};
    try {
      var r = v.getBoundingClientRect();
      var st = window.getComputedStyle(v);
      snap.currentTime = v.currentTime;
      snap.duration = Number.isFinite(v.duration) ? v.duration : null;
      snap.paused = !!v.paused;
      snap.ended = !!v.ended;
      snap.muted = !!v.muted;
      snap.volume = v.volume;
      snap.playbackRate = v.playbackRate;
      snap.loop = !!v.loop;
      snap.readyState = v.readyState;
      snap.networkState = v.networkState;
      snap.error = v.error ? (v.error.message || v.error.code) : null;
      snap.videoWidth = v.videoWidth || 0;
      snap.videoHeight = v.videoHeight || 0;
      snap.rect = {
        x: Math.round(r.x), y: Math.round(r.y),
        width: Math.round(r.width), height: Math.round(r.height),
      };
      snap.visible = r.width > 1 && r.height > 1 &&
        st.display !== "none" && st.visibility !== "hidden";
      snap.src = String(v.currentSrc || v.src || "").slice(0, 200);
      snap.title = v.title || v.getAttribute("aria-label") || "";
      snap.indexInDom = Array.prototype.indexOf.call(document.querySelectorAll("video"), v);
    } catch (e) {
      snap.snapshotError = toText(e);
    }
    if (extraError) snap.actionError = toText(extraError);
    return snap;
  }

  /** May return a promise (play/pip/fullscreen) — callers must await it. */
  function applyVideoAction(v, action, a) {
    switch (action) {
      case "play": {
        var p = v.play();
        if (p && typeof p.catch === "function") {
          return p.catch(function (err) {
            throw new Error("play() rejected: " + toText(err)); // e.g. NotAllowedError
          });
        }
        return undefined;
      }
      case "pause":
        v.pause();
        return undefined;
      case "toggle": {
        if (!v.paused) { v.pause(); return undefined; }
        var tp = v.play();
        return tp && typeof tp.catch === "function"
          ? tp.catch(function (err) { throw new Error("play() rejected: " + toText(err)); })
          : undefined;
      }
      case "seek": {
        var t = numArg(a, ["time", "seconds", "position", "value"]);
        if (t === null) throw new Error('seek requires numeric "time" (seconds)');
        var max = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : t;
        v.currentTime = Math.max(0, Math.min(t, max));
        return undefined;
      }
      case "forward":
      case "rewind": {
        var d = numArg(a, ["seconds", "delta", "value"]);
        if (d === null) d = 10;
        if (action === "rewind") d = -d;
        var target = v.currentTime + d;
        var ceiling = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : target;
        v.currentTime = Math.max(0, Math.min(target, ceiling));
        return undefined;
      }
      case "setspeed":
      case "speed":
      case "setplaybackrate":
      case "playbackrate": {
        var rate = clampNum(a.rate !== undefined ? a.rate : a.value, 0.0625, 16);
        if (!Number.isFinite(rate)) throw new Error('setSpeed requires numeric "rate" (0.0625-16)');
        v.playbackRate = rate;
        return undefined;
      }
      case "setvolume":
      case "volume": {
        var vol = clampNum(a.volume !== undefined ? a.volume : a.value, 0, 1);
        if (!Number.isFinite(vol)) throw new Error('setVolume requires numeric "volume" in [0,1]');
        v.volume = vol;
        if (vol > 0 && v.muted) v.muted = false;
        return undefined;
      }
      case "mute":
        v.muted = true;
        return undefined;
      case "unmute":
        v.muted = false;
        return undefined;
      case "togglemute":
        v.muted = !v.muted;
        return undefined;
      case "fullscreen": {
        var el = typeof v.webkitEnterFullscreen === "function" ? v : (v.parentElement || v);
        var fs = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
        if (typeof fs !== "function") throw new Error("Fullscreen API unavailable");
        var res = fs.call(el);
        return res && typeof res.then === "function" ? res : undefined;
      }
      case "pip":
      case "pictureinpicture": {
        if (!document.pictureInPictureEnabled) throw new Error("Picture-in-Picture is disabled");
        if (document.pictureInPictureElement === v) return undefined;
        if (typeof v.requestPictureInPicture !== "function") throw new Error("requestPictureInPicture unsupported");
        return v.requestPictureInPicture();
      }
      case "info":
      case "status":
      case "state":
        return undefined;
      default:
        throw new Error('Unknown video action "' + action + '". Supported: ' + VIDEO_ACTIONS);
    }
  }

  function handleVideoControl(req) {
    var a = req.args;
    var action = (req.action || a.action || "info").toLowerCase();

    try {
      if (action === "list") {
        var videos = Array.prototype.slice.call(document.querySelectorAll("video"), 0, 10)
          .map(function (v) { return videoSnapshot(v); });
        reply(req, { value: { action: action, count: videos.length, videos: videos } });
        return;
      }

      var v = pickVideo(typeof a.selector === "string" && a.selector ? a.selector : "");
      if (!v) {
        reply(req, errorPayload(new Error("No <video> element found on page")));
        return;
      }

      Promise.resolve()
        .then(function () { return applyVideoAction(v, action, a); })
        .then(
          function () {
            reply(req, { value: { action: action, ok: true, video: videoSnapshot(v) } });
          },
          function (err) {
            var p = errorPayload(err);
            p.action = action;
            p.video = videoSnapshot(v); // state at failure time aids debugging
            reply(req, p);
          },
        );
    } catch (e) {
      reply(req, errorPayload(e));
    }
  }

  // ==========================================================================
  // §8 Channel handlers
  // ==========================================================================

  function handleInject(req) {
    if (!NAME_RE.test(req.name)) {
      reply(req, errorPayload(new Error("Invalid script name: " + JSON.stringify(req.name) +
        " (must match " + NAME_RE + ")")));
      return;
    }
    if (!req.code.trim()) {
      reply(req, errorPayload(new Error("No code provided")));
      return;
    }
    // Persist first so the script survives even if this execution times out.
    runtime.scripts.set(req.name, req.code);
    runAndReply(req, req.code);
  }

  function handleExecuteJs(req) {
    if (!req.code.trim()) {
      reply(req, errorPayload(new Error("No code provided")));
      return;
    }
    runAndReply(req, req.code); // one-shot: deliberately not registered
  }

  function handleDetectCaptcha(req) {
    try {
      reply(req, { value: detectCaptcha() }); // structured report, not a JSON string
    } catch (e) {
      reply(req, errorPayload(e));
    }
  }

  function handlePing(req) {
    reply(req, {
      value: {
        pong: true,
        version: RUNTIME_VERSION,
        scripts: runtime.list(),
        href: location.href,
        ts: Date.now(),
      },
    });
  }

  function handleRequest(req) {
    try {
      switch (req.kind) {
        case "inject":     handleInject(req); break;
        case "execute":    handleExecuteJs(req); break;
        case "captcha":    handleDetectCaptcha(req); break;
        case "video":      handleVideoControl(req); break;
        case "ping":       handlePing(req); break;
        case "list":
          reply(req, { value: { scripts: runtime.list().sort() } });
          break;
        case "unregister": {
          var existed = runtime.unregister(req.name);
          reply(req, { value: { removed: existed, name: req.name } });
          break;
        }
        default:
          break; // unknown channel kinds are ignored silently
      }
    } catch (e) {
      reply(req, errorPayload(e));
    }
  }

  // ==========================================================================
  // §9 Wiring & bootstrap
  // ==========================================================================

  // ---- Transport B: window.postMessage ------------------------------------
  function routeMessage(ev) {
    if (ev.source !== window) return; // same-window traffic only
    var d = ev.data;
    if (!d || typeof d !== "object" || d[MARKER]) return; // never process own replies
    var t = typeof d.type === "string" ? d.type : "";
    if (!t) return;

    if (t.indexOf(INJECT_PREFIX) === 0) {
      var typeName = t.slice(INJECT_PREFIX.length);
      var injectReq = normalizeRequest("inject", d, "message", RESPONSE_PREFIX + typeName);
      if (typeName) injectReq.name = typeName; // envelope type is authoritative
      handleRequest(injectReq);
    } else if (t === "mcp-execute-js") {
      handleRequest(normalizeRequest("execute", d, "message", "mcp-execute-js-response"));
    } else if (t === "mcp-detect-captcha") {
      handleRequest(normalizeRequest("captcha", d, "message", "mcp-captcha-result"));
    } else if (t === "mcp-video-control") {
      handleRequest(normalizeRequest("video", d, "message", "mcp-video-control-response"));
    } else if (t === "mcp-ping") {
      handleRequest(normalizeRequest("ping", d, "message", "mcp-pong"));
    } else if (t === "mcp-list-scripts") {
      handleRequest(normalizeRequest("list", d, "message", "mcp-scripts-list"));
    } else if (t === "mcp-unregister") {
      handleRequest(normalizeRequest("unregister", d, "message", "mcp-unregister-result"));
    }
  }

  // ---- Transport A: CustomEvents ------------------------------------------
  //
  // EventTarget has no wildcard listeners, and __mcpSendInjected() addresses
  // us via "mcp-inject:<name>" with arbitrary names. To receive those we wrap
  // window.dispatchEvent once: requests are routed out-of-band (microtask) and
  // the original dispatch always proceeds untouched. If assignment fails
  // (frozen realm), fixed-name listeners below keep the static channels alive.
  function installDispatchShim() {
    var native = window.dispatchEvent;
    if (typeof native !== "function") return;

    function patchedDispatch(event) {
      try {
        if (event && typeof event.type === "string" &&
            (event.type.indexOf(INJECT_PREFIX) === 0 || event.type === "mcp-inject")) {
          Promise.resolve().then(function () {
            try {
              var typeName = event.type.indexOf(INJECT_PREFIX) === 0
                ? event.type.slice(INJECT_PREFIX.length)
                : "";
              var req = normalizeRequest("inject", event.detail, "event", "");
              if (typeName) req.name = typeName; // event-type name wins over detail.name
              handleRequest(req);
            } catch (_) { /* routing must never break page dispatch */ }
          });
        }
      } catch (_) { /* idem */ }
      return native.call(this, event);
    }

    try {
      // Look native to pages that probe for tampering (anti-bot heuristics).
      try {
        patchedDispatch.toString = function () {
          return Function.prototype.toString.call(native);
        };
      } catch (_) { /* cosmetic only */ }
      Object.defineProperty(window, "dispatchEvent", {
        value: patchedDispatch,
        writable: true,
        configurable: true,
      });
    } catch (_) { /* degraded mode: postMessage + fixed-name events still work */ }
  }

  // Fixed-name CustomEvent channels (usable even when the shim cannot install).
  ["mcp-execute-js", "mcp-detect-captcha", "mcp-video-control"].forEach(function (evtName) {
    window.addEventListener(evtName, function (ev) {
      var kind = evtName === "mcp-execute-js" ? "execute"
        : evtName === "mcp-detect-captcha" ? "captcha"
        : "video";
      var req = normalizeRequest(kind, ev.detail, "event", "");
      if (!req.replyEvent) return; // no nonce-based reply target → cannot answer
      handleRequest(req);
    });
  });

  // Expose exactly once, hardened against page-side replacement. Freezing the
  // facade keeps its methods stable; the scripts Map stays mutable internally.
  Object.defineProperty(window, RUNTIME_KEY, {
    value: Object.freeze(runtime),
    writable: false,
    configurable: false,
    enumerable: false,
  });

  window.addEventListener("message", routeMessage);
  installDispatchShim();

  signalReady("installed");
})();
