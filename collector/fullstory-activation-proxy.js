'use strict';

/**
 * Thin server-side proxy for FullStory **Sessions API v2 — Generate Context** (Anywhere: Activation).
 * @see https://developer.fullstory.com/server/sessions/generate-context/
 *
 * Auth: `Authorization: Basic {FULLSTORY_API_KEY}` per FullStory docs.
 *
 * Env:
 *   FULLSTORY_API_KEY — required for calls to succeed
 *   FULLSTORY_API_BASE — default `https://api.fullstory.com`
 *   FULLSTORY_CONTEXT_PATH_TEMPLATE — default `/v2/sessions/{sessionId}/context` (`{sessionId}` is URL-encoded)
 */

const https = require('https');
const { URL } = require('url');

function apiBase() {
    return (process.env.FULLSTORY_API_BASE || 'https://api.fullstory.com').replace(/\/$/, '');
}

function authHeader() {
    const k = process.env.FULLSTORY_API_KEY;
    if (!k || String(k).trim() === '') return null;
    return `Basic ${String(k).trim()}`;
}

/**
 * Best-effort session id from a replay / app URL (when callers pass session_url only).
 * @param {string} sessionUrl
 * @returns {string | null}
 */
function extractSessionIdMaybe(sessionUrl) {
    if (!sessionUrl || typeof sessionUrl !== 'string') return null;
    const m = sessionUrl.match(/\/session\/([^/?#]+)/i);
    if (m) {
        try {
            return decodeURIComponent(m[1]);
        } catch {
            return m[1];
        }
    }
    const m2 = sessionUrl.match(/\/replay\/([^/?#]+)/i);
    if (m2) {
        try {
            return decodeURIComponent(m2[1]);
        } catch {
            return m2[1];
        }
    }
    return null;
}

function buildContextPath(sessionIdRaw) {
    const encoded = encodeURIComponent(String(sessionIdRaw).trim());
    const tpl =
        process.env.FULLSTORY_CONTEXT_PATH_TEMPLATE || '/v2/sessions/{sessionId}/context';
    if (!tpl.includes('{sessionId}')) {
        throw new Error('FULLSTORY_CONTEXT_PATH_TEMPLATE must include {sessionId} placeholder');
    }
    const path = tpl.split('{sessionId}').join(encoded);
    return path.startsWith('/') ? path : `/${path}`;
}

/**
 * @param {{ method: string, pathname: string, body?: object }} opts
 * @returns {Promise<{ status: number, body: object }>}
 */
function httpsJsonRequest(opts) {
    const auth = authHeader();
    if (!auth) {
        const e = new Error('FULLSTORY_API_KEY not configured');
        e.code = 'NO_FS_KEY';
        return Promise.reject(e);
    }
    const u = new URL(opts.pathname, `${apiBase()}/`);
    const bodyStr =
        opts.body != null && opts.method !== 'GET' ? JSON.stringify(opts.body) : null;
    /** @type {import('http').OutgoingHttpHeaders} */
    const headers = {
        Authorization: auth,
        Accept: 'application/json',
    };
    if (bodyStr) headers['Content-Type'] = 'application/json';

    return new Promise((resolve, reject) => {
        const req = https.request(
            {
                hostname: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                method: opts.method,
                headers,
            },
            (res) => {
                let raw = '';
                res.on('data', (c) => {
                    raw += c;
                });
                res.on('end', () => {
                    let parsed = {};
                    if (raw) {
                        try {
                            parsed = JSON.parse(raw);
                        } catch {
                            parsed = { _parse_error: true, _raw: raw.slice(0, 8000) };
                        }
                    }
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({ status: res.statusCode, body: parsed });
                    } else {
                        const err = new Error(`FullStory HTTP ${res.statusCode}`);
                        err.status = res.statusCode;
                        err.body = parsed;
                        reject(err);
                    }
                });
            }
        );
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

/**
 * @param {{ sessionId?: string, sessionUrl?: string, contextPayload?: object }} args
 * @returns {Promise<object>} parsed JSON body from FullStory
 */
async function generateContext(args) {
    let sid = args.sessionId && String(args.sessionId).trim();
    if (!sid && args.sessionUrl) {
        sid = extractSessionIdMaybe(String(args.sessionUrl)) || '';
    }
    if (!sid) {
        const e = new Error('session_id or session_url required');
        e.code = 'EINVAL';
        throw e;
    }
    const path = buildContextPath(sid);
    const body =
        args.contextPayload && typeof args.contextPayload === 'object' && !Array.isArray(args.contextPayload)
            ? args.contextPayload
            : {};
    const { body: out } = await httpsJsonRequest({ method: 'POST', pathname: path, body });
    return out;
}

module.exports = {
    generateContext,
    extractSessionIdMaybe,
    authHeader,
};
