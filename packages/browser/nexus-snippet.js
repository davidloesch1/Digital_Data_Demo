/**
 * Nexus minimal browser capture — self-contained (collector URL wiring optional).
 * Keep env normalization in sync with lab_console/js/nexus-env.js when that file changes.
 *
 * Default: sends each flush as a FullStory analytics event via FS('trackEvent', { name, properties }).
 * See https://developer.fullstory.com/browser/capture-events/analytics-events/
 *
 * Optional dual-write: set window.NEXUS_DUAL_WRITE = true and configure NEXUS_PUBLISHABLE_KEY + collector base to also POST /v1/ingest.
 *
 * Optional: window.NexusSnippet = {
 *   disabled, flushMs, label,
 *   event_name: string (default 'nexus_kinetic_fingerprint', max 250 chars for FS),
 *   heuristics: { hoverLongMs, dwellIdleMs, confusionWindowMs, … } — see NEXUS_PLAN progressive rollout
 * }
 * Optional: window.NEXUS_HEURISTICS — same keys as heuristics; wins over NexusSnippet.heuristics and GET /v1/config
 * Optional: window.NEXUS_SKIP_RUNTIME_CONFIG = true — skip GET /v1/config (use only inline heuristics)
 * Optional: window.NEXUS_CONFIG_FETCH_TIMEOUT_MS — max wait before wiring listeners (default 2500)
 * Optional: window.NEXUS_USER_KEY for per-visitor correlation in FS properties.
 */
