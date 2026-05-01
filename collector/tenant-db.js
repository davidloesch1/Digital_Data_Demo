/**
 * Multi-tenant Postgres: orgs, publishable keys (hashed), behavior_events (JSONB payloads).
 * Used when DATABASE_URL and PUBLISHABLE_KEY_PEPPER are set.
 */
const crypto = require('crypto');
const { Pool } = require('pg');

const KEY_PREFIX_LEN = 16;

function hashPublishableKey(pepper, rawKey) {
    return crypto.createHash('sha256').update(pepper + rawKey, 'utf8').digest('hex');
}

function publishableKeyPrefix(rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return '';
    return rawKey.length <= KEY_PREFIX_LEN ? rawKey : rawKey.slice(0, KEY_PREFIX_LEN);
}

/**
 * @param {import('pg').Pool | import('pg').Client} client
 */
async function ensureSchema(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS organizations (
            id UUID PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS publishable_keys (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            key_prefix TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            label TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            revoked_at TIMESTAMPTZ
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_publishable_keys_prefix_active
        ON publishable_keys (key_prefix)
        WHERE revoked_at IS NULL;
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS behavior_events (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            payload JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_behavior_events_org_created
        ON behavior_events (org_id, created_at DESC);
    `);
}

/**
 * @param {string} databaseUrl
 * @param {string} pepper
 * @returns {Promise<{ pool: import('pg').Pool; pepper: string }>}
 */
async function createPoolAndMigrate(databaseUrl, pepper) {
    if (!pepper || String(pepper).trim() === '') {
        throw new Error('PUBLISHABLE_KEY_PEPPER must be set when DATABASE_URL is configured');
    }
    const pool = new Pool({ connectionString: databaseUrl, max: 10 });
    const client = await pool.connect();
    try {
        await ensureSchema(client);
    } finally {
        client.release();
    }
    return { pool, pepper };
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} pepper
 * @param {string} rawKey
 * @returns {Promise<{ orgId: string; orgSlug: string } | null>}
 */
async function resolvePublishableKey(pool, pepper, rawKey) {
    if (!rawKey) return null;
    const prefix = publishableKeyPrefix(rawKey);
    const hash = hashPublishableKey(pepper, rawKey);
    const { rows } = await pool.query(
        `SELECT pk.key_hash, pk.org_id, o.slug
         FROM publishable_keys pk
         INNER JOIN organizations o ON o.id = pk.org_id
         WHERE pk.key_prefix = $1 AND pk.revoked_at IS NULL`,
        [prefix]
    );
    const hashBuf = Buffer.from(hash, 'hex');
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        try {
            const stored = Buffer.from(row.key_hash, 'hex');
            if (stored.length === hashBuf.length && crypto.timingSafeEqual(stored, hashBuf)) {
                return { orgId: row.org_id, orgSlug: row.slug };
            }
        } catch {
            /* invalid hex in DB */
        }
    }
    return null;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {object} payload
 */
async function insertBehaviorEvent(pool, orgIdUuid, payload) {
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO behavior_events (id, org_id, payload) VALUES ($1, $2, $3::jsonb)`,
        [id, orgIdUuid, JSON.stringify(payload)]
    );
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function fetchRecentPayloads(pool, orgIdUuid, limit) {
    const { rows } = await pool.query(
        `SELECT payload FROM behavior_events
         WHERE org_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [orgIdUuid, limit]
    );
    return rows.map((r) => r.payload).reverse();
}

/**
 * Remove up to `maxDelete` most recent events for this org matching payload.session_url (legacy /discard parity).
 * @returns {Promise<number>} rows deleted
 */
async function deleteRecentEventsBySessionUrl(pool, orgIdUuid, sessionUrl, maxDelete) {
    const lim = Math.max(1, Math.min(100, Number(maxDelete) || 20));
    const { rowCount } = await pool.query(
        `DELETE FROM behavior_events
         WHERE id IN (
           SELECT id FROM (
             SELECT id FROM behavior_events
             WHERE org_id = $1 AND payload->>'session_url' = $2
             ORDER BY created_at DESC
             LIMIT $3
           ) AS del
         )`,
        [orgIdUuid, sessionUrl, lim]
    );
    return rowCount || 0;
}

/**
 * Create org if missing (by slug) and insert a new publishable key row.
 * @returns {{ orgId: string; orgSlug: string; plainKey: string; createdOrg: boolean }}
 */
async function provisionOrgAndPublishableKey(pool, slug, displayName, pepper, keyLabel) {
    const label = keyLabel && String(keyLabel).trim() !== '' ? String(keyLabel).trim() : 'provisioned';
    const name = displayName && String(displayName).trim() !== '' ? String(displayName).trim() : slug;
    const client = await pool.connect();
    try {
        await ensureSchema(client);
        const existing = await client.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
        let orgId;
        let createdOrg = false;
        if (existing.rows.length) {
            orgId = existing.rows[0].id;
        } else {
            createdOrg = true;
            orgId = crypto.randomUUID();
            await client.query(`INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`, [
                orgId,
                slug,
                name,
            ]);
        }
        const raw = crypto.randomBytes(24).toString('base64url');
        const plainKey = `nx_pub_${raw}`;
        const keyId = crypto.randomUUID();
        const prefix = publishableKeyPrefix(plainKey);
        const keyHash = hashPublishableKey(pepper, plainKey);
        await client.query(
            `INSERT INTO publishable_keys (id, org_id, key_prefix, key_hash, label)
             VALUES ($1, $2, $3, $4, $5)`,
            [keyId, orgId, prefix, keyHash, label]
        );
        return { orgId, orgSlug: slug, plainKey, createdOrg };
    } finally {
        client.release();
    }
}

/**
 * Revoke key matching plaintext (prefix + hash). Returns number of rows updated (0 or 1).
 */
async function revokePublishableKey(pool, pepper, rawKey) {
    if (!rawKey || typeof rawKey !== 'string') return 0;
    const trimmed = rawKey.trim();
    if (!trimmed) return 0;
    const prefix = publishableKeyPrefix(trimmed);
    const hash = hashPublishableKey(pepper, trimmed);
    const { rowCount } = await pool.query(
        `UPDATE publishable_keys SET revoked_at = now()
         WHERE key_prefix = $1 AND key_hash = $2 AND revoked_at IS NULL`,
        [prefix, hash]
    );
    return rowCount || 0;
}

module.exports = {
    KEY_PREFIX_LEN,
    hashPublishableKey,
    publishableKeyPrefix,
    ensureSchema,
    createPoolAndMigrate,
    resolvePublishableKey,
    insertBehaviorEvent,
    fetchRecentPayloads,
    deleteRecentEventsBySessionUrl,
    provisionOrgAndPublishableKey,
    revokePublishableKey,
};
