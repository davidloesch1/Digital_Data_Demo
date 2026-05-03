/**
 * Reverse lookup: FullStory URL fragment or visitor key → warehouse rows via collector search API.
 */
(function (g) {
    /**
     * Extract last path segment as session-ish id from a FullStory replay URL.
     */
    function sessionTokenFromUrl(url) {
        if (!url || typeof url !== "string") return "";
        var s = url.trim();
        if (!s) return "";
        try {
            var u = new URL(s);
            var parts = u.pathname.split("/").filter(Boolean);
            return parts.length ? parts[parts.length - 1] : "";
        } catch (_e) {
            var p = s.split("/").filter(Boolean);
            return p.length ? p[p.length - 1] : s;
        }
    }

    /**
     * Build search URL for org or internal master.
     * @param {{ internal: boolean, baseUrl: string }} api
     * @param {{ mode: 'session'|'visitor', sessionUrl?: string, visitorKey?: string, since?: string, until?: string, limit?: number, orgSlug?: string }} q
     */
    function buildSearchUrl(api, q) {
        var base = api.baseUrl.replace(/\/?$/, "");
        var params = new URLSearchParams();
        if (q.limit) params.set("limit", String(q.limit));
        if (q.since) params.set("since", q.since);
        if (q.until) params.set("until", q.until);
        if (api.internal) {
            if (q.orgSlug) params.set("org_slug", q.orgSlug);
            if (q.mode === "session" && q.sessionUrl) {
                params.set("session_url", q.sessionUrl);
            } else if (q.mode === "visitor" && q.visitorKey) {
                params.set("visitor_key", q.visitorKey);
            }
            return base + "/internal/v1/search/events?" + params.toString();
        }
        if (q.mode === "session" && q.sessionUrl) {
            params.set("session_url", q.sessionUrl);
        } else if (q.mode === "visitor" && q.visitorKey) {
            params.set("visitor_key", q.visitorKey);
        }
        return base + "/v1/search/events?" + params.toString();
    }

    g.NexusReverseSearch = {
        sessionTokenFromUrl: sessionTokenFromUrl,
        buildSearchUrl: buildSearchUrl,
    };
})(typeof window !== "undefined" ? window : this);
