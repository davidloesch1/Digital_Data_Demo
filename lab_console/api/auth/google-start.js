/**
 * GET /api/auth/google-start?next=/dashboard.html — redirects to Google OAuth (requires GOOGLE_CLIENT_ID, CONSOLE_PUBLIC_URL).
 */
const crypto = require('crypto');

function cookieSecureFlag() {
    return process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
}

module.exports = async function handler(req, res) {
    if (req.method !== 'GET') {
        res.status(405).send('Method not allowed');
        return;
    }
    const clientId = process.env.GOOGLE_CLIENT_ID || '';
    const publicUrl = (process.env.CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!clientId || !publicUrl) {
        res.status(503).send(
            'Google sign-in is not configured (set GOOGLE_CLIENT_ID and CONSOLE_PUBLIC_URL on Vercel).'
        );
        return;
    }
    const rawNext =
        req.query && req.query.next !== undefined && req.query.next !== null
            ? String(req.query.next)
            : '/dashboard.html';
    const next =
        typeof rawNext === 'string' && rawNext.startsWith('/') && !rawNext.startsWith('//')
            ? rawNext
            : '/dashboard.html';

    const state = crypto.randomBytes(24).toString('base64url');
    const secure = cookieSecureFlag();
    const stateCookie = [
        'nexus_google_oauth_state=' + encodeURIComponent(state),
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=600',
    ];
    const nextCookie = [
        'nexus_oauth_next=' + encodeURIComponent(next),
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        'Max-Age=600',
    ];
    if (secure) {
        stateCookie.splice(3, 0, 'Secure');
        nextCookie.splice(3, 0, 'Secure');
    }
    res.setHeader('Set-Cookie', [stateCookie.join('; '), nextCookie.join('; ')]);

    const redirectUri = publicUrl + '/api/auth/google-callback';
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'online');
    url.searchParams.set('prompt', 'select_account');
    res.redirect(302, url.toString());
};
