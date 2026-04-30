const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3000;
const WAREHOUSE_PATH =
    process.env.WAREHOUSE_PATH || path.join(process.cwd(), 'warehouse.jsonl');

const warehouseDir = path.dirname(WAREHOUSE_PATH);
try {
    fs.mkdirSync(warehouseDir, { recursive: true });
} catch (e) {
    console.error(`Collector: could not create warehouse dir ${warehouseDir}:`, e.message);
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
                // curl / server-side checks often omit Origin
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

/** Health check for load balancers / PaaS */
app.get('/health', (_req, res) => {
    res.status(200).json({ ok: true, warehouse: warehouseExists() });
});

app.post('/collect', (req, res) => {
    const dnaPackage = req.body;
    dnaPackage.server_timestamp = new Date().toISOString();
    const logEntry = JSON.stringify(dnaPackage) + '\n';

    fs.appendFile(WAREHOUSE_PATH, logEntry, (err) => {
        if (err) return res.status(500).send('Storage Error');
        console.log(`📥 DNA Captured | Label: ${dnaPackage.label}`);
        res.status(200).send('Stored');
    });
});

app.get('/summary', (req, res) => {
    try {
        if (!warehouseExists()) return res.json([]);
        const data = fs
            .readFileSync(WAREHOUSE_PATH, 'utf-8')
            .split('\n')
            .filter((line) => line.trim())
            .map((line) => JSON.parse(line));
        res.status(200).json(data);
    } catch (e) {
        res.status(500).send('Read Error');
    }
});

app.post('/discard', (req, res) => {
    const { session_url } = req.body;
    if (!warehouseExists()) return res.status(404).send();

    const lines = fs.readFileSync(WAREHOUSE_PATH, 'utf-8').split('\n');
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

    fs.writeFileSync(WAREHOUSE_PATH, filtered.join('\n'));
    console.log(`🗑️  Discarded last ${count} entries for session.`);
    res.status(200).send('Discarded');
});

app.listen(PORT, '0.0.0.0', () =>
    console.log(`🚀 Collector live on :${PORT} | warehouse: ${WAREHOUSE_PATH}`)
);
