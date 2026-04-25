/**
 * Data connector: filter flat warehouse rows (slice 1 — "connector + preview").
 * Preset specs in chart-builder-presets should consume rows *after* filter().
 *
 * @typedef {Object} ConnectorStateV1
 * @property {1} schemaVersion
 * @property {"all"|"kinetic"|"nexus_label"} rowMode
 * @property {"all"|"include"} sessionMode
 * @property {string[]} sessionKeys — when sessionMode is "include"
 * @property {number|null} tMin — ms, inclusive, optional
 * @property {number|null} tMax — ms, inclusive, optional
 */
(function (g) {
    const DEFAULT = {
        schemaVersion: 1,
        rowMode: "all",
        sessionMode: "all",
        sessionKeys: [],
        tMin: null,
        tMax: null,
    };

    function cloneState() {
        return {
            schemaVersion: DEFAULT.schemaVersion,
            rowMode: DEFAULT.rowMode,
            sessionMode: DEFAULT.sessionMode,
            sessionKeys: DEFAULT.sessionKeys.slice(),
            tMin: DEFAULT.tMin,
            tMax: DEFAULT.tMax,
        };
    }

    g.NexusDataConnector = {
        SCHEMA_V1: 1,
        /** Default for new sessions / "reset". */
        defaultState: function () {
            return JSON.parse(JSON.stringify(cloneState()));
        },

        /**
         * @param {Array<object>} flatRows
         * @param {Partial<ConnectorStateV1>|null|undefined} state
         * @returns {Array<object>} filtered (new array, rows not cloned)
         */
        filter: function (flatRows, state) {
            if (!Array.isArray(flatRows) || !flatRows.length) return [];
            const s = Object.assign(cloneState(), state || {});

            let out = flatRows;
            if (s.rowMode === "kinetic") {
                out = out.filter((r) => r.is_kinetic);
            } else if (s.rowMode === "nexus_label") {
                out = out.filter((r) => r.is_nexus_label);
            }

            if (s.sessionMode === "include") {
                if (!s.sessionKeys || !s.sessionKeys.length) {
                    return [];
                }
                const set = s.sessionKeys.reduce((acc, k) => {
                    acc[k] = 1;
                    return acc;
                }, {});
                out = out.filter((r) => set[r.session_key]);
            }

            const tMin = s.tMin;
            const tMax = s.tMax;
            if (tMin != null && tMin !== "" && !isNaN(Number(tMin))) {
                const lo = Number(tMin);
                out = out.filter((r) => r.ts == null || r.ts >= lo);
            }
            if (tMax != null && tMax !== "" && !isNaN(Number(tMax))) {
                const hi = Number(tMax);
                out = out.filter((r) => r.ts == null || r.ts <= hi);
            }

            return out;
        },

        /**
         * Unique session_key values, stable sort.
         * @param {Array<object>} flatRows
         * @returns {string[]}
         */
        uniqueSessionKeys: function (flatRows) {
            const u = {};
            (flatRows || []).forEach((r) => {
                if (r.session_key) u[r.session_key] = 1;
            });
            return Object.keys(u).sort();
        },
    };

    /** Single mutable object; chart-connector UI and chart-builder read from it. */
    g.NexusChartLab = g.NexusChartLab || { state: g.NexusDataConnector.defaultState() };
    if (!g.NexusChartLab.state || g.NexusChartLab.state.schemaVersion == null) {
        g.NexusChartLab.state = g.NexusDataConnector.defaultState();
    }
})(typeof window !== "undefined" ? window : this);
