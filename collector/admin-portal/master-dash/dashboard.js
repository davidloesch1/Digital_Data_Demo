/**
 * Discovery dashboard: warehouse summary → K-means cloud + archetype radar.
 */
(function () {
    const API_BASE = (typeof window !== "undefined" && window.NEXUS_DASH_API) || "http://localhost:3000";
    const DIRECT_SUMMARY_URL =
        typeof window !== "undefined" && window.NEXUS_DASH_DIRECT_SUMMARY_URL
            ? String(window.NEXUS_DASH_DIRECT_SUMMARY_URL).trim()
            : "";
    const MASTER_ORG_SCOPE =
        typeof window !== "undefined" && Boolean(window.NEXUS_DASH_MASTER_ORG_SCOPE);
    /** Browser session only — same secret as collector INTERNAL_ADMIN_TOKEN for /internal/v1/*. */
    const INTERNAL_ADMIN_TOKEN_STORAGE_KEY = "nexus_internal_admin_token";
    const M = typeof NexusDataModel !== "undefined" ? NexusDataModel : null;

    function getMasterInternalAdminToken() {
        if (typeof window === "undefined") return "";
        var w =
            window.NEXUS_LOCAL_MASTER_TOKEN != null ? String(window.NEXUS_LOCAL_MASTER_TOKEN).trim() : "";
        if (w) return w;
        try {
            var s = sessionStorage.getItem(INTERNAL_ADMIN_TOKEN_STORAGE_KEY);
            return s != null ? String(s).trim() : "";
        } catch (_e) {
            return "";
        }
    }

    /** Fixed order: cluster slot i always uses CLUSTER_COLORS[i % length]. */
    const CLUSTER_COLORS = [
        "#6366f1",
        "#10b981",
        "#f59e0b",
        "#ef4444",
        "#a855f7",
        "#06b6d4",
        "#ec4899",
        "#84cc16",
        "#eab308",
        "#f97316",
    ];
    const LS_K_KEY = "nexus_dash_k_max";
    const LS_MODULE_KEY = "nexus_dash_module_filter";
    const LS_GRAN_KEY = "nexus_dash_granularity";
    const LS_DIM_SCOPE_KEY = "nexus_dash_dim_scope";
    const LS_DIM_CHALLENGE_KEY = "nexus_dash_dim_challenge";
    const MAX_DIM_BARS = 20;

    let cloudChart = null;
    let radarCtrl = null;
    let globalSessions = {};
    let globalCentroids = [];
    let lastKineticPoints = [];
    let selectedSid = null;
    let selectedUserKey = null;
    let lastWarehouseRows = [];
    /** Focus scope: narrows charts to one session or visitor; optional population ghost. */
    let viewScope = { mode: "all", sid: null, visitorKey: null, showPopulation: false };
    let lastAxisTitles = { x: "PC1", y: "PC2" };
    let lastPcaEmptyHint = null;
    /** After reverse search, auto-apply session or user focus when rows load. */
    let pendingReverseFocus = null;
    /** Warehouse rows came from reverse search (Show all should refetch summary). */
    let datasetFromReverseSearch = false;
    let prototypeTimelineChart = null;
    let dimensionCharts = [];
    /** Saved cluster prototypes from GET /v1/clusters or GET /internal/v1/clusters */
    let behaviorPrototypes = [];
    /** Last k-means result (same order as chart). */
    let lastClusterResult = { clusters: [], centroids: [] };
    /** FullStory Event Stream payloads for the current session/visitor focus (from collector). */
    let lastFsEvents = [];
    /** Map session key → fullstory_session_metrics row (for prototype thresholds + persona FS block). */
    let fsSessionMetricsBySid = {};

    function $(id) {
        return document.getElementById(id);
    }

    function normalizeFingerprint(row) {
        var fp = row && row.fingerprint;
        if (!fp || !fp.length) return null;
        var out = fp.slice(0, 16);
        while (out.length < 16) out.push(0);
        return out;
    }

    /**
     * Maps warehouse row label to challenge module id (matches data/challenges.json ids).
     * Kinetic rows only carry `label`; there is no separate module field on POST today.
     */
    function moduleFromLabel(label) {
        var U = (label || "").toString().trim().toUpperCase();
        if (!U) return "unknown";
        if (U.startsWith("SR_")) return "social-risk";
        if (U.startsWith("SPEED_")) return "speed-accuracy";
        if (U.startsWith("SB_")) return "search-browse";
        if (U.startsWith("CALIB")) return "confidence-calibration";
        if (U === "CALIBRATION") return "confidence-calibration";
        if (U.startsWith("FRICTION")) return "friction-persistence";
        if (U.startsWith("READING") || U === "RETENTION") return "reading-behavior";
        if (U.startsWith("COMPARISON") || U === "BRIEF") return "comparison-choice";
        if (U.startsWith("ARCHETYPE")) return "archetype-lab";
        return "unknown";
    }

    /** Prefer explicit warehouse field from capture; fall back to label heuristics for older rows. */
    function resolveChallengeModule(row) {
        if (!row) return "unknown";
        var cm = row.challenge_module;
        if (cm !== undefined && cm !== null && String(cm).trim() !== "") {
            return String(cm).trim();
        }
        return moduleFromLabel(row.label);
    }

    /** Kinetic row with latest timestamp that has a usable FullStory URL (for session/visitor cloud dots). */
    function pickLatestKineticWarehouseRow(rows) {
        if (!rows || !rows.length || !M) return null;
        var best = null;
        var bestTs = -Infinity;
        var i;
        for (i = 0; i < rows.length; i++) {
            var r = rows[i];
            if (!M.isKineticEvent(r) || !normalizeFingerprint(r)) continue;
            var url = r.session_url;
            if (!url || String(url).trim() === "" || String(url) === "no-session") continue;
            var ts = r.timestamp != null ? Number(r.timestamp) : NaN;
            if (!Number.isFinite(ts)) ts = 0;
            if (ts >= bestTs) {
                bestTs = ts;
                best = r;
            }
        }
        return best;
    }

    /** Validate stored replay URL from capture (FullStory or other https replay links). */
    function resolveFullStoryReplayUrl(row) {
        if (!row) return null;
        var u = row.session_url;
        if (u === undefined || u === null) return null;
        var s = String(u).trim();
        if (!s || s === "no-session") return null;
        try {
            var parsed = new URL(s);
            if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
            return parsed.href;
        } catch (_e) {
            return null;
        }
    }

    function clearFullStoryMomentUI() {
        var btn = $("btn-fullstory-moment");
        var hint = $("fullstory-moment-hint");
        if (btn) {
            btn.hidden = true;
            btn.onclick = null;
        }
        if (hint) {
            hint.hidden = true;
            hint.textContent = "";
        }
    }

    function updateFullStoryMomentUI(row) {
        var btn = $("btn-fullstory-moment");
        var hint = $("fullstory-moment-hint");
        if (!btn) return;
        var url = resolveFullStoryReplayUrl(row);
        if (url) {
            btn.hidden = false;
            btn.onclick = function () {
                window.open(url, "_blank", "noopener,noreferrer");
            };
            if (hint) {
                hint.hidden = false;
                hint.textContent =
                    "Opens the replay link saved with this fingerprint (same moment FullStory exposed when the row was captured).";
            }
            return;
        }
        btn.hidden = true;
        btn.onclick = null;
        if (hint) {
            if (row) {
                hint.hidden = false;
                hint.textContent =
                    "No replay URL on this row — run the lab with FullStory recording to store session links with each capture.";
            } else {
                hint.hidden = true;
                hint.textContent = "";
            }
        }
    }

    function getSelectedModuleFilter() {
        var sel = $("dash-module-filter");
        if (!sel) return "";
        return sel.value || "";
    }

    function getGranularityMode() {
        var sel = $("dash-granularity");
        if (!sel) return "kinetic";
        var v = sel.value;
        if (v === "session" || v === "user") return v;
        return "kinetic";
    }

    /** Session vs visitor vs raw rows for the 16 dimension strip charts (separate from cloud granularity). */
    function getDimScope() {
        var sel = $("dim-scope");
        if (!sel) return "session";
        var v = sel.value;
        if (v === "kinetic" || v === "user") return v;
        return "session";
    }

    /** Small deterministic jitter for scatter x so nearby indices separate visually. */
    function hashSidForJitter(sid) {
        var h = 0;
        var s = String(sid || "");
        var i;
        for (i = 0; i < s.length; i++) {
            h = (h << 5) - h + s.charCodeAt(i);
            h |= 0;
        }
        return Math.abs(h);
    }

    function pointMatchesKineticScope(p) {
        if (viewScope.mode === "all") return true;
        if (viewScope.mode === "session") return viewScope.sid != null && p.sid === viewScope.sid;
        if (viewScope.mode === "user") {
            var uk = viewScope.visitorKey != null ? String(viewScope.visitorKey).trim() : "";
            return p.userKey && String(p.userKey).trim() === uk;
        }
        return true;
    }

    function rowMatchesWarehouseScope(r) {
        if (!M || viewScope.mode === "all") return true;
        var sid = M.getSessionKey(r);
        if (viewScope.mode === "session") return viewScope.sid != null && sid === viewScope.sid;
        if (viewScope.mode === "user") {
            var uk = viewScope.visitorKey != null ? String(viewScope.visitorKey).trim() : "";
            return r.nexus_user_key && String(r.nexus_user_key).trim() === uk;
        }
        return true;
    }

    function getScopedKineticPoints() {
        var all = lastKineticPoints || [];
        if (!all.length || viewScope.mode === "all") {
            return { focused: all, ghost: [] };
        }
        var focused = all.filter(pointMatchesKineticScope);
        var ghost =
            viewScope.showPopulation && viewScope.mode !== "all"
                ? all.filter(function (p) {
                      return !pointMatchesKineticScope(p);
                  })
                : [];
        return { focused: focused, ghost: ghost };
    }

    function getScopedRows() {
        var rows = lastWarehouseRows || [];
        if (viewScope.mode === "all") return rows;
        return rows.filter(rowMatchesWarehouseScope);
    }

    function getGhostRows() {
        if (viewScope.mode === "all" || !viewScope.showPopulation) return [];
        var rows = lastWarehouseRows || [];
        return rows.filter(function (r) {
            return !rowMatchesWarehouseScope(r);
        });
    }

    function filterClustersForDisplay(km) {
        if (!km || !km.clusters) return { clusters: [], centroids: km.centroids || [] };
        if (viewScope.mode === "all") return km;
        var clusters = km.clusters.map(function (cl) {
            return cl.filter(pointMatchesKineticScope);
        });
        return { clusters: clusters, centroids: km.centroids };
    }

    function syncScopeToolbar() {
        var chip = $("scope-chip");
        var exp = $("btn-scope-expand-user");
        var clr = $("btn-scope-clear");
        var pop = $("scope-show-population");
        if (chip) {
            chip.className =
                "dash-scope-chip" +
                (viewScope.mode === "session"
                    ? " dash-scope-chip--session"
                    : viewScope.mode === "user"
                      ? " dash-scope-chip--user"
                      : " dash-scope-chip--all");
            var orgHint =
                MASTER_ORG_SCOPE && selectedSid && viewScope.mode === "session"
                    ? ""
                    : "";
            if (viewScope.mode === "all") {
                chip.textContent = "All sessions";
            } else if (viewScope.mode === "session" && viewScope.sid) {
                chip.textContent =
                    "Session · #" +
                    truncateLabel(String(viewScope.sid), 36) +
                    (orgHint ? "" : "");
            } else if (viewScope.mode === "user" && viewScope.visitorKey) {
                chip.textContent =
                    "Visitor · " + truncateLabel(String(viewScope.visitorKey), 28);
            } else {
                chip.textContent = "Focused";
            }
        }
        if (pop) pop.checked = !!viewScope.showPopulation;
        if (clr) clr.hidden = viewScope.mode === "all";
        if (exp) {
            var canExpand = false;
            if (viewScope.mode === "session" && viewScope.sid && globalSessions[viewScope.sid]) {
                var sr = globalSessions[viewScope.sid];
                var ui;
                for (ui = 0; ui < sr.length; ui++) {
                    if (sr[ui].nexus_user_key && String(sr[ui].nexus_user_key).trim()) {
                        canExpand = true;
                        break;
                    }
                }
            }
            exp.hidden = !canExpand;
        }
    }

    function augmentPcaCaptionScope() {
        var capEl = $("pca-caption");
        if (!capEl) return;
        var base = capEl.getAttribute("data-base-caption") || capEl.textContent || "";
        if (!capEl.getAttribute("data-base-caption") && base) {
            capEl.setAttribute("data-base-caption", base);
        }
        base = capEl.getAttribute("data-base-caption") || "";
        var scoped = getScopedKineticPoints();
        var extra = "";
        if (viewScope.mode !== "all") {
            extra =
                " · Focus: " +
                (viewScope.mode === "session"
                    ? "session #" + truncateLabel(String(viewScope.sid || ""), 40)
                    : "visitor " + truncateLabel(String(viewScope.visitorKey || ""), 32)) +
                " · " +
                scoped.focused.length +
                " pt(s)";
            if (viewScope.showPopulation && scoped.ghost.length) {
                extra += " · population ghosted (" + scoped.ghost.length + ")";
            }
        }
        capEl.textContent = base + extra;
    }

    function refreshScopedCharts() {
        var kmDisp = filterClustersForDisplay(lastClusterResult);
        var scoped = getScopedKineticPoints();
        renderCloud(kmDisp, lastAxisTitles, lastPcaEmptyHint, scoped.ghost);
        augmentPcaCaptionScope();
        renderParallelPanel();
        renderDimensionCharts(getScopedRows(), getGhostRows());
        renderPersonaStrip();
        renderPrototypeTimeline();
        renderLabelBreakdown();
        renderTransitionHeatmap();
    }

    function setViewScope(next) {
        var sp = next.showPopulation !== undefined ? next.showPopulation : viewScope.showPopulation;
        if (next.mode === "all") {
            viewScope = { mode: "all", sid: null, visitorKey: null, showPopulation: sp };
            lastFsEvents = [];
        } else if (next.mode === "session") {
            viewScope = {
                mode: "session",
                sid: next.sid != null ? next.sid : null,
                visitorKey: null,
                showPopulation: sp,
            };
        } else if (next.mode === "user") {
            viewScope = {
                mode: "user",
                sid: null,
                visitorKey: next.visitorKey != null ? next.visitorKey : null,
                showPopulation: sp,
            };
        }
        syncScopeToolbar();
        void refreshScopedChartsAfterFs();
    }

    function clearViewScopeFromUi() {
        if (datasetFromReverseSearch) {
            datasetFromReverseSearch = false;
            viewScope = { mode: "all", sid: null, visitorKey: null, showPopulation: false };
            selectedSid = null;
            selectedUserKey = null;
            lastFsEvents = [];
            fetchData();
            return;
        }
        viewScope = { mode: "all", sid: null, visitorKey: null, showPopulation: false };
        selectedSid = null;
        selectedUserKey = null;
        lastFsEvents = [];
        syncScopeToolbar();
        renderSessionList();
        refreshScopedCharts();
        clearFullStoryMomentUI();
    }

    async function expandSessionToUserFromUi() {
        if (viewScope.mode !== "session" || !viewScope.sid) return;
        var rows = globalSessions[viewScope.sid] || [];
        var uk = null;
        var i;
        for (i = 0; i < rows.length; i++) {
            if (rows[i].nexus_user_key && String(rows[i].nexus_user_key).trim()) {
                uk = String(rows[i].nexus_user_key).trim();
                break;
            }
        }
        if (!uk) {
            alert("No nexus_user_key on this session's rows.");
            return;
        }
        if (!NexusReverseSearch) return;
        var base = API_BASE.replace(/\/?$/, "");
        var internal = DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1;
        try {
            if (internal) base = new URL(DIRECT_SUMMARY_URL).origin;
        } catch (_e) {}
        var q = {
            mode: "visitor",
            visitorKey: uk,
            sessionUrl: "",
            since:
                $("dash-filter-since") && $("dash-filter-since").value
                    ? $("dash-filter-since").value
                    : "",
            until:
                $("dash-filter-until") && $("dash-filter-until").value
                    ? $("dash-filter-until").value
                    : "",
            limit: 5000,
            orgSlug: getMasterOrgSlugForSave() || undefined,
        };
        var url = NexusReverseSearch.buildSearchUrl({ internal: internal, baseUrl: base }, q);
        var headers = {};
        if (internal) {
            var tok = getMasterInternalAdminToken();
            if (tok) headers.Authorization = "Bearer " + tok;
        } else {
            var pk =
                typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
                    ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
                    : "";
            if (pk) headers.Authorization = "Bearer " + pk;
        }
        if (!headers.Authorization) {
            alert("Sign in or set publishable key.");
            return;
        }
        setStatus(true, "Loading visitor…");
        try {
            var r = await fetch(url, { headers: headers });
            if (!r.ok) throw new Error("HTTP " + r.status);
            var data = await r.json();
            var arr = Array.isArray(data) ? data : [];
            pendingReverseFocus = { type: "user", key: uk };
            datasetFromReverseSearch = true;
            await processWarehouseRows(arr);
            setStatus(true, "Expanded to visitor · " + arr.length + " row(s)");
        } catch (e) {
            console.error(e);
            setStatus(false, "Expand to user failed.");
        }
    }

    function renderLabelBreakdown() {
        var host = $("label-breakdown-grid");
        if (!host || !NexusBehaviorSummary || !NexusBehaviorSummary.buildLabelBreakdown) return;
        var pts = getScopedKineticPoints().focused;
        var blocks = NexusBehaviorSummary.buildLabelBreakdown(pts, { topPerProto: 8 });
        host.innerHTML = "";
        if (!blocks.length) {
            host.innerHTML =
                '<p class="explainer dim-strip-empty" role="status">No kinetic points in this scope.</p>';
            return;
        }
        blocks.forEach(function (b) {
            var col = document.createElement("div");
            col.className = "label-breakdown-col";
            col.style.borderLeft = "4px solid " + (b.color || "#64748b");
            var h = document.createElement("div");
            h.className = "label-breakdown-col__title";
            h.textContent = b.name + " · " + (b.total || 0);
            col.appendChild(h);
            (b.labels || []).forEach(function (lb) {
                var row = document.createElement("div");
                row.className = "label-breakdown-row";
                var meta = document.createElement("span");
                meta.className = "label-breakdown-row__meta";
                meta.textContent = truncateLabel(lb.label, 42);
                meta.title = lb.label;
                var bar = document.createElement("div");
                bar.className = "label-breakdown-bar";
                var fill = document.createElement("div");
                fill.className = "label-breakdown-bar__fill";
                fill.style.width = Math.round((lb.share || 0) * 100) + "%";
                fill.style.backgroundColor = b.color || "#6366f1";
                bar.appendChild(fill);
                var pct = document.createElement("span");
                pct.className = "label-breakdown-row__pct";
                pct.textContent = Math.round((lb.share || 0) * 100) + "%";
                row.appendChild(meta);
                row.appendChild(bar);
                row.appendChild(pct);
                col.appendChild(row);
            });
            host.appendChild(col);
        });
    }

    function renderTransitionHeatmap() {
        var host = $("transition-heatmap");
        if (!host || !NexusBehaviorSummary || !NexusBehaviorSummary.buildTransitionMatrix) return;
        var pts = getScopedKineticPoints().focused;
        var tm = NexusBehaviorSummary.buildTransitionMatrix(pts);
        host.innerHTML = "";
        if (!tm.ids.length) {
            host.innerHTML =
                '<p class="explainer dim-strip-empty" role="status">No transitions in this scope.</p>';
            return;
        }
        var maxC = 0;
        var r;
        var c;
        for (r = 0; r < tm.matrix.length; r++) {
            for (c = 0; c < tm.matrix[r].length; c++) {
                if (tm.matrix[r][c] > maxC) maxC = tm.matrix[r][c];
            }
        }
        if (maxC <= 0) maxC = 1;
        var table = document.createElement("table");
        table.className = "transition-matrix";
        var thead = document.createElement("thead");
        var hr = document.createElement("tr");
        var corner = document.createElement("th");
        corner.className = "transition-corner";
        hr.appendChild(corner);
        tm.ids.forEach(function (id) {
            var th = document.createElement("th");
            th.textContent = truncateLabel(tm.names[id] || id, 16);
            th.title = tm.names[id] || id;
            hr.appendChild(th);
        });
        thead.appendChild(hr);
        table.appendChild(thead);
        var tbody = document.createElement("tbody");
        for (r = 0; r < tm.ids.length; r++) {
            var tr = document.createElement("tr");
            var rowH = document.createElement("th");
            rowH.textContent = truncateLabel(tm.names[tm.ids[r]] || tm.ids[r], 16);
            rowH.title = tm.names[tm.ids[r]] || tm.ids[r];
            tr.appendChild(rowH);
            for (c = 0; c < tm.ids.length; c++) {
                var td = document.createElement("td");
                var v = tm.matrix[r][c];
                td.className = "transition-cell" + (r === c ? " transition-cell--diag" : "");
                td.textContent = v ? String(v) : "—";
                var intensity = v / maxC;
                td.style.backgroundColor =
                    "rgba(99, 102, 241, " + (0.08 + intensity * 0.55).toFixed(3) + ")";
                td.setAttribute("data-intensity", String(intensity));
                (function (idFrom, idTo, val) {
                    td.onclick = function () {
                        console.log("transition cell", idFrom, "→", idTo, "n=", val);
                    };
                })(tm.ids[r], tm.ids[c], v);
                tr.appendChild(td);
            }
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        host.appendChild(table);
    }

    function fsNativeEventColor(ev) {
        var t = String(ev.EventType || ev.event_type || "").toLowerCase();
        if (t.indexOf("click") >= 0) return "#34d399";
        if (t.indexOf("navig") >= 0) return "#38bdf8";
        if (t.indexOf("page") >= 0) return "#a78bfa";
        if (t.indexOf("error") >= 0 || t.indexOf("err") >= 0) return "#f87171";
        return "#94a3b8";
    }

    function parseFsPayloadTime(ev) {
        var s = ev.EventStart || ev.eventstart || ev.event_start;
        if (!s) return NaN;
        return Date.parse(String(s));
    }

    function renderPrototypeTimeline() {
        var canvas = $("prototype-timeline");
        var cap = $("prototype-timeline-caption");
        if (!canvas || !NexusBehaviorSummary || !NexusBehaviorSummary.buildPrototypeTimeline) return;
        var pts = getScopedKineticPoints().focused;
        var tl = NexusBehaviorSummary.buildPrototypeTimeline(pts);
        if (prototypeTimelineChart) {
            try {
                prototypeTimelineChart.destroy();
            } catch (_e) {}
            prototypeTimelineChart = null;
        }
        var ctx = canvas.getContext("2d");
        var hasKin = tl.events && tl.events.length > 0;
        var fsPrepared = (lastFsEvents || [])
            .map(function (ev) {
                var tx = parseFsPayloadTime(ev);
                return { t: tx, ev: ev };
            })
            .filter(function (d) {
                return Number.isFinite(d.t);
            });
        var hasFs = fsPrepared.length > 0;
        if (!hasKin && !hasFs) {
            if (cap)
                cap.textContent =
                    "No kinetic timestamps or FullStory events in this scope — capture timestamps and/or upload a FullStory CSV, then focus a session or visitor.";
            prototypeTimelineChart = new Chart(ctx, {
                type: "scatter",
                data: {
                    datasets: [
                        {
                            label: "empty",
                            data: [{ x: 0, y: 0 }],
                            pointRadius: 0,
                            backgroundColor: "transparent",
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text: "Add timestamps or ingest FullStory CSV for this focus.",
                            color: "#94a3b8",
                            font: { size: 12 },
                        },
                        legend: { display: false },
                    },
                    scales: { x: { display: false }, y: { display: false } },
                },
            });
            return;
        }

        var fsLaneIndex;
        var laneCount;
        if (hasKin) {
            fsLaneIndex = hasFs ? tl.lanes.length : -1;
            laneCount = tl.lanes.length + (hasFs ? 1 : 0);
        } else {
            fsLaneIndex = 0;
            laneCount = 1;
        }

        if (cap) {
            var parts = [];
            if (hasKin) parts.push(tl.events.length + " kinetic");
            if (hasFs) parts.push(fsPrepared.length + " FS");
            if (hasKin) parts.push(tl.lanes.length + " prototype lane(s)");
            cap.textContent = parts.join(" · ");
        }

        var datasets = [];
        if (hasKin) {
            var colors = tl.events.map(function (e) {
                var lane = tl.lanes[e.lane];
                return lane && lane.color ? lane.color : "#94a3b8";
            });
            datasets.push({
                label: "kinetic",
                data: tl.events.map(function (e) {
                    return { x: e.t, y: e.lane, raw: e };
                }),
                pointBackgroundColor: colors,
                pointBorderColor: "rgba(255,255,255,0.15)",
                borderWidth: 1,
                pointRadius: 6,
                hoverRadius: 8,
                pointStyle: "circle",
            });
        }
        if (hasFs) {
            var fsY = fsLaneIndex >= 0 ? fsLaneIndex : 0;
            datasets.push({
                label: "fullstory",
                data: fsPrepared.map(function (d) {
                    return { x: d.t, y: fsY, rawFs: d.ev };
                }),
                pointBackgroundColor: fsPrepared.map(function (d) {
                    return fsNativeEventColor(d.ev);
                }),
                pointBorderColor: "rgba(255,255,255,0.2)",
                borderWidth: 1,
                pointRadius: 5,
                hoverRadius: 7,
                pointStyle: "rect",
            });
        }

        prototypeTimelineChart = new Chart(ctx, {
            type: "scatter",
            data: { datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            label: function (ctx) {
                                var pt = ctx.raw;
                                if (pt && pt.rawFs) {
                                    var ev = pt.rawFs;
                                    var lines = [
                                        String(ev.EventStart || ""),
                                        (String(ev.EventType || "") || "(type)") +
                                            (ev.EventSubType ? " · " + ev.EventSubType : ""),
                                    ];
                                    var tt = ev.EventTargetText || ev.eventtargettext;
                                    if (tt) lines.push(truncateLabel(String(tt), 56));
                                    var sel = ev.EventTargetSelector || ev.eventtargetselector;
                                    if (sel) {
                                        var ss = String(sel);
                                        lines.push(
                                            "selector …" +
                                                (ss.length > 44 ? ss.slice(ss.length - 44) : ss)
                                        );
                                    }
                                    return lines;
                                }
                                var raw = pt && pt.raw ? pt.raw : null;
                                if (!raw) return "";
                                return [
                                    new Date(raw.t).toISOString(),
                                    raw.label ? truncateLabel(raw.label, 48) : "",
                                    raw.similarity != null ? "sim " + raw.similarity.toFixed(2) : "",
                                ].filter(Boolean);
                            },
                        },
                    },
                },
                scales: {
                    x: {
                        type: "linear",
                        title: { display: true, text: "Time (UTC ms)", color: "#64748b", font: { size: 11 } },
                        ticks: { color: "#64748b", maxTicksLimit: 8 },
                        grid: { color: "rgba(51,65,85,0.35)" },
                    },
                    y: {
                        min: -0.5,
                        max: laneCount - 0.5,
                        title: {
                            display: true,
                            text: hasFs ? "Lane (prototype · FS)" : "Prototype lane",
                            color: "#64748b",
                            font: { size: 11 },
                        },
                        ticks: {
                            color: "#64748b",
                            stepSize: 1,
                            callback: function (val) {
                                var i = Math.round(Number(val));
                                if (hasFs && i === fsLaneIndex) return "FS events";
                                return tl.lanes[i] ? truncateLabel(tl.lanes[i].name, 22) : "";
                            },
                        },
                        grid: { color: "rgba(51,65,85,0.35)" },
                    },
                },
            },
        });
    }

    function getDimChallengeFilter() {
        var sel = $("dim-challenge");
        return sel ? sel.value || "" : "";
    }

    function truncateLabel(s, maxLen) {
        s = String(s || "");
        if (s.length <= maxLen) return s;
        return s.slice(0, Math.max(0, maxLen - 1)) + "…";
    }

    /**
     * Session/visitor means (aggregate), or one row per kinetic event (kinetic); optional challenge filter.
     * @returns {{ kind: 'aggregate', units: Array, hint: string|null } | { kind: 'kinetic', points: Array, hint: null }}
     */
    function buildDimensionUnits(allRows, scope, challengeFilter) {
        if (!M) return { kind: "aggregate", units: [], hint: null };
        var kineticRows = allRows.filter(function (r) {
            return M.isKineticEvent(r) && normalizeFingerprint(r);
        });
        var cf = challengeFilter !== undefined ? challengeFilter : getDimChallengeFilter();
        if (cf && cf !== "") {
            kineticRows = kineticRows.filter(function (r) {
                return resolveChallengeModule(r) === cf;
            });
        }
        if (!kineticRows.length) {
            return {
                kind: "aggregate",
                units: [],
                hint: cf
                    ? "No kinetic fingerprints for this module—only \"kinetic\" rows appear here, not SPEED_* phase labels. Keyboard-heavy flows used to skip capture when pointer motion was flat; reload and run the lab again to collect new rows."
                    : "No kinetic fingerprints yet — complete a challenge to populate strips.",
            };
        }
        var i;
        if (scope === "kinetic") {
            var pts = [];
            for (i = 0; i < kineticRows.length; i++) {
                var rk = kineticRows[i];
                var fpk = normalizeFingerprint(rk);
                if (!fpk) continue;
                pts.push({ fp: fpk, sid: M.getSessionKey(rk), row: rk });
            }
            if (!pts.length) {
                return {
                    kind: "aggregate",
                    units: [],
                    hint: "No kinetic fingerprints to plot.",
                };
            }
            return { kind: "kinetic", points: pts, hint: null };
        }
        if (scope === "session") {
            var bySid = {};
            kineticRows.forEach(function (r) {
                var sid = M.getSessionKey(r);
                if (!bySid[sid]) bySid[sid] = [];
                bySid[sid].push(r);
            });
            var units = Object.keys(bySid).map(function (sid) {
                var rs = bySid[sid];
                var fps = [];
                for (i = 0; i < rs.length; i++) {
                    var f = normalizeFingerprint(rs[i]);
                    if (f) fps.push(f);
                }
                return {
                    label: "#" + truncateLabel(sid, 14),
                    fp: meanVector(fps),
                    nRows: rs.length,
                    sid: sid,
                    userKey: null,
                };
            });
            return { kind: "aggregate", units: units, hint: null };
        }
        var byU = {};
        kineticRows.forEach(function (r) {
            var uk = r.nexus_user_key;
            if (uk === undefined || uk === null || String(uk).trim() === "") return;
            uk = String(uk).trim();
            if (!byU[uk]) byU[uk] = [];
            byU[uk].push(r);
        });
        var unitsU = Object.keys(byU).map(function (uk) {
            var rs = byU[uk];
            var fps = [];
            for (i = 0; i < rs.length; i++) {
                var f = normalizeFingerprint(rs[i]);
                if (f) fps.push(f);
            }
            return {
                label: truncateLabel(uk, 16),
                fp: meanVector(fps),
                nRows: rs.length,
                sid: M.getSessionKey(rs[0]),
                userKey: uk,
            };
        });
        if (!unitsU.length) {
            return {
                kind: "aggregate",
                units: [],
                hint: "Visitor strips need nexus_user_key on kinetic rows. Set window.NEXUS_USER_KEY in the lab or use Per session.",
            };
        }
        return { kind: "aggregate", units: unitsU, hint: null };
    }

    function destroyDimensionCharts() {
        dimensionCharts.forEach(function (c) {
            try {
                c.destroy();
            } catch (_e) {}
        });
        dimensionCharts = [];
    }

    function ensureDimensionChartGrid() {
        var grid = $("dimension-charts-grid");
        if (!grid || grid.querySelector(".dimension-chart-cell")) return;
        grid.innerHTML = "";
        var d;
        for (d = 0; d < 16; d++) {
            var cell = document.createElement("div");
            cell.className = "dimension-chart-cell";
            cell.innerHTML =
                '<div class="dimension-chart-cell__title">Dimension ' +
                d +
                '</div><div class="dimension-chart-cell__canvas"><canvas id="dim-chart-' +
                d +
                '" aria-label="Fingerprint dimension ' +
                d +
                ' strip chart"></canvas></div>';
            grid.appendChild(cell);
        }
    }

    function renderDimensionCharts(allRows, ghostRowsOpt) {
        var grid = $("dimension-charts-grid");
        if (!grid) return;
        destroyDimensionCharts();
        var rows = allRows && allRows.length ? allRows : [];
        var scope = getDimScope();
        var challengeFilter = getDimChallengeFilter();
        var built = buildDimensionUnits(rows, scope, challengeFilter);
        var builtGhost =
            ghostRowsOpt && ghostRowsOpt.length && scope === "kinetic" && viewScope.showPopulation
                ? buildDimensionUnits(ghostRowsOpt, scope, challengeFilter)
                : null;
        var gKin = builtGhost && builtGhost.kind === "kinetic" && builtGhost.points ? builtGhost.points : null;
        var caption = $("dim-strip-caption");
        var isKinetic = built.kind === "kinetic";
        var units = !isKinetic ? built.units : null;
        var kinPts = isKinetic ? built.points : null;
        var hasData = isKinetic ? kinPts && kinPts.length : units && units.length;

        if (!hasData) {
            grid.innerHTML =
                '<p class="explainer dim-strip-empty" role="status">' +
                (built.hint || "No data for dimension strips.") +
                "</p>";
            if (caption) {
                caption.textContent = "";
            }
            return;
        }

        ensureDimensionChartGrid();

        var chLabel =
            challengeFilter && challengeFilter !== ""
                ? "challenge “" + challengeFilter + "”"
                : "any module";

        if (caption) {
            if (isKinetic) {
                caption.textContent =
                    "Kinetic rows · " +
                    chLabel +
                    " · " +
                    kinPts.length +
                    " row(s)" +
                    (gKin && gKin.length
                        ? "; faded gray = population outside focus (" + gKin.length + ")"
                        : "") +
                    ". Same color = same FullStory session; x = row index with slight jitter.";
            } else {
                var scopeLabel = scope === "user" ? "Visitor means" : "Session means";
                caption.textContent =
                    scopeLabel +
                    " · " +
                    chLabel +
                    " · " +
                    units.length +
                    " unit(s); each chart shows up to " +
                    MAX_DIM_BARS +
                    " bars sorted high → low on that coordinate.";
            }
        }

        if (isKinetic) {
            var sessionOrder = [];
            var seenSid = Object.create(null);
            kinPts.forEach(function (p) {
                if (!seenSid[p.sid]) {
                    seenSid[p.sid] = true;
                    sessionOrder.push(p.sid);
                }
            });
            if (gKin && gKin.length) {
                gKin.forEach(function (p) {
                    if (!seenSid[p.sid]) {
                        seenSid[p.sid] = true;
                        sessionOrder.push(p.sid);
                    }
                });
            }
            var colorOfSid = {};
            sessionOrder.forEach(function (sid, idx) {
                colorOfSid[sid] = CLUSTER_COLORS[idx % CLUSTER_COLORS.length];
            });

            var dKin;
            for (dKin = 0; dKin < 16; dKin++) {
                (function (dim) {
                    var offset = gKin && gKin.length ? gKin.length : 0;
                    var metaG =
                        gKin && gKin.length
                            ? gKin.map(function (p) {
                                  return {
                                      sid: p.sid,
                                      label: p.row && p.row.label ? String(p.row.label) : "",
                                      ghost: true,
                                  };
                              })
                            : [];
                    var meta = kinPts.map(function (p) {
                        return {
                            sid: p.sid,
                            label: p.row && p.row.label ? String(p.row.label) : "",
                            ghost: false,
                        };
                    });
                    var scatterGhost =
                        gKin && gKin.length
                            ? gKin.map(function (p, idx) {
                                  var j = hashSidForJitter(String(p.sid) + ":g:" + idx) % 1999;
                                  var x = idx + j / 25000;
                                  return {
                                      x: x,
                                      y: (p.fp[dim] !== undefined ? p.fp[dim] : 0) || 0,
                                  };
                              })
                            : [];
                    var scatterData = kinPts.map(function (p, idx) {
                        var j = hashSidForJitter(String(p.sid) + ":" + idx) % 1999;
                        var x = offset + idx + j / 25000;
                        return {
                            x: x,
                            y: (p.fp[dim] !== undefined ? p.fp[dim] : 0) || 0,
                        };
                    });
                    var colors = kinPts.map(function (p) {
                        return colorOfSid[p.sid];
                    });
                    var canvas = $("dim-chart-" + dim);
                    if (!canvas) return;
                    var ctx = canvas.getContext("2d");
                    var dsList = [];
                    if (scatterGhost.length) {
                        dsList.push({
                            label: "population",
                            data: scatterGhost,
                            pointBackgroundColor: scatterGhost.map(function () {
                                return "rgba(148, 163, 184, 0.18)";
                            }),
                            pointBorderColor: "transparent",
                            borderWidth: 0,
                            pointRadius: 3,
                            pointHoverRadius: 3,
                        });
                    }
                    dsList.push({
                        label: "rows",
                        data: scatterData,
                        pointBackgroundColor: colors,
                        pointBorderColor: "rgba(255,255,255,0.2)",
                        borderWidth: 1,
                        pointRadius: 4,
                        pointHoverRadius: 6,
                    });
                    var chart = new Chart(ctx, {
                        type: "scatter",
                        data: {
                            datasets: dsList,
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 240 },
                            layout: { padding: { left: 4, right: 8, top: 4, bottom: 4 } },
                            onClick: function (_evt, elements) {
                                if (!elements.length) return;
                                var el = elements[0];
                                if (scatterGhost.length && el.datasetIndex === 0) return;
                                var idx = el.index;
                                var m =
                                    scatterGhost.length && el.datasetIndex === 1
                                        ? meta[idx]
                                        : !scatterGhost.length
                                          ? meta[idx]
                                          : meta[idx];
                                if (m && m.sid) {
                                    selectUser(m.sid);
                                }
                            },
                            plugins: {
                                legend: { display: false },
                                tooltip: {
                                    filter: function (item) {
                                        return !(scatterGhost.length && item.datasetIndex === 0);
                                    },
                                    callbacks: {
                                        label: function (ctx) {
                                            var i = ctx.dataIndex;
                                            var m =
                                                scatterGhost.length && ctx.datasetIndex === 0
                                                    ? metaG[i]
                                                    : meta[i];
                                            var yv =
                                                ctx.parsed.y !== undefined ? ctx.parsed.y : ctx.raw;
                                            var lines = [
                                                "#" + (m && m.sid ? m.sid : "—"),
                                                "value: " +
                                                    (typeof yv === "number" ? yv.toFixed(4) : yv),
                                            ];
                                            if (m && m.label) {
                                                lines.push(
                                                    "label: " +
                                                        (m.label.length > 48
                                                            ? m.label.slice(0, 45) + "…"
                                                            : m.label)
                                                );
                                            }
                                            return lines;
                                        },
                                    },
                                },
                            },
                            scales: {
                                x: {
                                    title: {
                                        display: true,
                                        text: "order",
                                        color: "#64748b",
                                        font: { size: 10 },
                                    },
                                    grid: { color: "rgba(51,65,85,0.35)" },
                                    ticks: { color: "#64748b", maxTicksLimit: 8, font: { size: 9 } },
                                },
                                y: {
                                    title: {
                                        display: true,
                                        text: "dim " + dim,
                                        color: "#64748b",
                                        font: { size: 10 },
                                    },
                                    grid: { color: "rgba(51,65,85,0.45)" },
                                    ticks: { color: "#64748b", maxTicksLimit: 6, font: { size: 10 } },
                                },
                            },
                        },
                    });
                    dimensionCharts.push(chart);
                })(dKin);
            }
            return;
        }

        var d;
        for (d = 0; d < 16; d++) {
            (function (dim) {
                var sorted = units.slice().sort(function (a, b) {
                        var va = (a.fp[dim] !== undefined ? a.fp[dim] : 0) || 0;
                        var vb = (b.fp[dim] !== undefined ? b.fp[dim] : 0) || 0;
                        return vb - va;
                    })
                    .slice(0, MAX_DIM_BARS);
                var labels = sorted.map(function (u) {
                    return u.label;
                });
                var values = sorted.map(function (u) {
                    return (u.fp[dim] !== undefined ? u.fp[dim] : 0) || 0;
                });
                var meta = sorted.map(function (u) {
                    return { sid: u.sid, userKey: u.userKey, nRows: u.nRows };
                });
                var canvas = $("dim-chart-" + dim);
                if (!canvas) return;
                var ctx = canvas.getContext("2d");
                var chart = new Chart(ctx, {
                    type: "bar",
                    data: {
                        labels: labels,
                        datasets: [
                            {
                                label: "mean",
                                data: values,
                                backgroundColor: "rgba(99, 102, 241, 0.78)",
                                borderColor: "rgba(129, 140, 248, 0.35)",
                                borderWidth: 1,
                                borderRadius: 4,
                                barThickness: 10,
                            },
                        ],
                    },
                    options: {
                        indexAxis: "y",
                        responsive: true,
                        maintainAspectRatio: false,
                        animation: { duration: 240 },
                        layout: { padding: { left: 0, right: 8, top: 2, bottom: 2 } },
                        onClick: function (_evt, elements) {
                            if (!elements.length) return;
                            var idx = elements[0].index;
                            var m = meta[idx];
                            if (!m) return;
                            if (scope === "user" && m.userKey) {
                                selectUserByVisitorKey(m.userKey);
                            } else if (m.sid) {
                                selectUser(m.sid);
                            }
                        },
                        plugins: {
                            legend: { display: false },
                            title: {
                                display: false,
                            },
                            tooltip: {
                                callbacks: {
                                    label: function (ctx) {
                                        var i = ctx.dataIndex;
                                        var m = meta[i];
                                        var v = ctx.parsed.x !== undefined ? ctx.parsed.x : ctx.raw;
                                        return [
                                            "mean: " + (typeof v === "number" ? v.toFixed(4) : v),
                                            "rows: " + (m && m.nRows !== undefined ? m.nRows : "—"),
                                        ];
                                    },
                                },
                            },
                        },
                        scales: {
                            x: {
                                grid: { color: "rgba(51,65,85,0.45)" },
                                ticks: { color: "#64748b", maxTicksLimit: 6, font: { size: 10 } },
                            },
                            y: {
                                grid: { display: false },
                                ticks: {
                                    color: "#94a3b8",
                                    font: { size: 9 },
                                    autoSkip: true,
                                    maxTicksLimit: 24,
                                },
                            },
                        },
                    },
                });
                dimensionCharts.push(chart);
            })(d);
        }
    }

    function meanVector(vectors) {
        if (!vectors || !vectors.length) return null;
        var d = vectors[0].length;
        var out = [];
        var i, j;
        for (j = 0; j < d; j++) {
            var s = 0;
            for (i = 0; i < vectors.length; i++) s += vectors[i][j] || 0;
            out.push(s / vectors.length);
        }
        return out;
    }

    /**
     * Collapse kinetic rows by session or visitor before PCA.
     * @returns {Array<{ fp: number[], row: object, sid: string, aggregateKind: string, userKey: string|null }>}
     */
    function buildAnalysisUnits(kineticRows) {
        var mode = getGranularityMode();
        var i;
        if (mode === "kinetic") {
            var outK = [];
            for (i = 0; i < kineticRows.length; i++) {
                var r = kineticRows[i];
                var fp = normalizeFingerprint(r);
                if (!fp) continue;
                outK.push({
                    fp: fp,
                    row: r,
                    sid: M.getSessionKey(r),
                    aggregateKind: "kinetic",
                    userKey: null,
                });
            }
            return outK;
        }
        if (mode === "session") {
            var bySid = {};
            kineticRows.forEach(function (r) {
                var fp = normalizeFingerprint(r);
                if (!fp) return;
                var sid = M.getSessionKey(r);
                if (!bySid[sid]) bySid[sid] = [];
                bySid[sid].push(r);
            });
            return Object.keys(bySid).map(function (sid) {
                var rs = bySid[sid];
                var fps = [];
                for (i = 0; i < rs.length; i++) {
                    var f = normalizeFingerprint(rs[i]);
                    if (f) fps.push(f);
                }
                var rep = pickLatestKineticWarehouseRow(rs);
                return {
                    fp: meanVector(fps),
                    row: rep || rs[0],
                    sid: sid,
                    aggregateKind: "session",
                    userKey: null,
                };
            });
        }
        if (mode === "user") {
            var byU = {};
            kineticRows.forEach(function (r) {
                var uk = r.nexus_user_key;
                if (uk === undefined || uk === null || String(uk).trim() === "") return;
                uk = String(uk).trim();
                if (!byU[uk]) byU[uk] = [];
                byU[uk].push(r);
            });
            return Object.keys(byU).map(function (uk) {
                var rs = byU[uk];
                var fps = [];
                for (i = 0; i < rs.length; i++) {
                    var f = normalizeFingerprint(rs[i]);
                    if (f) fps.push(f);
                }
                var rep = pickLatestKineticWarehouseRow(rs);
                return {
                    fp: meanVector(fps),
                    row: rep || rs[0],
                    sid: M.getSessionKey(rs[0]),
                    aggregateKind: "user",
                    userKey: uk,
                };
            });
        }
        return [];
    }

    function countKineticRows(rows, moduleFilter) {
        if (!M) return 0;
        var mf = moduleFilter !== undefined ? moduleFilter : getSelectedModuleFilter();
        return rows.filter(function (r) {
            if (!M.isKineticEvent(r) || !normalizeFingerprint(r)) return false;
            if (!mf || mf === "") return true;
            return resolveChallengeModule(r) === mf;
        }).length;
    }

    function sessionVisibleForModule(sid, moduleFilter) {
        var mf = moduleFilter !== undefined ? moduleFilter : getSelectedModuleFilter();
        if (!mf || mf === "") return true;
        if (!M) return true;
        var rows = globalSessions[sid] || [];
        return rows.some(function (r) {
            return M.isKineticEvent(r) && normalizeFingerprint(r) && resolveChallengeModule(r) === mf;
        });
    }

    /** Builds scatter points in PCA space + attaches fp for parallel coords. Uses NexusFingerprintViz when available. */
    function buildKineticPointsPCA(rows, moduleFilter) {
        if (!M) return { points: [], pca: { explainedPct: [0, 0], fallback: true }, emptyHint: null };
        var mf = moduleFilter !== undefined ? moduleFilter : getSelectedModuleFilter();
        var kineticRows = rows.filter(function (r) {
            return M.isKineticEvent(r) && normalizeFingerprint(r);
        });
        if (mf && mf !== "") {
            kineticRows = kineticRows.filter(function (r) {
                return resolveChallengeModule(r) === mf;
            });
        }
        if (!kineticRows.length) {
            return { points: [], pca: { explainedPct: [0, 0], fallback: true }, emptyHint: null };
        }
        var units = buildAnalysisUnits(kineticRows);
        if (getGranularityMode() === "user" && (!units || !units.length)) {
            return {
                points: [],
                pca: { explainedPct: [0, 0], fallback: true },
                emptyHint:
                    "Visitor view needs nexus_user_key on kinetic rows. Set window.NEXUS_USER_KEY in the lab, or switch to Session / Kinetic event.",
            };
        }
        if (!units.length) {
            return { points: [], pca: { explainedPct: [0, 0], fallback: true }, emptyHint: null };
        }
        var vectors = units.map(function (u) {
            return u.fp;
        });
        var VF = typeof NexusFingerprintViz !== "undefined" ? NexusFingerprintViz : null;
        var pca = VF ? VF.pcaProject2D(vectors) : null;
        if (!pca || !pca.points || pca.points.length !== units.length) {
            return {
                points: units.map(function (u) {
                    var fp = u.fp;
                    return {
                        x: fp[0],
                        y: fp[1],
                        fp: VF ? VF.pad16(fp) : fp,
                        original: u.row,
                        sid: u.sid,
                        userKey: u.userKey,
                        aggregateKind: u.aggregateKind,
                        clusterIndex: 0,
                    };
                }),
                pca: { explainedPct: [0, 0], fallback: true },
                emptyHint: null,
            };
        }
        var points = units.map(function (u, i) {
            var pt = pca.points[i];
            return {
                x: pt.x,
                y: pt.y,
                fp: VF.pad16(u.fp),
                original: u.row,
                sid: u.sid,
                userKey: u.userKey,
                aggregateKind: u.aggregateKind,
                clusterIndex: 0,
            };
        });
        return { points: points, pca: pca, emptyHint: null };
    }

    function groupSessions(rows) {
        var map = {};
        rows.forEach(function (entry) {
            var sid = M ? M.getSessionKey(entry) : fallbackSessionKey(entry);
            if (!map[sid]) map[sid] = [];
            map[sid].push(entry);
        });
        return map;
    }

    function fallbackSessionKey(row) {
        var u = row && row.session_url;
        if (!u || u === "no-session") return "no-session";
        var parts = String(u).split("/").filter(Boolean);
        return parts.length ? parts[parts.length - 1] : u;
    }

    function performKMeans(data, k) {
        if (!data.length) return { clusters: [], centroids: [] };
        k = Math.max(1, Math.min(k, data.length));
        var centroids = data.slice(0, k).map(function (p) {
            return { x: p.x, y: p.y };
        });
        var clusters = [];

        for (var iter = 0; iter < 14; iter++) {
            clusters = [];
            for (var c = 0; c < k; c++) clusters.push([]);
            data.forEach(function (p) {
                var dists = centroids.map(function (c) {
                    return Math.hypot(c.x - p.x, c.y - p.y);
                });
                var idx = dists.indexOf(Math.min.apply(null, dists));
                clusters[idx].push(p);
            });
            centroids = clusters.map(function (cl) {
                if (!cl.length) return { x: 0, y: 0 };
                return {
                    x: cl.reduce(function (a, b) {
                        return a + b.x;
                    }, 0) / cl.length,
                    y: cl.reduce(function (a, b) {
                        return a + b.y;
                    }, 0) / cl.length,
                };
            });
        }
        clusters.forEach(function (cl, ci) {
            cl.forEach(function (p) {
                p.clusterIndex = ci;
            });
        });
        return { clusters: clusters, centroids: centroids };
    }

    /** Nearest k-means centroid index in the PCA plane (for session summary text). */
    function nearestClusterIndex(px, py) {
        if (!globalCentroids.length) return 0;
        var best = 0;
        var bestD = Infinity;
        globalCentroids.forEach(function (c, i) {
            var d = Math.hypot(c.x - px, c.y - py);
            if (d < bestD) {
                bestD = d;
                best = i;
            }
        });
        return best;
    }

    function getDesiredClusterCount() {
        var el = $("kmeans-max-k");
        var v = el ? parseInt(el.value, 10) : 4;
        if (isNaN(v) || v < 1) v = 4;
        return Math.min(12, Math.max(1, v));
    }

    function syncClusterKUi() {
        var el = $("kmeans-max-k");
        var out = $("kmeans-max-k-value");
        if (!el || !out) return;
        out.textContent = String(getDesiredClusterCount());
    }

    function renderClusterLegendSwatches(datasets) {
        var host = $("cluster-color-legend");
        if (!host) return;
        host.innerHTML = "";
        if (!datasets || !datasets.length) return;
        datasets.forEach(function (ds) {
            var idx = typeof ds.clusterSlotIndex === "number" ? ds.clusterSlotIndex : 0;
            if (idx < 0) return;
            var cl = lastClusterResult.clusters[idx] || [];
            var proto = dominantProtoLabel(cl);
            var s = document.createElement("span");
            s.className = "cluster-swatch";
            s.style.backgroundColor = ds.backgroundColor;
            s.title = proto ? proto + " · slot " + (idx + 1) : "Cluster " + (idx + 1);
            host.appendChild(s);
        });
    }

    function sessionMeanPlane(sid) {
        var pts = lastKineticPoints.filter(function (p) {
            return p.sid === sid;
        });
        if (!pts.length) return null;
        return {
            x: pts.reduce(function (a, p) {
                return a + p.x;
            }, 0) / pts.length,
            y: pts.reduce(function (a, p) {
                return a + p.y;
            }, 0) / pts.length,
        };
    }

    function renderParallelPanel() {
        var host = $("parallel-coords-host");
        if (!host) return;
        if (typeof NexusFingerprintViz === "undefined") {
            host.innerHTML = "";
            return;
        }
        var scoped = getScopedKineticPoints();
        var items = [];
        scoped.ghost.forEach(function (p) {
            items.push({
                vector: p.fp,
                color: "rgba(148, 163, 184, 0.35)",
                opacity: 0.1,
                sid: p.sid,
                userKey: p.userKey || null,
            });
        });
        scoped.focused.forEach(function (p) {
            var col =
                p.prototypeMatch && p.prototypeMatch.color
                    ? p.prototypeMatch.color
                    : CLUSTER_COLORS[p.clusterIndex % CLUSTER_COLORS.length] || "#6366f1";
            items.push({
                vector: p.fp,
                color: col,
                opacity: 0.42,
                sid: p.sid,
                userKey: p.userKey || null,
            });
        });
        NexusFingerprintViz.renderParallelCoords(host, items, {
            highlightSid: selectedSid,
            highlightUserKey: selectedUserKey,
        });
    }

    function renderCloud(clusterResult, axisTitles, emptyHint, ghostPoints) {
        axisTitles = axisTitles || { x: "PC1", y: "PC2" };
        var ctx = $("cloudChart").getContext("2d");
        var clusters = clusterResult.clusters;
        var ghostArr = ghostPoints && ghostPoints.length ? ghostPoints : [];

        var clusterDatasets = clusters
            .map(function (cluster, i) {
                var baseCol = CLUSTER_COLORS[i % CLUSTER_COLORS.length];
                var ptBg = cluster.map(function (p) {
                    return p.prototypeMatch && p.prototypeMatch.color
                        ? p.prototypeMatch.color
                        : baseCol;
                });
                return {
                    label: "",
                    clusterSlotIndex: i,
                    data: cluster,
                    backgroundColor: baseCol,
                    pointBackgroundColor: ptBg,
                    pointRadius: 6,
                    hoverRadius: 9,
                    pointHoverBackgroundColor: ptBg,
                };
            })
            .filter(function (ds) {
                return ds.data.length > 0;
            });

        var datasets = [];
        if (ghostArr.length) {
            var gBg = ghostArr.map(function () {
                return "rgba(148, 163, 184, 0.22)";
            });
            datasets.push({
                label: "Population",
                clusterSlotIndex: -1,
                data: ghostArr,
                backgroundColor: "rgba(148, 163, 184, 0.12)",
                pointBackgroundColor: gBg,
                pointRadius: 4,
                hoverRadius: 4,
                pointHoverBackgroundColor: gBg,
            });
        }
        clusterDatasets.forEach(function (ds) {
            datasets.push(ds);
        });

        if (cloudChart) cloudChart.destroy();

        if (!datasets.length) {
            renderClusterLegendSwatches([]);
            cloudChart = new Chart(ctx, {
                type: "scatter",
                data: {
                    datasets: [
                        {
                            label: "empty",
                            data: [{ x: 0, y: 0 }],
                            backgroundColor: "transparent",
                            pointRadius: 0,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        title: {
                            display: true,
                            text:
                                emptyHint ||
                                "No kinetic fingerprints yet — complete a challenge to populate the cloud.",
                            color: "#94a3b8",
                            font: { size: 13 },
                        },
                        legend: { display: false },
                    },
                    scales: {
                        x: { display: false, min: -1, max: 1 },
                        y: { display: false, min: -1, max: 1 },
                    },
                },
            });
            return;
        }

        renderClusterLegendSwatches(datasets);

        cloudChart = new Chart(ctx, {
            type: "scatter",
            data: { datasets: datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                onClick: function (_e, elements) {
                    if (!elements.length) return;
                    var el = elements[0];
                    var ds = datasets[el.datasetIndex];
                    if (!ds || ds.clusterSlotIndex === -1) return;
                    var pt = ds.data[el.index];
                    if (!pt || !pt.original) return;
                    var teleportRow = pt.original;
                    if (pt.aggregateKind === "user" && pt.userKey) {
                        selectUserByVisitorKey(pt.userKey, teleportRow);
                    } else {
                        selectUser(pt.sid, teleportRow);
                    }
                },
                scales: {
                    x: {
                        title: {
                            display: true,
                            text: axisTitles.x,
                            color: "#64748b",
                            font: { size: 11 },
                        },
                        grid: { color: "rgba(51,65,85,0.35)" },
                        ticks: { color: "#64748b", maxTicksLimit: 6 },
                    },
                    y: {
                        title: {
                            display: true,
                            text: axisTitles.y,
                            color: "#64748b",
                            font: { size: 11 },
                        },
                        grid: { color: "rgba(51,65,85,0.35)" },
                        ticks: { color: "#64748b", maxTicksLimit: 6 },
                    },
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        filter: function (item) {
                            var ds0 = item.chart.data.datasets[item.datasetIndex];
                            return !ds0 || ds0.clusterSlotIndex !== -1;
                        },
                        callbacks: {
                            label: function (ctx) {
                                var raw = ctx.raw;
                                if (!raw) return "";
                                if (raw.prototypeMatch && raw.prototypeMatch.name) {
                                    return (
                                        raw.prototypeMatch.name +
                                        " · sim " +
                                        (raw.prototypeMatch.similarity != null
                                            ? raw.prototypeMatch.similarity.toFixed(2)
                                            : "?")
                                    );
                                }
                                return "Cluster " + ((raw.clusterIndex || 0) + 1);
                            },
                        },
                    },
                },
            },
        });
    }

    function collectRowsForVisitorKey(uk) {
        var out = [];
        Object.keys(globalSessions).forEach(function (sid) {
            (globalSessions[sid] || []).forEach(function (r) {
                if (r.nexus_user_key && String(r.nexus_user_key).trim() === uk) out.push(r);
            });
        });
        return out;
    }

    function visitorMeanPlane(uk) {
        var pts = lastKineticPoints.filter(function (p) {
            return p.userKey === uk;
        });
        if (!pts.length) return null;
        return {
            x: pts.reduce(function (a, p) {
                return a + p.x;
            }, 0) / pts.length,
            y: pts.reduce(function (a, p) {
                return a + p.y;
            }, 0) / pts.length,
        };
    }

    function selectUserByVisitorKey(uk, teleportRowOpt) {
        selectedUserKey = uk;
        selectedSid = null;
        var merged = collectRowsForVisitorKey(uk);
        if (!merged.length) return;

        document.querySelectorAll(".session-item").forEach(function (el) {
            var sid = el.getAttribute("data-sid");
            var rows = globalSessions[sid] || [];
            var hit = rows.some(function (r) {
                return r.nexus_user_key && String(r.nexus_user_key).trim() === uk;
            });
            el.classList.toggle("active", hit);
        });

        var mean = visitorMeanPlane(uk);
        var clusterIdx = mean ? nearestClusterIndex(mean.x, mean.y) : 0;

        $("user-archetype-label").textContent = "Cluster " + (clusterIdx + 1) + " · visitor " + uk;
        $("user-archetype-desc").textContent =
            merged.length +
            " warehouse row(s) for this visitor across sessions (module filter applies to the chart only).";

        if (radarCtrl && radarCtrl.update) radarCtrl.update(merged);
        setViewScope({ mode: "user", visitorKey: uk, showPopulation: viewScope.showPopulation });
        updateFullStoryMomentUI(
            teleportRowOpt !== undefined ? teleportRowOpt : pickLatestKineticWarehouseRow(merged)
        );
    }

    function selectUser(sid, teleportRowOpt) {
        selectedSid = sid;
        selectedUserKey = null;
        var userEvents = globalSessions[sid];
        if (!userEvents || !userEvents.length) return;

        document.querySelectorAll(".session-item").forEach(function (el) {
            el.classList.toggle("active", el.getAttribute("data-sid") === sid);
        });

        var mean = sessionMeanPlane(sid);
        var clusterIdx = mean ? nearestClusterIndex(mean.x, mean.y) : 0;

        var kineticN = countKineticRows(userEvents, getSelectedModuleFilter());
        var labels = userEvents
            .map(function (e) {
                return e.label;
            })
            .filter(Boolean);
        var labelPreview = labels.slice(0, 4).join(" · ");

        $("user-archetype-label").textContent = "Cluster " + (clusterIdx + 1) + " · #" + sid;
        $("user-archetype-desc").textContent =
            kineticN +
            " kinetic row(s). Recent labels: " +
            (labelPreview || "—") +
            (labels.length > 4 ? "…" : "");

        if (radarCtrl && radarCtrl.update) radarCtrl.update(userEvents);
        setViewScope({ mode: "session", sid: sid, showPopulation: viewScope.showPopulation });
        updateFullStoryMomentUI(
            teleportRowOpt !== undefined ? teleportRowOpt : pickLatestKineticWarehouseRow(userEvents)
        );
    }

    function renderSessionList() {
        var container = $("session-list");
        container.innerHTML = "";
        var mf = getSelectedModuleFilter();
        var keys = Object.keys(globalSessions).filter(function (sid) {
            return sessionVisibleForModule(sid, mf);
        });
        keys.sort(function (a, b) {
            var ka = countKineticRows(globalSessions[a], mf);
            var kb = countKineticRows(globalSessions[b], mf);
            if (kb !== ka) return kb - ka;
            return String(a).localeCompare(String(b));
        });
        keys.forEach(function (sid) {
            var rows = globalSessions[sid];
            var k = countKineticRows(rows, mf);
            var div = document.createElement("div");
            var activeSession = selectedSid && sid === selectedSid;
            var activeVisitor =
                selectedUserKey &&
                rows.some(function (r) {
                    return r.nexus_user_key && String(r.nexus_user_key).trim() === selectedUserKey;
                });
            div.className = "session-item" + (activeSession || activeVisitor ? " active" : "");
            div.setAttribute("data-sid", sid);
            div.innerHTML =
                "<div><strong>#" +
                sid +
                "</strong></div>" +
                '<div class="session-meta">' +
                rows.length +
                " row(s) · " +
                k +
                " kinetic</div>";
            div.onclick = function () {
                selectUser(sid);
            };
            container.appendChild(div);
        });
    }

    function setStatus(ok, msg) {
        var el = $("dev-status");
        el.style.color = ok ? "#34d399" : "#fb923c";
        el.textContent = msg;
    }

    function computeIntegrity(rows, kineticRows) {
        if (!rows.length) return "—";
        var pct = Math.round((kineticRows.length / rows.length) * 1000) / 10;
        return pct + "% kinetic";
    }

    function getDateFilterQueryString() {
        var sinceEl = $("dash-filter-since");
        var untilEl = $("dash-filter-until");
        var parts = [];
        if (sinceEl && sinceEl.value) parts.push("since=" + encodeURIComponent(sinceEl.value));
        if (untilEl && untilEl.value) parts.push("until=" + encodeURIComponent(untilEl.value));
        return parts.length ? "&" + parts.join("&") : "";
    }

    /** Human-readable range for friction triage shell. */
    function getDateRangeLabelForFriction() {
        var sinceEl = $("dash-filter-since");
        var untilEl = $("dash-filter-until");
        var a = sinceEl && sinceEl.value ? String(sinceEl.value) : "";
        var b = untilEl && untilEl.value ? String(untilEl.value) : "";
        if (!a && !b) return "all rows in current load (no since/until filter)";
        return (a || "…") + " → " + (b || "…");
    }

    function appendQueryToUrl(baseUrl, extraQs) {
        if (!extraQs) return baseUrl;
        return baseUrl + (baseUrl.indexOf("?") >= 0 ? "" : "?") + extraQs.replace(/^&/, "");
    }

    function collectorOriginForFullstory() {
        var root = API_BASE.replace(/\/?$/, "");
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            try {
                root = new URL(DIRECT_SUMMARY_URL).origin;
            } catch (_e) {}
        }
        return root;
    }

    function fullstoryAuthHeaders() {
        var h = {};
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            var tok = getMasterInternalAdminToken();
            if (tok) h.Authorization = "Bearer " + tok;
        } else {
            var pk =
                typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
                    ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
                    : "";
            if (pk) h.Authorization = "Bearer " + pk;
        }
        return h;
    }

    /**
     * Load session-level FullStory rollups for every session that has kinetic points (batched).
     */
    async function fetchFsSessionMetricsMap() {
        fsSessionMetricsBySid = {};
        if (!lastKineticPoints || !lastKineticPoints.length) return;
        var auth = fullstoryAuthHeaders();
        if (!auth.Authorization) return;
        var internal = DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1;
        if (internal && !getMasterOrgSlugForSave()) return;
        var seen = {};
        var i;
        for (i = 0; i < lastKineticPoints.length; i++) {
            var s = lastKineticPoints[i].sid != null ? String(lastKineticPoints[i].sid) : "";
            if (s) seen[s] = true;
        }
        var ids = Object.keys(seen);
        if (!ids.length) return;
        var origin = collectorOriginForFullstory();
        var chunkSize = 80;
        for (i = 0; i < ids.length; i += chunkSize) {
            var chunk = ids.slice(i, i + chunkSize);
            var q = "session_ids=" + encodeURIComponent(chunk.join(","));
            var path = internal
                ? "/internal/v1/fullstory/sessions?" +
                  q +
                  "&org_slug=" +
                  encodeURIComponent(getMasterOrgSlugForSave() || "")
                : "/v1/fullstory/sessions?" + q;
            try {
                var res = await fetch(origin + path, { headers: auth });
                if (!res.ok) continue;
                var rows = await res.json();
                if (!Array.isArray(rows)) continue;
                var r;
                for (r = 0; r < rows.length; r++) {
                    var row = rows[r];
                    if (row && row.fs_session_id != null) {
                        fsSessionMetricsBySid[String(row.fs_session_id)] = row;
                    }
                }
            } catch (e) {
                console.warn("fetchFsSessionMetricsMap:", e);
            }
        }
    }

    /** Populate lastFsEvents for the current viewScope (session or visitor); does not render. */
    async function fetchFsEventsForScope() {
        lastFsEvents = [];
        if (viewScope.mode === "all") return;
        var auth = fullstoryAuthHeaders();
        if (!auth.Authorization) return;
        var internal = DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1;
        if (internal && !getMasterOrgSlugForSave()) return;
        var parts = [];
        if (viewScope.mode === "session" && viewScope.sid) {
            parts.push("session_id=" + encodeURIComponent(String(viewScope.sid)));
        } else if (viewScope.mode === "user" && viewScope.visitorKey) {
            parts.push("visitor_key=" + encodeURIComponent(String(viewScope.visitorKey)));
        } else {
            return;
        }
        parts.push("limit=5000");
        var qs = parts.join("&");
        var origin = collectorOriginForFullstory();
        var path = internal
            ? "/internal/v1/fullstory/events?" + qs + "&org_slug=" + encodeURIComponent(getMasterOrgSlugForSave() || "")
            : "/v1/fullstory/events?" + qs;
        try {
            var res = await fetch(origin + path, { headers: auth });
            if (!res.ok) throw new Error("HTTP " + res.status);
            var data = await res.json();
            lastFsEvents = Array.isArray(data) ? data : [];
        } catch (e) {
            console.warn("fetchFsEventsForScope:", e);
            lastFsEvents = [];
        }
    }

    async function refreshScopedChartsAfterFs() {
        await fetchFsEventsForScope();
        refreshScopedCharts();
    }

    async function fetchBehaviorPrototypesList() {
        behaviorPrototypes = [];
        var root = API_BASE.replace(/\/?$/, "");
        var url;
        var headers = {};
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            try {
                root = new URL(DIRECT_SUMMARY_URL).origin;
            } catch (_e) {}
            url = root + "/internal/v1/clusters";
            var tok = getMasterInternalAdminToken();
            if (tok) headers.Authorization = "Bearer " + tok;
        } else {
            url = root + "/v1/clusters";
            var pk =
                typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
                    ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
                    : "";
            if (pk) headers.Authorization = "Bearer " + pk;
        }
        if (!headers.Authorization) return;
        try {
            var r = await fetch(url, { headers: headers });
            if (!r.ok) return;
            var j = await r.json();
            behaviorPrototypes = j.clusters || [];
            populatePrototypeClusterSelect();
        } catch (e) {
            console.warn("fetchBehaviorPrototypesList:", e);
        }
    }

    function populatePrototypeClusterSelect() {
        var sel = $("dash-cohort-cluster-select");
        if (!sel) return;
        var cur = sel.value;
        sel.innerHTML = "<option value=''>— pick saved prototype —</option>";
        behaviorPrototypes.forEach(function (p) {
            var o = document.createElement("option");
            o.value = p.id;
            o.textContent =
                (p.name || "Cluster") + (p.org_slug ? " · " + p.org_slug : "");
            sel.appendChild(o);
        });
        if (cur) {
            sel.value = cur;
        }
    }

    function visitorKeysFromCluster(cl) {
        var k = {};
        var i;
        for (i = 0; i < (cl || []).length; i++) {
            var p = cl[i];
            var uk = p.userKey;
            if (!uk && p.original && p.original.nexus_user_key) {
                uk = String(p.original.nexus_user_key).trim();
            }
            if (uk) k[String(uk).trim()] = 1;
        }
        return Object.keys(k);
    }

    async function snapshotCohortFromUi() {
        var cid = $("dash-cohort-cluster-select") && $("dash-cohort-cluster-select").value;
        var nameEl = $("dash-cohort-name");
        var name = nameEl ? String(nameEl.value || "").trim() : "";
        var slotEl = $("dash-cohort-slot");
        var slotNum = slotEl ? parseInt(slotEl.value, 10) : 1;
        var slot = slotNum - 1;
        if (!cid || !name) {
            alert("Select a saved prototype and enter a cohort name.");
            return;
        }
        var cl = lastClusterResult.clusters[slot] || [];
        var vkeys = visitorKeysFromCluster(cl);
        if (!vkeys.length) {
            alert(
                "No visitor keys in that slot — capture nexus_user_key or use Cloud points → Per visitor."
            );
            return;
        }
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1 && !getMasterOrgSlugForSave()) {
            alert("Select organization (master).");
            return;
        }
        var url = clusterApiPostUrl("/clusters/" + encodeURIComponent(cid) + "/snapshot-cohort");
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            url += "?org_slug=" + encodeURIComponent(getMasterOrgSlugForSave());
        }
        try {
            var res = await fetch(url, {
                method: "POST",
                headers: clusterAuthHeadersJson(),
                body: JSON.stringify({ name: name, visitor_keys: vkeys, filters: {} }),
            });
            if (!res.ok) throw new Error(await res.text());
            var j = await res.json();
            var cidOut = j.cohort && j.cohort.id ? j.cohort.id : "";
            if (cidOut && $("dash-segment-cohort-id")) $("dash-segment-cohort-id").value = cidOut;
            alert("Snapshot saved. Cohort id: " + (cidOut || "(see response)"));
        } catch (e) {
            console.error(e);
            alert("Snapshot failed: " + (e && e.message ? e.message : e));
        }
    }

    async function addOverseerClusterTagFromUi() {
        var cid = $("dash-cohort-cluster-select") && $("dash-cohort-cluster-select").value;
        var valEl = $("dash-cluster-tag-value");
        var kindEl = $("dash-cluster-tag-kind");
        var value = valEl ? String(valEl.value || "").trim() : "";
        var tagKind = kindEl && kindEl.value ? String(kindEl.value).trim() : "note";
        if (!cid) {
            alert("Select a saved prototype in the Prototype dropdown first.");
            return;
        }
        if (!value) {
            alert("Enter an Overseer label (e.g. Confusion).");
            return;
        }
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1 && !getMasterOrgSlugForSave()) {
            alert("Select organization (master).");
            return;
        }
        var url = clusterApiPostUrl("/clusters/" + encodeURIComponent(cid) + "/tags");
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            url += "?org_slug=" + encodeURIComponent(getMasterOrgSlugForSave());
        }
        try {
            var res = await fetch(url, {
                method: "POST",
                headers: clusterAuthHeadersJson(),
                body: JSON.stringify({ tag_kind: tagKind, value: value }),
            });
            if (!res.ok) throw new Error(await res.text());
            await res.json();
            await fetchBehaviorPrototypesList();
            enrichKineticPrototypes();
            refreshScopedCharts();
            alert("Tag saved on prototype.");
        } catch (e) {
            console.error(e);
            alert("Tag failed: " + (e && e.message ? e.message : e));
        }
    }

    function getEffectiveOrgSlugForInternal() {
        var g = $("dash-gold-org-slug");
        if (g && String(g.value || "").trim()) return String(g.value).trim();
        return getMasterOrgSlugForSave();
    }

    /** Collector origin for internal admin routes (gold, friction, etc.). */
    function masterInternalApiOrigin() {
        var root = API_BASE.replace(/\/?$/, "");
        if (DIRECT_SUMMARY_URL && String(DIRECT_SUMMARY_URL).trim() !== "") {
            try {
                root = new URL(DIRECT_SUMMARY_URL).origin;
            } catch (_e) {}
        }
        return root;
    }

    function requireContextForGoldApis() {
        if (!getMasterInternalAdminToken()) {
            alert("Save internal admin token in the sidebar first.");
            return false;
        }
        if (!getEffectiveOrgSlugForInternal()) {
            alert("Enter org slug (Gold card override) or select master organization.");
            return false;
        }
        return true;
    }

    async function refreshGoldStandardList() {
        if (!requireContextForGoldApis()) return;
        var slug = getEffectiveOrgSlugForInternal();
        var url =
            masterInternalApiOrigin() +
            "/internal/v1/orgs/" +
            encodeURIComponent(slug) +
            "/gold-standard-vectors?limit=25";
        var st = $("dash-gold-status");
        var pre = $("dash-gold-list-pre");
        if (st) st.textContent = "Loading…";
        try {
            var res = await fetch(url, {
                headers: { Authorization: "Bearer " + getMasterInternalAdminToken() },
            });
            if (!res.ok) throw new Error(await res.text());
            var j = await res.json();
            if (pre) pre.textContent = JSON.stringify(j.rows || [], null, 2);
            if (st) st.textContent = "OK — " + (j.rows && j.rows.length ? j.rows.length + " row(s)" : "0 rows");
        } catch (e) {
            if (st) st.textContent = "Error.";
            console.error(e);
            alert("Gold list failed: " + (e && e.message ? e.message : e));
        }
    }

    async function saveGoldStandardFromUi() {
        if (!requireContextForGoldApis()) return;
        var slug = getEffectiveOrgSlugForInternal();
        var labelEl = $("dash-gold-label");
        var label = labelEl ? String(labelEl.value || "").trim() : "";
        if (!label) {
            alert("Enter a label.");
            return;
        }
        var fpText = $("dash-gold-fingerprint-json") ? String($("dash-gold-fingerprint-json").value || "").trim() : "";
        var fingerprint;
        try {
            fingerprint = JSON.parse(fpText);
        } catch (_e) {
            alert("Fingerprint must be valid JSON array.");
            return;
        }
        if (!Array.isArray(fingerprint) || fingerprint.length !== 16) {
            alert("Fingerprint must be a JSON array of exactly 16 numbers.");
            return;
        }
        var notesEl = $("dash-gold-notes");
        var vbEl = $("dash-gold-verified-by");
        var body = {
            fingerprint: fingerprint,
            label: label,
            notes: notesEl && notesEl.value ? String(notesEl.value) : undefined,
            verified_by: vbEl && vbEl.value ? String(vbEl.value).trim() : undefined,
        };
        var url =
            masterInternalApiOrigin() +
            "/internal/v1/orgs/" +
            encodeURIComponent(slug) +
            "/gold-standard-vectors";
        var st = $("dash-gold-status");
        if (st) st.textContent = "Saving…";
        try {
            var res = await fetch(url, {
                method: "POST",
                headers: {
                    Authorization: "Bearer " + getMasterInternalAdminToken(),
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await res.text());
            if (st) st.textContent = "Saved.";
            await refreshGoldStandardList();
        } catch (e) {
            if (st) st.textContent = "Error.";
            console.error(e);
            alert("Save gold failed: " + (e && e.message ? e.message : e));
        }
    }

    async function applySegmentationFromUi() {
        var cid = $("dash-segment-cohort-id") && String($("dash-segment-cohort-id").value || "").trim();
        var raw = $("dash-seg-vars") && String($("dash-seg-vars").value || "").trim();
        if (!cid || !raw) {
            alert("Enter cohort id and JSON vars.");
            return;
        }
        var vars;
        try {
            vars = JSON.parse(raw);
        } catch (_e) {
            alert("Invalid JSON for vars.");
            return;
        }
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1 && !getMasterOrgSlugForSave()) {
            alert("Select organization (master).");
            return;
        }
        var url = clusterApiPostUrl("/cohorts/" + encodeURIComponent(cid) + "/segmentation");
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            url += "?org_slug=" + encodeURIComponent(getMasterOrgSlugForSave());
        }
        try {
            var res = await fetch(url, {
                method: "POST",
                headers: clusterAuthHeadersJson(),
                body: JSON.stringify({ vars: vars }),
            });
            if (!res.ok) throw new Error(await res.text());
            var j = await res.json();
            alert("Applied segmentation vars to " + (j.updated != null ? j.updated : "?") + " visitors.");
        } catch (e) {
            console.error(e);
            alert("Failed: " + (e && e.message ? e.message : e));
        }
    }

    /**
     * Load warehouse rows (same shape as GET /v1/summary).
     */
    async function fetchSummaryPayload() {
        var dateQs = getDateFilterQueryString();
        var data = null;
        if (DIRECT_SUMMARY_URL) {
            var hdrs = {};
            var masterTok = getMasterInternalAdminToken();
            if (masterTok) hdrs.Authorization = "Bearer " + masterTok;
            var sumUrl = appendQueryToUrl(DIRECT_SUMMARY_URL, dateQs);
            var directRes = await fetch(sumUrl, { headers: hdrs });
            if (!directRes.ok) throw new Error("HTTP " + directRes.status);
            data = await directRes.json();
        } else {
            var apiQs = dateQs ? "?" + dateQs.replace(/^&/, "") : "";
            var pr = await fetch("/api/summary" + apiQs, {
                credentials: "same-origin",
            });
            if (pr.status === 401) {
                var pkGate =
                    typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
                        ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
                        : "";
                if (!pkGate) {
                    window.location.href =
                        "/login.html?next=" +
                        encodeURIComponent(
                            (window.location.pathname || "/dashboard.html") + (window.location.search || "")
                        );
                    return null;
                }
            }
            if (pr.ok) {
                var pct = pr.headers.get("content-type") || "";
                if (pct.indexOf("application/json") !== -1) {
                    data = await pr.json();
                }
            }
        }
        if (data === null && !DIRECT_SUMMARY_URL) {
            var summaryPath =
                (typeof window !== "undefined" && window.NEXUS_SUMMARY_PATH) || "/summary";
            var sumQs = dateQs ? "?" + dateQs.replace(/^&/, "") : "";
            var url = API_BASE.replace(/\/?$/, "") + summaryPath + sumQs;
            var pk =
                typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
                    ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
                    : "";
            var fetchOpts = {};
            if (pk) fetchOpts.headers = { Authorization: "Bearer " + pk };
            var response = await fetch(url, fetchOpts);
            if (!response.ok) throw new Error("HTTP " + response.status);
            data = await response.json();
        }
        return data;
    }

    function enrichKineticPrototypes() {
        if (!NexusClusterPrototypes || !behaviorPrototypes.length || !lastKineticPoints.length) {
            lastKineticPoints.forEach(function (p) {
                p.prototypeMatch = null;
            });
            return;
        }
        var mf = getSelectedModuleFilter();
        NexusClusterPrototypes.enrichPoints(lastKineticPoints, behaviorPrototypes, {
            moduleFilter: mf,
            k: getDesiredClusterCount(),
            sessionMetricsBySid: fsSessionMetricsBySid,
        });
    }

    function dominantProtoLabel(clusterPoints) {
        var counts = {};
        var i;
        for (i = 0; i < clusterPoints.length; i++) {
            var p = clusterPoints[i];
            if (p.prototypeMatch && p.prototypeMatch.name) {
                var n = p.prototypeMatch.name;
                counts[n] = (counts[n] || 0) + 1;
            }
        }
        var best = null;
        var bn = 0;
        Object.keys(counts).forEach(function (k) {
            if (counts[k] > bn) {
                bn = counts[k];
                best = k;
            }
        });
        return best;
    }

    function renderPersonaStrip() {
        var host = $("dash-persona-strip");
        if (!host || !NexusBehaviorSummary) return;
        var pts = getScopedKineticPoints().focused;
        var cards = NexusBehaviorSummary.buildPersonaCards(
            behaviorPrototypes,
            pts,
            fsSessionMetricsBySid
        );
        host.innerHTML = "";
        cards.forEach(function (c) {
            var card = document.createElement("div");
            card.className = "dash-persona-card";
            card.style.borderLeft = "4px solid " + (c.color || "#6366f1");
            var h = document.createElement("div");
            h.className = "dash-persona-card__title";
            h.textContent = c.name + (c.org_slug ? " · " + c.org_slug : "");
            var meta = document.createElement("div");
            meta.className = "dash-persona-card__meta";
            meta.textContent =
                (c.count || 0) +
                " pts · pace " +
                (c.hints && c.hints.pace != null ? c.hints.pace : "—") +
                " · focus " +
                (c.hints && c.hints.focus != null ? c.hints.focus : "—");
            card.appendChild(h);
            card.appendChild(meta);
            if (c.tags && c.tags.length) {
                var tg = document.createElement("div");
                tg.className = "dash-persona-card__tags";
                c.tags.forEach(function (tag) {
                    var sp = document.createElement("span");
                    sp.className = "dash-persona-card__tag";
                    if (tag && tag.kind === "fs_signal") {
                        sp.className += " dash-persona-card__tag--fs-signal";
                    }
                    sp.textContent = tag && tag.text != null ? tag.text : String(tag);
                    tg.appendChild(sp);
                });
                card.appendChild(tg);
            }
            if (c.fs && c.fs.sessions_with_fs) {
                var fsEl = document.createElement("div");
                fsEl.className = "dash-persona-card__fs";
                var bits = [];
                if (c.fs.frustrated_pct_avg != null) {
                    bits.push("frust ~" + Math.round(c.fs.frustrated_pct_avg * 100) + "%");
                }
                if (c.fs.dead_pct_avg != null) {
                    bits.push("dead ~" + Math.round(c.fs.dead_pct_avg * 100) + "%");
                }
                if (c.fs.error_pct_avg != null) {
                    bits.push("err ~" + Math.round(c.fs.error_pct_avg * 100) + "%");
                }
                if (c.fs.clicks_per_min_avg != null) {
                    bits.push("~ " + c.fs.clicks_per_min_avg.toFixed(1) + " clk/min");
                }
                if (c.fs.max_scroll_depth_avg != null) {
                    bits.push("scroll ~" + Math.round(c.fs.max_scroll_depth_avg) + "%");
                }
                fsEl.textContent = bits.length ? "FullStory · " + bits.join(" · ") : "";
                if (fsEl.textContent) card.appendChild(fsEl);
            }
            host.appendChild(card);
        });

        var hmHost = $("dash-tag-heatmap");
        if (hmHost && NexusBehaviorSummary.buildTagHeatmap) {
            var rows = NexusBehaviorSummary.buildTagHeatmap(behaviorPrototypes, pts);
            hmHost.innerHTML =
                "<table class='dash-mini-table'><thead><tr><th>Prototype</th><th>Tag</th><th>n</th></tr></thead><tbody>" +
                rows
                    .slice(0, 12)
                    .map(function (r) {
                        return (
                            "<tr><td>" +
                            escapeHtml(r.prototype) +
                            "</td><td>" +
                            escapeHtml(r.tag) +
                            "</td><td>" +
                            r.n +
                            "</td></tr>"
                        );
                    })
                    .join("") +
                "</tbody></table>";
        }
    }

    function escapeHtml(s) {
        var d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    function computeFpCentroidForCluster(clusterPoints) {
        if (!clusterPoints || !clusterPoints.length) return null;
        var acc = new Array(16).fill(0);
        var n = 0;
        var i;
        var j;
        for (i = 0; i < clusterPoints.length; i++) {
            var fp = clusterPoints[i].fp;
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

    function clusterApiPostUrl(pathSuffix) {
        var root = API_BASE.replace(/\/?$/, "");
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            try {
                root = new URL(DIRECT_SUMMARY_URL).origin;
            } catch (_e) {}
            return root + "/internal/v1" + pathSuffix;
        }
        return root + "/v1" + pathSuffix;
    }

    function clusterAuthHeadersJson() {
        var headers = { "Content-Type": "application/json" };
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            var tok = getMasterInternalAdminToken();
            if (tok) headers.Authorization = "Bearer " + tok;
        } else {
            var pk =
                typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
                    ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
                    : "";
            if (pk) headers.Authorization = "Bearer " + pk;
        }
        return headers;
    }

    function getMasterOrgSlugForSave() {
        var sel = $("dash-prototype-org");
        if (sel && sel.value) return String(sel.value).trim();
        return "";
    }

    async function saveClusterPrototypeFromUi() {
        var nameEl = $("dash-prototype-name");
        var colorEl = $("dash-prototype-color");
        var slotEl = $("dash-prototype-slot");
        if (!nameEl || !slotEl) return;
        var name = String(nameEl.value || "").trim();
        if (!name) {
            alert("Enter a name for this cluster.");
            return;
        }
        var slot = parseInt(slotEl.value, 10);
        if (isNaN(slot) || slot < 1) {
            alert("Pick a k-means slot (1-based).");
            return;
        }
        var idx = slot - 1;
        var cl = lastClusterResult.clusters[idx];
        if (!cl || !cl.length) {
            alert("That cluster slot is empty for the current filters.");
            return;
        }
        var centroid = computeFpCentroidForCluster(cl);
        if (!centroid) {
            alert("Could not compute centroid.");
            return;
        }
        var body = {
            name: name,
            color: colorEl && colorEl.value ? colorEl.value : "#6366f1",
            centroid: centroid,
            match_threshold: 0.85,
            filters: {
                challenge_module: getSelectedModuleFilter() || "",
                granularity: getGranularityMode() || "",
                k: getDesiredClusterCount(),
            },
        };
        var url = clusterApiPostUrl("/clusters");
        if (DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1) {
            var osl = getMasterOrgSlugForSave();
            if (!osl) {
                alert("Select an organization for this prototype (master dashboard).");
                return;
            }
            url += "?org_slug=" + encodeURIComponent(osl);
        }
        try {
            var res = await fetch(url, {
                method: "POST",
                headers: clusterAuthHeadersJson(),
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                var err = await res.text();
                throw new Error(err || String(res.status));
            }
            await fetchBehaviorPrototypesList();
            await fetchData();
            alert("Saved prototype.");
        } catch (e) {
            console.error(e);
            alert("Save failed: " + (e && e.message ? e.message : e));
        }
    }

    async function runReverseSearch() {
        var modeEl = $("dash-reverse-mode");
        var sessionIn = $("dash-reverse-session-url");
        var visitorIn = $("dash-reverse-visitor");
        var mode = modeEl && modeEl.value === "visitor" ? "visitor" : "session";
        if (!NexusReverseSearch) return;
        var base = API_BASE.replace(/\/?$/, "");
        var internal = DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1;
        try {
            if (internal) base = new URL(DIRECT_SUMMARY_URL).origin;
        } catch (_e) {}
        var q = {
            mode: mode,
            sessionUrl: sessionIn && sessionIn.value ? sessionIn.value.trim() : "",
            visitorKey: visitorIn && visitorIn.value ? visitorIn.value.trim() : "",
            since:
                $("dash-filter-since") && $("dash-filter-since").value
                    ? $("dash-filter-since").value
                    : "",
            until:
                $("dash-filter-until") && $("dash-filter-until").value
                    ? $("dash-filter-until").value
                    : "",
            limit: 800,
            orgSlug: getMasterOrgSlugForSave() || undefined,
        };
        if (mode === "session" && !q.sessionUrl) {
            alert("Paste a FullStory replay URL (or path).");
            return;
        }
        if (mode === "visitor" && !q.visitorKey) {
            alert("Enter nexus_user_key / visitor id.");
            return;
        }
        var url = NexusReverseSearch.buildSearchUrl({ internal: internal, baseUrl: base }, q);
        var headers = {};
        if (internal) {
            var tok = getMasterInternalAdminToken();
            if (tok) headers.Authorization = "Bearer " + tok;
        } else {
            var pk =
                typeof window !== "undefined" && window.NEXUS_PUBLISHABLE_KEY
                    ? String(window.NEXUS_PUBLISHABLE_KEY).trim()
                    : "";
            if (pk) headers.Authorization = "Bearer " + pk;
        }
        if (!headers.Authorization) {
            alert("Sign in or set publishable key for search.");
            return;
        }
        setStatus(true, "Searching…");
        try {
            var r = await fetch(url, { headers: headers });
            if (!r.ok) throw new Error("HTTP " + r.status);
            var data = await r.json();
            var arr = Array.isArray(data) ? data : [];
            pendingReverseFocus =
                mode === "visitor"
                    ? { type: "user", key: q.visitorKey.trim() }
                    : { type: "session" };
            datasetFromReverseSearch = true;
            await processWarehouseRows(arr);
            setStatus(true, "Reverse search · " + arr.length + " row(s)");
        } catch (e) {
            console.error(e);
            setStatus(false, "Reverse search failed.");
        }
    }

    async function uploadFullstoryCsv(file) {
        if (!file) return;
        var auth = fullstoryAuthHeaders();
        if (!auth.Authorization) {
            alert("Set publishable key (NEXUS_PUBLISHABLE_KEY) or master token for CSV upload.");
            return;
        }
        var internal = DIRECT_SUMMARY_URL && DIRECT_SUMMARY_URL.indexOf("/internal/v1/") !== -1;
        if (internal && !getMasterOrgSlugForSave()) {
            alert("Select an organization for FullStory ingest (master dashboard).");
            return;
        }
        var st = $("fs-upload-status");
        if (st) st.textContent = "Uploading…";
        var text;
        try {
            text = await file.text();
        } catch (_e) {
            if (st) st.textContent = "Could not read file.";
            return;
        }
        var origin = collectorOriginForFullstory();
        var path = internal
            ? "/internal/v1/fullstory/events/upload-csv?org_slug=" +
              encodeURIComponent(getMasterOrgSlugForSave() || "")
            : "/v1/fullstory/events/upload-csv";
        try {
            var res = await fetch(origin + path, {
                method: "POST",
                headers: Object.assign({ "Content-Type": "text/csv" }, auth),
                body: text,
            });
            if (!res.ok) throw new Error((await res.text()) || "HTTP " + res.status);
            var j = await res.json();
            if (st) {
                st.textContent =
                    (j.inserted != null ? j.inserted : 0) +
                    " events ingested across " +
                    (j.sessions && j.sessions.length != null ? j.sessions.length : 0) +
                    " session(s) · dedup skipped " +
                    (j.skipped != null ? j.skipped : 0) +
                    (j.truncated ? " · truncated at 50k rows" : "");
            }
            var auto = $("fs-upload-autofocus") && $("fs-upload-autofocus").checked;
            await fetchData();
            if (auto && j.sessions && j.sessions[0]) {
                var sid0 = j.sessions[0];
                if (globalSessions[sid0]) {
                    selectUser(sid0);
                } else {
                    setViewScope({ mode: "session", sid: sid0, showPopulation: viewScope.showPopulation });
                }
            }
        } catch (e) {
            console.error(e);
            if (st) st.textContent = "Upload failed.";
            alert("FullStory CSV upload failed: " + (e && e.message ? e.message : e));
        }
    }

    async function processWarehouseRows(data) {
        if (!data || !data.length) {
            globalSessions = {};
            globalCentroids = [];
            lastKineticPoints = [];
            lastWarehouseRows = [];
            lastClusterResult = { clusters: [], centroids: [] };
            viewScope = { mode: "all", sid: null, visitorKey: null, showPopulation: false };
            fsSessionMetricsBySid = {};
            lastFsEvents = [];
            datasetFromReverseSearch = false;
            pendingReverseFocus = null;
            $("stat-kinetic").textContent = "0";
            $("stat-clusters").textContent = "0";
            $("stat-sessions").textContent = "0";
            $("stat-integrity").textContent = "—";
            clearFullStoryMomentUI();
            var capEmpty = $("pca-caption");
            if (capEmpty) {
                capEmpty.textContent = "";
                capEmpty.removeAttribute("data-base-caption");
            }
            lastAxisTitles = { x: "PC1", y: "PC2" };
            lastPcaEmptyHint = null;
            if (prototypeTimelineChart) {
                try {
                    prototypeTimelineChart.destroy();
                } catch (_e) {}
                prototypeTimelineChart = null;
            }
            renderSessionList();
            syncScopeToolbar();
            refreshScopedCharts();
            populatePrototypeOrgSelect([]);
            setStatus(true, "Warehouse reachable · empty");
            if (window.NexusFrictionTriage && window.NexusFrictionTriage.refreshAll) {
                void window.NexusFrictionTriage.refreshAll();
            }
            return;
        }

        lastWarehouseRows = data;
        globalSessions = groupSessions(data);
        var mf = getSelectedModuleFilter();
        var built = buildKineticPointsPCA(data, mf);
        lastKineticPoints = built.points;
        var pca = built.pca;

        $("stat-kinetic").textContent = String(lastKineticPoints.length);
        var visibleSessions = Object.keys(globalSessions).filter(function (sid) {
            return sessionVisibleForModule(sid, mf);
        });
        $("stat-sessions").textContent = String(visibleSessions.length);
        $("stat-integrity").textContent = computeIntegrity(data, lastKineticPoints);

        var axisTitles;
        var capEl = $("pca-caption");
        if (!lastKineticPoints.length && built.emptyHint) {
            axisTitles = { x: "PC1", y: "PC2" };
            if (capEl) capEl.textContent = built.emptyHint;
        } else if (pca.fallback) {
            axisTitles = { x: "Fingerprint · dim 0", y: "Fingerprint · dim 1" };
            if (capEl) capEl.textContent = "Using raw dimensions 0–1 (PCA needs more variance or samples).";
        } else {
            axisTitles = {
                x: "PC1 (" + pca.explainedPct[0] + "% variance)",
                y: "PC2 (" + pca.explainedPct[1] + "% variance)",
            };
            if (capEl) {
                var sumVar = Number(pca.explainedPct[0]) + Number(pca.explainedPct[1]);
                capEl.textContent =
                    "PCA on 16-D embeddings: PC1 + PC2 account for ~" +
                    sumVar.toFixed(1) +
                    "% of total variance (relative to the covariance trace).";
            }
        }

        if (capEl) capEl.setAttribute("data-base-caption", capEl.textContent || "");
        lastAxisTitles = axisTitles;
        lastPcaEmptyHint = lastKineticPoints.length ? null : built.emptyHint;

        var maxK = getDesiredClusterCount();
        syncClusterKUi();
        var km =
            lastKineticPoints.length === 0
                ? { clusters: [], centroids: [] }
                : performKMeans(lastKineticPoints, Math.min(maxK, lastKineticPoints.length));
        globalCentroids = km.centroids;
        lastClusterResult = km;
        await fetchFsSessionMetricsMap();
        enrichKineticPrototypes();

        var nonempty = km.clusters.filter(function (c) {
            return c.length > 0;
        }).length;
        $("stat-clusters").textContent = String(nonempty);

        renderSessionList();

        function applyDefaultSessionSelection() {
            var gran = getGranularityMode();
            if (
                gran === "user" &&
                selectedUserKey &&
                collectRowsForVisitorKey(selectedUserKey).length
            ) {
                selectUserByVisitorKey(selectedUserKey);
                return;
            }
            if (selectedSid && globalSessions[selectedSid] && sessionVisibleForModule(selectedSid, mf)) {
                selectUser(selectedSid);
                return;
            }
            selectedUserKey = null;
            var sorted = Object.keys(globalSessions).filter(function (sid) {
                return sessionVisibleForModule(sid, mf);
            });
            sorted.sort(function (a, b) {
                var ka = countKineticRows(globalSessions[a], mf);
                var kb = countKineticRows(globalSessions[b], mf);
                if (kb !== ka) return kb - ka;
                return String(a).localeCompare(String(b));
            });
            var first = sorted[0];
            if (first && lastKineticPoints.length) {
                selectUser(first);
                return;
            }
            selectedSid = null;
            viewScope = { mode: "all", sid: null, visitorKey: null, showPopulation: false };
            syncScopeToolbar();
            clearFullStoryMomentUI();
            refreshScopedCharts();
        }

        if (pendingReverseFocus) {
            var pr = pendingReverseFocus;
            pendingReverseFocus = null;
            if (pr.type === "user" && pr.key) {
                selectUserByVisitorKey(pr.key);
            } else if (pr.type === "session" && lastWarehouseRows.length) {
                var sid0 = M ? M.getSessionKey(lastWarehouseRows[0]) : fallbackSessionKey(lastWarehouseRows[0]);
                selectUser(sid0);
            } else {
                applyDefaultSessionSelection();
            }
        } else {
            applyDefaultSessionSelection();
        }

        populatePrototypeOrgSelect(data);

        setStatus(
            true,
            "Live · " +
                data.length +
                " warehouse rows" +
                (MASTER_ORG_SCOPE ? " (all local orgs)" : "")
        );
        if (window.NexusFrictionTriage && window.NexusFrictionTriage.refreshAll) {
            void window.NexusFrictionTriage.refreshAll();
        }
    }

    function populatePrototypeOrgSelect(rows) {
        var sel = $("dash-prototype-org");
        if (!sel || !MASTER_ORG_SCOPE) return;
        var seen = {};
        var opts = [];
        (rows || []).forEach(function (r) {
            var s = r && r._master_org_slug != null ? String(r._master_org_slug).trim() : "";
            if (s && !seen[s]) {
                seen[s] = true;
                opts.push(s);
            }
        });
        opts.sort();
        var cur = sel.value;
        sel.innerHTML = "<option value=''>— org for new prototype —</option>";
        opts.forEach(function (o) {
            var opt = document.createElement("option");
            opt.value = o;
            opt.textContent = o;
            sel.appendChild(opt);
        });
        if (cur && seen[cur]) sel.value = cur;
    }

    async function fetchData() {
        try {
            pendingReverseFocus = null;
            datasetFromReverseSearch = false;
            viewScope = { mode: "all", sid: null, visitorKey: null, showPopulation: false };
            var popEl = $("scope-show-population");
            if (popEl) popEl.checked = false;
            await fetchBehaviorPrototypesList();
            var data = await fetchSummaryPayload();
            if (data === null) return;
            await processWarehouseRows(Array.isArray(data) ? data : []);
        } catch (err) {
            console.error("Dashboard fetch error:", err);
            clearFullStoryMomentUI();
            setStatus(
                false,
                DIRECT_SUMMARY_URL
                    ? DIRECT_SUMMARY_URL.indexOf("/internal/v1/master-summary") !== -1
                        ? "Cannot load master summary — paste your collector INTERNAL_ADMIN_TOKEN under “Collector internal token” in the sidebar (saved in sessionStorage), or check Railway env / collector logs."
                        : "Cannot reach local master summary — is the collector running with ENABLE_LOCAL_MASTER_SUMMARY=1?"
                    : "Cannot reach warehouse API (try Log in for hosted console, or collector + publishable key for local)."
            );
        }
    }

    function populateModuleSelect(challenges) {
        var sel = $("dash-module-filter");
        if (!sel) return;
        var preserve = sel.value;
        sel.innerHTML = "";
        var optAll = document.createElement("option");
        optAll.value = "";
        optAll.textContent = "All modules";
        sel.appendChild(optAll);
        (challenges || []).forEach(function (c) {
            var o = document.createElement("option");
            o.value = c.id;
            o.textContent = c.title || c.id;
            sel.appendChild(o);
        });
        var hubOpt = document.createElement("option");
        hubOpt.value = "archetype-lab";
        hubOpt.textContent = "Challenge hub";
        sel.appendChild(hubOpt);
        var demoOpt = document.createElement("option");
        demoOpt.value = "demo";
        demoOpt.textContent = "Archetype lab (demo.html)";
        sel.appendChild(demoOpt);
        var un = document.createElement("option");
        un.value = "unknown";
        un.textContent = "Other / unmatched label";
        sel.appendChild(un);
        var opts = sel.options;
        var i;
        for (i = 0; i < opts.length; i++) {
            if (opts[i].value === preserve) {
                sel.value = preserve;
                return;
            }
        }
        var sv = localStorage.getItem(LS_MODULE_KEY);
        if (sv) {
            for (i = 0; i < opts.length; i++) {
                if (opts[i].value === sv) {
                    sel.value = sv;
                    return;
                }
            }
        }
        sel.value = "";
    }

    function populateDimChallengeSelect(challenges) {
        var sel = $("dim-challenge");
        if (!sel) return;
        var preserve = sel.value;
        sel.innerHTML = "";
        var optAny = document.createElement("option");
        optAny.value = "";
        optAny.textContent = "Any module";
        sel.appendChild(optAny);
        (challenges || []).forEach(function (c) {
            var o = document.createElement("option");
            o.value = c.id;
            o.textContent = c.title || c.id;
            sel.appendChild(o);
        });
        var hubOptDim = document.createElement("option");
        hubOptDim.value = "archetype-lab";
        hubOptDim.textContent = "Challenge hub";
        sel.appendChild(hubOptDim);
        var demoOpt = document.createElement("option");
        demoOpt.value = "demo";
        demoOpt.textContent = "Archetype lab (demo.html)";
        sel.appendChild(demoOpt);
        var un = document.createElement("option");
        un.value = "unknown";
        un.textContent = "Other / unmatched label";
        sel.appendChild(un);
        var opts = sel.options;
        var i;
        for (i = 0; i < opts.length; i++) {
            if (opts[i].value === preserve) {
                sel.value = preserve;
                return;
            }
        }
        var sv = localStorage.getItem(LS_DIM_CHALLENGE_KEY);
        if (sv !== null && sv !== undefined && sv !== "") {
            for (i = 0; i < opts.length; i++) {
                if (opts[i].value === sv) {
                    sel.value = sv;
                    return;
                }
            }
        }
        sel.value = "";
    }

    function setupSegmentationBanner() {
        var banner = $("dash-segment-banner");
        var text = $("dash-segment-banner-text");
        if (!banner || !text) return;
        var NS = typeof NexusSegmentation !== "undefined" ? NexusSegmentation : null;
        if (!NS || typeof NS.getState !== "function") return;
        var s = NS.getState();
        if (s && s.userKey && String(s.userKey).trim() !== "") {
            var parts = [String(s.userKey).trim()];
            if (s.fsVars && s.fsVars.nexus_cohort) {
                parts.push('cohort "' + String(s.fsVars.nexus_cohort) + '"');
            }
            text.textContent = parts.join(" · ");
            banner.hidden = false;
        } else {
            banner.hidden = true;
        }
    }

    function setupHowItWorksModal() {
        var btn = $("btn-dash-how-it-works");
        var dlg = $("dash-info-modal");
        if (!btn || !dlg) return;
        if (typeof dlg.showModal !== "function") {
            btn.hidden = true;
            return;
        }
        btn.addEventListener("click", function () {
            dlg.showModal();
        });
        dlg.addEventListener("close", function () {
            try {
                btn.focus();
            } catch (_e) {}
        });
    }

    /** Cookie / magic-link / Google session — show org switcher when JWT lists multiple orgs. */
    function setupConsoleOrgSwitcher() {
        var wrap = $("dash-org-switch-wrap");
        var sel = $("dash-org-switch");
        if (!wrap || !sel) return Promise.resolve();
        /* Master dashboard loads warehouse from collector directly; org JWT switcher does not apply. */
        if (DIRECT_SUMMARY_URL) return Promise.resolve();
        return fetch("/api/session", { credentials: "same-origin" })
            .then(function (r) {
                if (!r.ok) {
                    wrap.hidden = true;
                    return null;
                }
                return r.json();
            })
            .then(function (data) {
                if (!data || !data.org_access || !data.org_access.length) {
                    wrap.hidden = true;
                    return;
                }
                var active = data.active_org_slug || "";
                sel.innerHTML = "";
                data.org_access.forEach(function (o) {
                    var slug = o.slug != null ? String(o.slug) : "";
                    if (!slug) return;
                    var opt = document.createElement("option");
                    opt.value = slug;
                    opt.textContent = slug;
                    if (slug === active) opt.selected = true;
                    sel.appendChild(opt);
                });
                wrap.hidden = data.org_access.length < 2;
                sel.onchange = function () {
                    var slug = sel.value;
                    fetch("/api/switch-org", {
                        method: "POST",
                        credentials: "same-origin",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ org_slug: slug }),
                    })
                        .then(function (r) {
                            if (!r.ok) throw new Error("switch failed");
                            fetchData();
                        })
                        .catch(function () {
                            alert("Could not switch organization.");
                        });
                };
            });
    }

    function init() {
        if (MASTER_ORG_SCOPE && M && !M.__nexusMasterOrgScoped) {
            M.__nexusMasterOrgScoped = true;
            var origGetSessionKey = M.getSessionKey.bind(M);
            M.getSessionKey = function (row) {
                var org =
                    row && row._master_org_slug != null && String(row._master_org_slug).trim() !== ""
                        ? String(row._master_org_slug).trim()
                        : row && row.org_slug != null && String(row.org_slug).trim() !== ""
                          ? String(row.org_slug).trim()
                          : "";
                var base = origGetSessionKey(row);
                if (org) return org + " · " + base;
                return base;
            };
        }
        setupSegmentationBanner();
        setupHowItWorksModal();
        var radarCanvas = $("radarChart");
        if (typeof NexusDataCards !== "undefined" && NexusDataCards.radarArchetype) {
            radarCtrl = NexusDataCards.radarArchetype.create(radarCanvas);
        }

        $("btn-refresh-cloud").onclick = function () {
            fetchData();
        };
        $("btn-reload-page").onclick = function () {
            location.reload();
        };

        var granSel = $("dash-granularity");
        if (granSel) {
            var savedGran = localStorage.getItem(LS_GRAN_KEY);
            if (savedGran === "kinetic" || savedGran === "session" || savedGran === "user") {
                granSel.value = savedGran;
            }
            granSel.addEventListener("change", function () {
                localStorage.setItem(LS_GRAN_KEY, granSel.value);
                fetchData();
            });
        }

        var dimScopeEl = $("dim-scope");
        if (dimScopeEl) {
            var savedDs = localStorage.getItem(LS_DIM_SCOPE_KEY);
            if (savedDs === "session" || savedDs === "user" || savedDs === "kinetic") {
                dimScopeEl.value = savedDs;
            }
            dimScopeEl.addEventListener("change", function () {
                localStorage.setItem(LS_DIM_SCOPE_KEY, dimScopeEl.value);
                refreshScopedCharts();
            });
        }

        var dimChallengeEl = $("dim-challenge");
        if (dimChallengeEl) {
            dimChallengeEl.addEventListener("change", function () {
                localStorage.setItem(LS_DIM_CHALLENGE_KEY, dimChallengeEl.value);
                refreshScopedCharts();
            });
        }

        var scopePop = $("scope-show-population");
        if (scopePop) {
            scopePop.addEventListener("change", function () {
                viewScope.showPopulation = scopePop.checked;
                syncScopeToolbar();
                refreshScopedCharts();
            });
        }
        var btnScopeClear = $("btn-scope-clear");
        if (btnScopeClear) btnScopeClear.onclick = clearViewScopeFromUi;
        var btnScopeExpand = $("btn-scope-expand-user");
        if (btnScopeExpand) btnScopeExpand.onclick = expandSessionToUserFromUi;

        var orgRow = $("dash-prototype-org-row");
        if (orgRow) orgRow.hidden = !MASTER_ORG_SCOPE;
        var ps = $("dash-prototype-slot");
        var cs = $("dash-cohort-slot");
        var si;
        if (ps) {
            ps.innerHTML = "";
            for (si = 1; si <= 12; si++) {
                var o = document.createElement("option");
                o.value = String(si);
                o.textContent = String(si);
                ps.appendChild(o);
            }
        }
        if (cs) {
            cs.innerHTML = "";
            for (si = 1; si <= 12; si++) {
                var o2 = document.createElement("option");
                o2.value = String(si);
                o2.textContent = String(si);
                cs.appendChild(o2);
            }
        }
        var drm = $("dash-reverse-mode");
        function syncRevInputs() {
            var su = $("dash-reverse-session-url");
            var vu = $("dash-reverse-visitor");
            if (!drm || !su || !vu) return;
            var isV = drm.value === "visitor";
            su.hidden = isV;
            vu.hidden = !isV;
        }
        if (drm) drm.addEventListener("change", syncRevInputs);
        syncRevInputs();
        var df = $("dash-filter-apply");
        if (df)
            df.onclick = function () {
                fetchData();
            };
        var brv = $("btn-dash-reverse-search");
        if (brv) brv.onclick = runReverseSearch;
        var fsInput = $("fs-csv-input");
        var fsDrop = $("fs-upload-dropzone");
        if (fsInput) {
            fsInput.addEventListener("change", function () {
                var f = fsInput.files && fsInput.files[0];
                if (f) void uploadFullstoryCsv(f);
                fsInput.value = "";
            });
        }
        if (fsDrop && fsInput) {
            ["dragenter", "dragover"].forEach(function (evName) {
                fsDrop.addEventListener(evName, function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    fsDrop.classList.add("fs-upload-dropzone--hover");
                });
            });
            ["dragleave", "drop"].forEach(function (evName) {
                fsDrop.addEventListener(evName, function (e) {
                    e.preventDefault();
                    e.stopPropagation();
                    fsDrop.classList.remove("fs-upload-dropzone--hover");
                });
            });
            fsDrop.addEventListener("drop", function (e) {
                var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
                if (f) void uploadFullstoryCsv(f);
            });
            fsDrop.addEventListener("click", function () {
                fsInput.click();
            });
            fsDrop.addEventListener("keydown", function (e) {
                if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    fsInput.click();
                }
            });
        }
        var bsv = $("btn-dash-save-prototype");
        if (bsv) bsv.onclick = saveClusterPrototypeFromUi;
        var bsnap = $("btn-dash-snapshot-cohort");
        if (bsnap) bsnap.onclick = snapshotCohortFromUi;
        var bseg = $("btn-dash-apply-segmentation");
        if (bseg) bseg.onclick = applySegmentationFromUi;
        var btag = $("btn-dash-cluster-add-tag");
        if (btag) btag.onclick = addOverseerClusterTagFromUi;
        var bgf = $("btn-dash-gold-refresh");
        if (bgf) bgf.onclick = refreshGoldStandardList;
        var bgs = $("btn-dash-gold-save");
        if (bgs) bgs.onclick = saveGoldStandardFromUi;

        if (window.NexusFrictionTriage) {
            window.NexusFrictionTriage.init({
                getToken: getMasterInternalAdminToken,
                getOrigin: masterInternalApiOrigin,
                getOrgSlug: getEffectiveOrgSlugForInternal,
                getRows: function () {
                    return lastWarehouseRows;
                },
                getKineticPoints: function () {
                    return lastKineticPoints;
                },
                getM: function () {
                    return M;
                },
                onFocusSession: function (sid) {
                    if (!sid) return;
                    if (globalSessions[sid]) {
                        selectUser(sid);
                        return;
                    }
                    alert(
                        "Session #" +
                            sid +
                            " is not in the current warehouse load — widen the date filter or click Refresh data."
                    );
                },
                getDomainNeedle: function () {
                    var d = $("dash-context-domain");
                    return d && d.value ? String(d.value).trim() : "";
                },
                getDateRangeLabel: getDateRangeLabelForFriction,
            });
            function refreshFrictionShell() {
                if (window.NexusFrictionTriage && window.NexusFrictionTriage.refreshAll) {
                    void window.NexusFrictionTriage.refreshAll();
                }
            }
            var po = $("dash-prototype-org");
            if (po) po.addEventListener("change", refreshFrictionShell);
            var gs = $("dash-gold-org-slug");
            if (gs) gs.addEventListener("change", refreshFrictionShell);
            var cd = $("dash-context-domain");
            if (cd) cd.addEventListener("input", refreshFrictionShell);
            var ce = $("dash-context-env");
            if (ce) ce.addEventListener("change", refreshFrictionShell);
            refreshFrictionShell();
        }

        Promise.resolve()
            .then(function () {
                return setupConsoleOrgSwitcher();
            })
            .catch(function () {})
            .then(function () {
                return fetch("data/challenges.json");
            })
            .then(function (r) {
                return r.json();
            })
            .then(function (d) {
                populateModuleSelect(d.challenges || []);
                populateDimChallengeSelect(d.challenges || []);
            })
            .catch(function () {
                populateModuleSelect([]);
                populateDimChallengeSelect([]);
            })
            .then(function () {
                var sel = $("dash-module-filter");
                if (sel) {
                    sel.addEventListener("change", function () {
                        localStorage.setItem(LS_MODULE_KEY, sel.value);
                        fetchData();
                    });
                }
                fetchData();
            });

        var sk = $("kmeans-max-k");
        if (sk) {
            var saved = localStorage.getItem(LS_K_KEY);
            if (saved !== null && saved !== "") {
                var sv = parseInt(saved, 10);
                if (!isNaN(sv) && sv >= 1 && sv <= 12) sk.value = String(sv);
            }
            syncClusterKUi();
            var kdeb = null;
            sk.addEventListener("input", function () {
                syncClusterKUi();
                localStorage.setItem(LS_K_KEY, sk.value);
                clearTimeout(kdeb);
                kdeb = setTimeout(function () {
                    fetchData();
                }, 320);
            });
        }

        var resizeTimer;
        window.addEventListener("resize", function () {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(function () {
                renderParallelPanel();
                if (prototypeTimelineChart) {
                    try {
                        prototypeTimelineChart.resize();
                    } catch (_e) {}
                }
                dimensionCharts.forEach(function (ch) {
                    try {
                        ch.resize();
                    } catch (_e) {}
                });
            }, 200);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
