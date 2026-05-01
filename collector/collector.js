const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const tenantDbApi = require('./tenant-db.js');

/** @type {{ pool: import('pg').Pool; pepper: string } | null} */
let tenantContext = null;

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

function envTruthy(name) {
    const v = process.env[name];
    if (v === undefined || v === null || String(v).trim() === '') return false;
    const s = String(v).toLowerCase().trim();
    return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** When Postgres is on and this is true, /collect /summary /discard return 410 (product / org-only mode). */
function legacyFileWarehouseDisabled() {
    return Boolean(tenantContext && envTruthy('DISABLE_LEGACY_FILE_WAREHOUSE'));
}

function rejectLegacyFileRoutes(res) {
    res.status(410).json({
        error: 'Legacy file warehouse is disabled for this deployment',
        ingest: 'POST /v1/ingest',
        summary: 'GET /v1/summary',
        discard: 'POST /v1/discard',
        hint: 'Use a publishable key (Authorization: Bearer nx_pub_…). Re-enable file routes only for migration by unsetting DISABLE_LEGACY_FILE_WAREHOUSE.',
    });
}

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

/** Comma-separated CORS_ORIGINS: exact https origins, plus optional `https://*.vercel.app` (or `*.vercel.app`) for any preview host under .vercel.app. */
function parseCorsOriginsEnv(envStr) {
    const tokens = envStr.split(',').map((s) => s.trim()).filter(Boolean);
    const exact = [];
    let allowVercelPreviewHosts = false;
    for (const t of tokens) {
        if (t === 'https://*.vercel.app' || t === '*.vercel.app') {
            allowVercelPreviewHosts = true;
        } else {
            const n = normalizeOrigin(t);
            if (n) exact.push(n);
        }
    }
    return { exact, allowVercelPreviewHosts };
}

function isHttpsVercelAppOrigin(origin) {
    try {
        const u = new URL(origin);
        return u.protocol === 'https:' && u.hostname.endsWith('.vercel.app');
    } catch {
        return false;
    }
}

const corsOriginsEnv = process.env.CORS_ORIGINS;
let corsMiddleware = cors();
if (corsOriginsEnv && corsOriginsEnv.trim() !== '' && corsOriginsEnv.trim() !== '*') {
    const { exact, allowVercelPreviewHosts } = parseCorsOriginsEnv(corsOriginsEnv);
    if (exact.length > 0 || allowVercelPreviewHosts) {
        corsMiddleware = cors({
            origin(origin, cb) {
                if (!origin) return cb(null, true);
                const norm = normalizeOrigin(origin);
                if (exact.includes(norm)) return cb(null, true);
                if (allowVercelPreviewHosts && isHttpsVercelAppOrigin(origin)) return cb(null, true);
                return cb(null, false);
            },
        });
    }
}

const app = express();
app.use(corsMiddleware);
app.use(bodyParser.json({ limit: '2mb' }));

/** Root URL in browser — there is no HTML app here, only API routes. */
app.get('/', (_req, res) => {
    const body = {
        ok: true,
        service: 'nexus-collector',
        message: 'Use GET /health. Ingest: POST /v1/ingest (or legacy POST /collect if enabled).',
        endpoints: {
            health: 'GET /health',
            ingest_v1: 'POST /v1/ingest',
            summary_v1: 'GET /v1/summary',
            discard_v1: 'POST /v1/discard',
            collect_legacy: 'POST /collect',
            summary_legacy: 'GET /summary',
            discard_legacy: 'POST /discard',
        },
    };
    if (
        tenantContext &&
        process.env.INTERNAL_ADMIN_TOKEN &&
        String(process.env.INTERNAL_ADMIN_TOKEN).trim() !== ''
    ) {
        body.internal_admin_portal = 'GET /internal/admin';
        body.internal_admin_api =
            'GET /internal/v1/orgs | POST /internal/v1/orgs | POST /internal/v1/keys/revoke';
    }
    res.status(200).json(body);
});

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

function extractPublishableKey(req) {
    const auth = req.headers.authorization;
    if (auth && typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        const t = auth.slice(7).trim();
        if (t) return t;
    }
    const x = req.headers['x-nexus-publishable-key'];
    if (x) return String(x).trim();
    return null;
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
app.get('/health', async (_req, res) => {
    const st = warehouseStatSafe();
    const body = {
        ok: true,
        warehouse: warehouseExists(),
        warehouse_bytes: st ? st.size : null,
        warehouse_max_bytes: WAREHOUSE_MAX_BYTES,
        summary_max_lines: SUMMARY_MAX_LINES,
        multi_tenant: Boolean(tenantContext),
    };
    if (tenantContext) {
        try {
            await tenantContext.pool.query('SELECT 1');
            body.database = 'connected';
        } catch (e) {
            body.database = 'error';
            body.database_error = e.message;
        }
    } else {
        body.database = 'not_configured';
    }
    if (legacyFileWarehouseDisabled()) {
        body.legacy_file_warehouse = 'disabled';
    } else if (tenantContext) {
        body.legacy_file_warehouse = 'enabled_parallel';
    } else {
        body.legacy_file_warehouse = 'file_only';
    }
    res.status(200).json(body);
});

app.post('/collect', (req, res) => {
    if (legacyFileWarehouseDisabled()) return rejectLegacyFileRoutes(res);
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
    if (legacyFileWarehouseDisabled()) return rejectLegacyFileRoutes(res);
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
    if (legacyFileWarehouseDisabled()) return rejectLegacyFileRoutes(res);
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

/** Multi-tenant ingest (JSON body same shape as POST /collect). Requires publishable key. */
app.post('/v1/ingest', async (req, res) => {
    if (!tenantContext) {
        return res.status(503).json({
            error: 'Multi-tenant ingest not configured',
            hint: 'Set DATABASE_URL and PUBLISHABLE_KEY_PEPPER on the collector.',
        });
    }
    const rawKey = extractPublishableKey(req);
    if (!rawKey) {
        return res.status(401).json({
            error: 'Missing publishable key',
            hint: 'Use Authorization: Bearer <nx_pub_...> or X-Nexus-Publishable-Key',
        });
    }
    let resolved;
    try {
        resolved = await tenantDbApi.resolvePublishableKey(
            tenantContext.pool,
            tenantContext.pepper,
            rawKey
        );
    } catch (e) {
        console.error('resolvePublishableKey:', e);
        return res.status(500).json({ error: 'Auth lookup failed' });
    }
    if (!resolved) {
        return res.status(401).json({ error: 'Invalid or revoked publishable key' });
    }
    const dnaPackage = { ...req.body };
    dnaPackage.server_timestamp = new Date().toISOString();
    dnaPackage.org_slug = resolved.orgSlug;
    try {
        await tenantDbApi.insertBehaviorEvent(tenantContext.pool, resolved.orgId, dnaPackage);
    } catch (e) {
        console.error('insertBehaviorEvent:', e);
        return res.status(500).json({ error: 'Storage error' });
    }
    console.log(`📥 v1/ingest | org=${resolved.orgSlug} | label=${dnaPackage.label}`);
    res.status(200).json({ ok: true, stored: true });
});

/** Org-scoped summary (same response shape as GET /summary). Requires publishable key. */
app.get('/v1/summary', async (req, res) => {
    if (!tenantContext) {
        return res.status(503).json({
            error: 'Multi-tenant summary not configured',
            hint: 'Set DATABASE_URL and PUBLISHABLE_KEY_PEPPER on the collector.',
        });
    }
    const rawKey = extractPublishableKey(req);
    if (!rawKey) {
        return res.status(401).json({
            error: 'Missing publishable key',
            hint: 'Use Authorization: Bearer <nx_pub_...> or X-Nexus-Publishable-Key',
        });
    }
    let resolved;
    try {
        resolved = await tenantDbApi.resolvePublishableKey(
            tenantContext.pool,
            tenantContext.pepper,
            rawKey
        );
    } catch (e) {
        console.error('resolvePublishableKey:', e);
        return res.status(500).json({ error: 'Auth lookup failed' });
    }
    if (!resolved) {
        return res.status(401).json({ error: 'Invalid or revoked publishable key' });
    }
    const limit = parseSummaryLimit(req);
    try {
        const data = await tenantDbApi.fetchRecentPayloads(tenantContext.pool, resolved.orgId, limit);
        res.setHeader('X-Summary-Line-Limit', String(limit));
        res.setHeader('X-Summary-Lines-Returned', String(data.length));
        res.setHeader('X-Org-Slug', resolved.orgSlug);
        res.status(200).json(data);
    } catch (e) {
        console.error('fetchRecentPayloads:', e);
        res.status(500).send('Read Error');
    }
});

/** Org-scoped discard (same body as POST /discard: { session_url }). Requires publishable key. */
app.post('/v1/discard', async (req, res) => {
    if (!tenantContext) {
        return res.status(503).json({
            error: 'Multi-tenant discard not configured',
            hint: 'Set DATABASE_URL and PUBLISHABLE_KEY_PEPPER on the collector.',
        });
    }
    const rawKey = extractPublishableKey(req);
    if (!rawKey) {
        return res.status(401).json({
            error: 'Missing publishable key',
            hint: 'Use Authorization: Bearer <nx_pub_...> or X-Nexus-Publishable-Key',
        });
    }
    let resolved;
    try {
        resolved = await tenantDbApi.resolvePublishableKey(
            tenantContext.pool,
            tenantContext.pepper,
            rawKey
        );
    } catch (e) {
        console.error('resolvePublishableKey:', e);
        return res.status(500).json({ error: 'Auth lookup failed' });
    }
    if (!resolved) {
        return res.status(401).json({ error: 'Invalid or revoked publishable key' });
    }
    const sessionUrl = req.body && req.body.session_url;
    if (!sessionUrl || typeof sessionUrl !== 'string' || sessionUrl.trim() === '') {
        return res.status(400).json({ error: 'session_url required in JSON body' });
    }
    let removed;
    try {
        removed = await tenantDbApi.deleteRecentEventsBySessionUrl(
            tenantContext.pool,
            resolved.orgId,
            sessionUrl.trim(),
            20
        );
    } catch (e) {
        console.error('deleteRecentEventsBySessionUrl:', e);
        return res.status(500).json({ error: 'Discard failed' });
    }
    console.log(`🗑️  v1/discard | org=${resolved.orgSlug} | removed ${removed} row(s)`);
    res.status(200).json({ ok: true, discarded: removed });
});

/** POST /internal/v1/orgs, POST /internal/v1/keys/revoke — bearer INTERNAL_ADMIN_TOKEN */
function mountInternalAdminRoutes(app) {
    const expected = process.env.INTERNAL_ADMIN_TOKEN;
    if (!tenantContext || !expected || String(expected).trim() === '') {
        return;
    }

    function adminTokenOk(req) {
        let presented = null;
        const auth = req.headers.authorization;
        if (auth && typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
            presented = auth.slice(7).trim();
        }
        if (!presented && req.headers['x-nexus-admin-token']) {
            presented = String(req.headers['x-nexus-admin-token']).trim();
        }
        if (!presented) return false;
        const exp = String(expected).trim();
        try {
            const a = Buffer.from(presented, 'utf8');
            const b = Buffer.from(exp, 'utf8');
            if (a.length !== b.length) return false;
            return crypto.timingSafeEqual(a, b);
        } catch {
            return false;
        }
    }

    const router = express.Router();
    router.use((req, res, next) => {
        if (!adminTokenOk(req)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        next();
    });

    router.get('/orgs', async (_req, res) => {
        try {
            const orgs = await tenantDbApi.listOrganizations(tenantContext.pool);
            res.status(200).json({ orgs });
        } catch (e) {
            console.error('internal GET /orgs:', e.message || e);
            res.status(500).json({ error: 'List failed' });
        }
    });

    router.post('/orgs', async (req, res) => {
        const slug = req.body && req.body.slug;
        const name = (req.body && req.body.name) || slug;
        if (!slug || typeof slug !== 'string' || String(slug).trim() === '') {
            return res.status(400).json({ error: 'slug required (JSON body)' });
        }
        try {
            const out = await tenantDbApi.provisionOrgAndPublishableKey(
                tenantContext.pool,
                String(slug).trim(),
                typeof name === 'string' ? name.trim() : String(slug).trim(),
                tenantContext.pepper,
                'internal-admin'
            );
            res.status(201).json({ org_slug: out.orgSlug, publishable_key: out.plainKey });
        } catch (e) {
            console.error('internal POST /orgs:', e.message || e);
            res.status(500).json({ error: 'Provision failed' });
        }
    });

    router.post('/keys/revoke', async (req, res) => {
        const rawKey = req.body && req.body.publishable_key;
        if (!rawKey || typeof rawKey !== 'string' || String(rawKey).trim() === '') {
            return res.status(400).json({ error: 'publishable_key required (JSON body)' });
        }
        try {
            const n = await tenantDbApi.revokePublishableKey(
                tenantContext.pool,
                tenantContext.pepper,
                rawKey
            );
            res.status(200).json({ ok: true, revoked: n });
        } catch (e) {
            console.error('internal POST /keys/revoke:', e.message || e);
            res.status(500).json({ error: 'Revoke failed' });
        }
    });

    app.use('/internal/v1', router);
    console.log(
        'Collector: internal admin API at GET|POST /internal/v1/orgs, POST /internal/v1/keys/revoke (INTERNAL_ADMIN_TOKEN)'
    );
}

/** Static UI for org provisioning (same origin as API). Enabled only with INTERNAL_ADMIN_TOKEN + Postgres. */
function mountInternalAdminPortal(app) {
    const expected = process.env.INTERNAL_ADMIN_TOKEN;
    if (!tenantContext || !expected || String(expected).trim() === '') {
        return;
    }
    const adminDir = path.join(__dirname, 'admin-portal');
    const adminIndex = path.join(adminDir, 'index.html');
    /** Avoid 302 /internal/admin → /internal/admin/: proxies often normalize slashes the other way → redirect loops. */
    function sendAdminIndex(_req, res) {
        res.sendFile(adminIndex);
    }
    app.get('/internal/admin', sendAdminIndex);
    app.get('/internal/admin/', sendAdminIndex);
    app.use('/internal/admin', express.static(adminDir, { index: false }));
    console.log('Collector: internal admin portal at GET /internal/admin (with or without trailing slash)');
}

async function start() {
    if (process.env.DATABASE_URL) {
        try {
            tenantContext = await tenantDbApi.createPoolAndMigrate(
                process.env.DATABASE_URL,
                process.env.PUBLISHABLE_KEY_PEPPER || ''
            );
            console.log('Collector: multi-tenant Postgres enabled (/v1/ingest, /v1/summary, /v1/discard)');
            if (envTruthy('DISABLE_LEGACY_FILE_WAREHOUSE')) {
                console.log('Collector: legacy file routes disabled (DISABLE_LEGACY_FILE_WAREHOUSE)');
            }
        } catch (e) {
            console.error('Collector: DATABASE_URL set but Postgres init failed:', e.message);
            process.exit(1);
        }
    }
    mountInternalAdminRoutes(app);
    mountInternalAdminPortal(app);
    app.listen(PORT, '0.0.0.0', () =>
        console.log(
            `🚀 Collector live on :${PORT} | warehouse: ${WAREHOUSE_PATH} | max ${WAREHOUSE_MAX_BYTES}B | summary last ${SUMMARY_MAX_LINES} lines` +
                (tenantContext ? ' | v1 DB ingest on' : '')
        )
    );
}

start().catch((e) => {
    console.error(e);
    process.exit(1);
});
