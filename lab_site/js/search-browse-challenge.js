/**
 * Search & browse (ultra-minimal): one lookup, co-equal search and browse, same target.
 */
const SearchBrowseChallenge = (function () {
    const state = {
        sessionId: "B-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        t0: 0,
        tRun: 0,
        finished: false,
        usedSkip: false,
        hasFound: false,
        firstModality: null,
        msToFirstAction: null,
        usedSearch: false,
        usedBrowse: false,
        events: [],
        lastQuery: ""
    };

    function setLabel(x) {
        if (typeof BehavioralService === "undefined") {
            return;
        }
        try {
            BehavioralService.setLabel(x);
        } catch (e) {
            /* */
        }
    }

    function bindStatus() {
        const el = document.getElementById("dev-status");
        if (typeof BehavioralService === "undefined" || !el) {
            return;
        }
        BehavioralService.onSignal(function (data) {
            if (data.type === "STATUS") {
                el.textContent = "AI: " + data.msg;
            }
        });
    }

    function goPhase(name) {
        ["brief", "run", "done"].forEach(function (p) {
            const el = document.getElementById("phase-" + p);
            if (el) {
                el.hidden = p !== name;
            }
        });
    }

    function tNow() {
        return Math.round(performance.now() - state.tRun);
    }

    function logEv(code, detail) {
        if (state.finished) {
            return;
        }
        const row = { code: code, ms: tNow() };
        if (detail != null) {
            row.detail = detail;
        }
        state.events.push(row);
    }

    function markFirst(smod) {
        if (state.hasFound || smod === "submit") {
            return;
        }
        if (state.firstModality != null) {
            return;
        }
        if (smod === "search") {
            state.firstModality = "search";
            setLabel("SB_FIRST_SEARCH");
        } else if (smod === "browse") {
            state.firstModality = "browse";
            setLabel("SB_FIRST_BROWSE");
        } else {
            return;
        }
        state.msToFirstAction = tNow();
    }

    function runSearch() {
        const el = document.getElementById("sb-q");
        const msg = document.getElementById("sb-search-msg");
        const res = document.getElementById("sb-search-results");
        const q = (el && el.value) || "";
        state.lastQuery = q;
        markFirst("search");
        state.usedSearch = true;
        setLabel("SB_GO_SEARCH");
        if (res) {
            res.hidden = true;
        }
        if (msg) {
            msg.hidden = true;
        }
        if (state.hasFound) {
            return;
        }
        if (searchMatches(q)) {
            if (res) {
                res.hidden = false;
            }
            logEv("search_match", (q || "").trim().toLowerCase().slice(0, 40));
        } else {
            if (msg) {
                const t = (q || "").trim();
                if (t.length === 0) {
                    msg.textContent = "Type a short query (e.g. aur, cable) or use Browse; both reach the same item.";
                    msg.hidden = false;
                } else {
                    msg.textContent = "No match for that—try letters from the name, or open Cables & power.";
                    msg.hidden = false;
                }
            }
        }
    }

    function searchMatches(s) {
        const t = (s || "")
            .trim()
            .toLowerCase();
        if (t.length < 2) {
            return false;
        }
        if (t.indexOf("aur") >= 0) {
            return true;
        }
        if (t.indexOf("cable") >= 0) {
            return true;
        }
        return t === "ac" && t.length >= 2;
    }

    function renderCables() {
        const b = document.getElementById("sb-browse-body");
        if (!b) {
            return;
        }
        b.innerHTML = "";
        b.appendChild(helpText("In this (fake) list, one item matches the task."));
        const b1 = document.createElement("button");
        b1.type = "button";
        b1.className = "sb-prod sb-prod--bad";
        b1.setAttribute("data-kind", "wrong");
        b1.textContent = "Spare USB kit";
        b1.addEventListener("click", onWrongProduct);
        const b2 = document.createElement("button");
        b2.type = "button";
        b2.className = "sb-prod sb-prod--good";
        b2.setAttribute("data-kind", "ok");
        b2.textContent = "Aurora cable";
        b2.addEventListener("click", onAuroraFoundFromBrowse);
        b.appendChild(b1);
        b.appendChild(b2);
        b.hidden = false;
    }

    function renderNoItemCat() {
        const b = document.getElementById("sb-browse-body");
        if (!b) {
            return;
        }
        b.textContent = "The lab item is not in this group. Open Cables & power or use Search.";
        b.hidden = false;
    }

    function helpText(t) {
        const s = document.createElement("p");
        s.className = "sb-label";
        s.style.fontSize = "0.72rem";
        s.style.color = "#64748b";
        s.style.marginBottom = "0.35rem";
        s.textContent = t;
        return s;
    }

    function onCat(cat) {
        if (state.hasFound) {
            return;
        }
        markFirst("browse");
        state.usedBrowse = true;
        const catL = (cat || "").toLowerCase();
        if (catL === "cables") {
            setLabel("SB_CAT_CABLES");
        } else if (catL === "lighting") {
            setLabel("SB_CAT_LIGHT");
        } else {
            setLabel("SB_CAT_DESK");
        }
        logEv("category", cat);
        const out = document.getElementById("sb-browse-out");
        const b = document.getElementById("sb-browse-body");
        if (out) {
            out.hidden = false;
        }
        if (!b) {
            return;
        }
        b.innerHTML = "";
        if (cat === "cables") {
            renderCables();
        } else {
            renderNoItemCat();
        }
        document.querySelectorAll("#sb-chips .sb-chip").forEach(function (c) {
            c.classList.toggle("is-active", c.getAttribute("data-cat") === cat);
        });
    }

    function onWrongProduct() {
        if (state.hasFound) {
            return;
        }
        markFirst("browse");
        state.usedBrowse = true;
        setLabel("SB_PICK_WR");
        logEv("browse_wrong_product", "spare-usb");
        const b = document.getElementById("sb-browse-body");
        if (b) {
            const s = b.querySelector(".sb-err");
            if (s) {
                s.remove();
            }
            const err = document.createElement("p");
            err.className = "sb-err";
            err.style.cssText = "color:#9a3412;font-size:0.78rem;margin:0.25rem 0 0;";
            err.textContent = "Not the lab item. Try the other list row or use Search (Aurora, cable, …).";
            b.appendChild(err);
        }
    }

    function onAuroraFromSearchPath() {
        onAuroraFound("search");
    }
    function onAuroraFoundFromBrowse() {
        onAuroraFound("browse");
    }
    function onAuroraFound(how) {
        if (state.hasFound) {
            return;
        }
        if (how === "search") {
            state.usedSearch = true;
        } else {
            markFirst("browse");
            state.usedBrowse = true;
        }
        state.hasFound = true;
        setLabel("SB_OK");
        logEv("find_ok", how);
        const task = document.getElementById("sb-task");
        const won = document.getElementById("sb-won");
        if (task) {
            task.hidden = true;
        }
        if (won) {
            won.hidden = false;
        }
    }

    function goDone() {
        if (state.finished) {
            return;
        }
        state.finished = true;
        setLabel("SB_DONE");
        goPhase("done");
        const pack = {
            module: "search-browse",
            v: 1,
            sessionId: state.sessionId,
            usedSkip: state.usedSkip,
            firstModality: state.firstModality,
            msToFirstAction: state.msToFirstAction,
            usedSearch: state.usedSearch,
            usedBrowse: state.usedBrowse,
            switchedModality: state.usedSearch && state.usedBrowse,
            found: state.hasFound,
            lastSearchQuery: state.hasFound || state.usedSearch ? (state.lastQuery || "").trim().toLowerCase().slice(0, 80) : null,
            events: state.events,
            elapsedSec: Math.round((performance.now() - state.t0) * 10) / 10
        };
        const out = document.getElementById("sb-diagnostics");
        if (out) {
            out.textContent = JSON.stringify(pack, null, 2);
        }
        /* eslint-disable no-console */
        console.log("search-browse:result", pack);
    }

    function onStart() {
        state.t0 = performance.now();
        state.tRun = performance.now();
        state.finished = false;
        state.hasFound = false;
        state.firstModality = null;
        state.msToFirstAction = null;
        state.usedSearch = false;
        state.usedBrowse = false;
        state.events = [];
        state.lastQuery = "";
        state.usedSkip = false;
        const q = document.getElementById("sb-q");
        if (q) {
            q.value = "";
        }
        const msg = document.getElementById("sb-search-msg");
        if (msg) {
            msg.textContent = "";
            msg.hidden = true;
        }
        const res = document.getElementById("sb-search-results");
        if (res) {
            res.hidden = true;
        }
        const b = document.getElementById("sb-browse-body");
        if (b) {
            b.textContent = "";
            b.hidden = true;
        }
        const o = document.getElementById("sb-browse-out");
        if (o) {
            o.hidden = true;
        }
        const task = document.getElementById("sb-task");
        const won = document.getElementById("sb-won");
        if (task) {
            task.hidden = false;
        }
        if (won) {
            won.hidden = true;
        }
        document.querySelectorAll("#sb-chips .sb-chip").forEach(function (c) {
            c.classList.remove("is-active");
        });
        setLabel("SB_RUN");
        goPhase("run");
    }

    function skipToResults() {
        if (state.finished) {
            return;
        }
        state.usedSkip = true;
        setLabel("SB_SKIP");
        goDone();
    }

    function init() {
        state.t0 = performance.now();
        const sid = document.getElementById("session-id");
        if (sid) {
            sid.textContent = "#" + state.sessionId;
        }
        bindStatus();
        document.getElementById("btn-brief").addEventListener("click", onStart);
        const sk = document.getElementById("skip-brief");
        if (sk) {
            sk.addEventListener("click", function () {
                if (!state.finished) {
                    skipToResults();
                }
            });
        }
        const inp = document.getElementById("sb-q");
        if (inp) {
            inp.addEventListener("keydown", function (e) {
                if (state.finished) {
                    return;
                }
                if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) {
                    markFirst("search");
                }
            });
        }
        document.getElementById("btn-search").addEventListener("click", function () {
            if (!state.finished) {
                runSearch();
            }
        });
        if (inp) {
            inp.addEventListener("keydown", function (e) {
                if (e.key === "Enter") {
                    e.preventDefault();
                    if (!state.finished) {
                        runSearch();
                    }
                }
            });
        }
        document.getElementById("sb-chips").addEventListener("click", function (e) {
            const t = e.target;
            if (!t || t.getAttribute("data-cat") == null) {
                return;
            }
            if (state.finished) {
                return;
            }
            e.preventDefault();
            onCat(t.getAttribute("data-cat"));
        });
        const hit = document.getElementById("sb-hit");
        if (hit) {
            hit.addEventListener("click", function () {
                if (state.finished) {
                    return;
                }
                onAuroraFromSearchPath();
            });
        }
        document.getElementById("btn-finish").addEventListener("click", function () {
            if (state.finished) {
                return;
            }
            if (!state.hasFound) {
                return;
            }
            setLabel("SB_SUBMIT");
            goDone();
        });
    }

    return { init: init, _state: state };
})();

SearchBrowseChallenge.init();
