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
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_behavior_events_created_desc
        ON behavior_events (created_at DESC);
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS console_magic_tokens (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            email TEXT NOT NULL,
            token_hash TEXT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_console_magic_tokens_hash
        ON console_magic_tokens (token_hash);
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS console_org_members (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            email TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, email)
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_console_org_members_email
        ON console_org_members (lower(email));
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS behavior_clusters (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            description TEXT,
            color TEXT,
            centroid JSONB NOT NULL,
            match_threshold DOUBLE PRECISION NOT NULL DEFAULT 0.85,
            filters JSONB NOT NULL DEFAULT '{}'::jsonb,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_behavior_clusters_org_name_lower
        ON behavior_clusters (org_id, lower(name));
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_behavior_clusters_org ON behavior_clusters (org_id);
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS behavior_cluster_tags (
            id UUID PRIMARY KEY,
            cluster_id UUID NOT NULL REFERENCES behavior_clusters (id) ON DELETE CASCADE,
            tag_kind TEXT NOT NULL CHECK (tag_kind IN ('label_pattern', 'module', 'metric', 'note', 'fs_signal')),
            value TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_behavior_cluster_tags_cluster ON behavior_cluster_tags (cluster_id);
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS behavior_cohorts (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            cluster_id UUID REFERENCES behavior_clusters (id) ON DELETE SET NULL,
            name TEXT NOT NULL,
            visitor_keys TEXT[] NOT NULL DEFAULT '{}',
            filters JSONB NOT NULL DEFAULT '{}'::jsonb,
            snapshot_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            notes TEXT
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_behavior_cohorts_org ON behavior_cohorts (org_id);
    `);
    await client.query(`
        CREATE TABLE IF NOT EXISTS segmentation_assignments (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            visitor_key TEXT NOT NULL,
            vars JSONB NOT NULL DEFAULT '{}'::jsonb,
            source_cohort_id UUID REFERENCES behavior_cohorts (id) ON DELETE SET NULL,
            expires_at TIMESTAMPTZ,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, visitor_key)
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_segmentation_assignments_org_visitor
        ON segmentation_assignments (org_id, visitor_key);
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS fullstory_events (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            fs_session_id TEXT NOT NULL,
            fs_user_id TEXT,
            fs_indv_id TEXT,
            fs_page_id TEXT,
            event_type TEXT,
            event_sub_type TEXT,
            event_custom_name TEXT,
            event_target_text TEXT,
            event_target_selector TEXT,
            event_session_offset_ms INT,
            event_page_offset_ms INT,
            mod_frustrated BOOLEAN DEFAULT false,
            mod_dead BOOLEAN DEFAULT false,
            mod_error BOOLEAN DEFAULT false,
            mod_suspicious BOOLEAN DEFAULT false,
            page_url TEXT,
            page_device TEXT,
            page_browser TEXT,
            page_platform TEXT,
            page_max_scroll_depth_pct DOUBLE PRECISION,
            event_start TIMESTAMPTZ NOT NULL,
            session_start TIMESTAMPTZ,
            payload JSONB NOT NULL,
            ingest_hash TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            UNIQUE (org_id, ingest_hash)
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_fs_events_org_session ON fullstory_events (org_id, fs_session_id, event_start);
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_fs_events_org_user ON fullstory_events (org_id, fs_user_id, event_start);
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS fullstory_session_metrics (
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            fs_session_id TEXT NOT NULL,
            fs_user_id TEXT,
            first_event_at TIMESTAMPTZ NOT NULL,
            last_event_at TIMESTAMPTZ NOT NULL,
            duration_ms BIGINT,
            event_count INT,
            click_count INT,
            navigate_count INT,
            pageview_count INT,
            frustrated_count INT,
            dead_count INT,
            error_count INT,
            suspicious_count INT,
            max_scroll_depth_pct DOUBLE PRECISION,
            unique_urls INT,
            top_url TEXT,
            device TEXT,
            browser TEXT,
            metrics JSONB NOT NULL DEFAULT '{}'::jsonb,
            updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
            PRIMARY KEY (org_id, fs_session_id)
        );
    `);

    /** Relax tag_kind CHECK to allow fs_signal (existing deployments). */
    await client.query(`
        DO $$
        DECLARE r RECORD;
        BEGIN
            FOR r IN (
                SELECT conname FROM pg_constraint
                WHERE conrelid = 'behavior_cluster_tags'::regclass
                  AND contype = 'c'
                  AND pg_get_constraintdef(oid) LIKE '%tag_kind%'
            ) LOOP
                EXECUTE format('ALTER TABLE behavior_cluster_tags DROP CONSTRAINT IF EXISTS %I', r.conname);
            END LOOP;
        END $$;
    `);
    await client.query(`
        ALTER TABLE behavior_cluster_tags DROP CONSTRAINT IF EXISTS behavior_cluster_tags_tag_kind_check;
    `).catch(() => {});
    await client.query(`
        ALTER TABLE behavior_cluster_tags ADD CONSTRAINT behavior_cluster_tags_tag_kind_check
        CHECK (tag_kind IN ('label_pattern', 'module', 'metric', 'note', 'fs_signal'));
    `).catch(() => {});

    await client.query(`
        ALTER TABLE organizations ADD COLUMN IF NOT EXISTS snippet_runtime_config JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);

    await client.query(`
        CREATE TABLE IF NOT EXISTS nexus_friction_context (
            id UUID PRIMARY KEY,
            org_id UUID NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
            behavior_event_id UUID REFERENCES behavior_events (id) ON DELETE SET NULL,
            session_url TEXT NOT NULL,
            friction_kinds TEXT[] NOT NULL DEFAULT '{}',
            window_json JSONB NOT NULL,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        );
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS idx_nexus_friction_org_created
        ON nexus_friction_context (org_id, created_at DESC);
    `);
}

/** Normalize email for console allowlist (lowercase, trim). */
function normalizeConsoleEmail(raw) {
    return String(raw || '')
        .trim()
        .toLowerCase();
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
 * @returns {Promise<string>} new behavior_events row id
 */
async function insertBehaviorEvent(pool, orgIdUuid, payload) {
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO behavior_events (id, org_id, payload) VALUES ($1, $2, $3::jsonb)`,
        [id, orgIdUuid, JSON.stringify(payload)]
    );
    return id;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function fetchRecentPayloads(pool, orgIdUuid, limit, since, until) {
    const params = [orgIdUuid];
    let cond = 'org_id = $1';
    let p = 2;
    if (since) {
        cond += ` AND created_at >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND created_at <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT payload FROM behavior_events
         WHERE ${cond}
         ORDER BY created_at DESC
         LIMIT $${p}`,
        params
    );
    return rows.map((r) => r.payload).reverse();
}

/**
 * Recent payloads across all orgs (local master dashboard only). Newest-first query, returned chronological.
 * Adds `_master_org_id` / `_master_org_slug` for UI disambiguation.
 * @param {import('pg').Pool} pool
 * @param {number} limit
 * @returns {Promise<object[]>}
 */
async function fetchRecentPayloadsAllOrgs(pool, limit, since, until) {
    const params = [];
    let cond = '1=1';
    let p = 1;
    if (since) {
        cond += ` AND be.created_at >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND be.created_at <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT be.payload, o.id AS org_id, o.slug AS org_slug
         FROM behavior_events be
         INNER JOIN organizations o ON o.id = be.org_id
         WHERE ${cond}
         ORDER BY be.created_at DESC
         LIMIT $${p}`,
        params
    );
    return rows
        .map((r) => {
            const p = r.payload && typeof r.payload === 'object' ? { ...r.payload } : {};
            p._master_org_id = r.org_id;
            p._master_org_slug = r.org_slug;
            return p;
        })
        .reverse();
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
/**
 * @returns {Promise<Array<{ id: string; slug: string; name: string; created_at: Date }>>}
 */
async function listOrganizations(pool) {
    const { rows } = await pool.query(
        `SELECT id, slug, name, created_at FROM organizations ORDER BY created_at DESC`
    );
    return rows;
}

/** @returns {Promise<{ id: string; slug: string; snippet_runtime_config?: object } | null>} */
async function getOrganizationBySlug(pool, slug) {
    const s = String(slug || '').trim();
    if (!s) return null;
    const { rows } = await pool.query(
        `SELECT id, slug, snippet_runtime_config FROM organizations WHERE lower(slug) = lower($1) LIMIT 1`,
        [s]
    );
    return rows[0] || null;
}

/**
 * Org-scoped JSON for browser snippet (heuristic thresholds, flushMs, feature toggles).
 * Same keys as `window.NexusSnippet.heuristics` / `NEXUS_HEURISTICS` (see packages/browser README).
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @returns {Promise<Record<string, unknown>>}
 */
async function fetchSnippetRuntimeConfig(pool, orgIdUuid) {
    const { rows } = await pool.query(
        `SELECT snippet_runtime_config FROM organizations WHERE id = $1`,
        [orgIdUuid]
    );
    if (!rows.length) return {};
    const c = rows[0].snippet_runtime_config;
    return c && typeof c === 'object' && !Array.isArray(c) ? c : {};
}

/**
 * Shallow-merge `patch` into `organizations.snippet_runtime_config` (JSONB ||).
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {object} patch
 */
async function mergeSnippetRuntimeConfig(pool, orgIdUuid, patch) {
    const p = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
    await pool.query(
        `UPDATE organizations
         SET snippet_runtime_config = COALESCE(snippet_runtime_config, '{}'::jsonb) || $2::jsonb
         WHERE id = $1`,
        [orgIdUuid, JSON.stringify(p)]
    );
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Persist a high-friction rolling-window snapshot (NEXUS_PLAN Phase 2 contextual table).
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {{ session_url: string, window_json: object, friction_kinds?: string[], behavior_event_id?: string | null }} row
 * @returns {Promise<string>} new row id
 */
async function insertNexusFrictionContext(pool, orgIdUuid, row) {
    const sessionUrl = row.session_url && String(row.session_url).trim();
    if (!sessionUrl) {
        const e = new Error('session_url required');
        e.code = 'EINVAL';
        throw e;
    }
    const wj = row.window_json && typeof row.window_json === 'object' && !Array.isArray(row.window_json) ? row.window_json : {};
    const kinds = Array.isArray(row.friction_kinds)
        ? row.friction_kinds.map((k) => String(k)).filter((k) => k.length > 0 && k.length <= 64)
        : [];
    let beId = null;
    if (row.behavior_event_id && String(row.behavior_event_id).trim()) {
        const cand = String(row.behavior_event_id).trim();
        if (UUID_RE.test(cand)) beId = cand;
    }
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO nexus_friction_context (id, org_id, behavior_event_id, session_url, friction_kinds, window_json)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [id, orgIdUuid, beId, sessionUrl, kinds, JSON.stringify(wj)]
    );
    return id;
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {number} limit
 */
async function listNexusFrictionContext(pool, orgIdUuid, limit) {
    const lim = Math.max(1, Math.min(500, Number(limit) || 50));
    const { rows } = await pool.query(
        `SELECT id, behavior_event_id, session_url, friction_kinds, window_json, created_at
         FROM nexus_friction_context
         WHERE org_id = $1
         ORDER BY created_at DESC
         LIMIT $2`,
        [orgIdUuid, lim]
    );
    return rows;
}

/** Kinds in signal_buffer that trigger auto friction rows on ingest (Phase 2 contextual table). */
const AUTO_FRICTION_SIGNAL_KINDS = new Set(['CONFUSION', 'DWELL']);

function frictionKindsFromSignalBuffer(buffer) {
    if (!Array.isArray(buffer)) return [];
    const found = new Set();
    for (let i = 0; i < buffer.length; i++) {
        const e = buffer[i];
        if (e && typeof e === 'object' && typeof e.kind === 'string' && AUTO_FRICTION_SIGNAL_KINDS.has(e.kind)) {
            found.add(e.kind);
        }
    }
    return Array.from(found);
}

/**
 * If kinetic payload carries high-friction silent signals, append `nexus_friction_context`.
 * Set DISABLE_FRICTION_AUTOTRACK=1 on the collector to skip.
 * @returns {Promise<boolean>} true when a row was inserted
 */
async function maybeRecordFrictionFromKineticIngest(pool, orgIdUuid, behaviorEventId, payload) {
    if (!payload || typeof payload !== 'object') return false;
    const off = String(process.env.DISABLE_FRICTION_AUTOTRACK || '')
        .trim()
        .toLowerCase();
    if (off === '1' || off === 'true' || off === 'yes' || off === 'on') return false;
    if (payload.type !== 'kinetic') return false;
    const buf = payload.signal_buffer;
    const kinds = frictionKindsFromSignalBuffer(buf);
    if (kinds.length === 0) return false;
    const sessionUrl = payload.session_url && String(payload.session_url).trim();
    if (!sessionUrl) return false;
    const windowJson = {
        ingested_at: payload.server_timestamp || null,
        event_id: payload.event_id != null ? String(payload.event_id) : null,
        label: payload.label != null ? String(payload.label) : null,
        signal_schema_version:
            payload.signal_schema_version != null ? Number(payload.signal_schema_version) : null,
        signal_buffer: Array.isArray(buf) ? buf : [],
    };
    await insertNexusFrictionContext(pool, orgIdUuid, {
        session_url: sessionUrl,
        window_json: windowJson,
        friction_kinds: kinds,
        behavior_event_id: behaviorEventId,
    });
    return true;
}

/**
 * @returns {Promise<{ plainToken: string }>}
 */
async function createConsoleMagicToken(pool, orgId, email) {
    const plainToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = crypto.createHash('sha256').update(plainToken, 'utf8').digest('hex');
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO console_magic_tokens (id, org_id, email, token_hash, expires_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, orgId, email, tokenHash, expiresAt.toISOString()]
    );
    return { plainToken };
}

/**
 * @returns {Promise<{ org_id: string; email: string } | null>}
 */
async function consumeConsoleMagicToken(pool, plainToken) {
    if (!plainToken || typeof plainToken !== 'string') return null;
    const tokenHash = crypto.createHash('sha256').update(plainToken.trim(), 'utf8').digest('hex');
    const { rows } = await pool.query(
        `DELETE FROM console_magic_tokens
         WHERE token_hash = $1 AND expires_at > now()
         RETURNING org_id, email`,
        [tokenHash]
    );
    return rows[0] || null;
}

/**
 * If an org has zero console_org_members rows, any email may request magic links (legacy).
 * Once at least one member exists, only listed emails may log in for that org.
 */
async function countConsoleMembersForOrg(pool, orgIdUuid) {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS c FROM console_org_members WHERE org_id = $1`,
        [orgIdUuid]
    );
    return rows[0] ? rows[0].c : 0;
}

async function isConsoleEmailAllowedForOrg(pool, orgIdUuid, rawEmail) {
    const email = normalizeConsoleEmail(rawEmail);
    if (!email) return false;
    const n = await countConsoleMembersForOrg(pool, orgIdUuid);
    if (n === 0) return true;
    const { rows } = await pool.query(
        `SELECT 1 FROM console_org_members WHERE org_id = $1 AND email = $2 LIMIT 1`,
        [orgIdUuid, email]
    );
    return rows.length > 0;
}

/** @returns {Promise<Array<{ email: string, created_at: Date }>>} */
async function listConsoleMembersForOrg(pool, orgIdUuid) {
    const { rows } = await pool.query(
        `SELECT email, created_at FROM console_org_members
         WHERE org_id = $1 ORDER BY created_at ASC`,
        [orgIdUuid]
    );
    return rows;
}

async function addConsoleMember(pool, orgIdUuid, rawEmail) {
    const email = normalizeConsoleEmail(rawEmail);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        throw new Error('invalid_email');
    }
    const id = crypto.randomUUID();
    await pool.query(
        `INSERT INTO console_org_members (id, org_id, email) VALUES ($1, $2, $3)`,
        [id, orgIdUuid, email]
    );
}

async function removeConsoleMember(pool, orgIdUuid, rawEmail) {
    const email = normalizeConsoleEmail(rawEmail);
    if (!email) return 0;
    const { rowCount } = await pool.query(
        `DELETE FROM console_org_members WHERE org_id = $1 AND email = $2`,
        [orgIdUuid, email]
    );
    return rowCount || 0;
}

/** Orgs this email may access via console (Google / multi-org session). */
async function listOrgAccessForConsoleEmail(pool, rawEmail) {
    const email = normalizeConsoleEmail(rawEmail);
    if (!email) return [];
    const { rows } = await pool.query(
        `SELECT o.id, o.slug, o.name
         FROM console_org_members m
         INNER JOIN organizations o ON o.id = m.org_id
         WHERE m.email = $1
         ORDER BY o.slug ASC`,
        [email]
    );
    return rows;
}

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

function mapClusterRow(r) {
    if (!r) return null;
    return {
        id: r.id,
        org_id: r.org_id,
        name: r.name,
        description: r.description,
        color: r.color,
        centroid: r.centroid,
        match_threshold: r.match_threshold != null ? Number(r.match_threshold) : 0.85,
        filters: r.filters && typeof r.filters === 'object' ? r.filters : {},
        created_at: r.created_at,
        updated_at: r.updated_at,
        org_slug: r.org_slug || undefined,
        tags: Array.isArray(r.tags) ? r.tags : undefined,
    };
}

/**
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 */
async function listBehaviorClusters(pool, orgIdUuid) {
    const { rows } = await pool.query(
        `SELECT bc.*,
         COALESCE(
           (SELECT json_agg(json_build_object(
             'id', t.id, 'tag_kind', t.tag_kind, 'value', t.value, 'created_at', t.created_at
           ) ORDER BY t.created_at)
            FROM behavior_cluster_tags t WHERE t.cluster_id = bc.id),
           '[]'::json
         ) AS tags
         FROM behavior_clusters bc
         WHERE bc.org_id = $1
         ORDER BY bc.updated_at DESC`,
        [orgIdUuid]
    );
    return rows.map((r) => {
        const o = mapClusterRow(r);
        let tags = [];
        if (typeof r.tags === 'string') {
            try {
                tags = JSON.parse(r.tags);
            } catch {
                tags = [];
            }
        } else if (Array.isArray(r.tags)) {
            tags = r.tags;
        }
        o.tags = tags;
        return o;
    });
}

/**
 * All clusters with org slug (internal admin).
 * @param {import('pg').Pool} pool
 * @param {string | null} orgSlugFilter lower(trim) match or null for all
 */
async function listBehaviorClustersAllOrgs(pool, orgSlugFilter) {
    const params = [];
    let where = '';
    if (orgSlugFilter && String(orgSlugFilter).trim() !== '') {
        params.push(String(orgSlugFilter).trim().toLowerCase());
        where = 'WHERE lower(o.slug) = $1';
    }
    const { rows } = await pool.query(
        `SELECT bc.*, o.slug AS org_slug,
         COALESCE(
           (SELECT json_agg(json_build_object(
             'id', t.id, 'tag_kind', t.tag_kind, 'value', t.value, 'created_at', t.created_at
           ) ORDER BY t.created_at)
            FROM behavior_cluster_tags t WHERE t.cluster_id = bc.id),
           '[]'::json
         ) AS tags
         FROM behavior_clusters bc
         INNER JOIN organizations o ON o.id = bc.org_id
         ${where}
         ORDER BY o.slug ASC, bc.name ASC`,
        params
    );
    return rows.map((r) => {
        const o = mapClusterRow(r);
        let tags = [];
        if (r.tags && typeof r.tags === 'string') {
            try {
                tags = JSON.parse(r.tags);
            } catch {
                tags = [];
            }
        } else if (Array.isArray(r.tags)) {
            tags = r.tags;
        }
        o.tags = tags;
        return o;
    });
}

async function getBehaviorCluster(pool, orgIdUuid, clusterId) {
    const { rows } = await pool.query(
        `SELECT * FROM behavior_clusters WHERE id = $1 AND org_id = $2`,
        [clusterId, orgIdUuid]
    );
    return rows[0] ? mapClusterRow(rows[0]) : null;
}

async function createBehaviorCluster(pool, orgIdUuid, body) {
    const id = crypto.randomUUID();
    const name = body && body.name != null ? String(body.name).trim() : '';
    if (!name) throw new Error('name_required');
    const centroid = body && body.centroid != null ? body.centroid : null;
    if (!centroid) throw new Error('centroid_required');
    const description = body && body.description != null ? String(body.description) : null;
    const color = body && body.color != null ? String(body.color) : null;
    const matchThreshold =
        body && body.match_threshold != null ? Number(body.match_threshold) : 0.85;
    const filters = body && body.filters && typeof body.filters === 'object' ? body.filters : {};
    await pool.query(
        `INSERT INTO behavior_clusters (id, org_id, name, description, color, centroid, match_threshold, filters)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::jsonb)`,
        [
            id,
            orgIdUuid,
            name,
            description,
            color,
            JSON.stringify(centroid),
            matchThreshold,
            JSON.stringify(filters),
        ]
    );
    return getBehaviorCluster(pool, orgIdUuid, id);
}

async function updateBehaviorCluster(pool, orgIdUuid, clusterId, body) {
    const existing = await getBehaviorCluster(pool, orgIdUuid, clusterId);
    if (!existing) return null;
    const name = body && body.name != null ? String(body.name).trim() : existing.name;
    const description =
        body && body.description !== undefined ? body.description : existing.description;
    const color = body && body.color !== undefined ? body.color : existing.color;
    const centroid = body && body.centroid !== undefined ? body.centroid : existing.centroid;
    const matchThreshold =
        body && body.match_threshold !== undefined
            ? Number(body.match_threshold)
            : existing.match_threshold;
    const filters =
        body && body.filters !== undefined && typeof body.filters === 'object'
            ? body.filters
            : existing.filters;
    await pool.query(
        `UPDATE behavior_clusters SET
         name = $1, description = $2, color = $3, centroid = $4::jsonb,
         match_threshold = $5, filters = $6::jsonb, updated_at = now()
         WHERE id = $7 AND org_id = $8`,
        [
            name,
            description,
            color,
            JSON.stringify(centroid),
            matchThreshold,
            JSON.stringify(filters),
            clusterId,
            orgIdUuid,
        ]
    );
    return getBehaviorCluster(pool, orgIdUuid, clusterId);
}

async function deleteBehaviorCluster(pool, orgIdUuid, clusterId) {
    const { rowCount } = await pool.query(
        `DELETE FROM behavior_clusters WHERE id = $1 AND org_id = $2`,
        [clusterId, orgIdUuid]
    );
    return rowCount || 0;
}

async function addBehaviorClusterTag(pool, orgIdUuid, clusterId, tagKind, value) {
    const chk = await pool.query(
        `SELECT 1 FROM behavior_clusters WHERE id = $1 AND org_id = $2`,
        [clusterId, orgIdUuid]
    );
    if (!chk.rows.length) return null;
    const kind = ['label_pattern', 'module', 'metric', 'note', 'fs_signal'].includes(tagKind)
        ? tagKind
        : 'note';
    const id = crypto.randomUUID();
    const v = value != null ? String(value) : '';
    await pool.query(
        `INSERT INTO behavior_cluster_tags (id, cluster_id, tag_kind, value) VALUES ($1, $2, $3, $4)`,
        [id, clusterId, kind, v]
    );
    return { id, cluster_id: clusterId, tag_kind: kind, value: v };
}

async function deleteBehaviorClusterTag(pool, orgIdUuid, tagId) {
    const { rowCount } = await pool.query(
        `DELETE FROM behavior_cluster_tags t USING behavior_clusters bc
         WHERE t.id = $1 AND t.cluster_id = bc.id AND bc.org_id = $2`,
        [tagId, orgIdUuid]
    );
    return rowCount || 0;
}

async function createBehaviorCohort(pool, orgIdUuid, body) {
    const id = crypto.randomUUID();
    const name = body && body.name != null ? String(body.name).trim() : '';
    if (!name) throw new Error('name_required');
    const clusterId = body && body.cluster_id != null ? body.cluster_id : null;
    const visitorKeys = Array.isArray(body.visitor_keys)
        ? body.visitor_keys.map((k) => String(k).trim()).filter(Boolean)
        : [];
    const filters = body && body.filters && typeof body.filters === 'object' ? body.filters : {};
    const notes = body && body.notes != null ? String(body.notes) : null;
    if (clusterId) {
        const chk = await pool.query(
            `SELECT 1 FROM behavior_clusters WHERE id = $1 AND org_id = $2`,
            [clusterId, orgIdUuid]
        );
        if (!chk.rows.length) throw new Error('cluster_not_found');
    }
    await pool.query(
        `INSERT INTO behavior_cohorts (id, org_id, cluster_id, name, visitor_keys, filters, notes)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [id, orgIdUuid, clusterId, name, visitorKeys, JSON.stringify(filters), notes]
    );
    return getBehaviorCohort(pool, orgIdUuid, id);
}

async function getBehaviorCohort(pool, orgIdUuid, cohortId) {
    const { rows } = await pool.query(
        `SELECT * FROM behavior_cohorts WHERE id = $1 AND org_id = $2`,
        [cohortId, orgIdUuid]
    );
    if (!rows[0]) return null;
    const r = rows[0];
    return {
        id: r.id,
        org_id: r.org_id,
        cluster_id: r.cluster_id,
        name: r.name,
        visitor_keys: r.visitor_keys || [],
        filters: r.filters && typeof r.filters === 'object' ? r.filters : {},
        snapshot_at: r.snapshot_at,
        notes: r.notes,
    };
}

async function listBehaviorCohorts(pool, orgIdUuid) {
    const { rows } = await pool.query(
        `SELECT * FROM behavior_cohorts WHERE org_id = $1 ORDER BY snapshot_at DESC`,
        [orgIdUuid]
    );
    return rows.map((r) => ({
        id: r.id,
        org_id: r.org_id,
        cluster_id: r.cluster_id,
        name: r.name,
        visitor_keys: r.visitor_keys || [],
        filters: r.filters && typeof r.filters === 'object' ? r.filters : {},
        snapshot_at: r.snapshot_at,
        notes: r.notes,
    }));
}

/**
 * Merge vars into segmentation_assignments for each visitor in cohort.
 */
async function applyCohortSegmentationVars(pool, orgIdUuid, cohortId, vars) {
    const cohort = await getBehaviorCohort(pool, orgIdUuid, cohortId);
    if (!cohort) return { updated: 0 };
    if (!vars || typeof vars !== 'object') throw new Error('vars_required');
    const keys = cohort.visitor_keys || [];
    let n = 0;
    for (let i = 0; i < keys.length; i++) {
        const vk = keys[i];
        const id = crypto.randomUUID();
        await pool.query(
            `INSERT INTO segmentation_assignments (id, org_id, visitor_key, vars, source_cohort_id, updated_at)
             VALUES ($1, $2, $3, $4::jsonb, $5, now())
             ON CONFLICT (org_id, visitor_key) DO UPDATE SET
               vars = COALESCE(segmentation_assignments.vars, '{}'::jsonb) || EXCLUDED.vars,
               source_cohort_id = COALESCE(EXCLUDED.source_cohort_id, segmentation_assignments.source_cohort_id),
               updated_at = now()`,
            [id, orgIdUuid, vk, JSON.stringify(vars), cohortId]
        );
        n++;
    }
    return { updated: n };
}

async function getSegmentationManifestForVisitor(pool, orgIdUuid, visitorKey) {
    const vk = String(visitorKey || '').trim();
    if (!vk) return {};
    const { rows } = await pool.query(
        `SELECT vars, expires_at FROM segmentation_assignments
         WHERE org_id = $1 AND visitor_key = $2
         AND (expires_at IS NULL OR expires_at > now())`,
        [orgIdUuid, vk]
    );
    if (!rows.length) return {};
    const vars = rows[0].vars && typeof rows[0].vars === 'object' ? { ...rows[0].vars } : {};
    return vars;
}

/**
 * @param {string | null} sessionIdSubstr — substring to match in payload.session_url
 * @param {string | null} visitorKey — exact nexus_user_key
 */
async function searchBehaviorEvents(pool, orgIdUuid, opts) {
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 500));
    const since = opts.since || null;
    const until = opts.until || null;
    const sessionIdSubstr = opts.session_id_substr ? String(opts.session_id_substr).trim() : null;
    const visitorKey = opts.visitor_key ? String(opts.visitor_key).trim() : null;
    if (!sessionIdSubstr && !visitorKey) {
        throw new Error('session_or_visitor_required');
    }
    const params = [orgIdUuid];
    let p = 2;
    let cond = 'be.org_id = $1';
    if (since) {
        cond += ` AND be.created_at >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND be.created_at <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    if (sessionIdSubstr && visitorKey) {
        cond += ` AND (be.payload->>'session_url' ILIKE $${p} OR be.payload->>'nexus_user_key' = $${p + 1})`;
        params.push('%' + sessionIdSubstr.replace(/%/g, '\\%') + '%');
        params.push(visitorKey);
        p += 2;
    } else if (sessionIdSubstr) {
        cond += ` AND be.payload->>'session_url' ILIKE $${p}`;
        params.push('%' + sessionIdSubstr.replace(/%/g, '\\%') + '%');
        p++;
    } else {
        cond += ` AND be.payload->>'nexus_user_key' = $${p}`;
        params.push(visitorKey);
        p++;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT be.payload FROM behavior_events be
         WHERE ${cond}
         ORDER BY be.created_at DESC
         LIMIT $${p}`,
        params
    );
    return rows.map((r) => r.payload).reverse();
}

/** Cross-org search for internal admin; adds _master_org_id/slug to payloads. */
async function searchBehaviorEventsAllOrgs(pool, opts) {
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 500));
    const since = opts.since || null;
    const until = opts.until || null;
    const sessionIdSubstr = opts.session_id_substr ? String(opts.session_id_substr).trim() : null;
    const visitorKey = opts.visitor_key ? String(opts.visitor_key).trim() : null;
    const orgSlug = opts.org_slug ? String(opts.org_slug).trim().toLowerCase() : null;
    if (!sessionIdSubstr && !visitorKey) {
        throw new Error('session_or_visitor_required');
    }
    const params = [];
    let p = 1;
    const join = 'FROM behavior_events be INNER JOIN organizations o ON o.id = be.org_id';
    let cond = '1=1';
    if (orgSlug) {
        cond += ` AND lower(o.slug) = $${p}`;
        params.push(orgSlug);
        p++;
    }
    if (since) {
        cond += ` AND be.created_at >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND be.created_at <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    if (sessionIdSubstr && visitorKey) {
        cond += ` AND (be.payload->>'session_url' ILIKE $${p} OR be.payload->>'nexus_user_key' = $${p + 1})`;
        params.push('%' + sessionIdSubstr.replace(/%/g, '\\%') + '%');
        params.push(visitorKey);
        p += 2;
    } else if (sessionIdSubstr) {
        cond += ` AND be.payload->>'session_url' ILIKE $${p}`;
        params.push('%' + sessionIdSubstr.replace(/%/g, '\\%') + '%');
        p++;
    } else {
        cond += ` AND be.payload->>'nexus_user_key' = $${p}`;
        params.push(visitorKey);
        p++;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT be.payload, o.id AS org_id, o.slug AS org_slug
         ${join}
         WHERE ${cond}
         ORDER BY be.created_at DESC
         LIMIT $${p}`,
        params
    );
    return rows
        .map((r) => {
            const pl = r.payload && typeof r.payload === 'object' ? { ...r.payload } : {};
            pl._master_org_id = r.org_id;
            pl._master_org_slug = r.org_slug;
            return pl;
        })
        .reverse();
}

/**
 * @typedef {{
 *   fs_session_id: string,
 *   fs_user_id: string | null,
 *   fs_indv_id: string | null,
 *   fs_page_id: string | null,
 *   event_type: string | null,
 *   event_sub_type: string | null,
 *   event_custom_name: string | null,
 *   event_target_text: string | null,
 *   event_target_selector: string | null,
 *   event_session_offset_ms: number | null,
 *   event_page_offset_ms: number | null,
 *   mod_frustrated: boolean,
 *   mod_dead: boolean,
 *   mod_error: boolean,
 *   mod_suspicious: boolean,
 *   page_url: string | null,
 *   page_device: string | null,
 *   page_browser: string | null,
 *   page_platform: string | null,
 *   page_max_scroll_depth_pct: number | null,
 *   event_start: Date | string,
 *   session_start: Date | string | null,
 *   payload: object,
 *   ingest_hash: string,
 * }} FsInsertRow
 */

/**
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {FsInsertRow[]} rows
 * @returns {Promise<{ inserted: number, skipped: number, sessionIds: string[] }>}
 */
async function insertFullstoryEventsBatch(pool, orgIdUuid, rows) {
    if (!rows || !rows.length) return { inserted: 0, skipped: 0, sessionIds: [] };
    let inserted = 0;
    let skipped = 0;
    const sessions = new Set();
    let i;
    for (i = 0; i < rows.length; i++) {
        const r = rows[i];
        const id = crypto.randomUUID();
        try {
            const ins = await pool.query(
                `INSERT INTO fullstory_events (
                  id, org_id, fs_session_id, fs_user_id, fs_indv_id, fs_page_id,
                  event_type, event_sub_type, event_custom_name, event_target_text, event_target_selector,
                  event_session_offset_ms, event_page_offset_ms,
                  mod_frustrated, mod_dead, mod_error, mod_suspicious,
                  page_url, page_device, page_browser, page_platform, page_max_scroll_depth_pct,
                  event_start, session_start, payload, ingest_hash
                ) VALUES (
                  $1, $2, $3, $4, $5, $6,
                  $7, $8, $9, $10, $11,
                  $12, $13,
                  $14, $15, $16, $17,
                  $18, $19, $20, $21, $22,
                  $23::timestamptz, $24::timestamptz, $25::jsonb, $26
                )
                ON CONFLICT (org_id, ingest_hash) DO NOTHING
                RETURNING id, fs_session_id`,
                [
                    id,
                    orgIdUuid,
                    r.fs_session_id,
                    r.fs_user_id,
                    r.fs_indv_id,
                    r.fs_page_id,
                    r.event_type,
                    r.event_sub_type,
                    r.event_custom_name,
                    r.event_target_text,
                    r.event_target_selector,
                    r.event_session_offset_ms,
                    r.event_page_offset_ms,
                    r.mod_frustrated,
                    r.mod_dead,
                    r.mod_error,
                    r.mod_suspicious,
                    r.page_url,
                    r.page_device,
                    r.page_browser,
                    r.page_platform,
                    r.page_max_scroll_depth_pct,
                    r.event_start,
                    r.session_start,
                    JSON.stringify(r.payload || {}),
                    r.ingest_hash,
                ]
            );
            if (ins.rows.length) {
                inserted++;
                sessions.add(ins.rows[0].fs_session_id);
            } else {
                skipped++;
            }
        } catch (e) {
            skipped++;
            console.warn('insertFullstoryEventsBatch row skip:', e.message || e);
        }
    }
    return { inserted, skipped, sessionIds: [...sessions] };
}

/**
 * Recompute aggregates for given FS session ids (delete + insert).
 * @param {import('pg').Pool} pool
 * @param {string} orgIdUuid
 * @param {string[]} sessionIds
 */
async function recomputeFsSessionMetrics(pool, orgIdUuid, sessionIds) {
    const ids = (sessionIds || []).filter(Boolean);
    if (!ids.length) return;
    await pool.query(`DELETE FROM fullstory_session_metrics WHERE org_id = $1 AND fs_session_id = ANY($2::text[])`, [
        orgIdUuid,
        ids,
    ]);
    await pool.query(
        `INSERT INTO fullstory_session_metrics (
          org_id, fs_session_id, fs_user_id,
          first_event_at, last_event_at, duration_ms,
          event_count, click_count, navigate_count, pageview_count,
          frustrated_count, dead_count, error_count, suspicious_count,
          max_scroll_depth_pct, unique_urls, top_url, device, browser, metrics, updated_at
        )
        SELECT
          fe.org_id,
          fe.fs_session_id,
          (SELECT MAX(fs_user_id) FROM fullstory_events x WHERE x.org_id = fe.org_id AND x.fs_session_id = fe.fs_session_id),
          MIN(fe.event_start),
          MAX(fe.event_start),
          CAST(EXTRACT(EPOCH FROM (MAX(fe.event_start) - MIN(fe.event_start))) * 1000 AS BIGINT),
          COUNT(*)::int,
          SUM(CASE WHEN fe.event_type = 'click' THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN fe.event_type = 'navigate' THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN fe.event_type = 'pageview' THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN fe.mod_frustrated THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN fe.mod_dead THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN fe.mod_error THEN 1 ELSE 0 END)::int,
          SUM(CASE WHEN fe.mod_suspicious THEN 1 ELSE 0 END)::int,
          MAX(fe.page_max_scroll_depth_pct),
          COUNT(DISTINCT fe.page_url)::int,
          (
            SELECT fe2.page_url FROM fullstory_events fe2
            WHERE fe2.org_id = fe.org_id AND fe2.fs_session_id = fe.fs_session_id AND fe2.page_url IS NOT NULL AND fe2.page_url <> ''
            GROUP BY fe2.page_url
            ORDER BY COUNT(*) DESC
            LIMIT 1
          ),
          (SELECT MAX(page_device) FROM fullstory_events x WHERE x.org_id = fe.org_id AND x.fs_session_id = fe.fs_session_id),
          (SELECT MAX(page_browser) FROM fullstory_events x WHERE x.org_id = fe.org_id AND x.fs_session_id = fe.fs_session_id),
          jsonb_build_object(
            'click_rate', CASE WHEN COUNT(*) > 0 THEN ROUND(SUM(CASE WHEN fe.event_type = 'click' THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) ELSE 0 END,
            'frustrated_rate', CASE WHEN COUNT(*) > 0 THEN ROUND(SUM(CASE WHEN fe.mod_frustrated THEN 1 ELSE 0 END)::numeric / COUNT(*), 4) ELSE 0 END
          ),
          now()
        FROM fullstory_events fe
        WHERE fe.org_id = $1 AND fe.fs_session_id = ANY($2::text[])
        GROUP BY fe.org_id, fe.fs_session_id`,
        [orgIdUuid, ids]
    );
}

/**
 * @returns {Promise<object[]>} — plain rows for API / dashboard
 */
async function listFullstoryEvents(pool, orgIdUuid, opts) {
    const sessionId =
        opts.session_id != null && String(opts.session_id).trim() !== ''
            ? String(opts.session_id).trim()
            : opts.fs_session_id != null
              ? String(opts.fs_session_id).trim()
              : null;
    const sessionUrl =
        opts.session_url != null && String(opts.session_url).trim() !== ''
            ? String(opts.session_url).trim()
            : null;
    const sessionFromUrl = sessionUrl ? extractSessionIdFromFsUrlInternal(sessionUrl) : null;
    const sid = sessionId || sessionFromUrl;
    const visitorKey =
        opts.visitor_key != null && String(opts.visitor_key).trim() !== ''
            ? String(opts.visitor_key).trim()
            : null;
    const since = opts.since || null;
    const until = opts.until || null;
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 1000));
    if (!sid && !visitorKey) {
        throw new Error('session_or_visitor_required');
    }
    const params = [orgIdUuid];
    let p = 2;
    let cond = 'fe.org_id = $1';
    if (since) {
        cond += ` AND fe.event_start >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND fe.event_start <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    if (sid && visitorKey) {
        cond += ` AND (fe.fs_session_id = $${p} OR fe.fs_user_id = $${p + 1})`;
        params.push(sid, visitorKey);
        p += 2;
    } else if (sid) {
        cond += ` AND fe.fs_session_id = $${p}`;
        params.push(sid);
        p++;
    } else {
        cond += ` AND fe.fs_user_id = $${p}`;
        params.push(visitorKey);
        p++;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT fe.payload FROM fullstory_events fe
         WHERE ${cond}
         ORDER BY fe.event_start ASC
         LIMIT $${p}`,
        params
    );
    return rows.map((r) => r.payload);
}

function extractSessionIdFromFsUrlInternal(url) {
    if (!url || typeof url !== 'string') return null;
    const s = url.trim();
    if (!s) return null;
    try {
        const u = new URL(s);
        const parts = u.pathname.split('/').filter(Boolean);
        if (parts.length) return parts[parts.length - 1];
    } catch {
        /* fall through */
    }
    const parts = s.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : s;
}

async function listFullstoryEventsAllOrgs(pool, opts) {
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 1000));
    const since = opts.since || null;
    const until = opts.until || null;
    const orgSlug = opts.org_slug ? String(opts.org_slug).trim().toLowerCase() : null;
    const sessionId =
        opts.session_id != null && String(opts.session_id).trim() !== ''
            ? String(opts.session_id).trim()
            : null;
    const sessionUrl =
        opts.session_url != null && String(opts.session_url).trim() !== ''
            ? String(opts.session_url).trim()
            : null;
    const sid = sessionId || (sessionUrl ? extractSessionIdFromFsUrlInternal(sessionUrl) : null);
    const visitorKey =
        opts.visitor_key != null && String(opts.visitor_key).trim() !== ''
            ? String(opts.visitor_key).trim()
            : null;
    if (!sid && !visitorKey) {
        throw new Error('session_or_visitor_required');
    }
    const params = [];
    let p = 1;
    let cond = '1=1';
    const join = 'FROM fullstory_events fe INNER JOIN organizations o ON o.id = fe.org_id';
    if (orgSlug) {
        cond += ` AND lower(o.slug) = $${p}`;
        params.push(orgSlug);
        p++;
    }
    if (since) {
        cond += ` AND fe.event_start >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND fe.event_start <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    if (sid && visitorKey) {
        cond += ` AND (fe.fs_session_id = $${p} OR fe.fs_user_id = $${p + 1})`;
        params.push(sid, visitorKey);
        p += 2;
    } else if (sid) {
        cond += ` AND fe.fs_session_id = $${p}`;
        params.push(sid);
        p++;
    } else {
        cond += ` AND fe.fs_user_id = $${p}`;
        params.push(visitorKey);
        p++;
    }
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT fe.payload, o.id AS org_id, o.slug AS org_slug
         ${join}
         WHERE ${cond}
         ORDER BY fe.event_start ASC
         LIMIT $${p}`,
        params
    );
    return rows.map((r) => {
        const pl = r.payload && typeof r.payload === 'object' ? { ...r.payload } : {};
        pl._master_org_id = r.org_id;
        pl._master_org_slug = r.org_slug;
        return pl;
    });
}

async function listFullstorySessionMetrics(pool, orgIdUuid, opts) {
    const since = opts.since || null;
    const until = opts.until || null;
    const params = [orgIdUuid];
    let p = 2;
    let cond = 'org_id = $1';
    if (since) {
        cond += ` AND last_event_at >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND first_event_at <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 2000));
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT fs_session_id, fs_user_id, first_event_at, last_event_at, duration_ms,
                event_count, click_count, navigate_count, pageview_count,
                frustrated_count, dead_count, error_count, suspicious_count,
                max_scroll_depth_pct, unique_urls, top_url, device, browser, metrics
         FROM fullstory_session_metrics
         WHERE ${cond}
         ORDER BY last_event_at DESC
         LIMIT $${p}`,
        params
    );
    return rows;
}

async function getFullstorySessionMetricsByIds(pool, orgIdUuid, sessionIds) {
    const ids = (sessionIds || []).map((s) => String(s).trim()).filter(Boolean);
    if (!ids.length) return [];
    const { rows } = await pool.query(
        `SELECT fs_session_id, fs_user_id, first_event_at, last_event_at, duration_ms,
                event_count, click_count, navigate_count, pageview_count,
                frustrated_count, dead_count, error_count, suspicious_count,
                max_scroll_depth_pct, unique_urls, top_url, device, browser, metrics
         FROM fullstory_session_metrics
         WHERE org_id = $1 AND fs_session_id = ANY($2::text[])`,
        [orgIdUuid, ids]
    );
    return rows;
}

async function listFullstorySessionMetricsAllOrgs(pool, opts) {
    const since = opts.since || null;
    const until = opts.until || null;
    const orgSlug = opts.org_slug ? String(opts.org_slug).trim().toLowerCase() : null;
    const params = [];
    let p = 1;
    let cond = '1=1';
    const join = 'FROM fullstory_session_metrics m INNER JOIN organizations o ON o.id = m.org_id';
    if (orgSlug) {
        cond += ` AND lower(o.slug) = $${p}`;
        params.push(orgSlug);
        p++;
    }
    if (since) {
        cond += ` AND m.last_event_at >= $${p}::timestamptz`;
        params.push(since);
        p++;
    }
    if (until) {
        cond += ` AND m.first_event_at <= $${p}::timestamptz`;
        params.push(until);
        p++;
    }
    const limit = Math.max(1, Math.min(5000, Number(opts.limit) || 2000));
    params.push(limit);
    const { rows } = await pool.query(
        `SELECT m.fs_session_id, m.fs_user_id, m.first_event_at, m.last_event_at, m.duration_ms,
                m.event_count, m.click_count, m.navigate_count, m.pageview_count,
                m.frustrated_count, m.dead_count, m.error_count, m.suspicious_count,
                m.max_scroll_depth_pct, m.unique_urls, m.top_url, m.device, m.browser, m.metrics,
                o.slug AS org_slug
         ${join}
         WHERE ${cond}
         ORDER BY m.last_event_at DESC
         LIMIT $${p}`,
        params
    );
    return rows.map((r) => ({
        ...r,
        fs_session_id: r.fs_session_id,
        _master_org_slug: r.org_slug,
    }));
}

module.exports = {
    KEY_PREFIX_LEN,
    hashPublishableKey,
    publishableKeyPrefix,
    normalizeConsoleEmail,
    ensureSchema,
    createPoolAndMigrate,
    resolvePublishableKey,
    insertBehaviorEvent,
    maybeRecordFrictionFromKineticIngest,
    fetchRecentPayloads,
    fetchRecentPayloadsAllOrgs,
    deleteRecentEventsBySessionUrl,
    provisionOrgAndPublishableKey,
    revokePublishableKey,
    listOrganizations,
    getOrganizationBySlug,
    fetchSnippetRuntimeConfig,
    mergeSnippetRuntimeConfig,
    insertNexusFrictionContext,
    listNexusFrictionContext,
    createConsoleMagicToken,
    consumeConsoleMagicToken,
    countConsoleMembersForOrg,
    isConsoleEmailAllowedForOrg,
    listConsoleMembersForOrg,
    addConsoleMember,
    removeConsoleMember,
    listOrgAccessForConsoleEmail,
    listBehaviorClusters,
    listBehaviorClustersAllOrgs,
    getBehaviorCluster,
    createBehaviorCluster,
    updateBehaviorCluster,
    deleteBehaviorCluster,
    addBehaviorClusterTag,
    deleteBehaviorClusterTag,
    createBehaviorCohort,
    getBehaviorCohort,
    listBehaviorCohorts,
    applyCohortSegmentationVars,
    getSegmentationManifestForVisitor,
    searchBehaviorEvents,
    searchBehaviorEventsAllOrgs,
    insertFullstoryEventsBatch,
    recomputeFsSessionMetrics,
    listFullstoryEvents,
    listFullstoryEventsAllOrgs,
    listFullstorySessionMetrics,
    listFullstorySessionMetricsAllOrgs,
    getFullstorySessionMetricsByIds,
};
