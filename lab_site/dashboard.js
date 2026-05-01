/**
 * Discovery dashboard: warehouse summary → K-means cloud + archetype radar.
 */
(function () {
    const API_BASE = (typeof window !== "undefined" && window.NEXUS_DASH_API) || "http://localhost:3000";
    const M = typeof NexusDataModel !== "undefined" ? NexusDataModel : null;

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
    let dimensionCharts = [];

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
     * Maps warehouse row label to challenge module id (matches lab_site/data/challenges.json ids).
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

    function renderDimensionCharts(allRows) {
        var grid = $("dimension-charts-grid");
        if (!grid) return;
        destroyDimensionCharts();
        var rows = allRows && allRows.length ? allRows : [];
        var scope = getDimScope();
        var challengeFilter = getDimChallengeFilter();
        var built = buildDimensionUnits(rows, scope, challengeFilter);
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
                    " row(s). Same color = same FullStory session; x = row index with slight jitter.";
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
            var colorOfSid = {};
            sessionOrder.forEach(function (sid, idx) {
                colorOfSid[sid] = CLUSTER_COLORS[idx % CLUSTER_COLORS.length];
            });

            var dKin;
            for (dKin = 0; dKin < 16; dKin++) {
                (function (dim) {
                    var meta = kinPts.map(function (p) {
                        return {
                            sid: p.sid,
                            label: p.row && p.row.label ? String(p.row.label) : "",
                        };
                    });
                    var scatterData = kinPts.map(function (p, idx) {
                        var j = hashSidForJitter(String(p.sid) + ":" + idx) % 1999;
                        var x = idx + j / 25000;
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
                    var chart = new Chart(ctx, {
                        type: "scatter",
                        data: {
                            datasets: [
                                {
                                    label: "rows",
                                    data: scatterData,
                                    pointBackgroundColor: colors,
                                    pointBorderColor: "rgba(255,255,255,0.2)",
                                    borderWidth: 1,
                                    pointRadius: 4,
                                    pointHoverRadius: 6,
                                },
                            ],
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            animation: { duration: 240 },
                            layout: { padding: { left: 4, right: 8, top: 4, bottom: 4 } },
                            onClick: function (_evt, elements) {
                                if (!elements.length) return;
                                var idx = elements[0].index;
                                var m = meta[idx];
                                if (m && m.sid) {
                                    selectUser(m.sid);
                                }
                            },
                            plugins: {
                                legend: { display: false },
                                tooltip: {
                                    callbacks: {
                                        label: function (ctx) {
                                            var i = ctx.dataIndex;
                                            var m = meta[i];
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
            var s = document.createElement("span");
            s.className = "cluster-swatch";
            s.style.backgroundColor = ds.backgroundColor;
            s.title = "Cluster " + (idx + 1);
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
        var items = lastKineticPoints.map(function (p) {
            return {
                vector: p.fp,
                color: CLUSTER_COLORS[p.clusterIndex % CLUSTER_COLORS.length] || "#6366f1",
                opacity: 0.42,
                sid: p.sid,
                userKey: p.userKey || null,
            };
        });
        NexusFingerprintViz.renderParallelCoords(host, items, {
            highlightSid: selectedSid,
            highlightUserKey: selectedUserKey,
        });
    }

    function renderCloud(clusterResult, axisTitles, emptyHint) {
        axisTitles = axisTitles || { x: "PC1", y: "PC2" };
        var ctx = $("cloudChart").getContext("2d");
        var clusters = clusterResult.clusters;

        var datasets = clusters
            .map(function (cluster, i) {
                return {
                    label: "",
                    clusterSlotIndex: i,
                    data: cluster,
                    backgroundColor: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
                    pointRadius: 6,
                    hoverRadius: 9,
                    pointHoverBackgroundColor: CLUSTER_COLORS[i % CLUSTER_COLORS.length],
                };
            })
            .filter(function (ds) {
                return ds.data.length > 0;
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
        renderParallelPanel();
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
        renderParallelPanel();
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

    async function fetchData() {
        try {
            var url = API_BASE.replace(/\/?$/, "") + "/summary";
            var response = await fetch(url);
            if (!response.ok) throw new Error("HTTP " + response.status);
            var data = await response.json();

            if (!data || !data.length) {
                globalSessions = {};
                globalCentroids = [];
                lastKineticPoints = [];
                lastWarehouseRows = [];
                $("stat-kinetic").textContent = "0";
                $("stat-clusters").textContent = "0";
                $("stat-sessions").textContent = "0";
                $("stat-integrity").textContent = "—";
                clearFullStoryMomentUI();
                renderSessionList();
                renderCloud({ clusters: [] }, { x: "PC1", y: "PC2" }, null);
                renderParallelPanel();
                renderDimensionCharts([]);
                var cap = $("pca-caption");
                if (cap) cap.textContent = "";
                setStatus(true, "Warehouse reachable · empty");
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

            var maxK = getDesiredClusterCount();
            syncClusterKUi();
            var km =
                lastKineticPoints.length === 0
                    ? { clusters: [], centroids: [] }
                    : performKMeans(lastKineticPoints, Math.min(maxK, lastKineticPoints.length));
            globalCentroids = km.centroids;

            var nonempty = km.clusters.filter(function (c) {
                return c.length > 0;
            }).length;
            $("stat-clusters").textContent = String(nonempty);

            renderSessionList();
            renderCloud(
                km,
                axisTitles,
                lastKineticPoints.length ? null : built.emptyHint
            );
            renderParallelPanel();

            var gran = getGranularityMode();
            if (
                gran === "user" &&
                selectedUserKey &&
                collectRowsForVisitorKey(selectedUserKey).length
            ) {
                selectUserByVisitorKey(selectedUserKey);
            } else if (selectedSid && globalSessions[selectedSid] && sessionVisibleForModule(selectedSid, mf)) {
                selectUser(selectedSid);
            } else {
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
                } else {
                    clearFullStoryMomentUI();
                }
            }

            renderDimensionCharts(data);

            setStatus(true, "Live · " + data.length + " warehouse rows");
        } catch (err) {
            console.error("Dashboard fetch error:", err);
            clearFullStoryMomentUI();
            setStatus(false, "Cannot reach API (" + API_BASE + "). Start collector: node collector.js");
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

    function init() {
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
                renderDimensionCharts(lastWarehouseRows);
            });
        }

        var dimChallengeEl = $("dim-challenge");
        if (dimChallengeEl) {
            dimChallengeEl.addEventListener("change", function () {
                localStorage.setItem(LS_DIM_CHALLENGE_KEY, dimChallengeEl.value);
                renderDimensionCharts(lastWarehouseRows);
            });
        }

        fetch("data/challenges.json")
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
