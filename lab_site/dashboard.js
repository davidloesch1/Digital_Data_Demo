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

    let cloudChart = null;
    let radarCtrl = null;
    let globalSessions = {};
    let globalCentroids = [];
    let lastKineticPoints = [];
    let selectedSid = null;

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

    function countKineticRows(rows) {
        if (!M) return 0;
        return rows.filter(function (r) {
            return M.isKineticEvent(r) && normalizeFingerprint(r);
        }).length;
    }

    /** Builds scatter points in PCA space + attaches fp for parallel coords. Uses NexusFingerprintViz when available. */
    function buildKineticPointsPCA(rows) {
        if (!M) return { points: [], pca: { explainedPct: [0, 0], fallback: true } };
        var kineticRows = rows.filter(function (r) {
            return M.isKineticEvent(r) && normalizeFingerprint(r);
        });
        if (!kineticRows.length) {
            return { points: [], pca: { explainedPct: [0, 0], fallback: true } };
        }
        var vectors = kineticRows.map(function (r) {
            return normalizeFingerprint(r);
        });
        var VF = typeof NexusFingerprintViz !== "undefined" ? NexusFingerprintViz : null;
        var pca = VF ? VF.pcaProject2D(vectors) : null;
        if (!pca || !pca.points || pca.points.length !== kineticRows.length) {
            return {
                points: kineticRows.map(function (d) {
                    var fp = normalizeFingerprint(d);
                    return {
                        x: fp[0],
                        y: fp[1],
                        fp: VF ? VF.pad16(fp) : fp,
                        original: d,
                        sid: M.getSessionKey(d),
                        clusterIndex: 0,
                    };
                }),
                pca: { explainedPct: [0, 0], fallback: true },
            };
        }
        var points = kineticRows.map(function (row, i) {
            var fp = normalizeFingerprint(row);
            var pt = pca.points[i];
            return {
                x: pt.x,
                y: pt.y,
                fp: VF.pad16(fp),
                original: row,
                sid: M.getSessionKey(row),
                clusterIndex: 0,
            };
        });
        return { points: points, pca: pca };
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
            var k = M ? M.getSessionKey(p.original) : fallbackSessionKey(p.original);
            return k === sid;
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
            };
        });
        NexusFingerprintViz.renderParallelCoords(host, items, { highlightSid: selectedSid });
    }

    function renderCloud(clusterResult, axisTitles) {
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
                            text: "No kinetic fingerprints yet — complete a challenge to populate the cloud.",
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
                    if (pt && pt.original) {
                        var sid = M ? M.getSessionKey(pt.original) : fallbackSessionKey(pt.original);
                        selectUser(sid);
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

    function selectUser(sid) {
        selectedSid = sid;
        var userEvents = globalSessions[sid];
        if (!userEvents || !userEvents.length) return;

        document.querySelectorAll(".session-item").forEach(function (el) {
            el.classList.toggle("active", el.getAttribute("data-sid") === sid);
        });

        var mean = sessionMeanPlane(sid);
        var clusterIdx = mean ? nearestClusterIndex(mean.x, mean.y) : 0;

        var kineticN = userEvents.filter(function (e) {
            return M && M.isKineticEvent(e);
        }).length;
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
        var keys = Object.keys(globalSessions);
        keys.sort(function (a, b) {
            var ka = countKineticRows(globalSessions[a]);
            var kb = countKineticRows(globalSessions[b]);
            if (kb !== ka) return kb - ka;
            return String(a).localeCompare(String(b));
        });
        keys.forEach(function (sid) {
            var rows = globalSessions[sid];
            var k = countKineticRows(rows);
            var div = document.createElement("div");
            div.className = "session-item" + (sid === selectedSid ? " active" : "");
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
                renderCloud({ clusters: [] }, { x: "PC1", y: "PC2" });
                renderParallelPanel();
                var cap = $("pca-caption");
                if (cap) cap.textContent = "";
                setStatus(true, "Warehouse reachable · empty");
                return;
            }

            globalSessions = groupSessions(data);
            var built = buildKineticPointsPCA(data);
            lastKineticPoints = built.points;
            var pca = built.pca;

            $("stat-kinetic").textContent = String(lastKineticPoints.length);
            $("stat-sessions").textContent = String(Object.keys(globalSessions).length);
            $("stat-integrity").textContent = computeIntegrity(data, lastKineticPoints);

            var axisTitles;
            var capEl = $("pca-caption");
            if (pca.fallback) {
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
            var kTarget = Math.min(maxK, Math.max(1, lastKineticPoints.length));
            var km = performKMeans(lastKineticPoints, kTarget);
            globalCentroids = km.centroids;

            var nonempty = km.clusters.filter(function (c) {
                return c.length > 0;
            }).length;
            $("stat-clusters").textContent = String(nonempty);

            renderSessionList();
            renderCloud(km, axisTitles);
            renderParallelPanel();

            if (selectedSid && globalSessions[selectedSid]) {
                selectUser(selectedSid);
            } else {
                var sorted = Object.keys(globalSessions);
                sorted.sort(function (a, b) {
                    var ka = countKineticRows(globalSessions[a]);
                    var kb = countKineticRows(globalSessions[b]);
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

        fetchData();

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
