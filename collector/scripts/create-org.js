#!/usr/bin/env node
/**
 * Provision an organization + publishable key (prints key once).
 *
 *   DATABASE_URL=... PUBLISHABLE_KEY_PEPPER=... node scripts/create-org.js <slug> [name]
 *
 * Same PUBLISHABLE_KEY_PEPPER must be used by the collector when verifying keys.
 */
const crypto = require('crypto');
const { Client } = require('pg');
const path = require('path');
const {
    ensureSchema,
    hashPublishableKey,
    publishableKeyPrefix,
} = require(path.join(__dirname, '..', 'tenant-db.js'));

function generatePublishableKey() {
    const raw = crypto.randomBytes(24).toString('base64url');
    return `nx_pub_${raw}`;
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL;
    const pepper = process.env.PUBLISHABLE_KEY_PEPPER;
    const slug = process.argv[2];
    const name = process.argv[3] || slug;

    if (!databaseUrl || !pepper) {
        console.error('Set DATABASE_URL and PUBLISHABLE_KEY_PEPPER.');
        process.exit(1);
    }
    if (!slug || String(slug).trim() === '') {
        console.error('Usage: node scripts/create-org.js <slug> [display-name]');
        process.exit(1);
    }

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
        await ensureSchema(client);

        const existing = await client.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
        let orgId;
        if (existing.rows.length) {
            orgId = existing.rows[0].id;
            console.log('Organization slug already exists; reusing:', slug, '→', orgId);
        } else {
            orgId = crypto.randomUUID();
            await client.query(
                `INSERT INTO organizations (id, slug, name) VALUES ($1, $2, $3)`,
                [orgId, slug, name]
            );
            console.log('Created organization:', slug, name, '→', orgId);
        }

        const plainKey = generatePublishableKey();
        const keyId = crypto.randomUUID();
        const prefix = publishableKeyPrefix(plainKey);
        const keyHash = hashPublishableKey(pepper, plainKey);

        await client.query(
            `INSERT INTO publishable_keys (id, org_id, key_prefix, key_hash, label)
             VALUES ($1, $2, $3, $4, $5)`,
            [keyId, orgId, prefix, keyHash, 'cli-created']
        );

        console.log('');
        console.log('Publishable key (store securely; shown once):');
        console.log(plainKey);
        console.log('');
        console.log('Send as header on ingest/summary:');
        console.log('  Authorization: Bearer ' + plainKey);
        console.log('or: X-Nexus-Publishable-Key: ' + plainKey);
    } finally {
        await client.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
