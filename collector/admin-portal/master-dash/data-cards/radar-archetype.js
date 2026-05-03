/**
 * Archetype-style radar for the selected session's events (warehouse rows).
 */
(function (g) {
    const M = g.NexusDataModel;

    function clamp01(x) {
        return Math.max(0, Math.min(100, x));
    }

    g.NexusDataCards = g.NexusDataCards || {};
    g.NexusDataCards.radarArchetype = {
        create: function (canvas) {
            let radarChart;
            if (!canvas || !canvas.getContext) {
                return { update: function () {}, destroy: function () {} };
            }
            return {
                update: function (userEvents) {
                    const ctx = canvas.getContext("2d");
                    if (!userEvents || userEvents.length === 0) return;

                    const kinetic = userEvents.filter(function (e) {
                        return M.isKineticEvent(e) && e.fingerprint && e.fingerprint.length >= 4;
                    });

                    const total = userEvents.length;
                    const readingHits = userEvents.filter(function (e) {
                        return (e.label || "").toUpperCase().indexOf("READING") >= 0;
                    }).length;
                    const precision = total ? (readingHits / total) * 100 : 0;

                    var urgency = 0;
                    if (kinetic.length) {
                        urgency =
                            (kinetic.reduce(function (acc, e) {
                                return acc + Math.abs(e.fingerprint[1] || 0);
                            }, 0) /
                                kinetic.length) *
                            100;
                    }

                    var frictionN = userEvents.filter(function (e) {
                        return (e.label || "").toUpperCase().indexOf("FRICTION") >= 0;
                    }).length;
                    var resilience = frictionN === 0 ? 88 : Math.max(18, 100 - frictionN * 22);

                    var focus = 0;
                    if (kinetic.length) {
                        focus =
                            (kinetic.reduce(function (acc, e) {
                                return acc + Math.abs(e.fingerprint[3] || 0);
                            }, 0) /
                                kinetic.length) *
                            100;
                    }

                    var methodology = Math.min(100, (kinetic.length / 28) * 100);

                    var stats = [
                        clamp01(precision),
                        clamp01(urgency),
                        clamp01(resilience),
                        clamp01(focus),
                        clamp01(methodology),
                    ];

                    if (radarChart) radarChart.destroy();
                    radarChart = new Chart(ctx, {
                        type: "radar",
                        data: {
                            labels: ["Precision", "Urgency", "Resilience", "Focus", "Methodology"],
                            datasets: [
                                {
                                    label: "Session persona",
                                    data: stats,
                                    fill: true,
                                    backgroundColor: "rgba(99, 102, 241, 0.22)",
                                    borderColor: "#6366f1",
                                    borderWidth: 2,
                                    pointBackgroundColor: "#6366f1",
                                },
                            ],
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            scales: {
                                r: {
                                    min: 0,
                                    max: 100,
                                    ticks: { display: false },
                                    angleLines: { color: "#334155" },
                                    grid: { color: "#334155" },
                                    pointLabels: { color: "#94a3b8", font: { size: 10 } },
                                },
                            },
                            plugins: { legend: { display: false } },
                        },
                    });
                },
                destroy: function () {
                    if (radarChart) {
                        radarChart.destroy();
                        radarChart = null;
                    }
                },
            };
        },
    };
})(typeof window !== "undefined" ? window : this);
