/**
 * Archetype-style radar for the selected session's events.
 */
(function (g) {
    g.NexusDataCards = g.NexusDataCards || {};
    g.NexusDataCards.radarArchetype = {
        create: function (canvas) {
            let radarChart;
            if (!canvas || !canvas.getContext) {
                return { update: function () {} };
            }
            return {
                update: function (userEvents) {
                    const ctx = canvas.getContext("2d");
                    if (!userEvents || userEvents.length === 0) return;
                    const precision =
                        userEvents.filter((e) => (e.label || "").includes("READING")).length / userEvents.length;
                    const kinetic = userEvents.filter((e) => e.fingerprint && e.fingerprint.length > 2);
                    const urgency = kinetic.length
                        ? kinetic.reduce((acc, e) => acc + Math.abs(e.fingerprint[2]), 0) / kinetic.length
                        : 0;
                    const frictionEvents = userEvents.filter((e) => (e.label || "").includes("FRICTION"));
                    const resilience = frictionEvents.length > 0 ? 1 / frictionEvents.length : 1;
                    if (radarChart) radarChart.destroy();
                    radarChart = new Chart(ctx, {
                        type: "radar",
                        data: {
                            labels: ["Precision", "Urgency", "Resilience", "Focus", "Methodology"],
                            datasets: [
                                {
                                    label: "User Persona",
                                    data: [precision * 100, urgency * 100, resilience * 100, 70, 60],
                                    fill: true,
                                    backgroundColor: "rgba(99, 102, 241, 0.2)",
                                    borderColor: "#6366f1",
                                    pointBackgroundColor: "#6366f1",
                                },
                            ],
                        },
                        options: {
                            responsive: true,
                            maintainAspectRatio: false,
                            scales: { r: { min: 0, max: 100, ticks: { display: false }, grid: { color: "#334155" } } },
                            plugins: { legend: { display: false } },
                        },
                    });
                },
            };
        },
    };
})(typeof window !== "undefined" ? window : this);
