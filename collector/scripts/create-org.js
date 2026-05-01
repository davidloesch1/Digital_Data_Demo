#!/usr/bin/env node
/**
 * Provision an organization + publishable key (prints key once).
 *
 *   DATABASE_URL=... PUBLISHABLE_KEY_PEPPER=... npm run create-org -- <slug> [name]
 *
 * Same PUBLISHABLE_KEY_PEPPER must be used by the collector when verifying keys.
 */
const { Pool } = require('pg');
const path = require('path');
const { provisionOrgAndPublishableKey } = require(path.join(__dirname, '..', 'tenant-db.js'));

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
        console.error('Usage: npm run create-org -- <slug> [display-name]');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
        const { orgSlug, plainKey, createdOrg } = await provisionOrgAndPublishableKey(
            pool,
            String(slug).trim(),
            typeof name === 'string' ? name.trim() : slug,
            pepper,
            'cli-created'
        );
        console.log('');
        console.log(
            createdOrg ? 'Created organization:' : 'Organization slug already exists; added key for:',
            orgSlug
        );
        console.log('');
        console.log('Publishable key (store securely; shown once):');
        console.log(plainKey);
        console.log('');
        console.log('Send as header on ingest/summary:');
        console.log('  Authorization: Bearer ' + plainKey);
        console.log('or: X-Nexus-Publishable-Key: ' + plainKey);
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
