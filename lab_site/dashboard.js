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

    let cloudChart = null;
    let radarCtrl = null;
    let globalSessions = {};
    let globalCentroids = [];
    let lastKineticPoints = [];
    let selectedSid = null;
    let selectedUserKey = null;

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
                return {
                    fp: meanVector(fps),
                    row: rs[0],
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
                return {
                    fp: meanVector(fps),
                    row: rs[0],
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
                    if (pt.aggregateKind === "user" && pt.userKey) {
                        selectUserByVisitorKey(pt.userKey);
                    } else {
                        selectUser(pt.sid);
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

    function selectUserByVisitorKey(uk) {
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
    }

    function selectUser(sid) {
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
                $("stat-kinetic").textContent = "0";
                $("stat-clusters").textContent = "0";
                $("stat-sessions").textContent = "0";
                $("stat-integrity").textContent = "—";
                renderSessionList();
                renderCloud({ clusters: [] }, { x: "PC1", y: "PC2" }, null);
                renderParallelPanel();
                var cap = $("pca-caption");
                if (cap) cap.textContent = "";
                setStatus(true, "Warehouse reachable · empty");
                return;
            }

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
                if (first && lastKineticPoints.length) selectUser(first);
            }

            setStatus(true, "Live · " + data.length + " warehouse rows");
        } catch (err) {
            console.error("Dashboard fetch error:", err);
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

    function init() {
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

        fetch("data/challenges.json")
            .then(function (r) {
                return r.json();
            })
            .then(function (d) {
                populateModuleSelect(d.challenges || []);
            })
            .catch(function () {
                populateModuleSelect([]);
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
            }, 200);
        });
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
