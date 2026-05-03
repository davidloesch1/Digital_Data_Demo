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

    function numOr(x, d) {
        var n = Number(x);
        return Number.isFinite(n) ? n : d;
    }

    /**
     * Roll up FullStory session metrics for kinetic points in a group.
     * @param {Array<object>} pts
     * @param {Record<string, object>} sessionMetricsBySid
     */
    function aggregateFsSignals(pts, sessionMetricsBySid) {
        if (!pts || !pts.length || !sessionMetricsBySid) return null;
        var frs = [];
        var drs = [];
        var ers = [];
        var cpms = [];
        var scrolls = [];
        var nSess = 0;
        var p;
        for (p = 0; p < pts.length; p++) {
            var sid = pts[p].sid != null ? String(pts[p].sid) : "";
            var m = sid ? sessionMetricsBySid[sid] : null;
            if (!m) continue;
            nSess++;
            var ec = numOr(m.event_count, 0);
            if (ec > 0) {
                frs.push(numOr(m.frustrated_count, 0) / ec);
                drs.push(numOr(m.dead_count, 0) / ec);
                ers.push(numOr(m.error_count, 0) / ec);
            }
            var durMin = numOr(m.duration_ms, 0) / 60000;
            cpms.push(durMin > 0 ? numOr(m.click_count, 0) / durMin : 0);
            if (m.max_scroll_depth_pct != null) scrolls.push(numOr(m.max_scroll_depth_pct, 0));
        }
        if (!nSess) return null;
        function avg(arr) {
            if (!arr.length) return null;
            var s = 0;
            var i;
            for (i = 0; i < arr.length; i++) s += arr[i];
            return Math.round((s / arr.length) * 1000) / 1000;
        }
        return {
            sessions_with_fs: nSess,
            frustrated_pct_avg: avg(frs),
            dead_pct_avg: avg(drs),
            error_pct_avg: avg(ers),
            clicks_per_min_avg: avg(cpms),
            max_scroll_depth_avg: avg(scrolls),
        };
    }

    /**
     * Build persona card payloads for chart strip.
     * @param {Array<object>} prototypes — from API
     * @param {Array<object>} kineticPoints
     * @param {Record<string, object>} [sessionMetricsBySid]
     */
    function buildPersonaCards(prototypes, kineticPoints, sessionMetricsBySid) {
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
                    if (t.value) tagLabels.push({ kind: t.tag_kind || "note", text: String(t.value) });
                });
            }
            var fsAgg = aggregateFsSignals(pts, sessionMetricsBySid || null);
            cards.push({
                id: pr.id,
                name: pr.name,
                color: pr.color || "#6366f1",
                count: pts.length,
                tags: tagLabels.slice(0, 8),
                hints: hints,
                org_slug: pr.org_slug,
                fs: fsAgg,
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
                fs: aggregateFsSignals(unmatched, sessionMetricsBySid || null),
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

    function protoIdFromPoint(pt) {
        if (pt && pt.prototypeMatch && pt.prototypeMatch.id) return String(pt.prototypeMatch.id);
        return "__none";
    }

    function labelFromRow(r) {
        if (!r) return "(no row)";
        if (r.label) return String(r.label);
        if (r.challenge_module) return String(r.challenge_module);
        return "(unlabeled)";
    }

    /**
     * Wall-clock timeline: y = prototype lane, x = timestamp ms.
     * @returns {{ lanes: Array<{id:string,name:string,color:string,laneIndex:number}>, events: Array<{t:number,lane:number,sid:string,label:string,similarity:number|null}> }}
     */
    function buildPrototypeTimeline(points) {
        var laneMeta = {};
        var p;
        for (p = 0; p < (points || []).length; p++) {
            var pt = points[p];
            var id = protoIdFromPoint(pt);
            if (!laneMeta[id]) {
                laneMeta[id] = {
                    id: id,
                    name:
                        id === "__none"
                            ? "Unmatched"
                            : pt.prototypeMatch && pt.prototypeMatch.name
                              ? String(pt.prototypeMatch.name)
                              : id,
                    color:
                        pt.prototypeMatch && pt.prototypeMatch.color ? pt.prototypeMatch.color : "#64748b",
                };
            }
        }
        var laneIds = Object.keys(laneMeta);
        laneIds.sort(function (a, b) {
            if (a === "__none") return 1;
            if (b === "__none") return -1;
            return (laneMeta[a].name || "").localeCompare(laneMeta[b].name || "");
        });
        var lanes = [];
        var li;
        for (li = 0; li < laneIds.length; li++) {
            var lid = laneIds[li];
            var lm = laneMeta[lid];
            lanes.push({
                id: lid,
                name: lm.name,
                color: lm.color,
                laneIndex: li,
            });
            lm.laneIndex = li;
        }
        var events = [];
        for (p = 0; p < (points || []).length; p++) {
            pt = points[p];
            var ts = pt.row && pt.row.timestamp;
            var t = ts ? Date.parse(String(ts)) : NaN;
            if (!Number.isFinite(t)) continue;
            id = protoIdFromPoint(pt);
            var laneIdx = laneMeta[id].laneIndex;
            events.push({
                t: t,
                lane: laneIdx,
                sid: pt.sid || "",
                label: pt.row && pt.row.label ? String(pt.row.label) : "",
                similarity:
                    pt.prototypeMatch && pt.prototypeMatch.similarity != null
                        ? pt.prototypeMatch.similarity
                        : null,
            });
        }
        events.sort(function (a, b) {
            return a.t - b.t;
        });
        return { lanes: lanes, events: events };
    }

    /**
     * Top labels per prototype cluster match.
     */
    function buildLabelBreakdown(points, opts) {
        opts = opts || {};
        var topN = opts.topPerProto != null ? opts.topPerProto : 8;
        var byProto = {};
        var i;
        for (i = 0; i < (points || []).length; i++) {
            var pt = points[i];
            var pid = protoIdFromPoint(pt);
            if (!byProto[pid]) {
                byProto[pid] = {
                    id: pid,
                    name:
                        pid === "__none"
                            ? "Unmatched"
                            : pt.prototypeMatch && pt.prototypeMatch.name
                              ? String(pt.prototypeMatch.name)
                              : pid,
                    color:
                        pt.prototypeMatch && pt.prototypeMatch.color ? pt.prototypeMatch.color : "#64748b",
                    total: 0,
                    labelCounts: {},
                };
            }
            var pb = byProto[pid];
            pb.total++;
            var lab = labelFromRow(pt.row);
            pb.labelCounts[lab] = (pb.labelCounts[lab] || 0) + 1;
        }
        var out = [];
        Object.keys(byProto).forEach(function (pid) {
            var block = byProto[pid];
            var pairs = Object.keys(block.labelCounts).map(function (lab) {
                return { label: lab, count: block.labelCounts[lab] };
            });
            pairs.sort(function (a, b) {
                return b.count - a.count;
            });
            var labels = pairs.slice(0, topN).map(function (x) {
                return {
                    label: x.label,
                    count: x.count,
                    share: block.total ? x.count / block.total : 0,
                };
            });
            out.push({
                id: block.id,
                name: block.name,
                color: block.color,
                total: block.total,
                labels: labels,
            });
        });
        out.sort(function (a, b) {
            return (b.total || 0) - (a.total || 0);
        });
        return out;
    }

    /**
     * Consecutive prototype transitions within each session (by timestamp).
     */
    function buildTransitionMatrix(points) {
        var bySid = {};
        var i;
        for (i = 0; i < (points || []).length; i++) {
            var pt = points[i];
            var sid = pt.sid || "_nosid";
            if (!bySid[sid]) bySid[sid] = [];
            bySid[sid].push(pt);
        }
        var ids = [];
        var seen = {};
        Object.keys(bySid).forEach(function (sid) {
            var seq = bySid[sid];
            seq.sort(function (a, b) {
                var ta = a.row && a.row.timestamp ? Date.parse(String(a.row.timestamp)) : 0;
                var tb = b.row && b.row.timestamp ? Date.parse(String(b.row.timestamp)) : 0;
                if (!Number.isFinite(ta)) ta = 0;
                if (!Number.isFinite(tb)) tb = 0;
                return ta - tb;
            });
            var j;
            for (j = 0; j < seq.length; j++) {
                var id = protoIdFromPoint(seq[j]);
                if (!seen[id]) {
                    seen[id] = true;
                    ids.push(id);
                }
            }
        });
        ids.sort(function (a, b) {
            if (a === "__none") return 1;
            if (b === "__none") return -1;
            return a.localeCompare(b);
        });
        var index = {};
        for (i = 0; i < ids.length; i++) index[ids[i]] = i;
        var n = ids.length;
        var matrix = [];
        for (i = 0; i < n; i++) {
            matrix[i] = [];
            var j;
            for (j = 0; j < n; j++) matrix[i][j] = 0;
        }
        Object.keys(bySid).forEach(function (sid) {
            var seq = bySid[sid];
            for (i = 0; i < seq.length - 1; i++) {
                var a = protoIdFromPoint(seq[i]);
                var b = protoIdFromPoint(seq[i + 1]);
                if (index[a] === undefined || index[b] === undefined) continue;
                matrix[index[a]][index[b]]++;
            }
        });
        var names = {};
        var colors = {};
        for (i = 0; i < (points || []).length; i++) {
            var pt2 = points[i];
            var pid = protoIdFromPoint(pt2);
            names[pid] =
                pid === "__none"
                    ? "Unmatched"
                    : pt2.prototypeMatch && pt2.prototypeMatch.name
                      ? String(pt2.prototypeMatch.name)
                      : pid;
            colors[pid] =
                pt2.prototypeMatch && pt2.prototypeMatch.color ? pt2.prototypeMatch.color : "#64748b";
        }
        ids.forEach(function (id) {
            if (!names[id])
                names[id] = id === "__none" ? "Unmatched" : id;
            if (!colors[id]) colors[id] = "#64748b";
        });
        return { ids: ids, names: names, colors: colors, matrix: matrix };
    }

    g.NexusBehaviorSummary = {
        buildPersonaCards: buildPersonaCards,
        buildTagHeatmap: buildTagHeatmap,
        fingerprintPersonaHints: fingerprintPersonaHints,
        buildPrototypeTimeline: buildPrototypeTimeline,
        buildLabelBreakdown: buildLabelBreakdown,
        buildTransitionMatrix: buildTransitionMatrix,
    };
})(typeof window !== "undefined" ? window : this);
