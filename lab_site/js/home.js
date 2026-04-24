/**
 * Renders challenge cards from data/challenges.json + baseline metrics.
 */
(function () {
    const root = document.getElementById("challenge-grid");
    if (!root) {
        return;
    }

    function esc(s) {
        const d = document.createElement("div");
        d.textContent = s;
        return d.innerHTML;
    }

    function buildCard(c) {
        const article = document.createElement("article");
        article.className = "challenge-card" + (c.comingSoon ? " challenge-card--soon" : "");

        const attempts =
            typeof Metrics !== "undefined"
                ? Metrics.getDisplayCount(c.id, c.baselineAttempts)
                : c.baselineAttempts;
        const countLabel = typeof Metrics !== "undefined" ? Metrics.formatCount(attempts) : String(attempts);

        const a = document.createElement("a");
        a.className = "challenge-card__link";
        if (c.comingSoon) {
            a.href = "#";
            a.setAttribute("tabindex", "-1");
            a.setAttribute("aria-disabled", "true");
            a.addEventListener("click", function (e) {
                e.preventDefault();
            });
        } else {
            a.href = c.entryPage;
            a.addEventListener("click", function () {
                if (typeof Metrics !== "undefined") {
                    Metrics.recordAttempt(c.id);
                }
            });
        }

        const imageWrap = document.createElement("div");
        imageWrap.className = "challenge-card__image-wrap";
        const img = document.createElement("img");
        img.className = "challenge-card__image";
        const srcPath =
            c.image || (c.id === "social-risk" ? "img/challenges/pdp-trust-cues.svg" : "");
        if (srcPath) {
            img.setAttribute("src", srcPath);
        }
        if (c.imageAlt != null && c.imageAlt !== "") {
            img.setAttribute("alt", c.imageAlt);
        } else {
            img.setAttribute("alt", "");
        }
        img.setAttribute("width", "1200");
        img.setAttribute("height", "675");
        img.setAttribute("loading", "lazy");
        img.setAttribute("decoding", "async");
        imageWrap.appendChild(img);
        a.appendChild(imageWrap);

        const body = document.createElement("div");
        body.className = "challenge-card__body";
        body.innerHTML =
            "<h2 class='challenge-card__title'>" +
            esc(c.title) +
            "</h2>" +
            "<p class='challenge-card__desc'>" +
            esc(c.description) +
            "</p>" +
            "<div class='challenge-card__meta'>" +
            (c.comingSoon
                ? "<span class='chip chip--soon'>Coming soon</span>"
                : "<span class='chip' title='Anonymous runs (baseline + this browser)'>" + esc(countLabel) + " runs</span>") +
            "</div>";
        a.appendChild(body);

        article.appendChild(a);
        return article;
    }

    fetch("data/challenges.json")
        .then(function (r) {
            return r.json();
        })
        .then(function (data) {
            const frag = document.createDocumentFragment();
            data.challenges.forEach(function (c) {
                frag.appendChild(buildCard(c));
            });
            root.appendChild(frag);
        })
        .catch(function () {
            root.innerHTML =
                "<p class='home-err'>Could not load challenges. Serve this site over HTTP (e.g. python3 -m http.server).</p>";
        });
})();
