/**
 * POST /api/auth/magic-request — body: { orgSlug, email }
 * Mints token on collector (server secret) and sends magic link via Resend.
 */
async function sendResendMagicEmail(to, link) {
    const key = process.env.RESEND_API_KEY;
    const from = process.env.RESEND_FROM;
    if (!key || !from) {
        throw new Error('RESEND_API_KEY and RESEND_FROM must be set on Vercel');
    }
    const subject = process.env.RESEND_MAGIC_SUBJECT || 'Your Nexus Console login link';
    const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            Authorization: 'Bearer ' + key,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            from,
            to: [to],
            subject,
            html:
                '<p>Sign in to Nexus Console for your organization.</p>' +
                '<p><a href="' +
                link.replace(/"/g, '&quot;') +
                '">Open Nexus Console</a></p>' +
                '<p>This link expires in 15 minutes. If you did not request it, ignore this email.</p>',
        }),
    });
    if (!r.ok) {
        const t = await r.text();
        throw new Error(t || 'Resend ' + r.status);
    }
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
    const orgSlug = body.orgSlug != null ? String(body.orgSlug).trim() : '';
    const email = body.email != null ? String(body.email).trim().toLowerCase() : '';
    if (!orgSlug || !email) {
        res.status(400).json({ error: 'orgSlug and email required' });
        return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        res.status(400).json({ error: 'Invalid email' });
        return;
    }

    const collector = (process.env.NEXUS_COLLECTOR_ORIGIN || '').replace(/\/+$/, '');
    const bffSecret = process.env.CONSOLE_BFF_SECRET || '';
    const publicUrl = (process.env.CONSOLE_PUBLIC_URL || '').replace(/\/+$/, '');
    if (!collector || !bffSecret || !publicUrl) {
        res.status(503).json({ error: 'Console auth is not configured (collector URL / secrets)' });
        return;
    }

    let token;
    try {
        const mr = await fetch(collector + '/bff/v1/magic-token', {
            method: 'POST',
            headers: {
                Authorization: 'Bearer ' + bffSecret,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ org_slug: orgSlug, email }),
        });
        const text = await mr.text();
        let data = {};
        try {
            data = text ? JSON.parse(text) : {};
        } catch {
            data = { error: text };
        }
        if (!mr.ok) {
            res.status(mr.status === 404 ? 404 : 502).json({
                error: data.error || 'Could not create login token',
            });
            return;
        }
        token = data.token;
        if (!token) {
            res.status(502).json({ error: 'Invalid collector response' });
            return;
        }
    } catch (e) {
        console.error('magic-request collector:', e);
        res.status(502).json({ error: 'Collector unreachable' });
        return;
    }

    const next = body.next != null ? String(body.next) : '/dashboard.html';
    const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard.html';
    const link =
        publicUrl +
        '/api/auth/callback?token=' +
        encodeURIComponent(token) +
        '&next=' +
        encodeURIComponent(safeNext);

    try {
        await sendResendMagicEmail(email, link);
    } catch (e) {
        console.error('magic-request resend:', e);
        res.status(502).json({ error: 'Could not send email', detail: String(e.message || e) });
        return;
    }

    res.status(200).json({ ok: true });
};
