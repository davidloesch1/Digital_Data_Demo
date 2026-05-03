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

    /**
     * @param {number[]} fp
     * @param {Array<object>} prototypes
     * @param {{ moduleFilter?: string, k?: number }} opts
     * @returns {null | { id: string, name: string, color: string, similarity: number, org_slug?: string }}
     */
    function matchFingerprint(fp, prototypes, opts) {
        opts = opts || {};
        var nf = normFp(fp);
        if (!nf || !prototypes || !prototypes.length) return null;
        var mod = opts.moduleFilter != null ? String(opts.moduleFilter) : "";
        var best = null;
        var bestSim = -1;
        var i;
        for (i = 0; i < prototypes.length; i++) {
            var pr = prototypes[i];
            var cArr = parseCentroid(pr.centroid);
            if (!cArr) continue;
            if (!filtersCompatible(pr.filters, mod)) continue;
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
            p.prototypeMatch = matchFingerprint(p.fp, prototypes, opts);
        }
    }

    g.NexusClusterPrototypes = {
        matchFingerprint: matchFingerprint,
        enrichPoints: enrichPoints,
        normFp: normFp,
        parseCentroid: parseCentroid,
    };
})(typeof window !== "undefined" ? window : this);
