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
