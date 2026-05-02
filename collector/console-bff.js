/**
 * Server-to-server routes for Vercel console BFF: magic-link mint/redeem + JWT-backed summary.
 * Protected by CONSOLE_BFF_SECRET (Bearer). Session JWT signed with CONSOLE_JWT_SECRET.
 */
const express = require('express');
const crypto = require('crypto');
const { signJwt, verifyJwt } = require('./console-jwt.js');

function normalizeEmail(e) {
    return String(e || '')
        .trim()
        .toLowerCase();
}

function bffSecretOk(req, expected) {
    const auth = req.headers.authorization;
    if (!auth || typeof auth !== 'string' || !auth.toLowerCase().startsWith('bearer ')) return false;
    const presented = auth.slice(7).trim();
    const exp = String(expected || '').trim();
    if (!presented || !exp) return false;
    try {
        const a = Buffer.from(presented, 'utf8');
        const b = Buffer.from(exp, 'utf8');
        if (a.length !== b.length) return false;
        return crypto.timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

function jwtFromRequest(req) {
    const auth = req.headers.authorization;
    if (auth && typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
        const t = auth.slice(7).trim();
        if (t) return t;
    }
    return null;
}

/** @param {import('express').Express} app */
function mountConsoleBffRoutes(app, ctx) {
    const bffSecret = process.env.CONSOLE_BFF_SECRET;
    const jwtSecret = process.env.CONSOLE_JWT_SECRET || bffSecret;
    if (!bffSecret || String(bffSecret).trim() === '') {
        console.log('Collector: console BFF disabled (set CONSOLE_BFF_SECRET for Vercel magic-link flow)');
        return;
    }
    if (!jwtSecret || String(jwtSecret).trim() === '') {
        console.warn('Collector: CONSOLE_JWT_SECRET missing; using CONSOLE_BFF_SECRET for JWT signing');
    }

    const SESSION_TTL_SEC = Math.min(
        Math.max(60 * 60, parseInt(process.env.CONSOLE_SESSION_TTL_SEC || String(60 * 60 * 24 * 7), 10) || 604800),
        60 * 60 * 24 * 30
    );

    const router = express.Router();

    router.post('/magic-token', async (req, res) => {
        if (!bffSecretOk(req, bffSecret)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const tenantContext = ctx.getTenantContext();
        if (!tenantContext) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const orgSlug = req.body && req.body.org_slug;
        const email = normalizeEmail(req.body && req.body.email);
        if (!orgSlug || typeof orgSlug !== 'string' || String(orgSlug).trim() === '') {
            return res.status(400).json({ error: 'org_slug required' });
        }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'valid email required' });
        }
        let org;
        try {
            org = await ctx.tenantDbApi.getOrganizationBySlug(tenantContext.pool, String(orgSlug).trim());
        } catch (e) {
            console.error('bff magic-token:', e);
            return res.status(500).json({ error: 'Lookup failed' });
        }
        if (!org) {
            return res.status(404).json({ error: 'Unknown organization' });
        }
        try {
            const { plainToken } = await ctx.tenantDbApi.createConsoleMagicToken(
                tenantContext.pool,
                org.id,
                email
            );
            return res.status(201).json({ token: plainToken, org_slug: org.slug });
        } catch (e) {
            console.error('bff magic-token insert:', e);
            return res.status(500).json({ error: 'Token create failed' });
        }
    });

    router.post('/magic-redeem', async (req, res) => {
        if (!bffSecretOk(req, bffSecret)) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        const tenantContext = ctx.getTenantContext();
        if (!tenantContext) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const token = req.body && req.body.token;
        if (!token || typeof token !== 'string' || String(token).trim() === '') {
            return res.status(400).json({ error: 'token required' });
        }
        let row;
        try {
            row = await ctx.tenantDbApi.consumeConsoleMagicToken(tenantContext.pool, token.trim());
        } catch (e) {
            console.error('bff magic-redeem:', e);
            return res.status(500).json({ error: 'Redeem failed' });
        }
        if (!row) {
            return res.status(400).json({ error: 'Invalid or expired token' });
        }
        let slugRow;
        try {
            const r = await tenantContext.pool.query(`SELECT slug FROM organizations WHERE id = $1`, [row.org_id]);
            slugRow = r.rows[0];
        } catch (e) {
            console.error('bff magic-redeem slug:', e);
            return res.status(500).json({ error: 'Lookup failed' });
        }
        if (!slugRow) {
            return res.status(500).json({ error: 'Org missing' });
        }
        const jwt = signJwt(
            jwtSecret,
            {
                typ: 'nexus_console',
                org_id: row.org_id,
                org_slug: slugRow.slug,
                email: row.email,
            },
            SESSION_TTL_SEC
        );
        return res.status(200).json({
            jwt,
            expires_in_sec: SESSION_TTL_SEC,
            org_slug: slugRow.slug,
        });
    });

    router.get('/summary', async (req, res) => {
        const tenantContext = ctx.getTenantContext();
        if (!tenantContext) {
            return res.status(503).json({ error: 'Database not configured' });
        }
        const rawJwt = jwtFromRequest(req);
        if (!rawJwt) {
            return res.status(401).json({ error: 'Missing bearer token' });
        }
        const claims = verifyJwt(jwtSecret, rawJwt);
        if (!claims || !claims.org_id) {
            return res.status(401).json({ error: 'Invalid or expired session' });
        }
        const limit = ctx.parseSummaryLimit(req);
        try {
            const data = await ctx.tenantDbApi.fetchRecentPayloads(tenantContext.pool, claims.org_id, limit);
            res.setHeader('X-Summary-Line-Limit', String(limit));
            res.setHeader('X-Summary-Lines-Returned', String(data.length));
            if (claims.org_slug) res.setHeader('X-Org-Slug', String(claims.org_slug));
            res.status(200).json(data);
        } catch (e) {
            console.error('bff summary:', e);
            res.status(500).send('Read Error');
        }
    });

    app.use('/bff/v1', router);
    console.log(
        'Collector: console BFF at POST /bff/v1/magic-token, POST /bff/v1/magic-redeem, GET /bff/v1/summary (JWT)'
    );
}

module.exports = { mountConsoleBffRoutes };
