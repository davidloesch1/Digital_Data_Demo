#!/usr/bin/env node
/**
 * Phase 4 prototype: top-k cosine similarity between a 16-D candidate and rows in gold_standard_vectors.
 *
 *   cd collector
 *   export DATABASE_URL=postgresql://…
 *   node scripts/gold-nearest-neighbors.js --org-slug=myorg --top 5 --fp '[0.1,0.2,...16 numbers...]'
 *
 * Omit --fp to read one line of JSON array from stdin.
 */
'use strict';

const { Pool } = require('pg');

function parseArgs(argv) {
    const out = { orgSlug: '', top: 5, fp: null };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--org-slug' && argv[i + 1]) {
            out.orgSlug = String(argv[++i]).trim();
        } else if (a === '--top' && argv[i + 1]) {
            out.top = Math.max(1, Math.min(50, parseInt(String(argv[++i]), 10) || 5));
        } else if (a === '--fp' && argv[i + 1]) {
            out.fp = JSON.parse(String(argv[++i]));
        }
    }
    return out;
}

function norm16(v) {
    if (!Array.isArray(v) || v.length !== 16) {
        throw new Error('fingerprint must be a JSON array of 16 numbers');
    }
    const x = v.map((n) => Number(n));
    let s = 0;
    for (let i = 0; i < 16; i++) {
        if (!Number.isFinite(x[i])) throw new Error('non-finite fingerprint entry');
        s += x[i] * x[i];
    }
    const mag = Math.sqrt(s) || 1;
    return x.map((n) => n / mag);
}

function parseFpFromDb(row) {
    if (Array.isArray(row)) return row.map(Number);
    if (row && typeof row === 'object') {
        const keys = Object.keys(row).sort((a, b) => Number(a) - Number(b));
        const arr = [];
        for (let i = 0; i < keys.length; i++) arr.push(Number(row[keys[i]]));
        return arr;
    }
    return [];
}

function cosineToStored(candidateNorm, storedRaw) {
    const raw = parseFpFromDb(storedRaw);
    if (raw.length < 16) return -1;
    let s = 0;
    let dot = 0;
    for (let i = 0; i < 16; i++) {
        const b = Number(raw[i]);
        if (!Number.isFinite(b)) return -1;
        dot += candidateNorm[i] * b;
        s += b * b;
    }
    const mag = Math.sqrt(s) || 1;
    return dot / mag;
}

async function readStdinFp() {
    const chunks = [];
    for await (const ch of process.stdin) chunks.push(ch);
    const line = Buffer.concat(chunks).toString('utf8').trim();
    if (!line) throw new Error('stdin empty: pass JSON array of 16 numbers on one line');
    return JSON.parse(line);
}

async function main() {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
        console.error('Set DATABASE_URL.');
        process.exit(1);
    }
    const args = parseArgs(process.argv);
    if (!args.orgSlug) {
        console.error('Usage: node scripts/gold-nearest-neighbors.js --org-slug SLUG [--top 5] [--fp \'[...]\']');
        process.exit(1);
    }
    let fp = args.fp;
    if (!fp) {
        fp = await readStdinFp();
    }
    const cand = norm16(fp);

    const pool = new Pool({ connectionString: databaseUrl, max: 2 });
    try {
        const { rows: orgRows } = await pool.query(
            `SELECT id FROM organizations WHERE lower(trim(slug)) = lower(trim($1))`,
            [args.orgSlug]
        );
        if (!orgRows[0]) {
            console.error('Unknown org slug:', args.orgSlug);
            process.exit(1);
        }
        const orgId = orgRows[0].id;
        const { rows } = await pool.query(
            `SELECT id, label, fingerprint, created_at
             FROM gold_standard_vectors
             WHERE org_id = $1
             ORDER BY created_at DESC
             LIMIT 500`,
            [orgId]
        );
        const scored = rows
            .map((r) => ({
                id: r.id,
                label: r.label,
                score: cosineToStored(cand, r.fingerprint),
                created_at: r.created_at,
            }))
            .filter((r) => r.score >= 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, args.top);
        console.log(JSON.stringify({ org_slug: args.orgSlug, top_k: scored }, null, 2));
    } finally {
        await pool.end();
    }
}

main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
});
