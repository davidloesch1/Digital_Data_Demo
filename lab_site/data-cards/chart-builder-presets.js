/**
 * Vega-Lite 5 spec factories: chart definition = data, not ad-hoc Chart.js in many files.
 * New presets: add a key + factory here and register in CHART_PRESET_CATALOG in chart-builder.js
 */
(function (g) {
    g.NexusChartBuilderPresets = {
        /**
         * Arc / donut: count by family
         */
        labelFamilyDonut: function (rows) {
            const byFam = {};
            (rows || []).forEach((r) => {
                const f = r.family || "Other / unlabeled";
                byFam[f] = (byFam[f] || 0) + 1;
            });
            const L = g.NexusLabelFamily;
            const values = (L ? L.ORDER : Object.keys(byFam))
                .map((name) => ({ family: name, n: byFam[name] || 0 }))
                .filter((d) => d.n > 0);
            if (!values.length) {
                return {
                    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
                    description: "no rows",
                    data: { values: [{ family: "—", n: 1 }] },
                    mark: { type: "arc" },
                    encoding: {
                        theta: { field: "n", type: "quantitative" },
                        color: { field: "family", type: "nominal" },
                    },
                };
            }
            return {
                $schema: "https://vega.github.io/schema/vega-lite/v5.json",
                background: "transparent",
                data: { values: values },
                mark: { type: "arc", innerRadius: 50, cornerRadius: 2 },
                encoding: {
                    theta: { field: "n", type: "quantitative" },
                    color: {
                        field: "family",
                        type: "nominal",
                        title: "Lab family",
                    },
                },
                view: { stroke: "transparent" },
            };
        },

        /** Points: first two embedding dims, colored by session */
        fingerprintCloud: function (rows) {
            const pts = (rows || []).filter((r) => r.is_kinetic && r.fp0 != null && r.fp1 != null);
            return {
                $schema: "https://vega.github.io/schema/vega-lite/v5.json",
                background: "transparent",
                data: { values: pts },
                mark: { type: "point", filled: true, opacity: 0.7 },
                encoding: {
                    x: { field: "fp0", type: "quantitative", title: "fingerprint[0]" },
                    y: { field: "fp1", type: "quantitative", title: "fingerprint[1]" },
                    color: { field: "session_key", type: "nominal", title: "Session" },
                    tooltip: [
                        { field: "label", type: "nominal" },
                        { field: "session_key", type: "nominal" },
                    ],
                },
            };
        },

        /** Stacked time: binned by minute from ts, count by family */
        activityRidge: function (rows) {
            const withTs = (rows || []).filter((r) => r.ts != null);
            if (!withTs.length) {
                return {
                    $schema: "https://vega.github.io/schema/vega-lite/v5.json",
                    data: { values: [] },
                    mark: { type: "line" },
                };
            }
            const m = 60000;
            withTs.forEach((r) => {
                r.t_bin = Math.floor(r.ts / m) * m;
            });
            return {
                $schema: "https://vega.github.io/schema/vega-lite/v5.json",
                background: "transparent",
                data: { values: withTs },
                mark: { type: "line", point: true, interpolate: "monotone" },
                transform: [
                    { aggregate: [{ op: "count", as: "n" }], groupby: ["t_bin", "family"] },
                ],
                encoding: {
                    x: { field: "t_bin", type: "quantitative", title: "Time (ms, 1m bins)" },
                    y: { field: "n", type: "quantitative", title: "Events" },
                    color: { field: "family", type: "nominal" },
                },
            };
        },

        /** Open-field: paste a full VL spec in the text area. */
        templateEmpty: function () {
            return {
                $schema: "https://vega.github.io/schema/vega-lite/v5.json",
                description: "empty",
                data: { values: [] },
                mark: "point",
                encoding: { x: { value: 0 }, y: { value: 0 } },
            };
        },
    };
})(typeof window !== "undefined" ? window : this);
