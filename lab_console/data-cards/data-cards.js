/**
 * Builds the dashboard data-card regions and returns chart update handles.
 * Add new cards by extending the DOM in build() and calling another NexusDataCards.*.create().
 */
(function (g) {
    function el(tag, className, attrs) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        if (attrs) {
            Object.keys(attrs).forEach((k) => n.setAttribute(k, attrs[k]));
        }
        return n;
    }

    function dataCard(eyebrow, canvasId) {
        const card = el("section", "data-card");
        const sub = el("div", "data-card__eyebrow");
        sub.textContent = eyebrow;
        const box = el("div", "data-card__chart");
        const c = el("canvas", null, { id: canvasId });
        box.appendChild(c);
        card.appendChild(sub);
        card.appendChild(box);
        return { card, canvas: c };
    }

    g.NexusDataCards = g.NexusDataCards || {};
    g.NexusDataCards.mount = function (container) {
        if (!container) return { setSessions: function () {}, setSelectedRadarEvents: function () {} };

        const grid = el("div", "data-cards__grid");
        const a = dataCard("Behavioral Cloud (Clustering)", "nexus-card-behavioral-cloud");
        const b = dataCard("Archetype Radar (Selected User)", "nexus-card-radar");
        grid.appendChild(a.card);
        grid.appendChild(b.card);

        const velWrap = el("div", "data-card data-card--full-bleed");
        const velEyebrow = el("div", "data-card__eyebrow");
        velEyebrow.textContent = "Engagement Velocity vs. Friction";
        const velBox = el("div", "data-card__chart");
        const velCanvas = el("canvas", null, { id: "nexus-card-velocity" });
        velBox.appendChild(velCanvas);
        velWrap.appendChild(velEyebrow);
        velWrap.appendChild(velBox);

        const mix = dataCard("Phase mix (all runs)", "nexus-card-label-mix");
        const mixChartBox = mix.card.querySelector(".data-card__chart");
        if (mixChartBox) {
            mixChartBox.classList.add("data-card__chart--doughnut");
        }

        const root = el("div", "data-cards");
        root.appendChild(grid);
        root.appendChild(velWrap);
        mix.card.classList.add("data-card--span");
        root.appendChild(mix.card);
        container.appendChild(root);

        const cloud = g.NexusDataCards.behavioralCloud.create(
            document.getElementById("nexus-card-behavioral-cloud")
        );
        const radar = g.NexusDataCards.radarArchetype.create(document.getElementById("nexus-card-radar"));
        const velocity = g.NexusDataCards.velocityBars.create(document.getElementById("nexus-card-velocity"));
        const labelMix = g.NexusDataCards.labelMixDoughnut.create(
            document.getElementById("nexus-card-label-mix")
        );

        return {
            setSessions: function (sessions) {
                const s = sessions && typeof sessions === "object" ? sessions : {};
                cloud.update(s);
                velocity.update(s);
                labelMix.update(s);
            },
            setSelectedRadarEvents: function (userEvents) {
                radar.update(userEvents);
            },
        };
    };
})(typeof window !== "undefined" ? window : this);
