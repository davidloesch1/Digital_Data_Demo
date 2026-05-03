/**
 * GET /api/session — returns console JWT claims (org switcher) via collector GET /bff/v1/session.
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

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
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
    try {
        const r = await fetch(collector + '/bff/v1/session', {
            headers: { Authorization: 'Bearer ' + jwt },
        });
        const text = await r.text();
        const ct = r.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);
        res.status(r.status).send(text);
    } catch (e) {
        console.error('api/session:', e);
        res.status(502).json({ error: 'Collector unreachable' });
    }
};
