/**
 * Plain-language summaries for persona cards from kinetic points + prototype tags.
 */
(function (g) {
    function meanFingerprint(points) {
        if (!points || !points.length) return null;
        var acc = new Array(16).fill(0);
        var n = 0;
        var i;
        var j;
        for (i = 0; i < points.length; i++) {
            var fp = points[i].fp;
            if (!fp || !fp.length) continue;
            n++;
            for (j = 0; j < 16; j++) {
                acc[j] += Number(fp[j]) || 0;
            }
        }
        if (!n) return null;
        for (j = 0; j < 16; j++) acc[j] /= n;
        return acc;
    }

    /**
     * Heuristic "interpretability" scores from mean fingerprint (0–100).
     */
    function fingerprintPersonaHints(meanFp) {
        if (!meanFp || meanFp.length < 4) {
            return { pace: 50, focus: 50, exploration: 50 };
        }
        var pace = Math.min(100, Math.max(0, 40 + (Math.abs(meanFp[1]) || 0) * 120));
        var focus = Math.min(100, Math.max(0, 55 + (Math.abs(meanFp[2]) || 0) * 90));
        var exploration = Math.min(100, Math.max(0, 35 + (Math.abs(meanFp[3]) || 0) * 100));
        return {
            pace: Math.round(pace),
            focus: Math.round(focus),
            exploration: Math.round(exploration),
        };
    }

    /**
     * Group points by prototype id (matched on point.prototypeMatch.id).
     */
    function groupByPrototype(points) {
        var map = {};
        var i;
        for (i = 0; i < points.length; i++) {
            var p = points[i];
            var id = p.prototypeMatch && p.prototypeMatch.id ? p.prototypeMatch.id : "_none";
            if (!map[id]) map[id] = [];
            map[id].push(p);
        }
        return map;
    }

    /**
     * Build persona card payloads for chart strip.
     * @param {Array<object>} prototypes — from API
     * @param {Array<object>} kineticPoints
     */
    function buildPersonaCards(prototypes, kineticPoints) {
        var byProto = groupByPrototype(kineticPoints || []);
        var cards = [];
        var seen = {};
        var j;
        for (j = 0; j < (prototypes || []).length; j++) {
            var pr = prototypes[j];
            var pts = byProto[pr.id] || [];
            var mean = meanFingerprint(pts);
            var hints = fingerprintPersonaHints(mean);
            var tagLabels = [];
            if (pr.tags && pr.tags.length) {
                pr.tags.forEach(function (t) {
                    if (t.value) tagLabels.push(String(t.value));
                });
            }
            cards.push({
                id: pr.id,
                name: pr.name,
                color: pr.color || "#6366f1",
                count: pts.length,
                tags: tagLabels.slice(0, 5),
                hints: hints,
                org_slug: pr.org_slug,
            });
            seen[pr.id] = true;
        }
        var unmatched = byProto["_none"] || [];
        if (unmatched.length) {
            cards.push({
                id: "_unmatched",
                name: "Unlabeled",
                color: "#64748b",
                count: unmatched.length,
                tags: [],
                hints: fingerprintPersonaHints(meanFingerprint(unmatched)),
            });
        }
        return cards;
    }

    /**
     * Tag x prototype counts for simple heatmap table.
     */
    function buildTagHeatmap(prototypes, kineticPoints) {
        var rows = [];
        var protoById = {};
        var i;
        for (i = 0; i < (prototypes || []).length; i++) {
            protoById[prototypes[i].id] = prototypes[i].name;
        }
        var tagCounts = {};
        var p;
        for (p = 0; p < (kineticPoints || []).length; p++) {
            var pt = kineticPoints[p];
            var pid = pt.prototypeMatch && pt.prototypeMatch.id ? pt.prototypeMatch.id : null;
            var pr = prototypes.filter(function (x) {
                return x.id === pid;
            })[0];
            if (!pr || !pr.tags) continue;
            pr.tags.forEach(function (t) {
                var key = (pr.name || "") + "||" + String(t.value || "");
                tagCounts[key] = (tagCounts[key] || 0) + 1;
            });
        }
        Object.keys(tagCounts).forEach(function (k) {
            var parts = k.split("||");
            rows.push({ prototype: parts[0], tag: parts[1], n: tagCounts[k] });
        });
        return rows.sort(function (a, b) {
            return b.n - a.n;
        });
    }

    g.NexusBehaviorSummary = {
        buildPersonaCards: buildPersonaCards,
        buildTagHeatmap: buildTagHeatmap,
        fingerprintPersonaHints: fingerprintPersonaHints,
    };
})(typeof window !== "undefined" ? window : this);
