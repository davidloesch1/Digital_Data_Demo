const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const PORT = Number(process.env.PORT) || 3000;
const WAREHOUSE_PATH =
    process.env.WAREHOUSE_PATH || path.join(process.cwd(), 'warehouse.jsonl');

const WAREHOUSE_MAX_BYTES = (() => {
    const n = parseInt(process.env.WAREHOUSE_MAX_BYTES || String(500 * 1024 * 1024), 10);
    return Number.isFinite(n) && n > 0 ? n : 500 * 1024 * 1024;
})();

const SUMMARY_MAX_LINES = (() => {
    const n = parseInt(process.env.SUMMARY_MAX_LINES || '1000', 10);
    return Number.isFinite(n) && n > 0 ? n : 1000;
})();

/** Hard cap on ?limit= to avoid abuse. */
const SUMMARY_QUERY_LIMIT_CAP = (() => {
    const n = parseInt(process.env.SUMMARY_QUERY_LIMIT_CAP || '5000', 10);
    return Number.isFinite(n) && n > 0 ? n : 5000;
})();

const warehouseDir = path.dirname(WAREHOUSE_PATH);
try {
    fs.mkdirSync(warehouseDir, { recursive: true });
} catch (e) {
    console.error(`Collector: could not create warehouse dir ${warehouseDir}:`, e.message);
}

/** Serialize append / trim / discard so concurrent POSTs cannot corrupt JSONL. */
let warehouseWriteChain = Promise.resolve();

function enqueueWarehouseWrite(fn) {
    const next = warehouseWriteChain.then(() => fn());
    warehouseWriteChain = next.catch((e) => {
        console.error('Collector: warehouse write chain error:', e.message || e);
    });
    return next;
}

/** Browser Origin has no path/trailing slash; env entries often mistakenly include one. */
function normalizeOrigin(value) {
    if (!value || typeof value !== 'string') return '';
    return value.trim().replace(/\/+$/, '');
}

const corsOriginsEnv = process.env.CORS_ORIGINS;
let corsMiddleware = cors();
if (corsOriginsEnv && corsOriginsEnv.trim() !== '' && corsOriginsEnv.trim() !== '*') {
    const allowed = corsOriginsEnv
        .split(',')
        .map((s) => normalizeOrigin(s))
        .filter(Boolean);
    if (allowed.length > 0) {
        corsMiddleware = cors({
            origin(origin, cb) {
                if (!origin) return cb(null, true);
                if (allowed.includes(normalizeOrigin(origin))) return cb(null, true);
                return cb(null, false);
            },
        });
    }
}

const app = express();
app.use(corsMiddleware);
app.use(bodyParser.json({ limit: '2mb' }));

function warehouseExists() {
    return fs.existsSync(WAREHOUSE_PATH);
}

function warehouseStatSafe() {
    if (!warehouseExists()) return null;
    try {
        return fs.statSync(WAREHOUSE_PATH);
    } catch {
        return null;
    }
}

function parseSummaryLimit(req) {
    const q = req.query && req.query.limit;
    if (q === undefined || q === '') return SUMMARY_MAX_LINES;
    const n = parseInt(String(q), 10);
    if (!Number.isFinite(n) || n < 1) return SUMMARY_MAX_LINES;
    return Math.min(n, SUMMARY_QUERY_LIMIT_CAP);
}

/**
 * Stream file once and keep only the last `n` non-empty lines, parsed as JSON.
 * O(file size) time, O(n) memory.
 */
function readLastNLinesJson(filePath, n) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            resolve([]);
            return;
        }
        const rs = fs.createReadStream(filePath);
        const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
        const buf = [];
        rl.on('line', (line) => {
            if (!line.trim()) return;
            buf.push(line);
            if (buf.length > n) buf.shift();
        });
        rl.on('close', () => {
            const out = [];
            for (let i = 0; i < buf.length; i++) {
                try {
                    out.push(JSON.parse(buf[i]));
                } catch {
                    /* skip corrupt line */
                }
            }
            resolve(out);
        });
        rl.on('error', reject);
    });
}

/**
 * Remove oldest complete lines until file is under ~90% of WAREHOUSE_MAX_BYTES.
 */
