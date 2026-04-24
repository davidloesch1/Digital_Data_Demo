/**
 * Judgment & calibration v1: T/F on factual items + subjective P(correct); Brier-style rollup.
 */
const CalibrationChallenge = (function () {
    const ITEMS = [
        {
            id: 1,
            text: "The city of Washington, D.C. is a state of the United States.",
            answerIsTrue: false
        },
        {
            id: 2,
            text: "On average, Venus&rsquo;s distance from the Sun is smaller than Earth&rsquo;s.",
            answerIsTrue: true
        },
        {
            id: 3,
            text: "A standard acoustic piano is normally built with 88 keys.",
            answerIsTrue: true
        },
        {
            id: 4,
            text: "Penguins in the wild exist only in and around the Antarctic region.",
            answerIsTrue: false
        },
        {
            id: 5,
            text: "The &ldquo;Gambler&rsquo;s fallacy&rdquo; is the false belief that past random outcomes change the underlying odds of independent future events.",
            answerIsTrue: true
        }
    ];

    const state = {
        sessionId: "M-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        t0: 0,
        finished: false,
        usedSkip: false,
        phase: "brief",
        itemIndex: 0,
        sub: "tf",
        tQStart: 0,
        tTf: 0,
        trials: []
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
        state.phase = name;
        ["brief", "run", "done"].forEach(function (p) {
            const el = document.getElementById("phase-" + p);
            if (el) {
                el.hidden = p !== name;
            }
        });
    }

    function brierTerm(p, outcomeOne) {
        return (p - outcomeOne) * (p - outcomeOne);
    }

    function showItem() {
        if (state.itemIndex >= ITEMS.length) {
            goDone();
            return;
        }
        const item = ITEMS[state.itemIndex];
        setLabel("CALIB_Q" + item.id);
        state.sub = "tf";
        const lab = document.getElementById("jcal-question-label");
        if (lab) {
            lab.textContent = "Statement " + (state.itemIndex + 1) + " of " + ITEMS.length;
        }
        const s = document.getElementById("jcal-statement");
        if (s) {
            s.innerHTML = item.text;
        }
        const stf = document.getElementById("jcal-step-tf");
        const scf = document.getElementById("jcal-step-conf");
        if (stf) {
            stf.hidden = false;
        }
        if (scf) {
            scf.hidden = true;
        }
        const tTrue = document.getElementById("btn-true");
        const tFalse = document.getElementById("btn-false");
        if (tTrue) {
            tTrue.disabled = false;
        }
        if (tFalse) {
            tFalse.disabled = false;
        }
        state.tQStart = performance.now();
    }

    function onTf(saysTrue) {
        if (state.finished || state.phase !== "run" || state.sub !== "tf") {
            return;
        }
        const item = ITEMS[state.itemIndex];
        const t1 = performance.now();
        setLabel("CALIB_TF");
        const tTrue = document.getElementById("btn-true");
        const tFalse = document.getElementById("btn-false");
        if (tTrue) {
            tTrue.disabled = true;
        }
        if (tFalse) {
            tFalse.disabled = true;
        }
        const row = {
            itemId: item.id,
            statementTrue: item.answerIsTrue,
            responseTrue: saysTrue,
            correct: saysTrue === item.answerIsTrue,
            rtTfMs: Math.round(t1 - state.tQStart)
        };
        state.trials[state.itemIndex] = row;
        state.tTf = t1;
        state.sub = "conf";
        const stf = document.getElementById("jcal-step-tf");
        const scf = document.getElementById("jcal-step-conf");
        if (stf) {
            stf.hidden = true;
        }
        if (scf) {
            scf.hidden = false;
        }
        setLabel("CALIB_CONF");
    }

    function onConf(p) {
        if (state.finished || state.phase !== "run" || state.sub !== "conf") {
            return;
        }
        const t2 = performance.now();
        const cur = state.trials[state.itemIndex];
        if (!cur) {
            return;
        }
        const pNum = parseFloat(p, 10);
        if (pNum < 0 || pNum > 1 || pNum !== pNum) {
            return;
        }
        if (pNum === 0.5) {
            setLabel("CALIB_P50");
        } else if (pNum === 0.7) {
            setLabel("CALIB_P70");
        } else {
            setLabel("CALIB_P90");
        }
        cur.pCorrect = pNum;
        cur.rtConfMs = Math.round(t2 - state.tTf);
        cur.rtTotalMs = Math.round(t2 - state.tQStart);
        const o = cur.correct ? 1 : 0;
        cur.brier = Math.round(brierTerm(pNum, o) * 10000) / 10000;
        state.sub = "tf";
        state.itemIndex += 1;
        showItem();
    }

    function goDone() {
        if (state.finished) {
            return;
        }
        state.finished = true;
        setLabel("CALIB_DONE");
        goPhase("done");

        const list = state.trials.filter(function (r) {
            return r && r.pCorrect != null;
        });
        let meanBrier = null;
        if (list.length > 0) {
            const s = list.reduce(function (a, t) {
                return a + t.brier;
            }, 0);
            meanBrier = Math.round((s / list.length) * 10000) / 10000;
        }
        const correctN = list.filter(function (r) {
            return r.correct;
        }).length;
        const rate = list.length > 0 ? correctN / list.length : null;
        let meanPWhenCorrect = null;
        let meanPWhenWrong = null;
        const c = list.filter(function (r) {
            return r.correct;
        });
        const w = list.filter(function (r) {
            return !r.correct;
        });
        if (c.length > 0) {
            meanPWhenCorrect =
                Math.round(
                    (c.reduce(function (a, x) { return a + x.pCorrect; }, 0) / c.length) * 1000
                ) / 1000;
        }
        if (w.length > 0) {
            meanPWhenWrong =
                Math.round(
                    (w.reduce(function (a, x) { return a + x.pCorrect; }, 0) / w.length) * 1000
                ) / 1000;
        }
        let meanPAll = null;
        if (list.length > 0) {
            meanPAll =
                Math.round(
                    (list.reduce(function (a, x) { return a + x.pCorrect; }, 0) / list.length) * 1000
                ) / 1000;
        }
        const confidenceVsAccuracy =
            meanPAll != null && rate != null
                ? Math.round((meanPAll - rate) * 1000) / 1000
                : null;

        const pack = {
            module: "confidence-calibration",
            v: 1,
            sessionId: state.sessionId,
            usedSkip: state.usedSkip,
            itemCount: ITEMS.length,
            completedItems: list.length,
            correctCount: correctN,
            accuracy: rate == null ? null : Math.round(rate * 1000) / 1000,
            meanBrier: meanBrier,
            meanPAll: meanPAll,
            meanPWhenCorrect: meanPWhenCorrect,
            meanPWhenWrong: meanPWhenWrong,
            confidenceVsAccuracy: confidenceVsAccuracy,
            items: list,
            elapsedSec: Math.round((performance.now() - state.t0) / 100) / 10
        };

        const out = document.getElementById("jcal-diagnostics");
        if (out) {
            out.textContent = JSON.stringify(pack, null, 2);
        }
        /* eslint-disable no-console */
        console.log("calib-lab:result", pack);
    }

    function onStart() {
        state.t0 = performance.now();
        state.itemIndex = 0;
        state.sub = "tf";
        state.usedSkip = false;
        state.trials = [];
        setLabel("CALIB_RUN");
        goPhase("run");
        showItem();
    }

    function skipToResults() {
        if (state.finished) {
            return;
        }
        state.usedSkip = true;
        state.trials = [];
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
        document.getElementById("btn-true").addEventListener("click", function () {
            onTf(true);
        });
        document.getElementById("btn-false").addEventListener("click", function () {
            onTf(false);
        });
        document.querySelectorAll(".jcal-pbtn").forEach(function (b) {
            b.addEventListener("click", function () {
                const p = b.getAttribute("data-p");
                onConf(p);
            });
        });
        const sk = document.getElementById("skip-brief");
        if (sk) {
            sk.addEventListener("click", function () {
                if (!state.finished) {
                    skipToResults();
                }
            });
        }
        document.addEventListener(
            "keydown",
            function (e) {
                if (state.finished || state.phase !== "run" || state.sub !== "tf") {
                    return;
                }
                if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) {
                    return;
                }
                if (e.key === "t" || e.key === "T") {
                    e.preventDefault();
                    onTf(true);
                } else if (e.key === "f" || e.key === "F") {
                    e.preventDefault();
                    onTf(false);
                }
            },
            true
        );
    }

    return { init: init, _state: state };
})();

CalibrationChallenge.init();
