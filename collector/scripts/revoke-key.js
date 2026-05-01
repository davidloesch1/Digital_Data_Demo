#!/usr/bin/env node
/**
 * Revoke a publishable key by plaintext (same value clients send as Bearer).
 *
 *   DATABASE_URL=... PUBLISHABLE_KEY_PEPPER=... npm run revoke-key -- <nx_pub_...>
 */
const { Pool } = require('pg');
const path = require('path');
const { revokePublishableKey } = require(path.join(__dirname, '..', 'tenant-db.js'));

async function main() {
    const databaseUrl = process.env.DATABASE_URL;
    const pepper = process.env.PUBLISHABLE_KEY_PEPPER;
    const rawKey = process.argv[2];

    if (!databaseUrl || !pepper) {
        console.error('Set DATABASE_URL and PUBLISHABLE_KEY_PEPPER.');
        process.exit(1);
    }
    if (!rawKey || String(rawKey).trim() === '') {
        console.error('Usage: npm run revoke-key -- <nx_pub_...>');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
        const n = await revokePublishableKey(pool, pepper, String(rawKey).trim());
        if (n > 0) {
            console.log(`Revoked ${n} active key row(s).`);
        } else {
            console.log('No matching active key (already revoked or unknown key).');
        }
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
