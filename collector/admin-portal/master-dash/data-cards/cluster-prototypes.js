/**
 * Match 16-D fingerprints to saved cluster prototypes (centroids).
 */
(function (g) {
    function normFp(fp) {
        if (!fp || !fp.length) return null;
        var out = [];
        var i;
        for (i = 0; i < 16; i++) {
            out.push(Number(fp[i]) || 0);
        }
        return out;
    }

    function parseCentroid(raw) {
        if (!raw) return null;
        if (Array.isArray(raw)) return normFp(raw);
        if (typeof raw === "object") {
            var keys = Object.keys(raw).sort(function (a, b) {
                return Number(a) - Number(b);
            });
            var arr = [];
            keys.forEach(function (k) {
                arr.push(Number(raw[k]) || 0);
            });
            return normFp(arr);
        }
        return null;
    }

    function euclidean(a, b) {
        if (!a || !b || a.length < 16 || b.length < 16) return Infinity;
        var s = 0;
        var i;
        for (i = 0; i < 16; i++) {
            var d = a[i] - b[i];
            s += d * d;
        }
        return Math.sqrt(s);
    }

    /**
     * @param {object} protoFilters
     * @param {string} activeModule
     */
    function filtersCompatible(protoFilters, activeModule) {
        if (!protoFilters || typeof protoFilters !== "object") return true;
        var m = protoFilters.challenge_module != null ? String(protoFilters.challenge_module) : "";
        if (m === "" && protoFilters.module != null) m = String(protoFilters.module);
        if (m === "") return true;
        if (!activeModule || activeModule === "") return true;
        return m === activeModule;
    }

    function numOr(x, d) {
        var n = Number(x);
        return Number.isFinite(n) ? n : d;
    }

    /**
     * @param {object | null | undefined} m — fullstory_session_metrics row
     * @param {object} th — fs_signal_thresholds from cluster filters
     */
    function fsMetricsSatisfy(m, th) {
        if (!th || typeof th !== "object") return true;
        if (!m) return false;
        var keys = Object.keys(th);
        if (!keys.length) return true;
        var ec = numOr(m.event_count, 0);
        var fr = ec > 0 ? numOr(m.frustrated_count, 0) / ec : 0;
        var dr = ec > 0 ? numOr(m.dead_count, 0) / ec : 0;
        var er = ec > 0 ? numOr(m.error_count, 0) / ec : 0;
        var sr = ec > 0 ? numOr(m.suspicious_count, 0) / ec : 0;
        var durMin = numOr(m.duration_ms, 0) / 60000;
        var cpm = durMin > 0 ? numOr(m.click_count, 0) / durMin : 0;
        var scroll = m.max_scroll_depth_pct != null ? numOr(m.max_scroll_depth_pct, 0) : null;
        var met = m.metrics && typeof m.metrics === "object" ? m.metrics : {};
        var j;
        for (j = 0; j < keys.length; j++) {
            var k = keys[j];
            var need = th[k];
            if (need == null || need === "") continue;
            var minV = numOr(need, NaN);
            if (!Number.isFinite(minV)) continue;
            if (k === "frustrated_rate_min" || k === "frustrated_pct_min") {
                if (fr < minV) return false;
            } else if (k === "dead_rate_min" || k === "dead_pct_min") {
                if (dr < minV) return false;
            } else if (k === "error_rate_min" || k === "error_pct_min") {
                if (er < minV) return false;
            } else if (k === "suspicious_rate_min") {
                if (sr < minV) return false;
            } else if (k === "clicks_per_min_min") {
                if (cpm < minV) return false;
            } else if (k === "max_scroll_depth_pct_min") {
                if (scroll == null || scroll < minV) return false;
            } else if (k === "event_count_min") {
                if (ec < minV) return false;
            } else if (k === "unique_urls_min") {
                if (numOr(m.unique_urls, 0) < minV) return false;
            } else if (k === "metrics.frustrated_rate_min" && met.frustrated_rate != null) {
                if (numOr(met.frustrated_rate, 0) < minV) return false;
            }
        }
        return true;
    }

    /**
     * @param {number[]} fp
     * @param {Array<object>} prototypes
     * @param {{ moduleFilter?: string, k?: number, pointSid?: string, sessionMetricsBySid?: Record<string, object> }} opts
     * @returns {null | { id: string, name: string, color: string, similarity: number, org_slug?: string }}
     */
    function matchFingerprint(fp, prototypes, opts) {
        opts = opts || {};
        var nf = normFp(fp);
        if (!nf || !prototypes || !prototypes.length) return null;
        var mod = opts.moduleFilter != null ? String(opts.moduleFilter) : "";
        var sid = opts.pointSid != null ? String(opts.pointSid) : "";
        var bySid = opts.sessionMetricsBySid || null;
        var best = null;
        var bestSim = -1;
        var i;
        for (i = 0; i < prototypes.length; i++) {
            var pr = prototypes[i];
            var cArr = parseCentroid(pr.centroid);
            if (!cArr) continue;
            if (!filtersCompatible(pr.filters, mod)) continue;
            var fsTh = pr.filters && pr.filters.fs_signal_thresholds;
            if (fsTh && typeof fsTh === "object" && Object.keys(fsTh).length) {
                var metrics = bySid && sid ? bySid[sid] : null;
                if (!fsMetricsSatisfy(metrics, fsTh)) continue;
            }
            var d = euclidean(nf, cArr);
            var sim = 1 / (1 + d);
            var th = pr.match_threshold != null ? Number(pr.match_threshold) : 0.85;
            if (!Number.isFinite(th) || th <= 0) th = 0.85;
            if (th > 1) th = 1;
            if (sim >= th && sim > bestSim) {
                bestSim = sim;
                best = {
                    id: pr.id,
                    name: pr.name || "Cluster",
                    color: pr.color || "#6366f1",
                    similarity: sim,
                    org_slug: pr.org_slug,
                };
            }
        }
        return best;
    }

    /**
     * @param {Array<object>} points — kinetic points with .fp
     * @param {Array<object>} prototypes
     * @param {object} opts
     */
    function enrichPoints(points, prototypes, opts) {
        if (!points || !points.length) return;
        var i;
        for (i = 0; i < points.length; i++) {
            var p = points[i];
            var o = opts ? Object.assign({}, opts) : {};
            o.pointSid = p.sid != null ? String(p.sid) : "";
            p.prototypeMatch = matchFingerprint(p.fp, prototypes, o);
        }
    }

    g.NexusClusterPrototypes = {
        matchFingerprint: matchFingerprint,
        enrichPoints: enrichPoints,
        normFp: normFp,
        parseCentroid: parseCentroid,
        fsMetricsSatisfy: fsMetricsSatisfy,
    };
})(typeof window !== "undefined" ? window : this);
