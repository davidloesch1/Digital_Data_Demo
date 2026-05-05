/**
 * Master dashboard — Friction triage slice (schema health, friction counts, Postgres friction rows, review queue).
 * Depends on dashboard.js calling init() with getters and processWarehouseRows calling refreshAll().
 */
(function (g) {
    "use strict";

    var DASH_CONTRACT_VERSION = 1;
    var EXPECTED_SIGNAL_SCHEMA = 1;
    var LS_GUIDED = "nexus_dash_friction_guided";
    var ctx = {
        getToken: function () {
            return "";
        },
        getOrigin: function () {
            return "";
        },
        getOrgSlug: function () {
            return "";
        },
        getRows: function () {
            return [];
        },
        getKineticPoints: function () {
            return [];
        },
        getM: function () {
            return null;
        },
        onFocusSession: function (_sid) {},
        getDomainNeedle: function () {
            return "";
        },
        getDateRangeLabel: function () {
            return "";
        },
    };

    function $(id) {
        return document.getElementById(id);
    }

    function readSignalBuffer(row) {
        if (!row || typeof row !== "object") return [];
        var b = row.signal_buffer;
        if (Array.isArray(b)) return b;
        if (row.signal_buffer_json != null) {
            var s = String(row.signal_buffer_json).trim();
            if (!s) return [];
            try {
                var j = JSON.parse(s);
                return Array.isArray(j) ? j : [];
            } catch (_e) {
                return [];
            }
        }
        return [];
    }

    function bufferKinds(buf) {
        var set = {};
        for (var i = 0; i < buf.length; i++) {
            var e = buf[i];
            if (e && typeof e === "object" && e.kind) set[String(e.kind)] = true;
        }
        return Object.keys(set);
    }

    function rowMatchesDomain(row, needle) {
        if (!needle) return true;
        var n = needle.toLowerCase();
        var hay = ((row.session_url || "") + " " + (row.label || "")).toLowerCase();
        return hay.indexOf(n) !== -1;
    }

    function filterRows(rows) {
        var needle = ctx.getDomainNeedle ? ctx.getDomainNeedle() : "";
        if (!needle || !rows || !rows.length) return rows || [];
        return rows.filter(function (r) {
            return rowMatchesDomain(r, needle);
        });
    }

    function analyzeWarehouse(rows) {
        var M = ctx.getM && ctx.getM();
        var kinetic = 0;
        var missingBuf = 0;
        var schemaHist = {};
        var confusion = 0;
        var dwell = 0;
        var otherKinds = {};
        var schemaDrift = false;

        (rows || []).forEach(function (row) {
            if (!M || !M.isKineticEvent(row)) return;
            kinetic++;
            var buf = readSignalBuffer(row);
            if (!buf.length) missingBuf++;
            var sv = row.signal_schema_version;
            if (sv != null && Number(sv) !== EXPECTED_SIGNAL_SCHEMA) schemaDrift = true;
            var key = sv != null ? String(sv) : "unset";
            schemaHist[key] = (schemaHist[key] || 0) + 1;

            buf.forEach(function (e) {
                if (!e || typeof e !== "object" || !e.kind) return;
                var k = String(e.kind);
                if (k === "CONFUSION") confusion++;
                else if (k === "DWELL") dwell++;
                else otherKinds[k] = (otherKinds[k] || 0) + 1;
            });
        });

        return {
            kinetic: kinetic,
            missingBuffer: missingBuf,
            schemaHist: schemaHist,
            confusion: confusion,
            dwell: dwell,
            otherKinds: otherKinds,
            schemaDrift: schemaDrift,
        };
    }

    function reviewScoreFromPoint(pt) {
        var row = pt && pt.original;
        if (!row) return 0;
        var buf = readSignalBuffer(row);
        var score = 0;
        buf.forEach(function (e) {
            if (!e || !e.kind) return;
            if (e.kind === "CONFUSION") score += 4;
            else if (e.kind === "DWELL") score += 3;
            else score += 0.5;
        });
        var sim = pt.prototypeMatch && typeof pt.prototypeMatch.similarity === "number" ? pt.prototypeMatch.similarity : null;
        if (sim == null) score += 2;
        else score += (1 - sim) * 5;
        return score;
    }

    function buildReviewQueue(kineticPoints, limit) {
        var pts = (kineticPoints || []).slice();
        pts.sort(function (a, b) {
            return reviewScoreFromPoint(b) - reviewScoreFromPoint(a);
        });
        var out = [];
        var seen = {};
        for (var i = 0; i < pts.length && out.length < limit; i++) {
            var sid = pts[i].sid != null ? String(pts[i].sid) : "";
            if (!sid || seen[sid]) continue;
            seen[sid] = true;
            out.push({
                sid: sid,
                score: reviewScoreFromPoint(pts[i]).toFixed(1),
                preview: pts[i].original && pts[i].original.label ? String(pts[i].original.label).slice(0, 48) : "",
            });
        }
        return out;
    }

    function setText(id, text) {
        var el = $(id);
        if (el) el.textContent = text != null ? String(text) : "";
    }

    function setGuidedVisible(guided) {
        document.querySelectorAll(".dash-friction-guided").forEach(function (el) {
            el.hidden = !guided;
        });
        var aj = $("dash-friction-analyst-panel");
        if (aj) aj.hidden = guided;
    }

    function applyGuidedModeFromStorage() {
        var guided = true;
        try {
            var v = localStorage.getItem(LS_GUIDED);
            if (v === "0") guided = false;
        } catch (_e) {}
        var cb = $("dash-friction-guided-toggle");
        if (cb) cb.checked = guided;
        setGuidedVisible(guided);
    }

    function renderSchemaCard(agg) {
        setText("friction-metric-kinetic", agg.kinetic || 0);
        setText("friction-metric-missing-buffer", agg.missingBuffer || 0);
        var parts = Object.keys(agg.schemaHist || {})
            .sort()
            .map(function (k) {
                return k + ": " + agg.schemaHist[k];
            });
        setText("friction-metric-schema-hist", parts.length ? parts.join(" · ") : "—");
        var empty = $("friction-card-schema-empty");
        if (empty) empty.hidden = (agg.kinetic || 0) !== 0;
    }

    function renderFrictionKindsCard(agg) {
        setText("friction-metric-confusion", agg.confusion || 0);
        setText("friction-metric-dwell", agg.dwell || 0);
        var ok = Object.keys(agg.otherKinds || {}).length;
        setText("friction-metric-other-kinds", ok ? JSON.stringify(agg.otherKinds) : "—");
    }

    function sessionIdFromUrl(url) {
        if (!url) return "";
        var parts = String(url).split("/").filter(Boolean);
        return parts.length ? parts[parts.length - 1] : "";
    }

    function renderFrictionTable(rows) {
        var wrap = $("dash-friction-table-body");
        if (!wrap) return;
        wrap.innerHTML = "";
        if (!rows || !rows.length) {
            var tr0 = document.createElement("tr");
            var td0 = document.createElement("td");
            td0.colSpan = 4;
            td0.className = "dash-friction-table__empty";
            td0.textContent = "No friction rows from Postgres for this org (or not authorized).";
            tr0.appendChild(td0);
            wrap.appendChild(tr0);
            return;
        }
        rows.forEach(function (r) {
            var tr = document.createElement("tr");
            var url = r.session_url ? String(r.session_url) : "";
            var sid = sessionIdFromUrl(url);
            var tdT = document.createElement("td");
            tdT.className = "dash-friction-table__mono";
            tdT.textContent = r.created_at ? String(r.created_at).slice(0, 19) : "—";
            var tdK = document.createElement("td");
            tdK.textContent = Array.isArray(r.friction_kinds) ? r.friction_kinds.join(", ") : String(r.friction_kinds || "");
            var tdU = document.createElement("td");
            tdU.className = "dash-friction-table__url";
            if (url) {
                var a = document.createElement("a");
                a.href = url;
                a.target = "_blank";
                a.rel = "noopener";
                a.textContent = url.length > 72 ? url.slice(0, 72) + "…" : url;
                tdU.appendChild(a);
            } else {
                tdU.textContent = "—";
            }
            var tdB = document.createElement("td");
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn-refresh btn-refresh--small";
            btn.textContent = "Focus";
            btn.addEventListener(
                "click",
                function (s) {
                    return function () {
                        if (s) ctx.onFocusSession(s);
                    };
                }(sid)
            );
            tdB.appendChild(btn);
            tr.appendChild(tdT);
            tr.appendChild(tdK);
            tr.appendChild(tdU);
            tr.appendChild(tdB);
            wrap.appendChild(tr);
        });
    }

    function renderReviewQueue(items) {
        var tb = $("dash-review-queue-body");
        if (!tb) return;
        tb.innerHTML = "";
        if (!items || !items.length) {
            var tr = document.createElement("tr");
            var td = document.createElement("td");
            td.colSpan = 4;
            td.className = "dash-friction-table__empty";
            td.textContent = "No kinetic rows in scope, or nothing scored yet.";
            tr.appendChild(td);
            tb.appendChild(tr);
            return;
        }
        items.forEach(function (it) {
            var tr = document.createElement("tr");
            var tdS = document.createElement("td");
            tdS.className = "dash-friction-table__mono";
            tdS.textContent = "#" + String(it.sid);
            var tdSc = document.createElement("td");
            tdSc.textContent = String(it.score);
            var tdP = document.createElement("td");
            tdP.textContent = it.preview || "";
            var tdB = document.createElement("td");
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "btn-refresh btn-refresh--small";
            btn.textContent = "Focus session";
            btn.addEventListener(
                "click",
                function (sid) {
                    return function () {
                        ctx.onFocusSession(sid);
                    };
                }(it.sid)
            );
            tdB.appendChild(btn);
            tr.appendChild(tdS);
            tr.appendChild(tdSc);
            tr.appendChild(tdP);
            tr.appendChild(tdB);
            tb.appendChild(tr);
        });
    }

    function updateAnalystJson(payload) {
        var ta = $("dash-friction-analyst-json");
        if (ta) ta.value = JSON.stringify(payload, null, 2);
    }

    function updateContractBanner(schemaDrift) {
        var b = $("dash-contract-banner");
        if (!b) return;
        if (schemaDrift) {
            b.hidden = false;
            b.textContent =
                "Signal schema drift: some kinetic rows use signal_schema_version other than " +
                EXPECTED_SIGNAL_SCHEMA +
                ". Dashboard contract v" +
                DASH_CONTRACT_VERSION +
                " expects v" +
                EXPECTED_SIGNAL_SCHEMA +
                " for friction cards.";
        } else {
            b.hidden = true;
            b.textContent = "";
        }
    }

    async function pollHealthOnce() {
        var origin = ctx.getOrigin();
        if (!origin) return;
        var el = $("dash-friction-freshness");
        try {
            var res = await fetch(origin + "/health");
            var j = await res.json();
            var bits = [];
            bits.push(j.database === "connected" ? "DB OK" : "DB: " + (j.database || "?"));
            if (j.multi_tenant) bits.push("multi-tenant");
            if (j.warehouse != null) bits.push("file warehouse " + (j.warehouse ? "on" : "off"));
            if (el) el.textContent = "Collector " + (j.ok ? "healthy" : "degraded") + " · " + bits.join(" · ");
        } catch (e) {
            if (el) el.textContent = "Health check failed — " + (e && e.message ? e.message : e);
        }
    }

    async function fetchFrictionContextRows() {
        var tok = ctx.getToken();
        var slug = ctx.getOrgSlug();
        var origin = ctx.getOrigin();
        if (!tok || !slug || !origin) return [];
        var url = origin + "/internal/v1/orgs/" + encodeURIComponent(slug) + "/friction-context?limit=40";
        var res = await fetch(url, { headers: { Authorization: "Bearer " + tok } });
        if (!res.ok) throw new Error(await res.text());
        var j = await res.json();
        return j.rows || [];
    }

    async function fetchSnippetRuntimeConfigJson() {
        var tok = ctx.getToken();
        var slug = ctx.getOrgSlug();
        var origin = ctx.getOrigin();
        var pre = $("dash-snippet-runtime-preview");
        if (!tok || !slug || !origin || !pre) {
            if (pre) pre.textContent = "";
            return null;
        }
        try {
            var url = origin + "/internal/v1/orgs/" + encodeURIComponent(slug) + "/snippet-runtime-config";
            var res = await fetch(url, { headers: { Authorization: "Bearer " + tok } });
            if (!res.ok) throw new Error(await res.text());
            var j = await res.json();
            pre.textContent = JSON.stringify(j.snippet_runtime_config != null ? j.snippet_runtime_config : {}, null, 2);
            return j;
        } catch (e) {
            pre.textContent = "(unavailable) " + (e && e.message ? e.message : e);
            return null;
        }
    }

    g.NexusFrictionTriage = {
        DASH_CONTRACT_VERSION: DASH_CONTRACT_VERSION,
        EXPECTED_SIGNAL_SCHEMA: EXPECTED_SIGNAL_SCHEMA,
        init: function (c) {
            Object.assign(ctx, c);
            applyGuidedModeFromStorage();
            var cb = $("dash-friction-guided-toggle");
            if (cb) {
                cb.addEventListener("change", function () {
                    var guided = !!cb.checked;
                    try {
                        localStorage.setItem(LS_GUIDED, guided ? "1" : "0");
                    } catch (_e) {}
                    setGuidedVisible(guided);
                });
            }
            pollHealthOnce();
            setInterval(pollHealthOnce, 60000);
        },
        refreshAll: async function () {
            var rows = filterRows(ctx.getRows() || []);
            var agg = analyzeWarehouse(rows);
            var kpts = ctx.getKineticPoints() || [];
            var queue = buildReviewQueue(kpts, 15);

            renderSchemaCard(agg);
            renderFrictionKindsCard(agg);
            updateContractBanner(agg.schemaDrift);

            var rangeLabel = ctx.getDateRangeLabel ? ctx.getDateRangeLabel() : "";
            setText("dash-friction-range-label", rangeLabel ? "Date filter: " + rangeLabel : "");

            var frictionRows = [];
            try {
                frictionRows = await fetchFrictionContextRows();
            } catch (e) {
                frictionRows = [];
                var wrap = $("dash-friction-table-body");
                if (wrap) {
                    wrap.innerHTML =
                        "<tr><td colspan=\"4\" class=\"dash-friction-table__empty\">Friction API: " +
                        (e && e.message ? e.message : e) +
                        "</td></tr>";
                }
            }
            renderFrictionTable(frictionRows);
            renderReviewQueue(queue);

            updateAnalystJson({
                dash_contract_version: DASH_CONTRACT_VERSION,
                warehouse_row_count: rows.length,
                aggregates: agg,
                friction_context_sample: frictionRows.slice(0, 5),
                review_queue: queue,
            });

            await fetchSnippetRuntimeConfigJson();
        },
    };
})(typeof window !== "undefined" ? window : this);
