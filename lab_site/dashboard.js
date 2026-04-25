/**
 * Shell: fetches /summary, fills the session list, drives data-card updates.
 * Card markup and chart logic: lab_site/data-cards/*
 */
const DASH_API = (typeof window !== "undefined" && window.NEXUS_DASH_API) || "http://localhost:3000";

window.NexusDashboardState = window.NexusDashboardState || { sessions: {} };

const DM = window.NexusDataModel;
const dataCards = window.NexusDataCards.mount(document.getElementById("data-cards-root"));

function nexusDataUpdated() {
    window.dispatchEvent(
        new CustomEvent("nexus-sessions-updated", {
            detail: { sessionKeys: Object.keys(window.NexusDashboardState.sessions || {}) },
        })
    );
}

async function fetchData() {
    const list = document.getElementById("session-list");
    try {
        const response = await fetch(DASH_API + "/summary");
        if (!response.ok) throw new Error("HTTP " + response.status);
        const data = await response.json();
        if (!Array.isArray(data) || data.length === 0) {
            list.innerHTML =
                '<p class="dash-hint">No events yet. Copy <code>warehouse.example.jsonl</code> to <code>warehouse.jsonl</code> in the collector folder, or run a challenge with the collector on.</p>';
            dataCards.setSessions({});
            window.NexusDashboardState.sessions = {};
            nexusDataUpdated();
            return;
        }
        const sessions = {};
        data.forEach((d) => {
            const sid = DM.getSessionKey(d);
            if (!sessions[sid]) sessions[sid] = [];
            sessions[sid].push(d);
        });
        list.innerHTML = "";
        Object.keys(sessions).forEach((sid) => {
            const n = sessions[sid].length;
            const nKin = sessions[sid].filter(DM.isKineticEvent).length;
            const nLab = sessions[sid].filter(DM.isNexusLabelEvent).length;
            const div = document.createElement("div");
            div.className = "session-item";
            div.innerText = `> ${sid} (${n} evts · ${nKin} kin · ${nLab} labels)`;
            div.onclick = function () {
                dataCards.setSelectedRadarEvents(sessions[sid]);
            };
            list.appendChild(div);
        });
        dataCards.setSessions(sessions);
        window.NexusDashboardState.sessions = sessions;
        nexusDataUpdated();
    } catch (e) {
        list.innerHTML =
            '<p class="dash-hint">Cannot reach the collector at <code>' +
            DASH_API +
            '</code>. From the repo, run: <code>cd collector &amp;&amp; node collector.js</code> then refresh.</p>';
        dataCards.setSessions({});
        window.NexusDashboardState.sessions = {};
        nexusDataUpdated();
    }
}

fetchData();
