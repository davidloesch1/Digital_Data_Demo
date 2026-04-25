/**
 * BEHAVIORAL SERVICE
 * Handles AI Worker, FullStory bundle forwarding, and collector / FS hooks.
 */
const BehavioralService = (function () {
    // Worker URL: pages under subfolders set window.NEXUS_WORKER_PATH to reach lab root
    const worker = new Worker(
        (typeof window !== "undefined" && window.NEXUS_WORKER_PATH) || "worker.js"
    );

    const COLLECT_BASE =
        (typeof window !== "undefined" && window.NEXUS_COLLECT_BASE) || "http://localhost:3000";

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
        fetch(COLLECT_BASE + "/collect", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
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
            worker.postMessage({ type: "SET_LABEL", payload: label });
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
                return callback(e.data);
            };
        },
    };
})();
