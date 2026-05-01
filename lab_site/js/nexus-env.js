/**
 * Production: set your deployed collector origin here (HTTPS, no trailing slash).
 * Override per-page by defining window.NEXUS_COLLECT_BASE / window.NEXUS_DASH_API before this script.
 * Single-knob option: window.NEXUS_API_BASE applies to both collect and dashboard when others unset.
 *
 * Multi-tenant: set window.NEXUS_PUBLISHABLE_KEY (nx_pub_…) before this script (e.g. in js/nexus-env.secrets.js
 * or an inline script) to switch defaults to POST /v1/ingest and GET /v1/summary with Authorization: Bearer.
 * Override paths with NEXUS_INGEST_PATH / NEXUS_SUMMARY_PATH if needed.
 */
(function () {
    if (typeof window === "undefined") return;
    var fallback = "https://digitaldatademo-production.up.railway.app";
    var single = window.NEXUS_API_BASE;
    var collect =
        window.NEXUS_COLLECT_BASE ||
        single ||
        fallback;
    var dash = window.NEXUS_DASH_API || single || collect;
    window.NEXUS_COLLECT_BASE = String(collect).replace(/\/?$/, "");
    window.NEXUS_DASH_API = String(dash).replace(/\/?$/, "");

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
})();
