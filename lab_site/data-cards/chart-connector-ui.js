/**
 * Connector + preview: filters govern rows passed to Vega / presets; table shows first N rows.
 */
(function (g) {
    const PREVIEW_LIMIT = 18;
    const COLS = ["session_key", "label", "family", "type", "is_kinetic", "ts"];

    function el(tag, className) {
        const n = document.createElement(tag);
        if (className) n.className = className;
        return n;
    }

    function getRawFlat() {
        const ses = (g.NexusDashboardState && g.NexusDashboardState.sessions) || {};
        if (!g.NexusVizData || !g.NexusVizData.flatRows) return [];
        return g.NexusVizData.flatRows(ses);
    }

    function getFiltered() {
        const raw = getRawFlat();
        if (!g.NexusDataConnector) return raw;
        return g.NexusDataConnector.filter(raw, (g.NexusChartLab && g.NexusChartLab.state) || {});
    }

    function buildTable(rows) {
        const wrap = el("div", "chart-connector__table-wrap");
        if (!rows.length) {
            const p = el("p", "chart-connector__empty");
            p.textContent = "No rows. Refresh the dashboard or loosen filters.";
            wrap.appendChild(p);
            return wrap;
        }
        const table = el("table", "chart-connector__table");
        const thead = el("thead");
        const htr = el("tr");
        COLS.forEach((c) => {
            const th = el("th");
            th.textContent = c;
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);
        const tbody = el("tbody");
        const slice = rows.slice(0, PREVIEW_LIMIT);
        slice.forEach((r) => {
            const tr = el("tr");
            COLS.forEach((c) => {
                const td = el("td");
                const v = r[c];
                td.textContent = v == null ? "—" : String(v);
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        wrap.appendChild(table);
        const cap = el("p", "chart-connector__caption");
        const total = rows.length;
        const shown = Math.min(PREVIEW_LIMIT, total);
        cap.textContent =
            "Showing " + shown + " of " + total + " connected row" + (total === 1 ? "" : "s");
        wrap.appendChild(cap);
        return wrap;
    }

    g.NexusChartConnectorUI = {
        init: function (containerId) {
            const host = document.getElementById(containerId);
            if (!host) return;
            if (!g.NexusChartLab || !g.NexusDataConnector) {
                host.textContent = "nexus-connector.js must load first.";
                return;
            }

            function state() {
                return g.NexusChartLab.state;
            }
            const root = el("div", "chart-connector");

            const head = el("div", "chart-connector__head");
            const h3 = el("h3", "chart-connector__title");
            h3.textContent = "Data connection";
            const p = el("p", "chart-connector__lede");
            p.textContent = "Narrow the event stream, then use presets or custom JSON below. Charts always use the filtered set.";
            head.appendChild(h3);
            head.appendChild(p);
            root.appendChild(head);

            const grid = el("div", "chart-connector__form");

            const r1 = el("div", "chart-connector__row");
            r1.appendChild(lab("Event rows"));
            const rowMode = el("select", "chart-connector__input");
            [["all", "All events"], ["kinetic", "Kinetic only"], ["nexus_label", "Nexus label only"]].forEach(
                ([v, t]) => {
                    const o = el("option");
                    o.value = v;
                    o.textContent = t;
                    rowMode.appendChild(o);
                }
            );
            rowMode.value = state().rowMode;
            r1.appendChild(wrapField(rowMode));
            grid.appendChild(r1);

            const r2 = el("div", "chart-connector__row");
            r2.appendChild(lab("Sessions"));
            const sessMode = el("select", "chart-connector__input");
            [
                ["all", "All sessions"],
                ["include", "Only selected…"],
            ].forEach(([v, t]) => {
                const o = el("option");
                o.value = v;
                o.textContent = t;
                sessMode.appendChild(o);
            });
            sessMode.value = state().sessionMode;
            const mult = el("select", "chart-connector__multiselect");
            mult.multiple = true;
            mult.size = 5;
            mult.setAttribute("aria-label", "Session keys");
            const r2b = el("div", "chart-connector__session");
            r2b.appendChild(wrapField(sessMode));
            r2b.appendChild(mult);
            r2.appendChild(r2b);
            grid.appendChild(r2);

            const r3 = el("div", "chart-connector__row chart-connector__row--time");
            r3.appendChild(lab("Time (ms)"));
            const t1 = el("input", "chart-connector__input chart-connector__input--time");
            t1.type = "text";
            t1.placeholder = "t min (optional)";
            t1.value = state().tMin != null && state().tMin !== "" ? String(state().tMin) : "";
            const t2 = el("input", "chart-connector__input chart-connector__input--time");
            t2.type = "text";
            t2.placeholder = "t max (optional)";
            t2.value = state().tMax != null && state().tMax !== "" ? String(state().tMax) : "";
            const twrap = el("div", "chart-connector__time");
            twrap.appendChild(t1);
            twrap.appendChild(t2);
            r3.appendChild(twrap);
            grid.appendChild(r3);

            const r4 = el("div", "chart-connector__row chart-connector__row--btns");
            const reset = el("button", "chart-connector__btn");
            reset.type = "button";
            reset.textContent = "Reset filters";
            r4.appendChild(reset);
            grid.appendChild(r4);
            root.appendChild(grid);

            const preview = el("div", "chart-connector__preview");
            const h4 = el("h4", "chart-connector__sub");
            h4.textContent = "Preview";
            preview.appendChild(h4);
            const tableMount = el("div", "chart-connector__table-host");
            preview.appendChild(tableMount);
            root.appendChild(preview);

            host.appendChild(root);

            function readFormIntoState() {
                const s = state();
                s.rowMode = rowMode.value;
                s.sessionMode = sessMode.value;
                s.sessionKeys = [];
                if (s.sessionMode === "include") {
                    for (let i = 0; i < mult.options.length; i++) {
                        if (mult.options[i].selected) s.sessionKeys.push(mult.options[i].value);
                    }
                }
                s.tMin = t1.value.trim() === "" ? null : t1.value;
                s.tMax = t2.value.trim() === "" ? null : t2.value;
            }

            function repopSessionKeys() {
                const keys = g.NexusDataConnector
                    ? g.NexusDataConnector.uniqueSessionKeys(getRawFlat())
                    : [];
                mult.innerHTML = "";
                const cur = state().sessionKeys;
                keys.forEach((k) => {
                    const o = el("option");
                    o.value = k;
                    o.textContent = k;
                    if (cur && cur.indexOf(k) >= 0) o.selected = true;
                    mult.appendChild(o);
                });
                mult.disabled = sessMode.value === "all";
            }

            function renderPreview() {
                tableMount.innerHTML = "";
                const rows = getFiltered();
                tableMount.appendChild(buildTable(rows));
            }

            function onAnyChange() {
                readFormIntoState();
                renderPreview();
            }

            rowMode.addEventListener("change", onAnyChange);
            sessMode.addEventListener("change", function () {
                state().sessionMode = sessMode.value;
                mult.disabled = sessMode.value === "all";
                onAnyChange();
            });
            mult.addEventListener("change", onAnyChange);
            t1.addEventListener("input", onAnyChange);
            t2.addEventListener("input", onAnyChange);
            reset.addEventListener("click", function () {
                const cur = g.NexusChartLab.state;
                const fr = g.NexusDataConnector.defaultState();
                cur.schemaVersion = fr.schemaVersion;
                cur.rowMode = fr.rowMode;
                cur.sessionMode = fr.sessionMode;
                cur.sessionKeys = fr.sessionKeys.slice();
                cur.tMin = fr.tMin;
                cur.tMax = fr.tMax;
                rowMode.value = cur.rowMode;
                sessMode.value = cur.sessionMode;
                t1.value = "";
                t2.value = "";
                readFormIntoState();
                repopSessionKeys();
                onAnyChange();
            });

            window.addEventListener("nexus-sessions-updated", function () {
                repopSessionKeys();
                renderPreview();
            });

            repopSessionKeys();
            mult.disabled = state().sessionMode === "all";
            onAnyChange();
        },
    };

    function lab(text) {
        const l = el("label", "chart-connector__label");
        l.textContent = text;
        return l;
    }
    function wrapField(node) {
        const d = el("div", "chart-connector__field");
        d.appendChild(node);
        return d;
    }
    if (typeof document !== "undefined" && document.getElementById("chart-connector-root")) {
        g.NexusChartConnectorUI.init("chart-connector-root");
    }
})(typeof window !== "undefined" ? window : this);