async function trimWarehouseIfNeeded() {
    if (!fs.existsSync(WAREHOUSE_PATH)) return;
    const st = await fsp.stat(WAREHOUSE_PATH);
    if (st.size <= WAREHOUSE_MAX_BYTES) return;

    const toRemove = st.size - Math.floor(WAREHOUSE_MAX_BYTES * 0.9);
    if (toRemove <= 0) return;

    const tmpPath = `${WAREHOUSE_PATH}.tmp`;
    const rs = fs.createReadStream(WAREHOUSE_PATH);
    const rl = readline.createInterface({ input: rs, crlfDelay: Infinity });
    const ws = fs.createWriteStream(tmpPath);

    let skipped = 0;
    for await (const line of rl) {
        if (!line.trim()) continue;
        const nbytes = Buffer.byteLength(line, 'utf8') + 1;
        if (skipped < toRemove) {
            skipped += nbytes;
            continue;
        }
        ws.write(`${line}\n`);
    }

    await new Promise((resolve, reject) => {
        ws.end((err) => (err ? reject(err) : resolve()));
    });
    await fsp.rename(tmpPath, WAREHOUSE_PATH);
    const st2 = await fsp.stat(WAREHOUSE_PATH);
    console.log(`Collector: trimmed warehouse to ${st2.size} bytes (cap ${WAREHOUSE_MAX_BYTES})`);
}

/** Health check for load balancers / PaaS */
app.get('/health', (_req, res) => {
    const st = warehouseStatSafe();
    res.status(200).json({
        ok: true,
        warehouse: warehouseExists(),
        warehouse_bytes: st ? st.size : null,
        warehouse_max_bytes: WAREHOUSE_MAX_BYTES,
        summary_max_lines: SUMMARY_MAX_LINES,
    });
});

app.post('/collect', (req, res) => {
    const dnaPackage = req.body;
    dnaPackage.server_timestamp = new Date().toISOString();
    const logEntry = JSON.stringify(dnaPackage) + '\n';

    enqueueWarehouseWrite(async () => {
        await fsp.appendFile(WAREHOUSE_PATH, logEntry, 'utf8');
        await trimWarehouseIfNeeded();
    })
        .then(() => {
            console.log(`📥 DNA Captured | Label: ${dnaPackage.label}`);
            res.status(200).send('Stored');
        })
        .catch(() => res.status(500).send('Storage Error'));
});

app.get('/summary', async (req, res) => {
    try {
        if (!warehouseExists()) return res.json([]);
        const limit = parseSummaryLimit(req);
        const data = await readLastNLinesJson(WAREHOUSE_PATH, limit);
        res.setHeader('X-Summary-Line-Limit', String(limit));
        res.setHeader('X-Summary-Lines-Returned', String(data.length));
        res.status(200).json(data);
    } catch (e) {
        res.status(500).send('Read Error');
    }
});

app.post('/discard', (req, res) => {
    const { session_url } = req.body;
    if (!warehouseExists()) return res.status(404).send();

    enqueueWarehouseWrite(async () => {
        const text = await fsp.readFile(WAREHOUSE_PATH, 'utf8');
        const lines = text.split('\n');
        let count = 0;
        const filtered = lines
            .reverse()
            .filter((line) => {
                if (!line) return false;
                const entry = JSON.parse(line);
                if (entry.session_url === session_url && count < 20) {
                    count++;
                    return false;
                }
                return true;
            })
            .reverse();

        await fsp.writeFile(WAREHOUSE_PATH, filtered.join('\n'), 'utf8');
        await trimWarehouseIfNeeded();
        return count;
    })
        .then((count) => {
            console.log(`🗑️  Discarded last ${count} entries for session.`);
            res.status(200).send('Discarded');
        })
        .catch(() => res.status(500).send('Discard Error'));
});

app.listen(PORT, '0.0.0.0', () =>
    console.log(
        `🚀 Collector live on :${PORT} | warehouse: ${WAREHOUSE_PATH} | max ${WAREHOUSE_MAX_BYTES}B | summary last ${SUMMARY_MAX_LINES} lines`
    )
);
