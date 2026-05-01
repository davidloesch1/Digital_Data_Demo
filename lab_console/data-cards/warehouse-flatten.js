/**
 * Flatten grouped sessions to tabular rows for Vega / Parquet / exports.
 */
(function (g) {
    const M = g.NexusDataModel;

    g.NexusVizData = {
        /**
         * @param {Record<string, object[]>} sessions
         * @returns {Array<object>} one row per event
         */
        flatRows: function (sessions) {
            const Lf = g.NexusLabelFamily;
            const s = sessions && typeof sessions === "object" ? sessions : {};
            const out = [];
            Object.keys(s).forEach((sessionKey) => {
                s[sessionKey].forEach((row) => {
                    const fp = row.fingerprint;
                    out.push({
                        session_key: sessionKey,
                        session_url: row.session_url != null ? String(row.session_url) : "",
                        label: row.label != null ? String(row.label) : "",
                        family: Lf && Lf.fromLabel ? Lf.fromLabel(row.label) : "Other / unlabeled",
                        type: row.type != null ? String(row.type) : "",
                        is_kinetic: M.isKineticEvent(row),
                        is_nexus_label: M.isNexusLabelEvent(row),
                        ts: typeof row.timestamp === "number" ? row.timestamp : null,
                        server_ts: row.server_timestamp != null ? String(row.server_timestamp) : "",
                        fp0: fp && fp.length > 0 ? Number(fp[0]) : null,
                        fp1: fp && fp.length > 1 ? Number(fp[1]) : null,
                        fp2: fp && fp.length > 2 ? Number(fp[2]) : null,
                    });
                });
            });
            return out;
        },
    };
})(typeof window !== "undefined" ? window : this);
