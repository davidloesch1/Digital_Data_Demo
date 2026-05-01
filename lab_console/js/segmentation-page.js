/**
 * UI for segmentation.html — binds form to NexusSegmentation.
 */
(function () {
    function $(id) {
        return document.getElementById(id);
    }

    function rowTemplate(key, val) {
        var wrap = document.createElement("div");
        wrap.className = "seg-var-row";
        wrap.innerHTML =
            '<input type="text" class="seg-var-key" placeholder="property_name" aria-label="FullStory property name" value="' +
            escapeAttr(key || "") +
            '" />' +
            '<input type="text" class="seg-var-val" placeholder="value" aria-label="Property value" value="' +
            escapeAttr(val || "") +
            '" />' +
            '<button type="button" class="seg-var-remove" aria-label="Remove row">Remove</button>';
        wrap.querySelector(".seg-var-remove").addEventListener("click", function () {
            wrap.remove();
        });
        return wrap;
    }

    function escapeAttr(s) {
        return String(s)
            .replace(/&/g, "&amp;")
            .replace(/"/g, "&quot;")
            .replace(/</g, "&lt;");
    }

    function collectFsVars() {
        var vars = {};
        var cohort = $("seg-cohort") && $("seg-cohort").value.trim();
        if (cohort) vars.nexus_cohort = cohort;

        var container = $("seg-custom-vars");
        if (!container) return vars;
        container.querySelectorAll(".seg-var-row").forEach(function (row) {
            var k = row.querySelector(".seg-var-key");
            var v = row.querySelector(".seg-var-val");
            if (!k || !v) return;
            var key = k.value.trim();
            if (!key) return;
            vars[key] = v.value.trim();
        });
        return vars;
    }

    function fillForm(state) {
        $("seg-user-key").value = (state && state.userKey) || "";
        $("seg-cohort").value = "";
        var fs = (state && state.fsVars) || {};
        if (fs.nexus_cohort) $("seg-cohort").value = fs.nexus_cohort;
        var container = $("seg-custom-vars");
        container.innerHTML = "";
        var hasCustom = false;
        Object.keys(fs).forEach(function (k) {
            if (k === "nexus_cohort") return;
            container.appendChild(rowTemplate(k, fs[k]));
            hasCustom = true;
        });
        if (!hasCustom) container.appendChild(rowTemplate("", ""));
    }

    function showStatus(ok, msg) {
        var el = $("seg-status");
        el.hidden = false;
        el.className = "seg-status " + (ok ? "seg-status--ok" : "seg-status--err");
        el.textContent = msg;
    }

    document.addEventListener("DOMContentLoaded", function () {
        if (typeof NexusSegmentation === "undefined") return;

        fillForm(NexusSegmentation.getState());

        $("seg-add-var").addEventListener("click", function () {
            $("seg-custom-vars").appendChild(rowTemplate("", ""));
        });

        $("seg-save").addEventListener("click", function () {
            var uid = $("seg-user-key").value.trim();
            if (!uid) {
                showStatus(false, "Enter a stable visitor ID (used as Nexus visitor key and FullStory UID).");
                return;
            }
            try {
                NexusSegmentation.save(uid, collectFsVars());
                showStatus(
                    true,
                    "Saved. New kinetic rows include this visitor key; FullStory sessions use FS.identify with your variables. Run challenges in this browser to capture data."
                );
            } catch (e) {
                showStatus(false, e.message || "Save failed");
            }
        });

        $("seg-clear").addEventListener("click", function () {
            if (!confirm("Clear segmentation for this browser? FullStory identity is not reset automatically.")) return;
            NexusSegmentation.clear();
            $("seg-user-key").value = "";
            $("seg-cohort").value = "";
            $("seg-custom-vars").innerHTML = "";
            $("seg-custom-vars").appendChild(rowTemplate("", ""));
            showStatus(true, "Cleared local segmentation. Reload challenges to stop attaching a visitor key.");
        });
    });
})();
