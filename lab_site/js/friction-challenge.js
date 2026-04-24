/**
 * Friction and persistence v1: bounded delays, one auto-retry, verify step, one-time button nudge.
 * Skip-to-results is always available (guardrail), logged in payload.
 */
const FrictionChallenge = (function () {
    const VERIFY = "VERIFY";
    const state = {
        sessionId: "F-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        t0: 0,
        finished: false,
        timerS1a: 0,
        timerS1b: 0,
        timerS4: 0,
        phase: "brief",
        pointerEnergy: 0,
        lastX: null,
        lastY: null,
        usedSkip: false,
        events: {
            s1Clicks: 0,
            s1WorkingMs: 0,
            s2HiccupMs: 0,
            verifyAttempts: 0,
            nudgeApplied: false,
            finalizeClicks: 0
        }
    };
    const phaseBounds = { s1MaxMs: 1600, s2MaxMs: 2000, finalizeMaxMs: 2200 };

    function jitter(min, max) {
        return min + Math.random() * (max - min);
    }

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
            if (data.type === "SIGNAL_MATCH") {
                /* eslint-disable no-console */
                console.log("DNA MATCH:", data.signalName);
            }
        });
    }

    function onPtr(e) {
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

    function goPhase(name) {
        state.phase = name;
        ["brief", "s1", "s2", "s3", "s4", "done"].forEach(function (p) {
            const el = document.getElementById("phase-" + p);
            if (el) {
                el.hidden = p !== name;
            }
        });
    }

    function setWorking(el, on) {
        if (el) {
            el.hidden = !on;
        }
    }

    function clearAllTimers() {
        clearTimeout(state.timerS1a);
        clearTimeout(state.timerS1b);
        clearTimeout(state.timerS4);
        state.timerS1a = 0;
        state.timerS1b = 0;
        state.timerS4 = 0;
    }

    function skipToResults() {
        state.usedSkip = true;
        goDone();
    }

    function goDone() {
        if (state.finished) {
            return;
        }
        state.finished = true;
        clearAllTimers();
        setLabel("FRICTION_DONE");
        document.removeEventListener("mousemove", onPtr);
        goPhase("done");
        /* Re-lock in case a timeout fired after finish */
        const b = document.getElementById("btn-s1");
        if (b) {
            b.disabled = true;
        }
        const elapsed = (performance.now() - state.t0) / 1000;
        const pack = {
            module: "friction-persistence",
            v: 1,
            sessionId: state.sessionId,
            usedSkip: state.usedSkip,
            elapsedSec: Math.round(elapsed * 10) / 10,
            pointerPathPx: Math.round(state.pointerEnergy),
            events: state.events,
            capMs: phaseBounds
        };
        const out = document.getElementById("friction-diagnostics");
        if (out) {
            out.textContent = JSON.stringify(pack, null, 2);
        }
        /* eslint-disable no-console */
        console.log("friction-lab:result", pack);
    }

    function onBriefContinue() {
        setLabel("FRICTION");
        setLabel("FRICTION_S1");
        goPhase("s1");
    }

    function onS1Continue() {
        if (state.finished) {
            return;
        }
        const btn = document.getElementById("btn-s1");
        if (btn && btn.disabled) {
            return;
        }
        state.events.s1Clicks += 1;
        const work = document.getElementById("s1-working");
        if (btn) {
            btn.disabled = true;
        }
        setWorking(work, true);
        const t0 = performance.now();
        const d1 = Math.min(phaseBounds.s1MaxMs, Math.floor(jitter(400, 1400)));
        state.timerS1a = setTimeout(function () {
            if (state.finished) {
                return;
            }
            state.events.s1WorkingMs = Math.round(performance.now() - t0);
            setWorking(work, false);
            goPhase("s2");
            setLabel("FRICTION_S2");
            const d2 = Math.min(phaseBounds.s2MaxMs, Math.floor(jitter(1000, 2000)));
            state.events.s2HiccupMs = d2;
            state.timerS1b = setTimeout(function () {
                if (state.finished) {
                    return;
                }
                goPhase("s3");
                setLabel("FRICTION_S3");
            }, d2);
        }, d1);
    }

    function onVerifySubmit() {
        if (state.finished) {
            return;
        }
        const ins = document.getElementById("input-verify");
        const err = document.getElementById("verify-err");
        if (!ins) {
            return;
        }
        const v = (ins.value || "").trim();
        if (v.toUpperCase() !== VERIFY) {
            state.events.verifyAttempts += 1;
            if (err) {
                err.textContent = "That does not match. Type VERIFY in all capitals, as shown above.";
            }
            return;
        }
        if (err) {
            err.textContent = "";
        }
        goPhase("s4");
        setLabel("FRICTION_S4");
    }

    function onFinalize() {
        if (state.finished) {
            return;
        }
        state.events.finalizeClicks += 1;
        const btn = document.getElementById("btn-finish");
        const wait = document.getElementById("s4-working");
        if (btn) {
            btn.disabled = true;
        }
        if (wait) {
            wait.hidden = false;
        }
        const d = Math.min(phaseBounds.finalizeMaxMs, Math.floor(jitter(600, 2000)));
        state.timerS4 = setTimeout(function () {
            if (state.finished) {
                return;
            }
            if (wait) {
                wait.hidden = true;
            }
            goDone();
        }, d);
    }

    function onFinishNudge() {
        const btn = document.getElementById("btn-finish");
        if (btn && !state.events.nudgeApplied) {
            state.events.nudgeApplied = true;
            btn.classList.add("fp-btn--nudged");
        }
    }

    function init() {
        const sid = document.getElementById("session-id");
        if (sid) {
            sid.textContent = "#" + state.sessionId;
        }
        state.t0 = performance.now();
        bindStatus();
        document.addEventListener("mousemove", onPtr, { passive: true });

        document.getElementById("btn-brief").addEventListener("click", onBriefContinue);
        document.getElementById("btn-s1").addEventListener("click", onS1Continue);
        document.getElementById("form-verify").addEventListener("submit", function (e) {
            e.preventDefault();
            onVerifySubmit();
        });
        document.getElementById("btn-finish").addEventListener("click", onFinalize);
        document.getElementById("btn-finish").addEventListener("mouseenter", onFinishNudge, { once: true });

        ["brief", "s1", "s2", "s3", "s4"].forEach(function (pid) {
            const el = document.getElementById("skip-" + pid);
            if (el) {
                el.addEventListener("click", function () {
                    if (!state.finished) {
                        clearAllTimers();
                        skipToResults();
                    }
                });
            }
        });
    }

    return { init: init, _state: state };
})();

FrictionChallenge.init();
