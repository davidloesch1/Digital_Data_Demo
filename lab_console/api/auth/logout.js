/**
 * GET /api/auth/logout — clear session cookie
 */
module.exports = async function handler(req, res) {
    var secure = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
    var cookie =
        'nexus_console_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : '');
    res.setHeader('Set-Cookie', cookie);
    res.redirect(302, '/login.html');
};
