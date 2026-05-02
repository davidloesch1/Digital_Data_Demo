const crypto = require('crypto');

function signJwt(secret, payload, ttlSec) {
    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const body = { ...payload, iat: now, exp: now + ttlSec };
    const hB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const pB64 = Buffer.from(JSON.stringify(body)).toString('base64url');
    const sig = crypto.createHmac('sha256', secret).update(`${hB64}.${pB64}`).digest('base64url');
    return `${hB64}.${pB64}.${sig}`;
}

function verifyJwt(secret, tokenString) {
    if (!secret || !tokenString || typeof tokenString !== 'string') return null;
    const parts = tokenString.split('.');
    if (parts.length !== 3) return null;
    const [hB64, pB64, sigB64] = parts;
    const expectedSig = crypto.createHmac('sha256', secret).update(`${hB64}.${pB64}`).digest('base64url');
    try {
        const a = Buffer.from(expectedSig, 'utf8');
        const b = Buffer.from(sigB64, 'utf8');
        if (a.length !== b.length) return null;
        if (!crypto.timingSafeEqual(a, b)) return null;
    } catch {
        return null;
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(pB64, 'base64url').toString('utf8'));
    } catch {
        return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp !== undefined && payload.exp < now) return null;
    if (payload.typ !== 'nexus_console') return null;
    return payload;
}

module.exports = { signJwt, verifyJwt };
