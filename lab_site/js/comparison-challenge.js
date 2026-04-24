/**
 * Comparison & choice: per-option dwell, hovers, switches, time-to-decision, pointer energy.
 */
const ComparisonChallenge = (function () {
    const OPTIMAL_ID = "kite";
    const OPTION_KEYS = ["helio", "kite", "vanta"];

    const state = {
        sessionId: "C-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        phaseStart: 0,
        compareActive: false,
        selected: null,
        switchCount: 0,
        firstSelectAt: 0,
        pointerEnergy: 0,
        lastX: null,
        lastY: null,
        perCard: {
            helio: { visibleMs: 0, hoverStints: 0, hoverInSince: 0, visibleSince: 0, hoverTotalMs: 0 },
            kite: { visibleMs: 0, hoverStints: 0, hoverInSince: 0, visibleSince: 0, hoverTotalMs: 0 },
            vanta: { visibleMs: 0, hoverStints: 0, hoverInSince: 0, visibleSince: 0, hoverTotalMs: 0 }
        }
    };

    let sectionIo = null;

    function setLabel(lab) {
        if (typeof BehavioralService === "undefined") {
            return;
        }
        try {
            BehavioralService.setLabel(lab);
        } catch (e) {
            /* no-op */
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
            if (data.type === "SIGNAL_MATCH") {
                /* eslint-disable no-console */
                console.log("DNA MATCH:", data.signalName);
            }
        });
    }

    function onPointer(e) {
        if (!state.compareActive) {
            return;
        }
        if (state.lastX == null) {
            state.lastX = e.clientX;
            state.lastY = e.clientY;
            return;
        }
        const dx = e.clientX - state.lastX;
        const dy = e.clientY - state.lastY;
        state.pointerEnergy += Math.sqrt(dx * dx + dy * dy);
        state.lastX = e.clientX;
        state.lastY = e.clientY;
    }

    function goPhase(id) {
        ["brief", "compare", "results"].forEach(function (p) {
            const el = document.getElementById("phase-" + p);
            if (el) {
                el.hidden = p !== id;
            }
        });
    }

    function startCompare() {
        goPhase("compare");
        setLabel("COMPARISON");
        state.compareActive = true;
        state.phaseStart = performance.now();
        state.lastX = null;
        state.lastY = null;
        document.addEventListener("mousemove", onPointer, { passive: true });
        startVisibilityTracking();
    }

    function endCompare() {
        state.compareActive = false;
        document.removeEventListener("mousemove", onPointer);
        if (sectionIo) {
            sectionIo.disconnect();
            sectionIo = null;
        }
    }

    function flushAllVisible() {
        const now = performance.now();
        OPTION_KEYS.forEach(function (k) {
            const pc = state.perCard[k];
            if (pc.visibleSince) {
                pc.visibleMs += now - pc.visibleSince;
                pc.visibleSince = 0;
            }
            if (pc.hoverInSince) {
                pc.hoverTotalMs += now - pc.hoverInSince;
                pc.hoverInSince = 0;
            }
        });
    }

    function startVisibilityTracking() {
        if (sectionIo) {
            sectionIo.disconnect();
            sectionIo = null;
        }
        const opts = { threshold: [0, 0.12, 0.25, 0.4, 0.6, 0.8] };
        sectionIo = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                const id = entry.target.getAttribute("data-option");
                if (!id || !state.perCard[id]) {
                    return;
                }
                const pc = state.perCard[id];
                if (entry.isIntersecting && entry.intersectionRatio > 0.12) {
                    if (!pc.visibleSince) {
                        pc.visibleSince = performance.now();
                    }
                } else if (pc.visibleSince) {
                    pc.visibleMs += performance.now() - pc.visibleSince;
                    pc.visibleSince = 0;
                }
            });
        }, opts);
        OPTION_KEYS.forEach(function (k) {
            const el = document.getElementById("card-" + k);
            if (el) {
                sectionIo.observe(el);
            }
        });
    }

    function onCardClick(id) {
        if (!state.compareActive) {
            return;
        }
        if (state.selected && state.selected !== id) {
            state.switchCount += 1;
        }
        if (!state.selected) {
            state.firstSelectAt = performance.now() - state.phaseStart;
        }
        state.selected = id;
        document.querySelectorAll(".cc-card").forEach(function (c) {
            const match = c.getAttribute("data-option") === id;
            c.classList.toggle("cc-card--selected", match);
            c.setAttribute("aria-pressed", match ? "true" : "false");
        });
        const sub = document.getElementById("btn-submit-compare");
        if (sub) {
            sub.disabled = false;
        }
    }

    function onCardHover(k, inOut) {
        if (!state.compareActive || !state.perCard[k]) {
            return;
        }
        const pc = state.perCard[k];
        const t = performance.now();
        if (inOut) {
            if (!pc.hoverInSince) {
                pc.hoverInSince = t;
                pc.hoverStints += 1;
            }
        } else if (pc.hoverInSince) {
            pc.hoverTotalMs += t - pc.hoverInSince;
            pc.hoverInSince = 0;
        }
    }

    function showResults() {
        flushAllVisible();
        const form = document.getElementById("compare-form");
        const fd = new FormData(form);
        const conf = (fd.get("confident") || "3").toString();
        const hard = (fd.get("difficulty") || "3").toString();

        endCompare();
        setLabel("COMPARISON_COMPLETE");
        goPhase("results");
        const matches = state.selected === OPTIMAL_ID;
        const tTotal = performance.now() - state.phaseStart;
        const pack = {
            sessionId: state.sessionId,
            selectedId: state.selected,
            optimalId: OPTIMAL_ID,
            matchesStatedConstraintProfile: matches,
            timeToSubmitMs: Math.round(tTotal),
            timeToFirstSelectMs: state.firstSelectAt ? Math.round(state.firstSelectAt) : null,
            switchCount: state.switchCount,
            pointerPathPx: Math.round(state.pointerEnergy),
            perOption: {
                helio: {
                    visibleSec: sec(state.perCard.helio.visibleMs),
                    hoverStints: state.perCard.helio.hoverStints,
                    hoverTotalSec: sec(state.perCard.helio.hoverTotalMs)
                },
                kite: {
                    visibleSec: sec(state.perCard.kite.visibleMs),
                    hoverStints: state.perCard.kite.hoverStints,
                    hoverTotalSec: sec(state.perCard.kite.hoverTotalMs)
                },
                vanta: {
                    visibleSec: sec(state.perCard.vanta.visibleMs),
                    hoverStints: state.perCard.vanta.hoverStints,
                    hoverTotalSec: sec(state.perCard.vanta.hoverTotalMs)
                }
            },
            selfReport: { confident: conf, choiceDifficulty: hard }
        };
        const title = document.getElementById("result-line");
        if (title) {
            title.textContent = matches
                ? "Your shortlist lines up with the stated constraints in this scenario."
                : "Your shortlist does not line up with the best-fit option for the stated constraints — all outcomes are valid for research.";
        }
        const diag = document.getElementById("compare-diagnostics");
        if (diag) {
            diag.textContent = JSON.stringify(pack, null, 2);
        }
        /* eslint-disable no-console */
        console.log("comparison-lab:result", pack);
    }

    function sec(ms) {
        return Math.round(ms) / 1000;
    }

    function onSubmit(e) {
        e.preventDefault();
        if (!state.selected) {
            return;
        }
        showResults();
    }

    function init() {
        const sid = document.getElementById("session-id");
        if (sid) {
            sid.textContent = "#" + state.sessionId;
        }
        bindStatus();
        document.getElementById("btn-brief-go").addEventListener("click", function () {
            setLabel("BRIEF");
            startCompare();
        });
        document.getElementById("btn-submit-compare").disabled = true;
        document.getElementById("compare-form").addEventListener("submit", onSubmit);

        OPTION_KEYS.forEach(function (k) {
            const el = document.getElementById("card-" + k);
            if (!el) {
                return;
            }
            if (!el.hasAttribute("aria-pressed")) {
                el.setAttribute("aria-pressed", "false");
            }
            el.addEventListener("click", function () {
                onCardClick(k);
            });
            el.addEventListener("mouseenter", function () {
                onCardHover(k, true);
            });
            el.addEventListener("mouseleave", function () {
                onCardHover(k, false);
            });
        });
    }

    return { init: init, _state: state };
})();

ComparisonChallenge.init();
