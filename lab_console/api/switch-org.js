/**
 * POST /api/switch-org — body { org_slug }; rotates session JWT via collector POST /bff/v1/switch-org.
 */
function parseCookie(header, name) {
    if (!header || typeof header !== 'string') return '';
    const cookies = header.split(';');
    for (let i = 0; i < cookies.length; i++) {
        const p = cookies[i].trim().split('=');
        if (p[0] === name) return decodeURIComponent(p.slice(1).join('='));
    }
    return '';
}

function cookieSecureFlag() {
    return process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
}

module.exports = async function handler(req, res) {
    if (req.method !== 'POST') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    let body = {};
    try {
        body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    } catch {
        res.status(400).json({ error: 'Invalid JSON' });
        return;
    }
    const orgSlug = body.org_slug != null ? String(body.org_slug).trim() : '';
    if (!orgSlug) {
        res.status(400).json({ error: 'org_slug required' });
        return;
    }
    const jwt = parseCookie(req.headers.cookie, 'nexus_console_session');
    if (!jwt) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    const collector = (process.env.NEXUS_COLLECTOR_ORIGIN || '').replace(/\/+$/, '');
    if (!collector) {
        res.status(503).json({ error: 'NEXUS_COLLECTOR_ORIGIN not configured' });
        return;
    }
    let newJwt;
    let maxAge = 60 * 60 * 24 * 7;
    try {
        const r = await fetch(collector + '/bff/v1/switch-org', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + jwt,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ org_slug: orgSlug }),
        });
        const text = await r.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = {};
        }
        if (!r.ok) {
            res.status(r.status === 401 || r.status === 403 ? r.status : 502).json({
                error: data.error || 'Switch failed',
            });
            return;
        }
        newJwt = data.jwt;
        if (data.expires_in_sec && Number(data.expires_in_sec) > 0) {
            maxAge = Number(data.expires_in_sec);
        }
        if (!newJwt) {
            res.status(502).json({ error: 'Invalid collector response' });
            return;
        }
    } catch (e) {
        console.error('api/switch-org:', e);
        res.status(502).json({ error: 'Collector unreachable' });
        return;
    }
    const secure = cookieSecureFlag();
    const parts = [
        'nexus_console_session=' + encodeURIComponent(newJwt),
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=' + maxAge,
    ];
    if (secure) parts.splice(3, 0, 'Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
    res.status(200).json({ ok: true });
};
