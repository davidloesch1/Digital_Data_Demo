/**
 * Local attempt counts on top of a baseline. Replace with API in production.
 */
const Metrics = (function () {
    const KEY = "nexus-lab-local-attempts";

    function read() {
        try {
            return JSON.parse(localStorage.getItem(KEY) || "{}");
        } catch {
            return {};
        }
    }

    function getDisplayCount(challengeId, baseline) {
        return Math.max(0, baseline) + (read()[challengeId] || 0);
    }

    function recordAttempt(challengeId) {
        const o = read();
        o[challengeId] = (o[challengeId] || 0) + 1;
        localStorage.setItem(KEY, JSON.stringify(o));
    }

    function formatCount(n) {
        if (n >= 1_000_000) {
            return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
        }
        if (n >= 10_000) {
            return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
        }
        if (n >= 1_000) {
            return n.toLocaleString();
        }
        return String(n);
    }

    return { getDisplayCount, recordAttempt, formatCount };
})();
