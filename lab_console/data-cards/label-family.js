/**
 * Coarse "lab family" for any raw label string. Shared by Chart.js cards and the chart builder.
 */
(function (g) {
    g.NexusLabelFamily = {
        ORDER: [
            "Reading & retention",
            "Session friction",
            "Search & browse",
            "Social & PDP",
            "Judgment & calibration",
            "Speed & accuracy",
            "Comparison & choice",
            "Other / unlabeled",
        ],
        palette: [
            "#6366f1",
            "#f59e0b",
            "#22c55e",
            "#e879f9",
            "#38bdf8",
            "#f43f5e",
            "#a78bfa",
            "#64748b",
        ],
        fromLabel: function (raw) {
            const label = (raw == null ? "" : String(raw)).toUpperCase();
            if (!label || label === "NONE") return "Other / unlabeled";
            if (label.startsWith("READ") || label.indexOf("RETENTION") >= 0 || label.startsWith("RC_")) {
                return "Reading & retention";
            }
            if (label.startsWith("FRICTION")) return "Session friction";
            if (label.startsWith("SB_")) return "Search & browse";
            if (label.startsWith("SR_")) return "Social & PDP";
            if (label.startsWith("CALIB") || label.startsWith("JCAL") || label.startsWith("JCAL_")) {
                return "Judgment & calibration";
            }
            if (label.startsWith("SPEED") || label.startsWith("SA_")) return "Speed & accuracy";
            if (label.startsWith("COMPARISON") || label.startsWith("CC_")) return "Comparison & choice";
            return "Other / unlabeled";
        },
    };
})(typeof window !== "undefined" ? window : this);
