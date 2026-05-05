#!/usr/bin/env node
/**
 * Smoke: POST /v1/ingest → GET friction → POST/GET gold-standard-vectors.
 *
 *   cd collector
 *   export NEXUS_BASE_URL=https://…
 *   export NEXUS_PUBLISHABLE_KEY=nx_pub_…
 *   export INTERNAL_ADMIN_TOKEN=…
 *   export ORG_SLUG=my-org
 *   npm run smoke-nexus
 */
'use strict';

async function main() {
    const base = String(process.env.NEXUS_BASE_URL || '').replace(/\/$/, '');
    const pub = process.env.NEXUS_PUBLISHABLE_KEY;
    const admin = process.env.INTERNAL_ADMIN_TOKEN;
    const slug = process.env.ORG_SLUG && String(process.env.ORG_SLUG).trim();

    if (!base || !pub || !admin || !slug) {
        console.error(
            'Set NEXUS_BASE_URL, NEXUS_PUBLISHABLE_KEY, INTERNAL_ADMIN_TOKEN, ORG_SLUG (see docs/SMOKE_NEXUS_STACK.md).'
        );
        process.exit(1);
    }

    const ingestBody = {
        type: 'kinetic',
        event_id: `smoke-${Date.now()}`,
        label: 'smoke_nexus_stack',
        session_url: 'https://app.fullstory.com/ui/session/smoke-session',
        timestamp: Date.now(),
        signal_schema_version: 1,
        fingerprint: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.1, 0.11, 0.12, 0.13, 0.14, 0.15],
        signal_buffer: [{ kind: 'CONFUSION', t: 1 }],
    };

    async function req(method, path, { json, bearer } = {}) {
        const url = path.startsWith('http') ? path : `${base}${path}`;
        const headers = { Authorization: `Bearer ${bearer}` };
        let body;
        if (json !== undefined) {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(json);
        }
        const r = await fetch(url, { method, headers, body });
        const text = await r.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            parsed = { _raw: text };
        }
        return { ok: r.ok, status: r.status, json: parsed };
    }

    console.log('1) POST /v1/ingest …');
    const ing = await req('POST', '/v1/ingest', { json: ingestBody, bearer: pub });
    if (!ing.ok) {
        console.error('ingest failed', ing.status, ing.json);
        process.exit(1);
    }
    console.log('   ok', ing.json);

    console.log('2) GET friction-context …');
    const fr = await req('GET', `/internal/v1/orgs/${encodeURIComponent(slug)}/friction-context?limit=5`, {
        bearer: admin,
    });
    if (!fr.ok) {
        console.error('friction GET failed', fr.status, fr.json);
        process.exit(1);
    }
    const frRows = (fr.json && fr.json.rows) || [];
    console.log('   rows', frRows.length, frRows[0] ? '(latest has id ' + frRows[0].id + ')' : '(none — check DISABLE_FRICTION_AUTOTRACK)');

    console.log('3) POST gold-standard-vectors …');
    const goldPost = await req('POST', `/internal/v1/orgs/${encodeURIComponent(slug)}/gold-standard-vectors`, {
        json: {
            fingerprint: ingestBody.fingerprint,
            label: 'SmokeConfusion',
            notes: 'smoke-nexus-stack.js',
            verified_by: 'smoke-nexus-stack',
        },
        bearer: admin,
    });
    if (!goldPost.ok || goldPost.status !== 201) {
        console.error('gold POST failed', goldPost.status, goldPost.json);
        process.exit(1);
    }
    console.log('   ok', goldPost.json);

    console.log('4) GET gold-standard-vectors …');
    const gl = await req('GET', `/internal/v1/orgs/${encodeURIComponent(slug)}/gold-standard-vectors?limit=5`, {
        bearer: admin,
    });
    if (!gl.ok) {
        console.error('gold GET failed', gl.status, gl.json);
        process.exit(1);
    }
    const gRows = (gl.json && gl.json.rows) || [];
    console.log('   rows', gRows.length);
    console.log('Smoke completed successfully.');
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