(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    /* --- nexus-env (subset; mirrors lab_console/js/nexus-env.js) — used when NEXUS_DUAL_WRITE --- */
    function normalizeCollectorOrigin(value) {
        var s = String(value || "").trim();
        if (!s) return "";
        if (!/^https?:\/\//i.test(s)) {
            var hostOnly = s.replace(/^\/+/, "");
            var local = /^(localhost|127\.0\.0\.1)(\:|\/|$)/i.test(hostOnly);
            s = (local ? "http://" : "https://") + hostOnly;
        }
        return s.replace(/\/?$/, "");
    }
    var fallback = "https://gentle-amazement-staging.up.railway.app";
    var single = window.NEXUS_API_BASE;
    var collect = window.NEXUS_COLLECT_BASE || single || fallback;
    var dash = window.NEXUS_DASH_API || single || collect;
    window.NEXUS_COLLECT_BASE = normalizeCollectorOrigin(collect);
    window.NEXUS_DASH_API = normalizeCollectorOrigin(dash);

    var pubRaw = window.NEXUS_PUBLISHABLE_KEY;
    var pubStr =
        pubRaw !== undefined && pubRaw !== null && String(pubRaw).trim() !== ""
            ? String(pubRaw).trim()
            : "";
    window.NEXUS_PUBLISHABLE_KEY = pubStr;

    function normalizePath(p, defaultWhenEmpty) {
        if (p === undefined || p === null || String(p).trim() === "") return defaultWhenEmpty;
        var s = String(p).trim();
        return s.indexOf("/") === 0 ? s : "/" + s;
    }
    window.NEXUS_INGEST_PATH = normalizePath(
        window.NEXUS_INGEST_PATH,
        pubStr ? "/v1/ingest" : "/collect"
    );
    window.NEXUS_SUMMARY_PATH = normalizePath(
        window.NEXUS_SUMMARY_PATH,
        pubStr ? "/v1/summary" : "/summary"
    );

    /* --- capture --- */
    var cfg = window.NexusSnippet && typeof window.NexusSnippet === "object" ? window.NexusSnippet : {};
    if (cfg.disabled) return;

    var dualWrite = Boolean(window.NEXUS_DUAL_WRITE);
    var cfgFlushMs = Math.max(2000, Math.min(60000, Number(cfg.flushMs) || 8000));
    var label = (cfg.label != null && String(cfg.label).trim()) || "SITE";
    var eventNameDefault = "nexus_kinetic_fingerprint";

    var snippetHeur = cfg.heuristics && typeof cfg.heuristics === "object" ? cfg.heuristics : {};
    var winHeur = window.NEXUS_HEURISTICS && typeof window.NEXUS_HEURISTICS === "object" ? window.NEXUS_HEURISTICS : {};
    /** Populated from GET /v1/config when publishable key + collector origin are set. */
    var remoteHeur = {};

    function heurRaw(key) {
        if (winHeur[key] !== undefined && winHeur[key] !== null) return winHeur[key];
        if (snippetHeur[key] !== undefined && snippetHeur[key] !== null) return snippetHeur[key];
        if (remoteHeur[key] !== undefined && remoteHeur[key] !== null) return remoteHeur[key];
        return undefined;
    }

    function heurNum(key, def, lo, hi) {
        var raw = heurRaw(key);
        if (raw === undefined) return def;
        var n = Number(raw);
        if (!Number.isFinite(n)) return def;
        if (lo !== undefined && n < lo) n = lo;
        if (hi !== undefined && n > hi) n = hi;
        return n;
    }

    function heurBool(key, def) {
        var raw = heurRaw(key);
        if (raw === undefined) return def;
        return Boolean(raw);
    }

    var SIGNAL_SCHEMA_VERSION = 1;

    var moves = [];
    var maxMoves = 120;
    var scrollDy = 0;
    var clicks = 0;
    var warnedNoKey = false;
    var warnedNoFs = false;
    var warnedNoSink = false;

    /** NEXUS_PLAN Phase 1 — rolling semantic events (cap via heuristics.signalBufferMax). */
    var signalBuffer = [];

    function pushSignalEvent(rec) {
        signalBuffer.push(rec);
        var cap = Math.floor(heurNum("signalBufferMax", 20, 5, 100));
        while (signalBuffer.length > cap) signalBuffer.shift();
    }

    /** Minimal element description — no id/class (PII risk per NEXUS_PLAN). */
    function coarseElementHint(el) {
        if (!el || !el.tagName) return {};
        var o = { tag: String(el.tagName).toLowerCase() };
        try {
            var r = el.getAttribute && el.getAttribute("role");
            if (r && String(r).length <= 48) o.role = String(r);
        } catch (_e) {}
        return o;
    }

    /** Non-PII surface / CSS context (viewport, motion/color preferences). NEXUS_PLAN Phase 1. */
    function buildCssMeta() {
        var w = window.innerWidth || 0;
        var h = window.innerHeight || 0;
        var dpr =
            typeof window.devicePixelRatio === "number" && window.devicePixelRatio > 0
                ? window.devicePixelRatio
                : 1;
        var scheme = "unknown";
        try {
            if (window.matchMedia("(prefers-color-scheme: dark)").matches) scheme = "dark";
            else if (window.matchMedia("(prefers-color-scheme: light)").matches) scheme = "light";
        } catch (_e) {}
        var reduced = false;
        try {
            reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (_e2) {}
        var rootFs = null;
        try {
            if (window.getComputedStyle && document.documentElement) {
                var st = window.getComputedStyle(document.documentElement);
                if (st && st.fontSize) {
                    var p = parseFloat(st.fontSize);
                    if (Number.isFinite(p)) rootFs = Math.round(p * 10) / 10;
                }
            }
        } catch (_e3) {}
        return {
            viewport_w: Math.round(w),
            viewport_h: Math.round(h),
            dpr: dpr,
            color_scheme: scheme,
            prefers_reduced_motion: reduced,
            root_font_size_px: rootFs,
        };
    }

    var lastPointer = { x: 0, y: 0, t: 0 };
    var hoverLongEl = null;
    var hoverLongTimer = null;
    var lastActivityTs = 0;
    var dwellEligible = true;
    var lastConfusionTs = 0;

    function clearHoverLongTimer() {
        if (hoverLongTimer) {
            clearTimeout(hoverLongTimer);
            hoverLongTimer = null;
        }
    }

    function touchActivity() {
        lastActivityTs = Date.now();
        dwellEligible = true;
    }

    function scheduleHoverLongCheck() {
        if (!heurBool("hoverLongEnabled", true)) return;
        clearHoverLongTimer();
        var anchorEl = hoverLongEl;
        if (!anchorEl) return;
        var hMs = heurNum("hoverLongMs", 1500, 200, 120000);
        hoverLongTimer = setTimeout(function () {
            hoverLongTimer = null;
            var el2 = null;
            try {
                el2 = document.elementFromPoint(lastPointer.x, lastPointer.y);
            } catch (_e) {}
            if (el2 && anchorEl && el2 === anchorEl) {
                pushSignalEvent({
                    kind: "HOVER_LONG",
                    t: Date.now(),
                    ms: hMs,
                    target_hint: coarseElementHint(anchorEl),
                });
            }
        }, hMs);
    }

    function checkDwell() {
        if (!heurBool("dwellEnabled", true)) return;
        var now = Date.now();
        if (!dwellEligible) return;
        if (now - lastActivityTs < heurNum("dwellIdleMs", 3000, 500, 120000)) return;
        dwellEligible = false;
        var w = window.innerWidth || 1;
        var h = window.innerHeight || 1;
        var cx = Math.floor(w / 2);
        var cy = Math.floor(h / 2);
        var centerEl = null;
        try {
            centerEl = document.elementFromPoint(cx, cy);
        } catch (_e) {}
        pushSignalEvent({
            kind: "DWELL",
            t: now,
            idle_ms: now - lastActivityTs,
            center_norm: { x: 0.5, y: 0.5 },
            center_hint: coarseElementHint(centerEl),
        });
    }

    function maybeConfusion() {
        if (!heurBool("confusionEnabled", true)) return;
        var now = Date.now();
        if (now - lastConfusionTs < heurNum("confusionCooldownMs", 5000, 0, 120000)) return;
        var n = moves.length;
        if (n < 4) return;
        var i;
        var startIdx = -1;
        var winMs = heurNum("confusionWindowMs", 3000, 1000, 60000);
        for (i = 0; i < n; i++) {
            if (now - moves[i].t <= winMs) {
                startIdx = i;
                break;
            }
        }
        if (startIdx < 0 || n - 1 - startIdx < 3) return;
        var path = 0;
        var reversals = 0;
        for (i = startIdx + 1; i < n; i++) {
            var a = moves[i - 1];
            var b = moves[i];
            var dt = b.t - a.t;
            if (dt <= 0) continue;
            var dx = b.x - a.x;
            var dy = b.y - a.y;
            path += Math.sqrt(dx * dx + dy * dy);
        }
        for (i = startIdx + 2; i < n; i++) {
            var p0 = moves[i - 2];
            var p1 = moves[i - 1];
            var p2 = moves[i];
            var v1x = p1.x - p0.x;
            var v1y = p1.y - p0.y;
            var v2x = p2.x - p1.x;
            var v2y = p2.y - p1.y;
            var d1 = Math.sqrt(v1x * v1x + v1y * v1y);
            var d2 = Math.sqrt(v2x * v2x + v2y * v2y);
            if (d1 < 4 || d2 < 4) continue;
            var dot = v1x * v2x + v1y * v2y;
            if (dot < 0) reversals++;
        }
        var minPath = heurNum("confusionMinPathPx", 2000, 100, 500000);
        var minRev = Math.floor(heurNum("confusionMinReversals", 3, 1, 50));
        if (path >= minPath && reversals >= minRev) {
            lastConfusionTs = now;
            pushSignalEvent({
                kind: "CONFUSION",
                t: now,
                path_px: Math.round(path),
                dir_changes: reversals,
                window_ms: winMs,
            });
        }
    }

    function sessionUrl() {
        try {
            if (window.FS && typeof window.FS.getCurrentSessionURL === "function") {
                var u = window.FS.getCurrentSessionURL(true);
                if (u && String(u).trim()) return String(u).trim();
            }
        } catch (_e) {}
        try {
            var href = window.location.href;
            if (href && href.length < 2048) return href;
        } catch (_e2) {}
        return "no-session";
    }

    function evId() {
        return "nx_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 11);
    }

    function tanh(x) {
        return Math.tanh ? Math.tanh(x) : x === 0 ? 0 : (Math.exp(x) - Math.exp(-x)) / (Math.exp(x) + Math.exp(-x));
    }

    /**
     * Coarse 16-D embedding from pointer samples + scroll + clicks (not ML-grade; dashboard-compatible).
     */
    function buildFingerprint() {
        var fp = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
        var w = window.innerWidth || 1;
        var h = window.innerHeight || 1;
        var diag = Math.sqrt(w * w + h * h) || 1;

        fp[8] = tanh(scrollDy / (diag * 2));
        fp[9] = tanh(clicks / 8);

        var n = moves.length;
        if (n < 2) {
            fp[10] = tanh(n / 10);
            return fp;
        }

        var i;
        var path = 0;
        var speeds = [];
        var idleLong = 0;
        for (i = 1; i < n; i++) {
            var a = moves[i - 1];
            var b = moves[i];
            var dt = b.t - a.t;
            if (dt <= 0) continue;
            var dx = b.x - a.x;
            var dy = b.y - a.y;
            var dist = Math.sqrt(dx * dx + dy * dy);
            path += dist;
            speeds.push(dist / dt);
            if (dt > 400) idleLong++;
        }

        var meanSpeed =
            speeds.reduce(function (s, v) {
                return s + v;
            }, 0) / (speeds.length || 1);
        var varSpeed = 0;
        for (i = 0; i < speeds.length; i++) {
            var d = speeds[i] - meanSpeed;
            varSpeed += d * d;
        }
        varSpeed = speeds.length ? Math.sqrt(varSpeed / speeds.length) : 0;

        fp[0] = tanh(Math.log(1 + n) / 4);
        fp[1] = tanh(path / diag);
        fp[2] = tanh(meanSpeed / (diag / 1000));
        fp[3] = tanh(varSpeed / (diag / 1000));
        fp[4] = tanh(idleLong / Math.max(1, n / 4));
        fp[5] = tanh((moves[n - 1].x - moves[0].x) / w);
        fp[6] = tanh((moves[n - 1].y - moves[0].y) / h);
        fp[7] = tanh(path / (meanSpeed * (moves[n - 1].t - moves[0].t + 1)));
        fp[10] = tanh(n / 40);

        return fp;
    }

    function ingestBody() {
        var body = {
            type: "kinetic",
            event_id: evId(),
            fingerprint: buildFingerprint(),
            label: label,
            session_url: sessionUrl(),
            timestamp: Date.now(),
            signal_schema_version: SIGNAL_SCHEMA_VERSION,
            signal_buffer: signalBuffer.slice(),
            css_meta: buildCssMeta(),
        };
        var uk =
            typeof window.NEXUS_USER_KEY === "string" && window.NEXUS_USER_KEY.trim()
                ? window.NEXUS_USER_KEY.trim()
                : "";
        if (uk) body.nexus_user_key = uk;
        return body;
    }

    /**
     * @returns {boolean} true if FullStory accepted the call
     */
    function trackToFullStory(body) {
        if (typeof window.FS !== "function") {
            if (!warnedNoFs) {
                warnedNoFs = true;
                if (typeof console !== "undefined" && console.warn) {
                    console.warn(
                        "[NexusSnippet] FullStory FS() not available — load the FullStory snippet before nexus-snippet.js, or set window.NEXUS_DUAL_WRITE with NEXUS_PUBLISHABLE_KEY for collector POST."
                    );
                }
            }
            return false;
        }
        var name =
            cfg.event_name != null && String(cfg.event_name).trim()
                ? String(cfg.event_name).trim()
                : eventNameDefault;
        if (name.length > 250) name = name.slice(0, 250);

        var props = {
            source: "nexus_snippet",
            type: body.type,
            event_id: body.event_id,
            label: body.label,
            timestamp: body.timestamp,
            session_url: body.session_url,
            fingerprint: body.fingerprint,
            signal_schema_version: body.signal_schema_version,
        };
        if (body.nexus_user_key) props.nexus_user_key = body.nexus_user_key;

        var bufStr = "";
        try {
            bufStr = JSON.stringify(body.signal_buffer || []);
        } catch (_eb) {}
        if (bufStr.length > 24000) bufStr = bufStr.slice(0, 24000);
        props.signal_buffer_json = bufStr;

        var cm = body.css_meta || {};
        props.surface_viewport_w = cm.viewport_w;
        props.surface_viewport_h = cm.viewport_h;
        props.surface_dpr = cm.dpr;
        props.surface_color_scheme = cm.color_scheme;
        props.surface_reduced_motion = cm.prefers_reduced_motion;
        if (cm.root_font_size_px != null) props.surface_root_font_px = cm.root_font_size_px;

        try {
            window.FS("trackEvent", { name: name, properties: props });
            return true;
        } catch (e) {
            if (typeof console !== "undefined" && console.warn) {
                console.warn("[NexusSnippet] FS trackEvent failed:", e && e.message ? e.message : e);
            }
            return false;
        }
    }

    function postToCollector(body) {
        if (!dualWrite) return;
        var base = window.NEXUS_COLLECT_BASE;
        var path = window.NEXUS_INGEST_PATH || "/v1/ingest";
        var pk = window.NEXUS_PUBLISHABLE_KEY;
        if (!pubStr || !pk) {
            if (!warnedNoKey) {
                warnedNoKey = true;
                if (typeof console !== "undefined" && console.warn) {
                    console.warn(
                        "[NexusSnippet] NEXUS_DUAL_WRITE is set but NEXUS_PUBLISHABLE_KEY is missing — collector POST skipped."
                    );
                }
            }
            return;
        }
        if (!base) return;

        var url = base.replace(/\/$/, "") + path;
        var headers = { "Content-Type": "application/json" };
        if (pk) headers.Authorization = "Bearer " + pk;

        if (typeof fetch === "function") {
            fetch(url, {
                method: "POST",
                headers: headers,
                body: JSON.stringify(body),
                keepalive: true,
                mode: "cors",
            }).catch(function () {});
        }
    }

    function flushSend(reason) {
        var why =
            reason !== undefined && reason !== null && String(reason).trim() !== ""
                ? String(reason).trim()
                : "manual";
        pushSignalEvent({
            kind: "FLUSH",
            t: Date.now(),
            flush_reason: why,
            moves_in_window: moves.length,
            scroll_delta_sum: scrollDy,
            clicks_in_window: clicks,
        });

        var body = ingestBody();
        var okFs = trackToFullStory(body);
        postToCollector(body);
        if (!okFs && !dualWrite) {
            if (!warnedNoSink) {
                warnedNoSink = true;
                if (typeof console !== "undefined" && console.warn) {
                    console.warn(
                        "[NexusSnippet] No event sink: enable FullStory before this script, or set window.NEXUS_DUAL_WRITE with publishable key + collector URL."
                    );
                }
            }
        }
        scrollDy = 0;
        clicks = 0;
        if (moves.length > 30) moves = moves.slice(-30);
    }

    var moveScheduled = false;
    function onMove(ev) {
        if (moveScheduled) return;
        moveScheduled = true;
        if (typeof requestAnimationFrame === "function") {
            requestAnimationFrame(function () {
                moveScheduled = false;
                try {
                    lastPointer.x = ev.clientX;
                    lastPointer.y = ev.clientY;
                    lastPointer.t = Date.now();
                    touchActivity();

                    moves.push({
                        t: lastPointer.t,
                        x: lastPointer.x,
                        y: lastPointer.y,
                    });
                    if (moves.length > maxMoves) moves.shift();

                    if (heurBool("hoverLongEnabled", true)) {
                        var el = null;
                        try {
                            el = document.elementFromPoint(lastPointer.x, lastPointer.y);
                        } catch (_e) {}
                        if (el !== hoverLongEl) {
                            hoverLongEl = el;
                            clearHoverLongTimer();
                            if (el) scheduleHoverLongCheck();
                        }
                    } else {
                        hoverLongEl = null;
                        clearHoverLongTimer();
                    }

                    maybeConfusion();
                } catch (_e) {}
            });
        } else {
            moveScheduled = false;
            try {
                lastPointer.x = ev.clientX;
                lastPointer.y = ev.clientY;
                lastPointer.t = Date.now();
                touchActivity();
                moves.push({ t: lastPointer.t, x: lastPointer.x, y: lastPointer.y });
                if (moves.length > maxMoves) moves.shift();
                if (heurBool("hoverLongEnabled", true)) {
                    var el = null;
                    try {
                        el = document.elementFromPoint(lastPointer.x, lastPointer.y);
                    } catch (_e2) {}
                    if (el !== hoverLongEl) {
                        hoverLongEl = el;
                        clearHoverLongTimer();
                        if (el) scheduleHoverLongCheck();
                    }
                } else {
                    hoverLongEl = null;
                    clearHoverLongTimer();
                }
                maybeConfusion();
            } catch (_e3) {}
        }
    }

    function onWheel(ev) {
        touchActivity();
        try {
            scrollDy += ev.deltaY || 0;
        } catch (_e) {}
    }

    function onClick() {
        touchActivity();
        clicks++;
    }

    function mergeRemoteConfigIntoHeuristics(data) {
        if (!data || typeof data !== "object") return;
        var h = data.heuristics;
        if (!h || typeof h !== "object" || Array.isArray(h)) return;
        var k;
        for (k in h) {
            if (Object.prototype.hasOwnProperty.call(h, k)) remoteHeur[k] = h[k];
        }
    }

    function beginCapture() {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", wire);
        } else {
            wire();
        }
    }

    function configPath() {
        var p = window.NEXUS_CONFIG_PATH;
        if (p != null && String(p).trim() !== "") {
            var s = String(p).trim();
            return s.indexOf("/") === 0 ? s : "/" + s;
        }
        return "/v1/config";
    }

    function maybeFetchRuntimeConfigThenRun() {
        if (!pubStr || !window.NEXUS_COLLECT_BASE) {
            beginCapture();
            return;
        }
        if (window.NEXUS_SKIP_RUNTIME_CONFIG === true) {
            beginCapture();
            return;
        }
        var base = String(window.NEXUS_COLLECT_BASE || "").replace(/\/$/, "");
        var url = base + configPath();
        var timeoutMs = Math.max(500, Math.min(15000, Number(window.NEXUS_CONFIG_FETCH_TIMEOUT_MS) || 2500));
        var done = false;
        function finish() {
            if (done) return;
            done = true;
            beginCapture();
        }
        var tid = setTimeout(finish, timeoutMs);
        if (typeof fetch !== "function") {
            clearTimeout(tid);
            finish();
            return;
        }
        fetch(url, {
            method: "GET",
            headers: { Authorization: "Bearer " + pubStr },
            mode: "cors",
            cache: "no-store",
        })
            .then(function (r) {
                return r.ok ? r.json() : Promise.reject(new Error("config_" + r.status));
            })
            .then(function (data) {
                mergeRemoteConfigIntoHeuristics(data);
            })
            .catch(function () {})
            .then(function () {
                clearTimeout(tid);
                finish();
            });
    }

    function wire() {
        lastActivityTs = Date.now();
        var flushMs = Math.floor(heurNum("flushMs", cfgFlushMs, 2000, 60000));
        document.addEventListener("mousemove", onMove, { passive: true });
        document.addEventListener("wheel", onWheel, { passive: true });
        document.addEventListener("click", onClick, true);
        setInterval(checkDwell, 1000);
        setInterval(function () {
            flushSend("interval");
        }, flushMs);
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "hidden") flushSend("visibility");
        });
        window.addEventListener("pagehide", function () {
            flushSend("pagehide");
        });
    }

    window.NexusSnippetFlush = flushSend;

    maybeFetchRuntimeConfigThenRun();
})();
