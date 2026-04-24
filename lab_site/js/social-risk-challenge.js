/**
 * Social & risk: PDP-style surface, product gallery, toggles, defaults, pointer path.
 */
const SocialRiskChallenge = (function () {
    const TAX = 2.5;
    const BASE = 49;
    const EXT = 8;

    const state = {
        sessionId: "R-" + Math.random().toString(36).slice(2, 8).toUpperCase(),
        t0: 0,
        tRun: 0,
        finished: false,
        usedSkip: false,
        lastX: null,
        lastY: null,
        pointerPathPx: 0,
        reviews: { opened: false, openCount: 0, msToFirstOpen: null },
        sections: {
            warranty: { openCount: 0, firstOpenMs: null },
            privacy: { openCount: 0, firstOpenMs: null },
            price: { openCount: 0, firstOpenMs: null },
            returns: { openCount: 0, firstOpenMs: null }
        },
        gallery: {
            activeIndex: 0,
            thumbClicks: 0,
            msToFirstThumb: null,
            clickSequence: []
        },
        onResize: null
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

    function fmtMoney(n) {
        return n.toFixed(2);
    }

    function updateTotals() {
        const w = document.getElementById("opt-warranty");
        const wOn = w && w.checked;
        const extRow = document.getElementById("row-table-ext");
        if (extRow) {
            extRow.hidden = !wOn;
        }
        const t = TAX + BASE + (wOn ? EXT : 0);
        const tStr = "$" + fmtMoney(t);
        const o = document.getElementById("row-total");
        const est = document.getElementById("sr-order-total");
        const stk = document.getElementById("sr-sticky-amount");
        if (o) {
            o.textContent = tStr;
        }
        if (est) {
            est.textContent = tStr;
        }
        if (stk) {
            stk.textContent = tStr;
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

    function onPtr(e) {
        if (state.finished) {
            return;
        }
        if (state.lastX == null) {
            state.lastX = e.clientX;
            state.lastY = e.clientY;
            return;
        }
        const dx = e.clientX - state.lastX;
        const dy = e.clientY - state.lastY;
        state.pointerPathPx += Math.sqrt(dx * dx + dy * dy);
        state.lastX = e.clientX;
        state.lastY = e.clientY;
    }

    function goPhase(name) {
        ["brief", "run", "done"].forEach(function (p) {
            const el = document.getElementById("phase-" + p);
            if (el) {
                el.hidden = p !== name;
            }
        });
    }

    function setSticky() {
        const s = document.getElementById("sr-sticky");
        if (!s) {
            return;
        }
        if (state.finished) {
            s.setAttribute("hidden", "");
            s.classList.remove("is-on");
            return;
        }
        if (window.matchMedia("(max-width: 768px)").matches) {
            s.removeAttribute("hidden");
            s.classList.add("is-on");
        } else {
            s.setAttribute("hidden", "");
            s.classList.remove("is-on");
        }
    }

    function bindGallery() {
        const main = document.getElementById("sr-hero-img");
        const bar = document.getElementById("sr-thumbs");
        if (!main || !bar) {
            return;
        }
        bar.addEventListener("click", function (e) {
            if (state.finished) {
                return;
            }
            const t = e.target;
            const btn = t && t.closest ? t.closest(".sr-thumb") : null;
            if (!btn) {
                return;
            }
            const idx = parseInt(btn.getAttribute("data-index"), 10);
            if (isNaN(idx) || idx < 0) {
                return;
            }
            if (state.gallery.activeIndex === idx) {
                return;
            }
            const src = btn.getAttribute("data-src");
            if (src) {
                main.setAttribute("src", src);
            }
            state.gallery.activeIndex = idx;
            state.gallery.thumbClicks += 1;
            state.gallery.clickSequence.push(idx);
            if (state.gallery.msToFirstThumb == null) {
                state.gallery.msToFirstThumb = Math.round(performance.now() - state.tRun);
            }
            setLabel("SR_GALL_" + (idx + 1));
            bar.querySelectorAll(".sr-thumb").forEach(function (b) {
                const j = parseInt(b.getAttribute("data-index"), 10);
                const on = j === idx;
                b.classList.toggle("is-active", on);
                b.setAttribute("aria-pressed", on ? "true" : "false");
            });
        });
    }

    function bindAccordion(btnId, bodyId, key, label) {
        const b = document.getElementById(btnId);
        const d = document.getElementById(bodyId);
        if (!b || !d) {
            return;
        }
        b.addEventListener("click", function () {
            if (state.finished) {
                return;
            }
            const on = b.getAttribute("aria-expanded") === "true";
            b.setAttribute("aria-expanded", on ? "false" : "true");
            d.hidden = on;
            if (on) {
                return;
            }
            setLabel(label);
            const block = state.sections[key];
            block.openCount += 1;
            if (block.firstOpenMs == null) {
                block.firstOpenMs = Math.round(performance.now() - state.tRun);
            }
        });
    }

    function bindReviews() {
        const b = document.getElementById("btn-reviews");
        const p = document.getElementById("panel-reviews");
        if (!b || !p) {
            return;
        }
        b.addEventListener("click", function () {
            if (state.finished) {
                return;
            }
            const on = b.getAttribute("aria-expanded") === "true";
            b.setAttribute("aria-expanded", on ? "false" : "true");
            p.hidden = on;
            if (on) {
                return;
            }
            setLabel("SR_REVIEW");
            const r = state.reviews;
            r.opened = true;
            r.openCount += 1;
            if (r.openCount === 1 && r.msToFirstOpen == null) {
                r.msToFirstOpen = Math.round(performance.now() - state.tRun);
            }
        });
    }

    function bindCheckboxes() {
        ["opt-warranty", "opt-tips"].forEach(function (id) {
            const el = document.getElementById(id);
            if (!el) {
                return;
            }
            el.addEventListener("change", function () {
                if (state.finished) {
                    return;
                }
                updateTotals();
                if (id === "opt-warranty") {
                    setLabel(el.checked ? "SR_CHK_WON" : "SR_CHK_WOFF");
                } else {
                    setLabel(el.checked ? "SR_CHK_TON" : "SR_CHK_TOFF");
                }
            });
        });
    }

    function goDone() {
        if (state.finished) {
            return;
        }
        state.finished = true;
        if (state.onResize) {
            window.removeEventListener("resize", state.onResize);
            state.onResize = null;
        }
        setLabel("SR_DONE");
        document.removeEventListener("mousemove", onPtr, { passive: true });
        goPhase("done");
        setSticky();
        const sk = document.getElementById("sr-sticky");
        if (sk) {
            sk.setAttribute("hidden", "");
            sk.classList.remove("is-on");
        }

        const w = document.getElementById("opt-warranty");
        const t2 = document.getElementById("opt-tips");
        const wChecked = w ? w.checked : null;
        const tChecked = t2 ? t2.checked : null;

        const openSum =
            (state.sections.warranty.openCount > 0 ? 1 : 0) +
            (state.sections.privacy.openCount > 0 ? 1 : 0) +
            (state.sections.price.openCount > 0 ? 1 : 0) +
            (state.sections.returns.openCount > 0 ? 1 : 0);

        const pack = {
            module: "social-risk",
            v: 2,
            sessionId: state.sessionId,
            usedSkip: state.usedSkip,
            productGallery: {
                activeIndexAtEnd: state.gallery.activeIndex,
                totalThumbClicks: state.gallery.thumbClicks,
                msToFirstThumb: state.gallery.msToFirstThumb,
                clickIndexSequence: state.gallery.clickSequence.slice(0, 20)
            },
            socialProof: {
                reviewsOpenCount: state.reviews.openCount,
                reviewsFirstOpenMs: state.reviews.msToFirstOpen
            },
            riskSections: {
                warranty: state.sections.warranty,
                privacy: state.sections.privacy,
                price: state.sections.price,
                returns: state.sections.returns
            },
            sectionsOpenedCount: openSum,
            defaultChoices: {
                extendedWarranty: wChecked,
                productTipsEmail: tChecked,
                extendedWarrantyDeclined: w ? w.checked === false : null,
                productTipsDeclined: t2 ? t2.checked === false : null,
                estimatedOrderTotalDemo: wChecked ? TAX + BASE + EXT : TAX + BASE
            },
            pointerPathPx: Math.round(state.pointerPathPx),
            elapsedSec: Math.round((performance.now() - state.t0) * 10) / 10
        };

        const out = document.getElementById("sr-diagnostics");
        if (out) {
            out.textContent = JSON.stringify(pack, null, 2);
        }
        /* eslint-disable no-console */
        console.log("social-risk:result", pack);
    }

    function onStart() {
        state.t0 = performance.now();
        state.tRun = performance.now();
        state.finished = false;
        state.usedSkip = false;
        state.reviews = { opened: false, openCount: 0, msToFirstOpen: null };
        state.pointerPathPx = 0;
        state.lastX = null;
        state.lastY = null;
        state.gallery = {
            activeIndex: 0,
            thumbClicks: 0,
            msToFirstThumb: null,
            clickSequence: []
        };
        ["warranty", "privacy", "price", "returns"].forEach(function (k) {
            state.sections[k] = { openCount: 0, firstOpenMs: null };
        });
        const main = document.getElementById("sr-hero-img");
        if (main) {
            main.setAttribute("src", "product/photo-1.svg");
        }
        document.querySelectorAll("#sr-thumbs .sr-thumb").forEach(function (b, i) {
            b.classList.toggle("is-active", i === 0);
            b.setAttribute("aria-pressed", i === 0 ? "true" : "false");
        });
        const w = document.getElementById("opt-warranty");
        const t = document.getElementById("opt-tips");
        if (w) {
            w.checked = true;
        }
        if (t) {
            t.checked = true;
        }
        updateTotals();
        setLabel("SR_RUN");
        goPhase("run");
        document.addEventListener("mousemove", onPtr, { passive: true });
        setSticky();
        state.onResize = function () {
            if (!state.finished) {
                setSticky();
            }
        };
        window.addEventListener("resize", state.onResize, { passive: true });
    }

    function skipToResults() {
        if (state.finished) {
            return;
        }
        state.usedSkip = true;
        setLabel("SR_SKIP");
        goDone();
    }

    function init() {
        function sendSubmit() {
            if (state.finished) {
                return;
            }
            setLabel("SR_SUBMIT");
            goDone();
        }
        state.t0 = performance.now();
        const sid = document.getElementById("session-id");
        if (sid) {
            sid.textContent = "#" + state.sessionId;
        }
        bindStatus();
        document.getElementById("btn-brief").addEventListener("click", onStart);
        document.getElementById("btn-submit").addEventListener("click", sendSubmit);
        const s2 = document.getElementById("btn-submit-sticky");
        if (s2) {
            s2.addEventListener("click", sendSubmit);
        }
        const sk = document.getElementById("skip-brief");
        if (sk) {
            sk.addEventListener("click", function () {
                if (!state.finished) {
                    skipToResults();
                }
            });
        }
        bindGallery();
        bindReviews();
        bindAccordion("acc-w", "body-w", "warranty", "SR_SECT_W");
        bindAccordion("acc-p", "body-p", "privacy", "SR_SECT_P");
        bindAccordion("acc-price", "body-price", "price", "SR_SECT_PRICE");
        bindAccordion("acc-r", "body-r", "returns", "SR_SECT_R");
        bindCheckboxes();
    }

    return { init: init, _state: state };
})();

SocialRiskChallenge.init();
