/**
 * GET /api/auth/google-callback — OAuth code exchange, collector session JWT, session cookie.
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

function clearCookie(name, secure) {
    const p = [name + '=deleted', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (secure) p.splice(3, 0, 'Secure');
    return p.join('; ');
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).send('Method not allowed');
        return;
    }
    const secure = cookieSecureFlag();
    const errUrl = (code) => '/login.html?err=' + encodeURIComponent(code);

    const q = req.query || {};
    if (q.error) {
        res.setHeader('Set-Cookie', [
            clearCookie('nexus_google_oauth_state', secure),
            clearCookie('nexus_oauth_next', secure),
        ]);
        res.redirect(302, errUrl('google_denied'));
        return;
    }

    const code = q.code != null ? String(q.code) : '';
    const state = q.state != null ? String(q.state) : '';
    const cookieState = parseCookie(req.headers.cookie, 'nexus_google_oauth_state');
    const rawNext = parseCookie(req.headers.cookie, 'nexus_oauth_next');
    const next =
        rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
            ? rawNext
            : '/dashboard.html';

    if (!code || !state || !cookieState || state !== cookieState) {
        res.setHeader('Set-Cookie', [
            clearCookie('nexus_google_oauth_state', secure),
            clearCookie('nexus_oauth_next', secure),
        ]);
        res.redirect(302, errUrl('google_state'));
        return;
    }

    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET || '';
    const publicUrl = (process.env.CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '');
    const collector = (process.env.NEXUS_COLLECTOR_ORIGIN || '').replace(/\/+$/, '');
    const bffSecret = process.env.CONSOLE_BFF_SECRET || '';

    if (!clientId || !clientSecret || !publicUrl || !collector || !bffSecret) {
        res.setHeader('Set-Cookie', [
            clearCookie('nexus_google_oauth_state', secure),
            clearCookie('nexus_oauth_next', secure),
        ]);
        res.redirect(302, errUrl('server_config'));
        return;
    }

    const redirectUri = publicUrl + '/api/auth/google-callback';
    let accessToken;
    try {
        const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                code,
                client_id: clientId,
                client_secret: clientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code',
            }).toString(),
        });
        const tokenJson = await tokenRes.json();
        if (!tokenRes.ok || !tokenJson.access_token) {
            console.error('google token:', tokenRes.status, tokenJson);
            res.setHeader('Set-Cookie', [
                clearCookie('nexus_google_oauth_state', secure),
                clearCookie('nexus_oauth_next', secure),
            ]);
            res.redirect(302, errUrl('google_token'));
            return;
        }
        accessToken = tokenJson.access_token;
    } catch (e) {
        console.error('google token fetch:', e);
        res.setHeader('Set-Cookie', [
            clearCookie('nexus_google_oauth_state', secure),
            clearCookie('nexus_oauth_next', secure),
        ]);
        res.redirect(302, errUrl('collector_unreachable'));
        return;
    }

    let email = '';
    try {
        const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
            headers: { Authorization: 'Bearer ' + accessToken },
        });
        const info = await ui.json();
        if (!ui.ok || !info.email || !info.email_verified) {
            console.error('google userinfo:', ui.status, info);
            res.setHeader('Set-Cookie', [
                clearCookie('nexus_google_oauth_state', secure),
                clearCookie('nexus_oauth_next', secure),
            ]);
            res.redirect(302, errUrl('google_email'));
            return;
        }
        email = String(info.email).trim().toLowerCase();
    } catch (e) {
        console.error('google userinfo:', e);
        res.setHeader('Set-Cookie', [
            clearCookie('nexus_google_oauth_state', secure),
            clearCookie('nexus_oauth_next', secure),
        ]);
        res.redirect(302, errUrl('collector_unreachable'));
        return;
    }

    let jwt;
    let maxAge = 60 * 60 * 24 * 7;
    try {
        const mr = await fetch(collector + '/bff/v1/session-from-verified-email', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + bffSecret,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ email }),
        });
        const text = await mr.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = {};
        }
        if (mr.status === 403) {
            res.setHeader('Set-Cookie', [
                clearCookie('nexus_google_oauth_state', secure),
                clearCookie('nexus_oauth_next', secure),
            ]);
            res.redirect(302, errUrl('no_console_access'));
            return;
        }
        if (!mr.ok) {
            console.error('session-from-verified-email:', mr.status, text);
            res.setHeader('Set-Cookie', [
                clearCookie('nexus_google_oauth_state', secure),
                clearCookie('nexus_oauth_next', secure),
            ]);
            res.redirect(302, errUrl('bad_session'));
            return;
        }
        jwt = data.jwt;
        if (data.expires_in_sec && Number(data.expires_in_sec) > 0) {
            maxAge = Number(data.expires_in_sec);
        }
        if (!jwt) {
            res.setHeader('Set-Cookie', [
                clearCookie('nexus_google_oauth_state', secure),
                clearCookie('nexus_oauth_next', secure),
            ]);
            res.redirect(302, errUrl('bad_session'));
            return;
        }
    } catch (e) {
        console.error('google callback collector:', e);
        res.setHeader('Set-Cookie', [
            clearCookie('nexus_google_oauth_state', secure),
            clearCookie('nexus_oauth_next', secure),
        ]);
        res.redirect(302, errUrl('collector_unreachable'));
        return;
    }

    const sessionParts = [
        'nexus_console_session=' + encodeURIComponent(jwt),
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=' + maxAge,
    ];
    if (secure) sessionParts.splice(3, 0, 'Secure');
    res.setHeader('Set-Cookie', [
        sessionParts.join('; '),
        clearCookie('nexus_google_oauth_state', secure),
        clearCookie('nexus_oauth_next', secure),
    ]);
    res.redirect(302, next);
};
