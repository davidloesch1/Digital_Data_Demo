/**
 * Mirror of packages/browser/nexus-snippet.js — update both when changing capture logic.
 * Served publicly at GET /sdk/nexus-snippet.js (no auth).
 */
/**
 * Nexus minimal browser capture — self-contained (includes collector URL wiring).
 * Keep env normalization in sync with lab_console/js/nexus-env.js when that file changes.
 *
 * Expects before load (inline script): window.NEXUS_PUBLISHABLE_KEY, window.NEXUS_API_BASE
 * Optional: window.NexusSnippet = { label, flushMs, challenge_module, disabled }
 * Optional: window.NEXUS_USER_KEY for per-visitor clustering when you set it elsewhere.
 */
(function () {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    /* --- nexus-env (subset; mirrors lab_console/js/nexus-env.js) --- */
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
    var fallback = "https://digitaldatademo-production.up.railway.app";
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

    /* --- snippet --- */
    var cfg = window.NexusSnippet && typeof window.NexusSnippet === "object" ? window.NexusSnippet : {};
    if (cfg.disabled) return;

    var flushMs = Math.max(2000, Math.min(60000, Number(cfg.flushMs) || 8000));
    var label = (cfg.label != null && String(cfg.label).trim()) || "SITE";
    var challengeModule =
        (cfg.challenge_module != null && String(cfg.challenge_module).trim()) || "site-generic";

    var moves = [];
    var maxMoves = 120;
    var scrollDy = 0;
    var clicks = 0;
    var warnedNoKey = false;

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

    function clamp(n, lo, hi) {
        return Math.max(lo, Math.min(hi, n));
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
            challenge_module: challengeModule,
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

    function post(body) {
        var base = window.NEXUS_COLLECT_BASE;
        var path = window.NEXUS_INGEST_PATH || "/v1/ingest";
        var pk = window.NEXUS_PUBLISHABLE_KEY;
        if (!pubStr || !pk) {
            if (!warnedNoKey) {
                warnedNoKey = true;
                if (typeof console !== "undefined" && console.warn)
                    console.warn("[NexusSnippet] Set window.NEXUS_PUBLISHABLE_KEY before loading nexus-snippet.js");
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
        post(body);
        scrollDy = 0;
        clicks = 0;
        /* keep last 30 moves for continuity */
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
