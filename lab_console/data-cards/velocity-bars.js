/**
 * Kinetic vs nexus-label counts by session.
 */
(function (g) {
    const M = g.NexusDataModel;

    g.NexusDataCards = g.NexusDataCards || {};
    g.NexusDataCards.velocityBars = {
        create: function (canvas) {
            let velocityChart;
            if (!canvas || !canvas.getContext) {
                return { update: function () {} };
            }
            return {
                update: function (sessions) {
                    const ctx = canvas.getContext("2d");
                    const labels = Object.keys(sessions);
                    const kin = labels.map((sid) => sessions[sid].filter(M.isKineticEvent).length);
                    const lab = labels.map((sid) => sessions[sid].filter(M.isNexusLabelEvent).length);
                    if (velocityChart) velocityChart.destroy();
                    if (!labels.length) {
                        velocityChart = new Chart(ctx, {
                            type: "bar",
                            data: { labels: [""], datasets: [{ data: [0] }] },
                            options: { plugins: { title: { display: true, text: "No sessions", color: "#94a3b8" } } },
                        });
                        return;
                    }
                    velocityChart = new Chart(ctx, {
                        type: "bar",
                        data: {
                            labels,
                            datasets: [
                                { label: "Kinetic samples", data: kin, backgroundColor: "rgba(99, 102, 241, 0.7)" },
                                { label: "Nexus label events", data: lab, backgroundColor: "rgba(148, 163, 184, 0.7)" },
                            ],
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            plugins: { legend: { position: "bottom" } },
                            scales: { x: { grid: { color: "#334155" } }, y: { beginAtZero: true, grid: { color: "#334155" } } },
                        },
                    });
                },
            };
        },
    };
})(typeof window !== "undefined" ? window : this);
