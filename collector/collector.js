const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');
const tenantDbApi = require('./tenant-db.js');
const { mountConsoleBffRoutes } = require('./console-bff.js');
const { mountV1DashboardRoutes, addInternalDashboardRoutes } = require('./dashboard-routes.js');
const fsActivation = require('./fullstory-activation-proxy.js');

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

/** Public SDK snippet (same file as packages/browser/nexus-snippet.js — keep in sync). */
const sdkSnippetPath = path.join(__dirname, 'sdk', 'nexus-snippet.js');
app.get('/sdk/nexus-snippet.js', (_req, res) => {
    res.type('application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(sdkSnippetPath, (err) => {
        if (err) {
            console.error('sdk snippet sendFile:', err.message);
            res.status(404).type('text/plain').send('SDK snippet not found on server');
        }
    });
});

/** Root URL in browser — there is no HTML app here, only API routes. */
app.get('/', (_req, res) => {
    const body = {
        ok: true,
        service: 'nexus-collector',
        message: 'Use GET /health. Ingest: POST /v1/ingest; snippet runtime: GET /v1/config (or legacy POST /collect if enabled).',
        endpoints: {
            health: 'GET /health',
            sdk_snippet: 'GET /sdk/nexus-snippet.js',
            ingest_v1: 'POST /v1/ingest',
            config_v1: 'GET /v1/config',
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
            'GET /internal/v1/orgs | GET /internal/v1/master-summary | POST /internal/v1/orgs | GET|POST|DELETE /internal/v1/orgs/:slug/console-members | GET|PATCH /internal/v1/orgs/:slug/snippet-runtime-config | GET|POST /internal/v1/orgs/:slug/friction-context | GET|POST /internal/v1/orgs/:slug/gold-standard-vectors | POST /internal/v1/fullstory/generate-context | POST /internal/v1/keys/revoke';
    }
    if (tenantContext && process.env.CONSOLE_BFF_SECRET && String(process.env.CONSOLE_BFF_SECRET).trim() !== '') {
        body.console_bff =
            'POST /bff/v1/magic-token | POST /bff/v1/magic-redeem | GET /bff/v1/summary (Bearer JWT)';
    }
    if (tenantContext && envTruthy('ENABLE_LOCAL_MASTER_SUMMARY')) {
        body.local_master_summary =
            'GET /local/v1/master-summary — all orgs; loopback client or Bearer LOCAL_MASTER_SUMMARY_TOKEN';
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

function parseOptionalIsoDate(req, key) {
    const q = req.query && req.query[key];
    if (q === undefined || q === null || String(q).trim() === '') return null;
    const d = new Date(String(q));
    if (Number.isNaN(d.getTime())) return null;
    return d.toISOString();
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
    let behaviorRowId;
    try {
        behaviorRowId = await tenantDbApi.insertBehaviorEvent(tenantContext.pool, resolved.orgId, dnaPackage);
    } catch (e) {
        console.error('insertBehaviorEvent:', e);
        return res.status(500).json({ error: 'Storage error' });
    }
    try {
        const rec = await tenantDbApi.maybeRecordFrictionFromKineticIngest(
            tenantContext.pool,
            resolved.orgId,
            behaviorRowId,
            dnaPackage
        );
        if (rec) {
            console.log(`📌 v1/ingest | org=${resolved.orgSlug} | friction_context auto-recorded`);
        }
    } catch (e) {
        console.error('maybeRecordFrictionFromKineticIngest:', e.message || e);
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
    const since = parseOptionalIsoDate(req, 'since');
    const until = parseOptionalIsoDate(req, 'until');
    try {
        const data = await tenantDbApi.fetchRecentPayloads(
            tenantContext.pool,
            resolved.orgId,
            limit,
            since,
            until
        );
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

/** Org-scoped snippet runtime config (heuristics, flushMs). Same auth as /v1/ingest. */
app.get('/v1/config', async (req, res) => {
    if (!tenantContext) {
        return res.status(503).json({
            error: 'Multi-tenant config not configured',
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
    let heuristics = {};
    try {
        heuristics = await tenantDbApi.fetchSnippetRuntimeConfig(tenantContext.pool, resolved.orgId);
    } catch (e) {
        console.error('fetchSnippetRuntimeConfig:', e);
        return res.status(500).json({ error: 'Config read failed' });
    }
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.setHeader('X-Org-Slug', resolved.orgSlug);
    res.status(200).json({
        ok: true,
        org_slug: resolved.orgSlug,
        signal_schema_version: 1,
        heuristics,
    });
});

/** Raw CSV body for FullStory Event Stream imports (10 MB cap). */
const csvUploadMiddleware = bodyParser.text({
    limit: '10mb',
    type: (req) => {
        const ct = String(req.headers['content-type'] || '').toLowerCase();
        return ct.includes('text/csv') || ct.includes('application/csv') || ct === 'text/plain';
    },
});

mountV1DashboardRoutes(app, {
    tenantContext,
    tenantDbApi,
    extractPublishableKey,
    csvUploadMiddleware,
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

    addInternalDashboardRoutes(router, { tenantContext, tenantDbApi, csvUploadMiddleware });

    router.get('/orgs', async (_req, res) => {
        try {
            const orgs = await tenantDbApi.listOrganizations(tenantContext.pool);
            res.status(200).json({ orgs });
        } catch (e) {
            console.error('internal GET /orgs:', e.message || e);
            res.status(500).json({ error: 'List failed' });
        }
    });

    router.get('/orgs/:slug/console-members', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            const members = await tenantDbApi.listConsoleMembersForOrg(tenantContext.pool, org.id);
            res.status(200).json({ members });
        } catch (e) {
            console.error('internal GET console-members:', e.message || e);
            res.status(500).json({ error: 'List failed' });
        }
    });

    router.post('/orgs/:slug/console-members', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        const email = req.body && req.body.email;
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            await tenantDbApi.addConsoleMember(tenantContext.pool, org.id, email);
            res.status(201).json({ ok: true });
        } catch (e) {
            if (e && e.message === 'invalid_email') {
                return res.status(400).json({ error: 'Invalid email' });
            }
            if (e && e.code === '23505') {
                return res.status(409).json({ error: 'Email already listed' });
            }
            console.error('internal POST console-members:', e.message || e);
            res.status(500).json({ error: 'Add failed' });
        }
    });

    router.delete('/orgs/:slug/console-members', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        const email = req.body && req.body.email;
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            const n = await tenantDbApi.removeConsoleMember(tenantContext.pool, org.id, email);
            if (!n) {
                return res.status(404).json({ error: 'Email not in list' });
            }
            res.status(200).json({ ok: true });
        } catch (e) {
            console.error('internal DELETE console-members:', e.message || e);
            res.status(500).json({ error: 'Remove failed' });
        }
    });

    /** Read organizations.snippet_runtime_config (same JSON served by GET /v1/config). */
    router.get('/orgs/:slug/snippet-runtime-config', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            const cfg = await tenantDbApi.fetchSnippetRuntimeConfig(tenantContext.pool, org.id);
            res.status(200).json({ org_slug: org.slug, snippet_runtime_config: cfg });
        } catch (e) {
            console.error('internal GET snippet-runtime-config:', e.message || e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    /** JSON-merge into organizations.snippet_runtime_config (served by GET /v1/config). */
    router.patch('/orgs/:slug/snippet-runtime-config', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        const patch = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        if (!patch) {
            return res.status(400).json({ error: 'JSON object body required' });
        }
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            await tenantDbApi.mergeSnippetRuntimeConfig(tenantContext.pool, org.id, patch);
            res.status(200).json({ ok: true });
        } catch (e) {
            console.error('internal PATCH snippet-runtime-config:', e.message || e);
            res.status(500).json({ error: 'Update failed' });
        }
    });

    /** Append nexus_friction_context row (rolling window / high-friction snapshot). */
    router.post('/orgs/:slug/friction-context', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        if (!body) {
            return res.status(400).json({ error: 'JSON object body required' });
        }
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            const id = await tenantDbApi.insertNexusFrictionContext(tenantContext.pool, org.id, {
                session_url: body.session_url,
                window_json: body.window_json,
                friction_kinds: body.friction_kinds,
                behavior_event_id: body.behavior_event_id,
            });
            res.status(201).json({ ok: true, id });
        } catch (e) {
            if (e && e.code === 'EINVAL') {
                return res.status(400).json({ error: e.message || 'Invalid body' });
            }
            if (e && e.code === '23503') {
                return res.status(400).json({ error: 'behavior_event_id not found or wrong org' });
            }
            console.error('internal POST friction-context:', e.message || e);
            res.status(500).json({ error: 'Insert failed' });
        }
    });

    router.get('/orgs/:slug/friction-context', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        const limRaw = req.query && req.query.limit;
        const lim = Math.max(1, Math.min(500, parseInt(String(limRaw || '50'), 10) || 50));
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            const rows = await tenantDbApi.listNexusFrictionContext(tenantContext.pool, org.id, lim);
            res.setHeader('X-Friction-Limit', String(lim));
            res.setHeader('X-Friction-Rows', String(rows.length));
            res.status(200).json({ org_slug: org.slug, rows });
        } catch (e) {
            console.error('internal GET friction-context:', e.message || e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    /** Human-verified 16D kinetic fingerprints for Phase 4 centroids (NEXUS_PLAN). */
    router.post('/orgs/:slug/gold-standard-vectors', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
        if (!body) {
            return res.status(400).json({ error: 'JSON object body required' });
        }
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            const id = await tenantDbApi.insertGoldStandardVector(tenantContext.pool, org.id, {
                fingerprint: body.fingerprint,
                label: body.label,
                notes: body.notes,
                verified_by: body.verified_by,
                source_behavior_event_id: body.source_behavior_event_id,
                source_friction_context_id: body.source_friction_context_id,
            });
            res.status(201).json({ ok: true, id });
        } catch (e) {
            if (e && e.code === 'EINVAL') {
                return res.status(400).json({ error: e.message || 'Invalid body' });
            }
            if (e && e.code === '23503') {
                return res.status(400).json({ error: 'source_behavior_event_id or source_friction_context_id invalid' });
            }
            console.error('internal POST gold-standard-vectors:', e.message || e);
            res.status(500).json({ error: 'Insert failed' });
        }
    });

    router.get('/orgs/:slug/gold-standard-vectors', async (req, res) => {
        const slug = req.params && req.params.slug != null ? String(req.params.slug).trim() : '';
        if (!slug) {
            return res.status(400).json({ error: 'slug required' });
        }
        const limRaw = req.query && req.query.limit;
        const lim = Math.max(1, Math.min(500, parseInt(String(limRaw || '50'), 10) || 50));
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
            if (!org) {
                return res.status(404).json({ error: 'Unknown organization' });
            }
            const rows = await tenantDbApi.listGoldStandardVectors(tenantContext.pool, org.id, lim);
            res.setHeader('X-Gold-Limit', String(lim));
            res.setHeader('X-Gold-Rows', String(rows.length));
            res.status(200).json({ org_slug: org.slug, rows });
        } catch (e) {
            console.error('internal GET gold-standard-vectors:', e.message || e);
            res.status(500).json({ error: 'Read failed' });
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

    /**
     * Proxy to FullStory **Generate Context** (Sessions API v2). Requires `FULLSTORY_API_KEY` on the collector.
     * Body: `{ session_id?, session_url?, context?: { ... } }` — at least one of `session_id` or parseable `session_url`.
     */
    router.post('/fullstory/generate-context', async (req, res) => {
        if (!process.env.FULLSTORY_API_KEY || String(process.env.FULLSTORY_API_KEY).trim() === '') {
            return res.status(503).json({
                error: 'FULLSTORY_API_KEY not configured',
                hint: 'Set FullStory Operations API key (Admin/Architect) on the collector. See docs/FULLSTORY_ACTIVATION.md',
            });
        }
        const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
        const session_id = b.session_id;
        const session_url = b.session_url;
        const context = b.context;
        try {
            const fullstory = await fsActivation.generateContext({
                sessionId: session_id,
                sessionUrl: session_url,
                contextPayload: context,
            });
            res.status(200).json({ ok: true, fullstory });
        } catch (e) {
            if (e && e.code === 'EINVAL') {
                return res.status(400).json({ error: e.message });
            }
            if (e && e.code === 'NO_FS_KEY') {
                return res.status(503).json({ error: e.message });
            }
            const status = e && e.status >= 400 && e.status < 600 ? e.status : 502;
            console.error('internal POST fullstory/generate-context:', e.message || e);
            res.status(status).json({
                error: e.message || 'FullStory request failed',
                fullstory: e.body || null,
            });
        }
    });

    /** Same warehouse rows as GET /local/v1/master-summary; gated by INTERNAL_ADMIN_TOKEN (internal admin UI). */
    router.get('/master-summary', async (req, res) => {
        const limit = parseSummaryLimit(req);
        try {
            const since = parseOptionalIsoDate(req, 'since');
            const until = parseOptionalIsoDate(req, 'until');
            const orgSlug =
                req.query && req.query.org_slug != null ? String(req.query.org_slug).trim() : '';
            let data;
            if (orgSlug) {
                data = await tenantDbApi.fetchRecentPayloadsForOrg(
                    tenantContext.pool,
                    orgSlug,
                    limit,
                    since,
                    until
                );
                res.setHeader('X-Master-Summary', `org:${orgSlug}`);
            } else {
                data = await tenantDbApi.fetchRecentPayloadsAllOrgs(
                    tenantContext.pool,
                    limit,
                    since,
                    until
                );
                res.setHeader('X-Master-Summary', 'all-orgs');
            }
            res.setHeader('X-Summary-Line-Limit', String(limit));
            res.setHeader('X-Summary-Lines-Returned', String(data.length));
            res.status(200).json(data);
        } catch (e) {
            console.error('internal GET /master-summary:', e.message || e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    app.use('/internal/v1', router);
    console.log(
        'Collector: internal admin API at /internal/v1/orgs, GET /internal/v1/master-summary, /orgs/:slug/console-members, GET|PATCH /orgs/:slug/snippet-runtime-config, GET|POST /orgs/:slug/friction-context, GET|POST /orgs/:slug/gold-standard-vectors, POST /fullstory/generate-context, POST /keys/revoke (INTERNAL_ADMIN_TOKEN)'
    );
}

function isLoopbackRemoteAddress(addr) {
    const ip = String(addr || '').trim();
    return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** Local dev: cross-org warehouse read. Off unless ENABLE_LOCAL_MASTER_SUMMARY=1; loopback or Bearer LOCAL_MASTER_SUMMARY_TOKEN. */
function mountLocalMasterSummary(app) {
    if (!envTruthy('ENABLE_LOCAL_MASTER_SUMMARY') || !tenantContext) {
        return;
    }
    const optionalToken = process.env.LOCAL_MASTER_SUMMARY_TOKEN;
    const tokenConfigured = optionalToken && String(optionalToken).trim() !== '';

    function localMasterAuthOk(req) {
        if (tokenConfigured) {
            const auth = req.headers.authorization;
            if (auth && typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
                const presented = auth.slice(7).trim();
                const exp = String(optionalToken).trim();
                try {
                    const a = Buffer.from(presented, 'utf8');
                    const b = Buffer.from(exp, 'utf8');
                    if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
                        return true;
                    }
                } catch {
                    /* fall through */
                }
            }
        }
        return isLoopbackRemoteAddress(req.socket && req.socket.remoteAddress);
    }

    app.get('/local/v1/master-summary', async (req, res) => {
        if (!localMasterAuthOk(req)) {
            return res.status(403).json({
                error: 'Forbidden',
                hint: 'Enable ENABLE_LOCAL_MASTER_SUMMARY=1 and call from localhost, or set LOCAL_MASTER_SUMMARY_TOKEN and Authorization: Bearer …',
            });
        }
        const limit = parseSummaryLimit(req);
        const since = parseOptionalIsoDate(req, 'since');
        const until = parseOptionalIsoDate(req, 'until');
        const orgSlug =
            req.query && req.query.org_slug != null ? String(req.query.org_slug).trim() : '';
        try {
            let data;
            if (orgSlug) {
                data = await tenantDbApi.fetchRecentPayloadsForOrg(
                    tenantContext.pool,
                    orgSlug,
                    limit,
                    since,
                    until
                );
                res.setHeader('X-Master-Summary', `org:${orgSlug}`);
            } else {
                data = await tenantDbApi.fetchRecentPayloadsAllOrgs(
                    tenantContext.pool,
                    limit,
                    since,
                    until
                );
                res.setHeader('X-Master-Summary', 'all-orgs');
            }
            res.setHeader('X-Summary-Line-Limit', String(limit));
            res.setHeader('X-Summary-Lines-Returned', String(data.length));
            res.status(200).json(data);
        } catch (e) {
            console.error('local GET /master-summary:', e.message || e);
            res.status(500).send('Read Error');
        }
    });
    console.log(
        'Collector: GET /local/v1/master-summary (optional ?org_slug=…, ?since, ?until, ?limit; ENABLE_LOCAL_MASTER_SUMMARY — loopback or LOCAL_MASTER_SUMMARY_TOKEN)'
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
    const masterDashDir = path.join(adminDir, 'master-dash');
    /** Avoid 302 /internal/admin → /internal/admin/: proxies often normalize slashes the other way → redirect loops. */
    function sendAdminIndex(_req, res) {
        res.sendFile(adminIndex);
    }
    app.get('/internal/admin', sendAdminIndex);
    app.get('/internal/admin/', sendAdminIndex);
    /** Legacy entry point — no trailing slash so proxies that strip "/" do not loop with sendMasterDashIndex. */
    app.get(['/internal/admin/master-dashboard', '/internal/admin/master-dashboard/'], (_req, res) => {
        res.redirect(308, '/internal/admin/master-dash');
    });
    function sendMasterDashIndex(_req, res) {
        res.sendFile(path.join(masterDashDir, 'index.html'), (err) => {
            if (err) {
                console.error('internal admin master-dash index:', err.message);
                res.status(500).type('text/plain').send('Master dashboard bundle missing');
            }
        });
    }
    /** Serve HTML for both paths; avoid 308 to .../master-dash/ (Railway/proxies often normalize slashes → redirect loops). */
    app.get(['/internal/admin/master-dash', '/internal/admin/master-dash/'], sendMasterDashIndex);
    app.use('/internal/admin/master-dash', express.static(masterDashDir, { index: false }));
    app.use('/internal/admin', express.static(adminDir, { index: false }));
    console.log(
        'Collector: internal admin portal at GET /internal/admin, GET /internal/admin/master-dash (legacy /master-dashboard redirects here)'
    );
}

async function start() {
    if (process.env.DATABASE_URL) {
        try {
            tenantContext = await tenantDbApi.createPoolAndMigrate(
                process.env.DATABASE_URL,
                process.env.PUBLISHABLE_KEY_PEPPER || ''
            );
            console.log('Collector: multi-tenant Postgres enabled (/v1/ingest, GET /v1/config, /v1/summary, /v1/discard)');
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
    mountConsoleBffRoutes(app, {
        tenantDbApi,
        getTenantContext: () => tenantContext,
        parseSummaryLimit,
    });
    mountLocalMasterSummary(app);
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
