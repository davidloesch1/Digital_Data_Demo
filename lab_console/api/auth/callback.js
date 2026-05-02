/**
 * GET /api/auth/callback?token=...&next=/dashboard.html
 * Redeems magic token on collector, sets HttpOnly session cookie, redirects.
 */
function cookieSecureFlag() {
    return process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).send('Method not allowed');
        return;
    }
    const token =
        req.query && req.query.token !== undefined && req.query.token !== null
            ? String(req.query.token)
            : '';
    const rawNext =
        req.query && req.query.next !== undefined && req.query.next !== null
            ? String(req.query.next)
            : '/dashboard.html';
    const next =
        typeof rawNext === 'string' && rawNext.startsWith('/') && !rawNext.startsWith('//')
            ? rawNext
            : '/dashboard.html';

    if (!token || typeof token !== 'string' || token.trim() === '') {
        res.redirect(302, '/login.html?err=' + encodeURIComponent('missing_token'));
        return;
    }

    const collector = (process.env.NEXUS_COLLECTOR_ORIGIN || '').replace(/\/+$/, '');
    const bffSecret = process.env.CONSOLE_BFF_SECRET || '';
    if (!collector || !bffSecret) {
        res.redirect(302, '/login.html?err=' + encodeURIComponent('server_config'));
        return;
    }

    let jwt;
    let maxAge = 60 * 60 * 24 * 7;
    try {
        const mr = await fetch(collector + '/bff/v1/magic-redeem', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + bffSecret,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ token: token.trim() }),
        });
        const text = await mr.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = {};
        }
        if (!mr.ok) {
            res.redirect(302, '/login.html?err=' + encodeURIComponent('invalid_or_expired'));
            return;
        }
        jwt = data.jwt;
        if (data.expires_in_sec && Number(data.expires_in_sec) > 0) {
            maxAge = Number(data.expires_in_sec);
        }
        if (!jwt) {
            res.redirect(302, '/login.html?err=' + encodeURIComponent('bad_session'));
            return;
        }
    } catch (e) {
        console.error('callback redeem:', e);
        res.redirect(302, '/login.html?err=' + encodeURIComponent('collector_unreachable'));
        return;
    }

    const secure = cookieSecureFlag();
    const parts = [
        'nexus_console_session=' + encodeURIComponent(jwt),
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=' + maxAge,
    ];
    if (secure) parts.splice(3, 0, 'Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
    res.redirect(302, next);
};
