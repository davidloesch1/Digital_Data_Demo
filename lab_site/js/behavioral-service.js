/**
 * BEHAVIORAL SERVICE
 * Handles AI Worker, FullStory bundle forwarding, and collector / FS hooks.
 */
const BehavioralService = (function () {
    // Worker URL: pages under subfolders set window.NEXUS_WORKER_PATH to reach lab root
    const worker = new Worker(
        (typeof window !== "undefined" && window.NEXUS_WORKER_PATH) || "worker.js"
    );

    var COLLECT_BASE_RAW =
        (typeof window !== "undefined" && window.NEXUS_COLLECT_BASE) || "http://localhost:3000";
    var COLLECT_BASE = String(COLLECT_BASE_RAW).replace(/\/?$/, "");
    var INGEST_PATH =
        (typeof window !== "undefined" && window.NEXUS_INGEST_PATH) || "/collect";
    var PUBLISHABLE_KEY =
        typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
            ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
            : "";

    worker.postMessage({
        type: "CONFIG",
        collectBase: COLLECT_BASE,
        ingestPath: INGEST_PATH,
        publishableKey: PUBLISHABLE_KEY,
    });

    function ingestHeaders() {
        var h = { "Content-Type": "application/json" };
        if (PUBLISHABLE_KEY) h.Authorization = "Bearer " + PUBLISHABLE_KEY;
        return h;
    }

    /** Challenge id from the host page (matches data/challenges.json). Worker receives the same for kinetic rows. */
    function getChallengeModule() {
        if (typeof window === "undefined") return null;
        var m = window.NEXUS_CHALLENGE_MODULE;
        if (m === undefined || m === null) return null;
        var s = String(m).trim();
        return s === "" ? null : s;
    }

    /** Optional stable visitor id for cross-session aggregation on the dashboard (e.g. set from localStorage). */
    function getUserKey() {
        if (typeof window === "undefined") return null;
        var u = window.NEXUS_USER_KEY;
        if (u === undefined || u === null) return null;
        var s = String(u).trim();
        return s === "" ? null : s;
    }

    function newEventId() {
        if (typeof crypto !== "undefined" && crypto.randomUUID) {
            return crypto.randomUUID();
        }
        return "evt_" + Date.now() + "_" + Math.random().toString(16).slice(2);
    }

    /** Resolves a replay link for the current capture (FS v1 method or v2 getSession). */
    function getFullStorySessionUrl() {
        if (typeof window === "undefined" || !window.FS) {
            return "no-session";
        }
        const fs = window.FS;
        try {
            if (typeof fs.getCurrentSessionURL === "function") {
                const a = fs.getCurrentSessionURL();
                if (a) return a;
            }
            if (typeof fs === "function") {
                const s = fs("getSession", { format: "url" });
                if (s && typeof s.then !== "function") return s;
                const t = fs("getSession", { format: "url.now" });
                if (t && typeof t.then !== "function") return t;
            }
        } catch (e) {
            /* ignore */
        }
        return "no-session";
    }

    function postNexusLabel(phase) {
        if (phase === "none") return;
        const payload = {
            type: "nexus_label",
            event_id: newEventId(),
            label: phase,
            session_url: getFullStorySessionUrl(),
            timestamp: Date.now(),
        };
        var cm = getChallengeModule();
        if (cm) payload.challenge_module = cm;
        var uk = getUserKey();
        if (uk) payload.nexus_user_key = uk;
        fetch(COLLECT_BASE + INGEST_PATH, {
            method: "POST",
            headers: ingestHeaders(),
            body: JSON.stringify(payload),
        }).catch(function () {});
    }

    // Intercept FullStory Network Bundles
    const oldSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function (body) {
        if (this._url && this._url.includes("rs.fullstory.com/rec/bundle")) {
            worker.postMessage({
                payload: body,
                sessionUrl: getFullStorySessionUrl(),
            });
        }
        return oldSend.apply(this, arguments);
    };

    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) {
        this._url = u;
        return oldOpen.apply(this, arguments);
    };

    return {
        setLabel: function (label) {
            worker.postMessage({
                type: "SET_LABEL",
                payload: label,
                challenge_module: getChallengeModule(),
                nexus_user_key: getUserKey(),
            });
            if (label !== "none" && window.FS && typeof FS.event === "function") {
                try {
                    FS.event("Nexus label", { phase: label, source: "nexus_lab" });
                } catch (e) {
                    /* ignore */
                }
            }
            postNexusLabel(label);
        },
        onSignal: function (callback) {
            worker.onmessage = function (e) {
                var data = e.data;
                var out = callback(data);
                if (
                    data &&
                    data.type === "STATUS" &&
                    typeof document !== "undefined"
                ) {
                    var el = document.getElementById("dev-status");
                    if (el) {
                        var line = "AI: " + data.msg;
                        if (data.detail) line += " — " + data.detail;
                        el.textContent = line;
                    }
                }
                return out;
            };
        },
    };
})();
