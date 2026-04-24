/**
 * Reading & retention: section dwell, pointer path length, back-scroll, quiz.
 */
const ReadingChallenge = (function () {
    const state = {
        sessionId: "R-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        sectionDwell: { s1: 0, s2: 0, s3: 0, s4: 0 },
        tVisible: { s1: 0, s2: 0, s3: 0, s4: 0 },
        pointerEnergy: 0,
        lastX: null,
        lastY: null,
        lastScrollY: 0,
        backScrollNudges: 0,
        readStartAt: 0,
        readWallMs: 0,
        readActive: false
    };

    const CORRECT = { q1: "64", q2: "20", q3: "split", q4: "200" };

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
        if (typeof BehavioralService === "undefined" || !document.getElementById("dev-status")) {
            return;
        }
        BehavioralService.onSignal(function (data) {
            if (data.type === "STATUS") {
                document.getElementById("dev-status").textContent = "AI: " + data.msg;
            }
            if (data.type === "SIGNAL_MATCH") {
                /* eslint-disable no-console */
                console.log("DNA MATCH:", data.signalName);
            }
        });
    }

    function onPointer(e) {
        if (!state.readActive) {
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

    let articleScrollEl = null;

    function onArticleScroll() {
        if (!state.readActive || !articleScrollEl) {
            return;
        }
        const y = articleScrollEl.scrollTop;
        if (y < state.lastScrollY - 4) {
            state.backScrollNudges += 1;
        }
        state.lastScrollY = y;
    }

    function startSectionDwell() {
        const article = document.getElementById("article-scroll");
        const sectionIds = ["s1", "s2", "s3", "s4"];
        if (!article) {
            return;
        }
        const rootOpt = { root: article, threshold: [0, 0.15, 0.3, 0.5, 0.75] };
        const io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                const id = entry.target.getAttribute("data-section");
                if (!id) {
                    return;
                }
                if (entry.isIntersecting && entry.intersectionRatio > 0.2) {
                    if (!state.tVisible[id]) {
                        state.tVisible[id] = performance.now();
                    }
                } else if (state.tVisible[id]) {
                    state.sectionDwell[id] += performance.now() - state.tVisible[id];
                    state.tVisible[id] = 0;
                }
            });
        }, rootOpt);
        sectionIds.forEach(function (id) {
            const el = document.getElementById("section-" + id);
            if (el) {
                el.setAttribute("data-section", id);
                io.observe(el);
            }
        });
    }

    function roundMs(ms) {
        return Math.round(ms) / 1000;
    }

    function goPhase(id) {
        ["brief", "read", "quiz", "results"].forEach(function (p) {
            const el = document.getElementById("phase-" + p);
            if (el) {
                el.hidden = p !== id;
            }
        });
    }

    function startRead() {
        setLabel("READING");
        goPhase("read");
        state.readActive = true;
        state.readStartAt = performance.now();
        startSectionDwell();
        document.addEventListener("mousemove", onPointer, { passive: true });
        articleScrollEl = document.getElementById("article-scroll");
        if (articleScrollEl) {
            state.lastScrollY = articleScrollEl.scrollTop;
            articleScrollEl.addEventListener("scroll", onArticleScroll, { passive: true });
        }
    }

    function endRead() {
        state.readActive = false;
        state.lastX = null;
        state.lastY = null;
        state.tVisible = { s1: 0, s2: 0, s3: 0, s4: 0 };
        document.removeEventListener("mousemove", onPointer);
        if (articleScrollEl) {
            articleScrollEl.removeEventListener("scroll", onArticleScroll);
            articleScrollEl = null;
        }
    }

    function goQuiz() {
        state.readWallMs = performance.now() - state.readStartAt;
        ["s1", "s2", "s3", "s4"].forEach(function (id) {
            if (state.tVisible[id]) {
                state.sectionDwell[id] += performance.now() - state.tVisible[id];
                state.tVisible[id] = 0;
            }
        });
        endRead();
        setLabel("RETENTION");
        goPhase("quiz");
    }

    function scoreForm() {
        const form = document.getElementById("quiz-form");
        const fd = new FormData(form);
        const answers = { q1: "", q2: "", q3: "", q4: "" };
        ["q1", "q2", "q3", "q4"].forEach(function (k) {
            answers[k] = (fd.get(k) || "").toString();
        });
        const careful = fd.get("careful") || "";
        const conf = fd.get("confident") || "";
        let correctN = 0;
        if (answers.q1 === CORRECT.q1) {
            correctN += 1;
        }
        if (answers.q2 === CORRECT.q2) {
            correctN += 1;
        }
        if (answers.q3 === CORRECT.q3) {
            correctN += 1;
        }
        if (answers.q4 === CORRECT.q4) {
            correctN += 1;
        }
        return {
            correctN: correctN,
            total: 4,
            answers: answers,
            careful: careful,
            confident: conf
        };
    }

    function showResults(score) {
        goPhase("results");
        setLabel("READING_COMPLETE");
        const pack = {
            sessionId: state.sessionId,
            readSeconds: roundMs(state.readWallMs),
            sectionDwellSec: {
                s1: roundMs(state.sectionDwell.s1),
                s2: roundMs(state.sectionDwell.s2),
                s3: roundMs(state.sectionDwell.s3),
                s4: roundMs(state.sectionDwell.s4)
            },
            pointerPathPx: Math.round(state.pointerEnergy),
            backScrollNudges: state.backScrollNudges,
            retention: score
        };
        document.getElementById("result-fraction").textContent = score.correctN + " / " + score.total;
        const diag = document.getElementById("result-diagnostics");
        if (diag) {
            diag.textContent = JSON.stringify(pack, null, 2);
        }
        /* eslint-disable no-console */
        console.log("reading-lab:result", pack);
    }

    function onSubmit(e) {
        e.preventDefault();
        const s = scoreForm();
        showResults(s);
    }

    function init() {
        const sid = document.getElementById("session-id");
        if (sid) {
            sid.textContent = "#" + state.sessionId;
        }
        bindStatus();

        document.getElementById("btn-start-read").addEventListener("click", function () {
            startRead();
        });
        document.getElementById("btn-to-quiz").addEventListener("click", function () {
            goQuiz();
        });
        document.getElementById("quiz-form").addEventListener("submit", onSubmit);
    }

    return { init: init, _state: state, CORRECT: CORRECT };
})();

ReadingChallenge.init();
