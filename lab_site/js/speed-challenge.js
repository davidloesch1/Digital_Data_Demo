/**
 * Speed and accuracy v1: odd / even on digits; RT + error rate, optional skip from brief.
 */
const SpeedChallenge = (function () {
    const TRIAL_COUNT = 12;
    const MIN_RTI_MS = 100;

    const state = {
        sessionId: "V-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        t0: 0,
        finished: false,
        usedSkip: false,
        currentDigit: null,
        phase: "brief",
        trialIndex: 0,
        tShow: 0,
        answered: false,
        isiTimer: 0,
        trials: []
    };

    function jitter(a, b) {
        return a + Math.random() * (b - a);
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
        });
    }

    function goPhase(name) {
        state.phase = name;
        ["brief", "run", "done"].forEach(function (p) {
            const el = document.getElementById("phase-" + p);
            if (el) {
                el.hidden = p !== name;
            }
        });
    }

    function setButtonsEnabled(on) {
        const a = document.getElementById("btn-odd");
        const b = document.getElementById("btn-even");
        if (a) {
            a.disabled = !on;
        }
        if (b) {
            b.disabled = !on;
        }
    }

    function randomDigit() {
        return 1 + Math.floor(Math.random() * 9);
    }

    function isOdd(n) {
        return n % 2 === 1;
    }

    function updateTrialLabel() {
        const el = document.getElementById("sa-trial-label");
        if (!el) {
            return;
        }
        if (state.trialIndex >= TRIAL_COUNT) {
            return;
        }
        el.textContent = "Trial " + (state.trialIndex + 1) + " of " + TRIAL_COUNT;
    }

    function showStimulus() {
        const d = state.currentDigit;
        const el = document.getElementById("sa-stimulus");
        if (el) {
            el.classList.remove("sa-stimulus--dim");
            el.textContent = d === null ? "—" : String(d);
        }
    }

    function runTrial() {
        clearTimeout(state.isiTimer);
        state.isiTimer = 0;
        if (state.finished || state.phase !== "run") {
            return;
        }
        if (state.trialIndex >= TRIAL_COUNT) {
            goDone();
            return;
        }
        state.answered = false;
        state.currentDigit = randomDigit();
        setLabel("SPEED_T" + (state.trialIndex + 1));
        updateTrialLabel();
        showStimulus();
        state.tShow = performance.now();
        setButtonsEnabled(true);
    }

    function isiAndNext() {
        setButtonsEnabled(false);
        const el = document.getElementById("sa-stimulus");
        if (el) {
            el.classList.add("sa-stimulus--dim");
            el.textContent = "· · ·";
        }
        const ms = Math.min(1000, Math.max(400, Math.floor(jitter(480, 920))));
        state.isiTimer = setTimeout(function () {
            state.isiTimer = 0;
            if (state.finished) {
                return;
            }
            runTrial();
        }, ms);
    }

    function onAnswer(wantsOdd) {
        if (state.finished || state.phase !== "run" || state.answered) {
            return;
        }
        const d = state.currentDigit;
        if (d == null) {
            return;
        }
        state.answered = true;
        const tEnd = performance.now();
        const rt = Math.round(tEnd - state.tShow);
        const targetOdd = isOdd(d);
        const correct = wantsOdd === targetOdd;
        const suspicious = rt < MIN_RTI_MS;
        state.trials.push({
            i: state.trialIndex,
            digit: d,
            targetIsOdd: targetOdd,
            responseIsOdd: wantsOdd,
            correct: correct,
            rtMs: rt,
            rtSuspicious: suspicious
        });
        setLabel("SPEED_ANS");
        state.trialIndex += 1;
        if (state.trialIndex >= TRIAL_COUNT) {
            goDone();
            return;
        }
        isiAndNext();
    }

    function onKey(e) {
        if (state.phase !== "run" || state.answered) {
            return;
        }
        if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
            return;
        }
        if (e.key === "1" || e.key === "a" || e.key === "A" || e.key === "o" || e.key === "O") {
            e.preventDefault();
            onAnswer(true);
        } else if (e.key === "2" || e.key === "l" || e.key === "L" || e.key === "e" || e.key === "E") {
            e.preventDefault();
            onAnswer(false);
        }
    }

    function goDone() {
        if (state.finished) {
            return;
        }
        state.finished = true;
        clearTimeout(state.isiTimer);
        state.isiTimer = 0;
        setLabel("SPEED_DONE");
        document.removeEventListener("keydown", onKey, true);
        goPhase("done");
        setButtonsEnabled(false);

        const rts = state.trials
            .filter(function (t) {
                return t.correct;
            })
            .map(function (t) {
                return t.rtMs;
            });
        const meanCorrect =
            rts.length > 0 ? rts.reduce(function (a, b) { return a + b; }, 0) / rts.length : null;
        const nErr = state.trials.filter(function (t) { return !t.correct; }).length;
        const nSusp = state.trials.filter(function (t) { return t.rtSuspicious; }).length;
        const allRt = state.trials.map(function (t) { return t.rtMs; });
        const meanAll =
            allRt.length > 0 ? allRt.reduce(function (a, b) { return a + b; }, 0) / allRt.length : null;

        const pack = {
            module: "speed-accuracy",
            v: 1,
            sessionId: state.sessionId,
            usedSkip: state.usedSkip,
            trialCount: TRIAL_COUNT,
            completedTrials: state.trials.length,
            errorCount: nErr,
            errorRate: state.trials.length ? Math.round((nErr / state.trials.length) * 1000) / 1000 : null,
            suspiciousRtCount: nSusp,
            meanRtCorrectMs: meanCorrect == null ? null : Math.round(meanCorrect),
            meanRtAllMs: meanAll == null ? null : Math.round(meanAll),
            stdevRtCorrectMs:
                rts.length < 2
                    ? null
                    : (function () {
                        const m = meanCorrect;
                        const s =
                            rts.reduce(function (acc, x) {
                                return acc + (x - m) * (x - m);
                            }, 0) / (rts.length - 1);
                        return Math.round(Math.sqrt(s));
                    })(),
            trials: state.trials,
            elapsedSec: Math.round((performance.now() - state.t0) / 100) / 10
        };
        const out = document.getElementById("sa-diagnostics");
        if (out) {
            out.textContent = JSON.stringify(pack, null, 2);
        }
        /* eslint-disable no-console */
        console.log("speed-lab:result", pack);
    }

    function skipToResults() {
        if (state.finished) {
            return;
        }
        state.usedSkip = true;
        state.trials = [];
        state.trialIndex = 0;
        goDone();
    }

    function onStart() {
        state.t0 = performance.now();
        state.trialIndex = 0;
        state.trials = [];
        state.usedSkip = false;
        setLabel("SPEED_LAB");
        goPhase("run");
        document.addEventListener("keydown", onKey, true);
        runTrial();
    }

    function init() {
        state.t0 = performance.now();
        const sid = document.getElementById("session-id");
        if (sid) {
            sid.textContent = "#" + state.sessionId;
        }
        bindStatus();

        document.getElementById("btn-brief").addEventListener("click", onStart);
        document.getElementById("btn-odd").addEventListener("click", function () {
            onAnswer(true);
        });
        document.getElementById("btn-even").addEventListener("click", function () {
            onAnswer(false);
        });
        const skip = document.getElementById("skip-brief");
        if (skip) {
            skip.addEventListener("click", function () {
                if (!state.finished) {
                    skipToResults();
                }
            });
        }
    }

    return { init: init, _state: state };
})();

SpeedChallenge.init();
