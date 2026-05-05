/**
 * Master dashboard — Slice 2: session timeline deep-dive (job story 5).
 * Merges warehouse kinetic rows for the current focus (session or visitor) with FullStory events
 * already fetched by dashboard.js (GET /v1/fullstory/events or internal variant). No extra APIs.
 *
 * Slice 2 DoD (see docs/MASTER_DASH_REVAMP.md): operators can read a unified chronological table
 * in the Friction shell without curl; Guided explains sources; Analyst JSON includes a compact snapshot.
 */
(function (g) {
    "use strict";

    var MAX_RENDER = 220;
    var MAX_ANALYST_PREVIEW = 48;

    var ctx = {
        getViewScope: function () {
            return { mode: "all", sid: null, visitorKey: null, showPopulation: false };
        },
        getLastFsEvents: function () {
            return [];
        },
        getGlobalSessions: function () {
            return {};
        },
        getKineticPoints: function () {
            return [];
        },
        getM: function () {
            return null;
        },
        collectVisitorRows: function () {
            return [];
        },
        scrollToChartTimeline: function () {},
    };

    var lastSnapshot = null;

    function $(id) {
        return document.getElementById(id);
    }

    function readSignalBuffer(row) {
        if (!row || typeof row !== "object") return [];
        var b = row.signal_buffer;
        if (Array.isArray(b)) return b;
        if (row.signal_buffer_json != null) {
            var s = String(row.signal_buffer_json).trim();
            if (!s) return [];
            try {
                var j = JSON.parse(s);
                return Array.isArray(j) ? j : [];
            } catch (_e) {
                return [];
            }
        }
        return [];
    }

    function summarizeBuffer(buf) {
        if (!buf || !buf.length) return "—";
        var parts = [];
        var i;
        for (i = 0; i < buf.length; i++) {
            var e = buf[i];
            if (!e || typeof e !== "object") continue;
            var k = e.kind != null ? String(e.kind) : "?";
            var ph = e.phase != null ? "/" + String(e.phase) : "";
            parts.push(k + ph);
        }
        return parts.length ? parts.join(", ") : "—";
    }

    function parseFsPayloadTime(ev) {
        var s = ev.EventStart || ev.eventstart || ev.event_start;
        if (!s) return NaN;
        return Date.parse(String(s));
    }

    function fsEventSummary(ev) {
        var t = String(ev.EventType || ev.event_type || ev.type || "").trim() || "event";
        var tgt = ev.TargetSelector || ev.target_selector || ev.TargetText || ev.target_text;
        if (tgt) return t + " · " + String(tgt).slice(0, 120);
        return t;
    }

    function rowTimestampMs(row) {
        var ts = row && row.timestamp != null ? Number(row.timestamp) : NaN;
        return Number.isFinite(ts) ? ts : NaN;
    }

    function prototypeForRow(row) {
        var pts = ctx.getKineticPoints() || [];
        var i;
        for (i = 0; i < pts.length; i++) {
            if (pts[i].original === row) {
                return pts[i].prototypeMatch || null;
            }
        }
        return null;
    }

    function prototypeLabel(pm) {
        if (!pm) return "—";
        var n = pm.name != null ? String(pm.name) : "";
        var sim =
            pm.similarity != null && Number.isFinite(Number(pm.similarity))
                ? Number(pm.similarity).toFixed(2)
                : null;
        if (n && sim != null) return n + " · sim " + sim;
        if (n) return n;
        return "—";
    }

    function kineticRowsForScope() {
        var vs = ctx.getViewScope();
        var M = ctx.getM();
        if (!M) return [];
        if (vs.mode === "session" && vs.sid) {
            return (ctx.getGlobalSessions()[String(vs.sid)] || []).filter(function (r) {
                return M.isKineticEvent(r);
            });
        }
        if (vs.mode === "user" && vs.visitorKey) {
            return (ctx.collectVisitorRows(String(vs.visitorKey).trim()) || []).filter(function (r) {
                return M.isKineticEvent(r);
            });
        }
        return [];
    }

    function buildMergedEvents() {
        var out = [];
        var kin = kineticRowsForScope();
        var i;
        for (i = 0; i < kin.length; i++) {
            var row = kin[i];
            var t = rowTimestampMs(row);
            var pm = prototypeForRow(row);
            out.push({
                sortKey: Number.isFinite(t) ? t : -Infinity,
                timeMs: t,
                source: "kinetic",
                summary: row.label != null ? String(row.label) : "—",
                detail: summarizeBuffer(readSignalBuffer(row)),
                prototype: prototypeLabel(pm),
            });
        }
        var fsEv = ctx.getLastFsEvents() || [];
        for (i = 0; i < fsEv.length; i++) {
            var ev = fsEv[i];
            var tx = parseFsPayloadTime(ev);
            if (!Number.isFinite(tx)) continue;
            out.push({
                sortKey: tx,
                timeMs: tx,
                source: "fullstory",
                summary: fsEventSummary(ev),
                detail: "",
                prototype: "—",
            });
        }
        out.sort(function (a, b) {
            if (a.sortKey !== b.sortKey) return a.sortKey - b.sortKey;
            var sa = a.source === "kinetic" ? 0 : 1;
            var sb = b.source === "kinetic" ? 0 : 1;
            return sa - sb;
        });
        return out;
    }

    function scopeTitle() {
        var vs = ctx.getViewScope();
        if (vs.mode === "session" && vs.sid) return "Session #" + String(vs.sid);
        if (vs.mode === "user" && vs.visitorKey) return "Visitor · " + String(vs.visitorKey).slice(0, 48);
        return "No focus";
    }

    function render() {
        var merged = buildMergedEvents();
        var cap = $("dash-session-timeline-caption");
        var tb = $("dash-session-timeline-body");
        var title = $("dash-session-timeline-scope");
        if (title) title.textContent = scopeTitle();

        var vs = ctx.getViewScope();
        if (vs.mode === "all" || (vs.mode === "session" && !vs.sid) || (vs.mode === "user" && !vs.visitorKey)) {
            if (cap) {
                cap.textContent =
                    "Focus a session from the review queue, friction context table, or session list — or a visitor from the Exploration strip. Kinetic rows and ingested FullStory events merge here.";
            }
            if (tb) {
                tb.innerHTML = "";
                var tr = document.createElement("tr");
                var td = document.createElement("td");
                td.colSpan = 5;
                td.className = "dash-friction-table__empty";
                td.textContent = "No session or visitor focus.";
                tr.appendChild(td);
                tb.appendChild(tr);
            }
            lastSnapshot = {
                view_scope: vs,
                merged_total: 0,
                kinetic_in_scope: 0,
                fs_in_scope: 0,
                preview: [],
                truncated: false,
            };
            return;
        }

        var kinN = kineticRowsForScope().length;
        var fsN = (ctx.getLastFsEvents() || []).filter(function (ev) {
            return Number.isFinite(parseFsPayloadTime(ev));
        }).length;

        if (cap) {
            cap.textContent =
                merged.length +
                " merged event(s) · " +
                kinN +
                " kinetic row(s) · " +
                fsN +
                " FullStory event(s) with timestamps";
        }

        var truncated = merged.length > MAX_RENDER;
        var slice = merged.slice(0, MAX_RENDER);

        if (tb) {
            tb.innerHTML = "";
            var r;
            for (r = 0; r < slice.length; r++) {
                var e = slice[r];
                var tr2 = document.createElement("tr");
                var tdT = document.createElement("td");
                tdT.className = "dash-friction-table__mono";
                tdT.textContent = Number.isFinite(e.timeMs)
                    ? new Date(e.timeMs).toISOString().replace("T", " ").slice(0, 19) + " UTC"
                    : "—";
                var tdS = document.createElement("td");
                tdS.textContent = e.source === "kinetic" ? "Kinetic" : "FullStory";
                var tdSm = document.createElement("td");
                tdSm.textContent = e.summary || "—";
                var tdD = document.createElement("td");
                tdD.className = "dash-session-timeline__detail";
                tdD.textContent = e.detail || "—";
                var tdP = document.createElement("td");
                tdP.className = "dash-friction-table__mono";
                tdP.textContent = e.prototype || "—";
                tr2.appendChild(tdT);
                tr2.appendChild(tdS);
                tr2.appendChild(tdSm);
                tr2.appendChild(tdD);
                tr2.appendChild(tdP);
                tb.appendChild(tr2);
            }
            if (truncated) {
                var tr3 = document.createElement("tr");
                var td3 = document.createElement("td");
                td3.colSpan = 5;
                td3.className = "dash-friction-table__empty";
                td3.textContent = "Showing first " + MAX_RENDER + " of " + merged.length + " — narrow date range or use Analyst JSON export.";
                tr3.appendChild(td3);
                tb.appendChild(tr3);
            }
        }

        var prev = merged.slice(0, MAX_ANALYST_PREVIEW).map(function (x) {
            return {
                time_ms: x.timeMs,
                source: x.source,
                summary: x.summary,
                detail: x.detail,
                prototype: x.prototype,
            };
        });
        lastSnapshot = {
            view_scope: vs,
            merged_total: merged.length,
            kinetic_in_scope: kinN,
            fs_in_scope: fsN,
            preview: prev,
            truncated: truncated || merged.length > MAX_ANALYST_PREVIEW,
        };
    }

    g.NexusSessionTimelineDive = {
        init: function (c) {
            Object.assign(ctx, c);
            var btn = $("dash-session-timeline-scroll-explore");
            if (btn) {
                btn.addEventListener("click", function () {
                    if (ctx.scrollToChartTimeline) ctx.scrollToChartTimeline();
                });
            }
            render();
        },
        refresh: function () {
            render();
        },
        getAnalystSnapshot: function () {
            return lastSnapshot;
        },
    };
})(typeof window !== "undefined" ? window : this);
