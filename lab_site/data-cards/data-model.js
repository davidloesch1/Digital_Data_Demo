/**
 * Shared helpers for warehouse / summary rows. Used by dashboard cards and by dashboard.js.
 */
(function (g) {
    g.NexusDataModel = {
        getSessionKey: function (row) {
            const u = row && row.session_url;
            if (!u || u === "no-session") return "no-session";
            const parts = u.split("/").filter(Boolean);
            return parts.length ? parts[parts.length - 1] : u;
        },
        isKineticEvent: function (row) {
            if (!row) return false;
            if (row.type === "nexus_label") return false;
            if (row.type === "kinetic") return true;
            return row.fingerprint && row.fingerprint.length > 1;
        },
        isNexusLabelEvent: function (row) {
            return row && row.type === "nexus_label";
        },
    };
})(typeof window !== "undefined" ? window : this);
