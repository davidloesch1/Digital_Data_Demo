/**
 * Declarative chart builder: loads Vega-Lite specs from presets or a JSON textarea.
 * Data source: window.NexusDashboardState.sessions → NexusVizData.flatRows
 */
(function (g) {
    const CATALOG = [
        { id: "labelFamilyDonut", name: "Donut · lab family mix" },
        { id: "fingerprintCloud", name: "Scatter · fp0 vs fp1 (kinetic)" },
        { id: "activityRidge", name: "Lines · event rate (1m) by family" },
    ];

    let _embedResult = null;
    const DEFAULT_CUSTOM =
        '{\n' +
        '  "$schema": "https://vega.github.io/schema/vega-lite/v5.json",\n' +
        '  "data": { "values": [ { "hint": "Edit this spec or use Run preset" } ] },\n' +
        '  "mark": "text",\n' +
        '  "encoding": { "text": { "field": "hint" } },\n' +
        '  "width": 400\n' +
        "}";

    function getRows() {
        const ses = (g.NexusDashboardState && g.NexusDashboardState.sessions) || {};
        const raw = g.NexusVizData && g.NexusVizData.flatRows ? g.NexusVizData.flatRows(ses) : [];
        if (g.NexusDataConnector && g.NexusChartLab && g.NexusChartLab.state) {
            return g.NexusDataConnector.filter(raw, g.NexusChartLab.state);
        }
        return raw;
    }

    function finalize() {
        if (_embedResult && typeof _embedResult.finalize === "function") {
            try {
                _embedResult.finalize();
            } catch (e) {
                /* no-op */
            }
        }
        _embedResult = null;
    }

    function resolveVegaEmbed() {
        if (typeof g.vegaEmbed === "function") return g.vegaEmbed;
        if (typeof window !== "undefined" && typeof window.vegaEmbed === "function") {
            g.vegaEmbed = window.vegaEmbed;
            return g.vegaEmbed;
        }
        return null;
    }

    async function renderSpec(target, spec) {
        const run = resolveVegaEmbed();
        if (typeof run !== "function") {
            target.innerHTML =
                '<p class="chart-builder__err">Vega-Embed is not on window.vegaEmbed — add vega, vega-lite, then vega-embed in that order (see dashboard.html).</p>';
            return;
        }
        finalize();
        target.innerHTML = "";
        _embedResult = await run(target, spec, {
            actions: { export: true, source: true, editor: true, compiled: true },
            config: { background: null, axis: { labelColor: "#94a3b8", titleColor: "#e2e8f0" } },
        });
    }

    function wire(container) {
        if (!container) return;

        const sel = document.createElement("select");
        sel.className = "chart-builder__select";
        CATALOG.forEach((o) => {
            const opt = document.createElement("option");
            opt.value = o.id;
            opt.textContent = o.name;
            sel.appendChild(opt);
        });

        const runBtn = document.createElement("button");
        runBtn.type = "button";
        runBtn.className = "chart-builder__btn";
        runBtn.textContent = "Run preset";
        const applyCustomBtn = document.createElement("button");
        applyCustomBtn.type = "button";
        applyCustomBtn.className = "chart-builder__btn chart-builder__btn--secondary";
        applyCustomBtn.textContent = "Run custom JSON";

        const ta = document.createElement("textarea");
        ta.className = "chart-builder__ta";
        ta.setAttribute("spellcheck", "false");
        ta.rows = 10;
        ta.placeholder = "Vega-Lite 5 spec JSON (optional)…";
        ta.value = DEFAULT_CUSTOM;

        const out = document.createElement("div");
        out.className = "chart-builder__view";
        out.id = "nexus-vega-builder-target";

        const top = document.createElement("div");
        top.className = "chart-builder__toolbar";
        top.appendChild(sel);
        top.appendChild(runBtn);
        top.appendChild(applyCustomBtn);
        container.appendChild(top);
        container.appendChild(ta);
        container.appendChild(out);

        const Presets = g.NexusChartBuilderPresets;
        if (!Presets) {
            out.innerHTML =
                '<p class="chart-builder__err">Load data-cards/chart-builder-presets.js before chart-builder.js.</p>';
            return;
        }

        runBtn.addEventListener("click", function () {
            const fn = Presets[sel.value];
            if (typeof fn !== "function") return;
            const rows = getRows();
            const spec = fn(rows);
            return renderSpec(out, spec);
        });
        applyCustomBtn.addEventListener("click", function () {
            try {
                const j = JSON.parse(ta.value);
                return renderSpec(out, j);
            } catch (e) {
                out.innerHTML =
                    '<p class="chart-builder__err">Invalid JSON: ' +
                    String((e && e.message) || e) +
                    "</p>";
            }
        });
    }

    g.NexusChartBuilder = {
        init: function (containerId) {
            const c = document.getElementById(containerId);
            wire(c);
        },
    };

    g.NexusChartBuilderCatalog = CATALOG;
    if (typeof document !== "undefined" && document.getElementById("chart-builder") && g.NexusChartBuilder) {
        g.NexusChartBuilder.init("chart-builder");
    }
})(typeof window !== "undefined" ? window : this);
