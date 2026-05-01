/**
 * Behavioral cloud (2D scatter of fingerprint[0] vs [1]).
 */
(function (g) {
    const M = g.NexusDataModel;

    g.NexusDataCards = g.NexusDataCards || {};
    g.NexusDataCards.behavioralCloud = {
        create: function (canvas) {
            let cloudChart;
            if (!canvas || !canvas.getContext) {
                return { update: function () {} };
            }
            return {
                update: function (sessions) {
                    const ctx = canvas.getContext("2d");
                    const datasets = Object.keys(sessions).map((sid) => {
                        const pts = sessions[sid]
                            .filter(M.isKineticEvent)
                            .map((d) => ({ x: d.fingerprint[0], y: d.fingerprint[1] }));
                        return {
                            label: sid,
                            data: pts,
                            backgroundColor: sid === "no-session" ? "#64748b" : "#6366f1",
                        };
                    });
                    if (cloudChart) cloudChart.destroy();
                    if (!datasets.length || !datasets.some((d) => d.data.length)) {
                        cloudChart = new Chart(ctx, {
                            type: "scatter",
                            data: {
                                datasets: [
                                    {
                                        label: "empty",
                                        data: [{ x: 0, y: 0 }],
                                        backgroundColor: "transparent",
                                    },
                                ],
                            },
                            options: {
                                plugins: {
                                    title: {
                                        display: true,
                                        text: "Add kinetic rows (fingerprints) to see the cloud",
                                        color: "#94a3b8",
                                    },
                                },
                                scales: { x: { display: false }, y: { display: false } },
                            },
                        });
                        return;
                    }
                    cloudChart = new Chart(ctx, {
                        type: "scatter",
                        data: { datasets },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            scales: { x: { display: false }, y: { display: false } },
                            plugins: { legend: { display: false } },
                        },
                    });
                },
            };
        },
    };
})(typeof window !== "undefined" ? window : this);
