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
 *   event_name: string (default 'nexus_kinetic_fingerprint', max 250 chars for FS)
 * }
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
    var flushMs = Math.max(2000, Math.min(60000, Number(cfg.flushMs) || 8000));
    var label = (cfg.label != null && String(cfg.label).trim()) || "SITE";
    var eventNameDefault = "nexus_kinetic_fingerprint";

    var moves = [];
    var maxMoves = 120;
    var scrollDy = 0;
    var clicks = 0;
    var warnedNoKey = false;
    var warnedNoFs = false;
    var warnedNoSink = false;

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
        };
        if (body.nexus_user_key) props.nexus_user_key = body.nexus_user_key;

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

    function flushSend() {
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
                    moves.push({
                        t: Date.now(),
                        x: ev.clientX,
                        y: ev.clientY,
                    });
                    if (moves.length > maxMoves) moves.shift();
                } catch (_e) {}
            });
        } else {
            moveScheduled = false;
            moves.push({ t: Date.now(), x: ev.clientX, y: ev.clientY });
            if (moves.length > maxMoves) moves.shift();
        }
    }

    function onWheel(ev) {
        try {
            scrollDy += ev.deltaY || 0;
        } catch (_e) {}
    }

    function onClick() {
        clicks++;
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", wire);
    } else {
        wire();
    }

    function wire() {
        document.addEventListener("mousemove", onMove, { passive: true });
        document.addEventListener("wheel", onWheel, { passive: true });
        document.addEventListener("click", onClick, true);
        setInterval(flushSend, flushMs);
        document.addEventListener("visibilitychange", function () {
            if (document.visibilityState === "hidden") flushSend();
        });
        window.addEventListener("pagehide", flushSend);
    }

    window.NexusSnippetFlush = flushSend;
})();
