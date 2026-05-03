/**
 * Customer segmentation: stable visitor id for Nexus warehouse + FullStory user vars.
 * Persists to localStorage; applies window.NEXUS_USER_KEY and FS.identify when FS loads.
 */
(function () {
    if (typeof window === "undefined") return;

    var STORAGE_KEY = "nexus_segmentation_v1";

    function safeParse(raw) {
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    function readState() {
        try {
            var raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) return null;
            var o = safeParse(raw);
            if (!o || typeof o !== "object") return null;
            return o;
        } catch (e) {
            return null;
        }
    }

    function writeState(obj) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
        } catch (e) {}
    }

    /** @returns {Record<string,string>} */
    function normalizeFsVars(obj) {
        var out = {};
        if (!obj || typeof obj !== "object") return out;
        Object.keys(obj).forEach(function (k) {
            var key = String(k).trim();
            if (!key) return;
            var v = obj[k];
            if (v === undefined || v === null) return;
            out[key] = String(v).trim();
        });
        return out;
    }

    function pushToFullStory(uid, vars) {
        var FS = window.FS;
        if (!FS || !uid) return false;
        var v = vars && typeof vars === "object" ? vars : {};
        try {
            if (typeof FS.identify === "function") {
                FS.identify(uid, v);
                return true;
            }
            if (typeof FS === "function") {
                FS("setIdentity", { uid: uid, properties: v });
                return true;
            }
        } catch (e) {}
        return false;
    }

    function applyFromStorage() {
        var s = readState();
        if (!s || !s.userKey || String(s.userKey).trim() === "") {
            return;
        }
        var uid = String(s.userKey).trim();
        window.NEXUS_USER_KEY = uid;
        var vars = normalizeFsVars(s.fsVars);
        pushToFullStory(uid, vars);
    }

    applyFromStorage();

    function collectorOriginForManifest() {
        var base =
            window.NEXUS_DASH_API || window.NEXUS_COLLECT_BASE || window.NEXUS_API_BASE || "";
        base = String(base).trim().replace(/\/?$/, "");
        if (!base) return "";
        if (!/^https?:\/\//i.test(base)) {
            base =
                (/^(localhost|127\.0\.0\.1)(\:|\/|$)/i.test(base.replace(/^\/+/, ""))
                    ? "http://"
                    : "https://") + base.replace(/^\/+/, "");
        }
        return base;
    }

    async function mergeManifestFromCollector() {
        var pk =
            window.NEXUS_PUBLISHABLE_KEY && String(window.NEXUS_PUBLISHABLE_KEY).trim();
        var uid = window.NEXUS_USER_KEY && String(window.NEXUS_USER_KEY).trim();
        if (!pk || !uid) return;
        var origin = collectorOriginForManifest();
        if (!origin) return;
        try {
            var r = await fetch(
                origin + "/v1/segmentation/manifest?visitor_id=" + encodeURIComponent(uid),
                { headers: { Authorization: "Bearer " + pk } }
            );
            if (!r.ok) return;
            var j = await r.json();
            var extra = j.vars && typeof j.vars === "object" ? j.vars : {};
            var s = readState();
            var merged = Object.assign(
                {},
                normalizeFsVars(s && s.fsVars ? s.fsVars : {}),
                normalizeFsVars(extra)
            );
            if (s && s.userKey) {
                pushToFullStory(String(s.userKey).trim(), merged);
            }
        } catch (_e) {}
    }

    mergeManifestFromCollector();

    var pollTries = 0;
    var pollMax = 80;
    var pollMs = 250;
    var pollId = setInterval(function () {
        pollTries++;
        var s = readState();
        if (s && s.userKey && window.FS) {
            pushToFullStory(String(s.userKey).trim(), normalizeFsVars(s.fsVars));
            clearInterval(pollId);
            return;
        }
        if (pollTries >= pollMax) clearInterval(pollId);
    }, pollMs);

    window.NexusSegmentation = {
        STORAGE_KEY: STORAGE_KEY,
        getState: readState,
        /** @param {string} userKey @param {Record<string,string>} fsVars */
        save: function (userKey, fsVars) {
            var uid = String(userKey || "").trim();
            if (!uid) {
                throw new Error("Visitor ID is required");
            }
            var vars = normalizeFsVars(fsVars || {});
            writeState({ v: 1, userKey: uid, fsVars: vars });
            window.NEXUS_USER_KEY = uid;
            pushToFullStory(uid, vars);
            mergeManifestFromCollector();
        },
        clear: function () {
            try {
                localStorage.removeItem(STORAGE_KEY);
            } catch (e) {}
            try {
                delete window.NEXUS_USER_KEY;
            } catch (e2) {}
        },
        refreshFullStory: function () {
            var s = readState();
            if (!s || !s.userKey) return false;
            return pushToFullStory(String(s.userKey).trim(), normalizeFsVars(s.fsVars));
        },
    };
})();
