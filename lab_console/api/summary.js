/**
 * GET /api/summary — forwards session cookie JWT to collector GET /bff/v1/summary
 */
function parseCookie(header, name) {
    if (!header || typeof header !== 'string') return '';
    var cookies = header.split(';');
    var i;
    for (i = 0; i < cookies.length; i++) {
        var p = cookies[i].trim().split('=');
        if (p[0] === name) return decodeURIComponent(p.slice(1).join('='));
    }
    return '';
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).json({ error: 'Method not allowed' });
        return;
    }
    var jwt = parseCookie(req.headers.cookie, 'nexus_console_session');
    if (!jwt) {
        res.status(401).json({ error: 'Not authenticated' });
        return;
    }
    var collector = (process.env.NEXUS_COLLECTOR_ORIGIN || '').replace(/\/+$/, '');
    if (!collector) {
        res.status(503).json({ error: 'NEXUS_COLLECTOR_ORIGIN not configured' });
        return;
    }
    var limit =
        req.query && req.query.limit != null && String(req.query.limit).trim() !== ''
            ? String(req.query.limit).trim()
            : '';
    var q = limit ? '?limit=' + encodeURIComponent(limit) : '';
    try {
        var r = await fetch(collector + '/bff/v1/summary' + q, {
            headers: { Authorization: 'Bearer ' + jwt },
        });
        var text = await r.text();
        var ct = r.headers.get('content-type');
        if (ct) res.setHeader('Content-Type', ct);
        var xl = r.headers.get('x-summary-line-limit');
        var xr = r.headers.get('x-summary-lines-returned');
        var xo = r.headers.get('x-org-slug');
        if (xl) res.setHeader('X-Summary-Line-Limit', xl);
        if (xr) res.setHeader('X-Summary-Lines-Returned', xr);
        if (xo) res.setHeader('X-Org-Slug', xo);
        res.status(r.status).send(text);
    } catch (e) {
        console.error('api/summary:', e);
        res.status(502).json({ error: 'Collector unreachable' });
    }
};
