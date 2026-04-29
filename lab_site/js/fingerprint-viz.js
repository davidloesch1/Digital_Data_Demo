/**
 * PCA (2D) + parallel coordinates for 16-D kinetic fingerprints. No external deps.
 */
(function (g) {
    var DIM = 16;

    function pad16(v) {
        var out = v.slice(0, DIM);
        while (out.length < DIM) out.push(0);
        return out;
    }

    function zeros(n) {
        var a = [];
        for (var i = 0; i < n; i++) a.push(0);
        return a;
    }

    function dot(a, b) {
        var s = 0;
        for (var i = 0; i < a.length; i++) s += a[i] * b[i];
        return s;
    }

    function norm(a) {
        return Math.sqrt(dot(a, a));
    }

    function scaleVec(a, s) {
        return a.map(function (x) {
            return x * s;
        });
    }

    function matVec(C, v) {
        var d = v.length;
        var out = zeros(d);
        for (var i = 0; i < d; i++) {
            var row = C[i];
            var s = 0;
            for (var j = 0; j < d; j++) s += row[j] * v[j];
            out[i] = s;
        }
        return out;
    }

    function outer(u, v) {
        var d = u.length;
        var M = [];
        for (var i = 0; i < d; i++) {
            M[i] = [];
            for (var j = 0; j < d; j++) M[i][j] = u[i] * v[j];
        }
        return M;
    }

    function matSub(A, B) {
        var d = A.length;
        var R = [];
        for (var i = 0; i < d; i++) {
            R[i] = [];
            for (var j = 0; j < d; j++) R[i][j] = A[i][j] - B[i][j];
        }
        return R;
    }

    function trace(C) {
        var t = 0;
        for (var i = 0; i < C.length; i++) t += C[i][i];
        return t;
    }

    function covarianceMatrix(X) {
        var n = X.length;
        var d = X[0].length;
        var mean = zeros(d);
        var i, j, k;
        for (k = 0; k < n; k++) {
            for (j = 0; j < d; j++) mean[j] += X[k][j];
        }
        for (j = 0; j < d; j++) mean[j] /= n;

        var Z = [];
        for (k = 0; k < n; k++) {
            var row = [];
            for (j = 0; j < d; j++) row.push(X[k][j] - mean[j]);
            Z.push(row);
        }

        var C = [];
        for (i = 0; i < d; i++) {
            C[i] = [];
            for (j = 0; j < d; j++) {
                var s = 0;
                for (k = 0; k < n; k++) s += Z[k][i] * Z[k][j];
                C[i][j] = n > 1 ? s / (n - 1) : 0;
            }
        }

        return { C: C, mean: mean, Z: Z };
    }

    function randomUnit(d) {
        var v = [];
        var s = 0;
        for (var i = 0; i < d; i++) {
            var x = Math.random() - 0.5;
            v.push(x);
            s += x * x;
        }
        s = Math.sqrt(s) || 1;
        return v.map(function (x) {
            return x / s;
        });
    }

    function powerSymmetricEigenpair(C, iterations) {
        var d = C.length;
        var v = randomUnit(d);
        var it = iterations || 80;
        var i, t;
        for (t = 0; t < it; t++) {
            var w = matVec(C, v);
            var nw = norm(w);
            if (nw < 1e-14) break;
            v = scaleVec(w, 1 / nw);
        }
        var Cv = matVec(C, v);
        var lambda = dot(v, Cv);
        return { eigenvector: v, eigenvalue: lambda };
    }

    function deflate(C, lambda, v) {
        var d = v.length;
        var O = outer(v, v);
        var R = [];
        for (var i = 0; i < d; i++) {
            R[i] = [];
            for (var j = 0; j < d; j++) R[i][j] = C[i][j] - lambda * O[i][j];
        }
        return R;
    }

    /**
     * @param {number[][]} vectors - rows of length 16 (padded)
     * @returns {{ points: {x:number,y:number}[], explainedPct: [number,number], pcBasis: number[][], mean: number[], fallback: boolean }}
     */
    function pcaProject2D(vectors) {
        if (!vectors || !vectors.length) {
            return { points: [], explainedPct: [0, 0], pcBasis: [], mean: [], fallback: true };
        }

        var X = vectors.map(function (v) {
            return pad16(v);
        });
        var n = X.length;

        if (n === 1) {
            return {
                points: [{ x: X[0][0], y: X[0][1] }],
                explainedPct: [100, 0],
                pcBasis: [
                    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                    [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
                ],
                mean: X[0].slice(),
                fallback: true,
            };
        }

        var cov = covarianceMatrix(X);
        var C = cov.C;
        var mean = cov.mean;
        var Z = cov.Z;

        var tr = trace(C);
        if (tr < 1e-18) {
            var pts = [];
            for (var i = 0; i < n; i++) {
                pts.push({ x: X[i][0], y: X[i][1] });
            }
            return {
                points: pts,
                explainedPct: [100, 0],
                pcBasis: [],
                mean: mean,
                fallback: true,
            };
        }

        var e1 = powerSymmetricEigenpair(C, 80);
        var v1 = e1.eigenvector;
        var lam1 = Math.max(0, e1.eigenvalue);

        var C2 = deflate(C, lam1, v1);
        var e2 = powerSymmetricEigenpair(C2, 80);
        var v2 = e2.eigenvector;
        var lam2 = Math.max(0, e2.eigenvalue);

        var orth = dot(v1, v2);
        v2 = v2.map(function (x, i) {
            return x - orth * v1[i];
        });
        var n2 = norm(v2);
        if (n2 > 1e-12) v2 = scaleVec(v2, 1 / n2);

        var pcBasis = [v1, v2];

        var points = Z.map(function (row) {
            return {
                x: dot(row, v1),
                y: dot(row, v2),
            };
        });

        var totalVar = tr;
        var p1 = totalVar > 1e-18 ? (lam1 / totalVar) * 100 : 0;
        var p2 = totalVar > 1e-18 ? (lam2 / totalVar) * 100 : 0;

        return {
            points: points,
            explainedPct: [Math.round(p1 * 10) / 10, Math.round(p2 * 10) / 10],
            pcBasis: pcBasis,
            mean: mean,
            fallback: false,
        };
    }

    /**
     * @param {HTMLElement} container
     * @param {Array<{ vector: number[], color: string, opacity?: number, lineWidth?: number, sid?: string }>} items
     * @param {{ highlightSid?: string|null, highlightUserKey?: string|null }} opts
     */
    function renderParallelCoords(container, items, opts) {
        opts = opts || {};
        var highlightSid = opts.highlightSid;
        var highlightUserKey = opts.highlightUserKey;

        if (!container) return;
        container.innerHTML = "";

        if (!items || !items.length) {
            var empty = document.createElement("p");
            empty.className = "parallel-empty";
            empty.textContent = "No kinetic rows to draw.";
            container.appendChild(empty);
            return;
        }

        var vecs = items.map(function (it) {
            return pad16(it.vector);
        });

        var mins = zeros(DIM);
        var maxs = zeros(DIM);
        var j;
        for (j = 0; j < DIM; j++) {
            mins[j] = Infinity;
            maxs[j] = -Infinity;
        }
        vecs.forEach(function (row) {
            for (j = 0; j < DIM; j++) {
                mins[j] = Math.min(mins[j], row[j]);
                maxs[j] = Math.max(maxs[j], row[j]);
            }
        });
        for (j = 0; j < DIM; j++) {
            if (mins[j] === maxs[j]) {
                mins[j] -= 1e-6;
                maxs[j] += 1e-6;
            }
        }

        var W = container.clientWidth;
        if (!W || W < 280) W = 720;
        var H = 260;
        var padL = 36;
        var padR = 16;
        var padT = 14;
        var padB = 28;
        var innerW = W - padL - padR;
        var innerH = H - padT - padB;

        var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        svg.setAttribute("viewBox", "0 0 " + W + " " + H);
        svg.setAttribute("class", "parallel-svg");
        svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
        svg.style.width = "100%";
        svg.style.height = H + "px";

        var bg = document.createElementNS("http://www.w3.org/2000/svg", "rect");
        bg.setAttribute("x", "0");
        bg.setAttribute("y", "0");
        bg.setAttribute("width", W);
        bg.setAttribute("height", H);
        bg.setAttribute("fill", "rgba(15,23,42,0.35)");
        bg.setAttribute("rx", "12");
        svg.appendChild(bg);

        function xAt(dimIdx) {
            return padL + (dimIdx / (DIM - 1)) * innerW;
        }

        function yAt(val, dimIdx) {
            var t = (val - mins[dimIdx]) / (maxs[dimIdx] - mins[dimIdx]);
            return padT + innerH * (1 - t);
        }

        for (var ax = 0; ax < DIM; ax++) {
            var line = document.createElementNS("http://www.w3.org/2000/svg", "line");
            line.setAttribute("x1", xAt(ax));
            line.setAttribute("x2", xAt(ax));
            line.setAttribute("y1", padT);
            line.setAttribute("y2", padT + innerH);
            line.setAttribute("stroke", "#334155");
            line.setAttribute("stroke-width", "1");
            svg.appendChild(line);

            var lbl = document.createElementNS("http://www.w3.org/2000/svg", "text");
            lbl.setAttribute("x", xAt(ax));
            lbl.setAttribute("y", H - 8);
            lbl.setAttribute("text-anchor", "middle");
            lbl.setAttribute("fill", "#64748b");
            lbl.setAttribute("font-size", "9");
            lbl.setAttribute("font-family", "JetBrains Mono, monospace");
            lbl.textContent = String(ax);
            svg.appendChild(lbl);
        }

        var sorted = items
            .map(function (it, idx) {
                return { it: it, idx: idx };
            })
            .sort(function (a, b) {
                function score(it) {
                    var uh = highlightUserKey && it.userKey === highlightUserKey ? 2 : 0;
                    var sh = highlightSid && it.sid === highlightSid ? 1 : 0;
                    return uh || sh;
                }
                return score(a.it) - score(b.it);
            });

        sorted.forEach(function (wrap) {
            var it = wrap.it;
            var row = vecs[wrap.idx];
            var parts = [];
            for (var d = 0; d < DIM; d++) {
                parts.push(xAt(d).toFixed(2) + "," + yAt(row[d], d).toFixed(2));
            }
            var dStr = "M " + parts.join(" L ");

            var path = document.createElementNS("http://www.w3.org/2000/svg", "path");
            path.setAttribute("d", dStr);
            path.setAttribute("fill", "none");
            path.setAttribute("stroke", it.color || "#6366f1");

            var isHi =
                (highlightUserKey && it.userKey === highlightUserKey) ||
                (highlightSid && it.sid === highlightSid);
            var dim =
                highlightUserKey || highlightSid
                    ? !isHi
                    : false;
            var baseOp = typeof it.opacity === "number" ? it.opacity : 0.35;
            path.setAttribute("stroke-opacity", isHi ? 1 : dim ? baseOp * 0.35 : baseOp);
            path.setAttribute("stroke-width", isHi ? (it.lineWidth || 2.5) + 1 : it.lineWidth || 1.5);
            path.setAttribute("stroke-linecap", "round");
            path.setAttribute("stroke-linejoin", "round");
            svg.appendChild(path);
        });

        container.appendChild(svg);
    }

    g.NexusFingerprintViz = {
        DIM: DIM,
        pad16: pad16,
        pcaProject2D: pcaProject2D,
        renderParallelCoords: renderParallelCoords,
    };
})(typeof window !== "undefined" ? window : this);
