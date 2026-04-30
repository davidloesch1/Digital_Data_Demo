/**
 * Production: set your deployed collector origin here (HTTPS, no trailing slash).
 * Override per-page by defining window.NEXUS_COLLECT_BASE / window.NEXUS_DASH_API before this script.
 * Single-knob option: window.NEXUS_API_BASE applies to both collect and dashboard when others unset.
 */
(function () {
    if (typeof window === "undefined") return;
    var fallback = "digitaldatademo-production.up.railway.app";
    var single = window.NEXUS_API_BASE;
    var collect =
        window.NEXUS_COLLECT_BASE ||
        single ||
        fallback;
    var dash = window.NEXUS_DASH_API || single || collect;
    window.NEXUS_COLLECT_BASE = String(collect).replace(/\/?$/, "");
    window.NEXUS_DASH_API = String(dash).replace(/\/?$/, "");
})();
