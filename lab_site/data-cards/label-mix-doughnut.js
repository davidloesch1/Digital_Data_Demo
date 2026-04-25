/**
 * Lab "phase family" mix — doughnut of event counts by family (uses NexusLabelFamily).
 */
(function (g) {
    const M = g.NexusDataModel;
    const L = g.NexusLabelFamily;

    function countFamilies(sessions) {
        const counts = {};
        (L.ORDER || []).forEach((k) => {
            counts[k] = 0;
        });
        Object.keys(sessions).forEach((sid) => {
            sessions[sid].forEach((row) => {
                const fam = L.fromLabel(row && row.label);
                counts[fam] = (counts[fam] || 0) + 1;
            });
        });
        return counts;
    }

    g.NexusDataCards = g.NexusDataCards || {};
    g.NexusDataCards.labelMixDoughnut = {
        create: function (canvas) {
            let chart;
            if (!canvas || !canvas.getContext) {
                return { update: function () {} };
            }
            return {
                update: function (sessions) {
                    const ctx = canvas.getContext("2d");
                    const s = sessions && typeof sessions === "object" ? sessions : {};
                    const totalRows = Object.keys(s).reduce((a, k) => a + s[k].length, 0);
                    if (chart) chart.destroy();
                    if (!totalRows) {
                        chart = new Chart(ctx, {
                            type: "doughnut",
                            data: { labels: [""], datasets: [{ data: [1], backgroundColor: ["#1e293b"] }] },
                            options: {
                                cutout: "58%",
                                plugins: {
                                    legend: { display: false },
                                    title: {
                                        display: true,
                                        text: "Load warehouse data to see the mix",
                                        color: "#94a3b8",
                                        font: { size: 14, family: "'Inter', system-ui, sans-serif" },
                                    },
                                },
                            },
                        });
                        return;
                    }
                    const counts = countFamilies(s);
                    const labels = [];
                    const data = [];
                    const colors = [];
                    L.ORDER.forEach((name, i) => {
                        const c = counts[name] || 0;
                        if (c > 0) {
                            labels.push(name);
                            data.push(c);
                            colors.push(L.palette[i % L.palette.length]);
                        }
                    });
                    if (labels.length === 0) {
                        chart = new Chart(ctx, {
                            type: "doughnut",
                            data: { labels: [""], datasets: [{ data: [1], backgroundColor: ["#1e293b"] }] },
                            options: {
                                cutout: "58%",
                                plugins: {
                                    legend: { display: false },
                                    title: {
                                        display: true,
                                        text: "No label fields to aggregate",
                                        color: "#94a3b8",
                                    },
                                },
                            },
                        });
                        return;
                    }
                    const kRows = Object.keys(s).reduce(
                        (acc, sid) => acc + s[sid].filter(M.isKineticEvent).length,
                        0
                    );
                    const kineticShare = totalRows ? Math.round((100 * kRows) / totalRows) : 0;
                    chart = new Chart(ctx, {
                        type: "doughnut",
                        data: {
                            labels: labels,
                            datasets: [
                                {
                                    data: data,
                                    backgroundColor: colors,
                                    borderColor: "#0f172a",
                                    borderWidth: 2,
                                    hoverOffset: 10,
                                },
                            ],
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            cutout: "58%",
                            animation: { animateRotate: true, animateScale: true, duration: 800 },
                            plugins: {
                                legend: {
                                    position: "right",
                                    labels: {
                                        color: "#e2e8f0",
                                        usePointStyle: true,
                                        padding: 12,
                                    },
                                },
                                title: {
                                    display: true,
                                    text: "Events in view · ~" + kineticShare + "% kinetic rows",
                                    color: "#94a3b8",
                                    font: { size: 11, weight: "500" },
                                },
                                tooltip: {
                                    backgroundColor: "rgba(15, 23, 42, 0.96)",
                                    titleColor: "#f8fafc",
                                    bodyColor: "#cbd5e1",
                                    borderColor: "#334155",
                                    borderWidth: 1,
                                    callbacks: {
                                        label: function (ctx) {
                                            const n = ctx.raw;
                                            const sum = ctx.dataset.data.reduce((a, b) => a + b, 0);
                                            const pct = sum ? ((100 * n) / sum).toFixed(1) : "0";
                                            return " " + n + " evts  ·  " + pct + "% of chart";
                                        },
                                    },
                                },
                            },
                        },
                    });
                },
            };
        },
    };
})(typeof window !== "undefined" ? window : this);
