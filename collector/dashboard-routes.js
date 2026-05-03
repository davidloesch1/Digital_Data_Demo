'use strict';

const SEARCH_LIMIT_CAP = 5000;
const fullstoryCsv = require('./fullstory-csv.js');

function parseSearchLimit(req) {
    const q = req.query && req.query.limit;
    if (q === undefined || q === '') return 500;
    const n = parseInt(String(q), 10);
    if (!Number.isFinite(n) || n < 1) return 500;
    return Math.min(n, SEARCH_LIMIT_CAP);
}

/**
 * @param {import('express').Application} app
 * @param {{ tenantContext: any, tenantDbApi: any, extractPublishableKey: (req: any) => string | null, csvUploadMiddleware?: import('express').RequestHandler }} deps
 */
function mountV1DashboardRoutes(app, deps) {
    const { tenantContext, tenantDbApi, extractPublishableKey, csvUploadMiddleware } = deps;
    if (!tenantContext) return;

    async function requireOrg(req, res) {
        const rawKey = extractPublishableKey(req);
        if (!rawKey) {
            res.status(401).json({
                error: 'Missing publishable key',
                hint: 'Use Authorization: Bearer <nx_pub_...> or X-Nexus-Publishable-Key',
            });
            return null;
        }
        let resolved;
        try {
            resolved = await tenantDbApi.resolvePublishableKey(
                tenantContext.pool,
                tenantContext.pepper,
                rawKey
            );
        } catch (e) {
            console.error('resolvePublishableKey:', e);
            res.status(500).json({ error: 'Auth lookup failed' });
            return null;
        }
        if (!resolved) {
            res.status(401).json({ error: 'Invalid or revoked publishable key' });
            return null;
        }
        return resolved;
    }

    app.get('/v1/clusters', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        try {
            const clusters = await tenantDbApi.listBehaviorClusters(tenantContext.pool, org.orgId);
            res.status(200).json({ clusters });
        } catch (e) {
            console.error('GET /v1/clusters:', e);
            res.status(500).json({ error: 'List failed' });
        }
    });

    app.post('/v1/clusters', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        try {
            const row = await tenantDbApi.createBehaviorCluster(tenantContext.pool, org.orgId, req.body || {});
            res.status(201).json({ cluster: row });
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'name_required' || msg === 'centroid_required') {
                return res.status(400).json({ error: msg });
            }
            if (e && e.code === '23505') {
                return res.status(409).json({ error: 'Cluster name already exists for this org' });
            }
            console.error('POST /v1/clusters:', e);
            res.status(500).json({ error: 'Create failed' });
        }
    });

    app.patch('/v1/clusters/:id', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const id = req.params && req.params.id;
        try {
            const row = await tenantDbApi.updateBehaviorCluster(
                tenantContext.pool,
                org.orgId,
                id,
                req.body || {}
            );
            if (!row) return res.status(404).json({ error: 'Not found' });
            res.status(200).json({ cluster: row });
        } catch (e) {
            if (e && e.code === '23505') {
                return res.status(409).json({ error: 'Cluster name conflict' });
            }
            console.error('PATCH /v1/clusters:', e);
            res.status(500).json({ error: 'Update failed' });
        }
    });

    app.delete('/v1/clusters/:id', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const id = req.params && req.params.id;
        try {
            const n = await tenantDbApi.deleteBehaviorCluster(tenantContext.pool, org.orgId, id);
            if (!n) return res.status(404).json({ error: 'Not found' });
            res.status(200).json({ ok: true });
        } catch (e) {
            console.error('DELETE /v1/clusters:', e);
            res.status(500).json({ error: 'Delete failed' });
        }
    });

    app.post('/v1/clusters/:id/tags', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const id = req.params && req.params.id;
        const tagKind = req.body && req.body.tag_kind;
        const value = req.body && req.body.value;
        try {
            const tag = await tenantDbApi.addBehaviorClusterTag(
                tenantContext.pool,
                org.orgId,
                id,
                tagKind || 'note',
                value
            );
            if (!tag) return res.status(404).json({ error: 'Cluster not found' });
            res.status(201).json({ tag });
        } catch (e) {
            console.error('POST /v1/clusters/:id/tags:', e);
            res.status(500).json({ error: 'Tag add failed' });
        }
    });

    app.delete('/v1/clusters/:clusterId/tags/:tagId', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const tagId = req.params && req.params.tagId;
        try {
            const n = await tenantDbApi.deleteBehaviorClusterTag(tenantContext.pool, org.orgId, tagId);
            if (!n) return res.status(404).json({ error: 'Not found' });
            res.status(200).json({ ok: true });
        } catch (e) {
            console.error('DELETE tag:', e);
            res.status(500).json({ error: 'Delete failed' });
        }
    });

    app.post('/v1/clusters/:id/snapshot-cohort', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const id = req.params && req.params.id;
        const body = req.body || {};
        body.cluster_id = id;
        try {
            const cohort = await tenantDbApi.createBehaviorCohort(tenantContext.pool, org.orgId, body);
            res.status(201).json({ cohort });
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'name_required') return res.status(400).json({ error: msg });
            if (msg === 'cluster_not_found') return res.status(404).json({ error: msg });
            console.error('snapshot-cohort:', e);
            res.status(500).json({ error: 'Snapshot failed' });
        }
    });

    app.get('/v1/cohorts', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        try {
            const cohorts = await tenantDbApi.listBehaviorCohorts(tenantContext.pool, org.orgId);
            res.status(200).json({ cohorts });
        } catch (e) {
            console.error('GET /v1/cohorts:', e);
            res.status(500).json({ error: 'List failed' });
        }
    });

    app.post('/v1/cohorts/:id/segmentation', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const id = req.params && req.params.id;
        const vars = req.body && req.body.vars;
        try {
            const out = await tenantDbApi.applyCohortSegmentationVars(
                tenantContext.pool,
                org.orgId,
                id,
                vars
            );
            res.status(200).json(out);
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'vars_required') return res.status(400).json({ error: msg });
            console.error('POST segmentation:', e);
            res.status(500).json({ error: 'Apply failed' });
        }
    });

    app.get('/v1/segmentation/manifest', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const vid =
            req.query && req.query.visitor_id != null
                ? String(req.query.visitor_id).trim()
                : req.query && req.query.visitor_key != null
                  ? String(req.query.visitor_key).trim()
                  : '';
        if (!vid) {
            return res.status(400).json({ error: 'visitor_id or visitor_key query required' });
        }
        try {
            const vars = await tenantDbApi.getSegmentationManifestForVisitor(
                tenantContext.pool,
                org.orgId,
                vid
            );
            res.status(200).json({ vars });
        } catch (e) {
            console.error('GET manifest:', e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    app.get('/v1/search/events', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const q = req.query || {};
        const session_id_substr =
            q.session_id_substr != null && String(q.session_id_substr).trim() !== ''
                ? String(q.session_id_substr).trim()
                : q.session_url != null && String(q.session_url).trim() !== ''
                  ? extractSessionIdFromFsUrl(String(q.session_url))
                  : null;
        const visitor_key =
            q.visitor_key != null && String(q.visitor_key).trim() !== ''
                ? String(q.visitor_key).trim()
                : q.nexus_user_key != null
                  ? String(q.nexus_user_key).trim()
                  : null;
        const since = q.since != null && String(q.since).trim() !== '' ? String(q.since).trim() : null;
        const until = q.until != null && String(q.until).trim() !== '' ? String(q.until).trim() : null;
        const limit = parseSearchLimit(req);
        try {
            const data = await tenantDbApi.searchBehaviorEvents(tenantContext.pool, org.orgId, {
                session_id_substr,
                visitor_key,
                since,
                until,
                limit,
            });
            res.setHeader('X-Search-Lines-Returned', String(data.length));
            res.status(200).json(data);
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'session_or_visitor_required') {
                return res.status(400).json({
                    error: 'Provide session_url or session_id_substr, or visitor_key / nexus_user_key',
                });
            }
            console.error('GET /v1/search/events:', e);
            res.status(500).json({ error: 'Search failed' });
        }
    });

    async function handleFullstoryCsvUpload(req, res, orgIdUuid) {
        const text = typeof req.body === 'string' ? req.body : '';
        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'empty body' });
        }
        const prep = fullstoryCsv.fullstoryCsvToInserts(text, { maxRows: 50000 });
        try {
            const batch = await tenantDbApi.insertFullstoryEventsBatch(tenantContext.pool, orgIdUuid, prep.inserts);
            await tenantDbApi.recomputeFsSessionMetrics(tenantContext.pool, orgIdUuid, prep.sessionsTouched);
            res.status(200).json({
                inserted: batch.inserted,
                skipped: batch.skipped,
                sessions: prep.sessionsTouched,
                rowCount: prep.rowCount,
                truncated: Boolean(prep.truncated),
            });
        } catch (e) {
            console.error('POST /v1/fullstory/events/upload-csv:', e);
            res.status(500).json({ error: 'Upload failed' });
        }
    }

    if (csvUploadMiddleware) {
        app.post('/v1/fullstory/events/upload-csv', csvUploadMiddleware, async (req, res) => {
            const org = await requireOrg(req, res);
            if (!org) return;
            await handleFullstoryCsvUpload(req, res, org.orgId);
        });
    }

    app.get('/v1/fullstory/events', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const q = req.query || {};
        const session_id =
            q.session_id != null && String(q.session_id).trim() !== ''
                ? String(q.session_id).trim()
                : null;
        const session_url =
            q.session_url != null && String(q.session_url).trim() !== ''
                ? String(q.session_url).trim()
                : null;
        const visitor_key =
            q.visitor_key != null && String(q.visitor_key).trim() !== ''
                ? String(q.visitor_key).trim()
                : null;
        const since = q.since != null && String(q.since).trim() !== '' ? String(q.since).trim() : null;
        const until = q.until != null && String(q.until).trim() !== '' ? String(q.until).trim() : null;
        const limit = parseSearchLimit(req);
        try {
            const data = await tenantDbApi.listFullstoryEvents(tenantContext.pool, org.orgId, {
                session_id,
                session_url,
                visitor_key,
                since,
                until,
                limit,
            });
            res.setHeader('X-Fullstory-Events-Returned', String(data.length));
            res.status(200).json(data);
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'session_or_visitor_required') {
                return res.status(400).json({
                    error: 'Provide session_id, session_url, or visitor_key',
                });
            }
            console.error('GET /v1/fullstory/events:', e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    app.get('/v1/fullstory/sessions', async (req, res) => {
        const org = await requireOrg(req, res);
        if (!org) return;
        const q = req.query || {};
        const sessionIdsRaw = q.session_ids != null ? String(q.session_ids).trim() : '';
        const sessionIds = sessionIdsRaw
            ? sessionIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
            : [];
        const since = q.since != null && String(q.since).trim() !== '' ? String(q.since).trim() : null;
        const until = q.until != null && String(q.until).trim() !== '' ? String(q.until).trim() : null;
        const limit = parseSearchLimit(req);
        try {
            let rows;
            if (sessionIds.length) {
                rows = await tenantDbApi.getFullstorySessionMetricsByIds(tenantContext.pool, org.orgId, sessionIds);
            } else {
                rows = await tenantDbApi.listFullstorySessionMetrics(tenantContext.pool, org.orgId, {
                    since,
                    until,
                    limit,
                });
            }
            res.status(200).json(rows);
        } catch (e) {
            console.error('GET /v1/fullstory/sessions:', e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    console.log(
        'Collector: GET|POST /v1/clusters, /v1/cohorts, /v1/segmentation/manifest, /v1/search/events, /v1/fullstory/* (publishable key)'
    );
}

/** Extract likely FullStory session token from a replay URL path segment. */
function extractSessionIdFromFsUrl(url) {
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

/**
 * @param {import('express').Router} router
 */
function addInternalDashboardRoutes(router, deps) {
    const { tenantContext, tenantDbApi, csvUploadMiddleware } = deps;
    if (!tenantContext) return;

    async function orgFromReq(req) {
        const slug =
            (req.query && req.query.org_slug != null && String(req.query.org_slug).trim()) ||
            (req.body && req.body.org_slug != null && String(req.body.org_slug).trim()) ||
            '';
        if (!slug) return null;
        const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, slug);
        return org ? { orgId: org.id, orgSlug: org.slug } : null;
    }

    router.get('/clusters', async (req, res) => {
        const slugFilter =
            req.query && req.query.org_slug != null ? String(req.query.org_slug).trim() : '';
        try {
            const clusters = await tenantDbApi.listBehaviorClustersAllOrgs(
                tenantContext.pool,
                slugFilter || null
            );
            res.status(200).json({ clusters });
        } catch (e) {
            console.error('internal GET /clusters:', e);
            res.status(500).json({ error: 'List failed' });
        }
    });

    router.post('/clusters', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        try {
            const row = await tenantDbApi.createBehaviorCluster(tenantContext.pool, org.orgId, req.body || {});
            res.status(201).json({ cluster: row });
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'name_required' || msg === 'centroid_required') {
                return res.status(400).json({ error: msg });
            }
            if (e && e.code === '23505') {
                return res.status(409).json({ error: 'Cluster name already exists for this org' });
            }
            console.error('internal POST /clusters:', e);
            res.status(500).json({ error: 'Create failed' });
        }
    });

    router.patch('/clusters/:id', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const id = req.params && req.params.id;
        try {
            const row = await tenantDbApi.updateBehaviorCluster(
                tenantContext.pool,
                org.orgId,
                id,
                req.body || {}
            );
            if (!row) return res.status(404).json({ error: 'Not found' });
            res.status(200).json({ cluster: row });
        } catch (e) {
            console.error('internal PATCH /clusters:', e);
            res.status(500).json({ error: 'Update failed' });
        }
    });

    router.delete('/clusters/:id', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const id = req.params && req.params.id;
        try {
            const n = await tenantDbApi.deleteBehaviorCluster(tenantContext.pool, org.orgId, id);
            if (!n) return res.status(404).json({ error: 'Not found' });
            res.status(200).json({ ok: true });
        } catch (e) {
            console.error('internal DELETE /clusters:', e);
            res.status(500).json({ error: 'Delete failed' });
        }
    });

    router.post('/clusters/:id/tags', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const id = req.params && req.params.id;
        try {
            const tag = await tenantDbApi.addBehaviorClusterTag(
                tenantContext.pool,
                org.orgId,
                id,
                (req.body && req.body.tag_kind) || 'note',
                req.body && req.body.value
            );
            if (!tag) return res.status(404).json({ error: 'Cluster not found' });
            res.status(201).json({ tag });
        } catch (e) {
            console.error('internal POST tags:', e);
            res.status(500).json({ error: 'Tag add failed' });
        }
    });

    router.delete('/clusters/:clusterId/tags/:tagId', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const tagId = req.params && req.params.tagId;
        try {
            const n = await tenantDbApi.deleteBehaviorClusterTag(tenantContext.pool, org.orgId, tagId);
            if (!n) return res.status(404).json({ error: 'Not found' });
            res.status(200).json({ ok: true });
        } catch (e) {
            console.error('internal DELETE tag:', e);
            res.status(500).json({ error: 'Delete failed' });
        }
    });

    router.post('/clusters/:id/snapshot-cohort', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const id = req.params && req.params.id;
        const body = { ...(req.body || {}), cluster_id: id };
        try {
            const cohort = await tenantDbApi.createBehaviorCohort(tenantContext.pool, org.orgId, body);
            res.status(201).json({ cohort });
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'name_required') return res.status(400).json({ error: msg });
            if (msg === 'cluster_not_found') return res.status(404).json({ error: msg });
            console.error('internal snapshot:', e);
            res.status(500).json({ error: 'Snapshot failed' });
        }
    });

    router.get('/cohorts', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        try {
            const cohorts = await tenantDbApi.listBehaviorCohorts(tenantContext.pool, org.orgId);
            res.status(200).json({ cohorts });
        } catch (e) {
            console.error('internal GET /cohorts:', e);
            res.status(500).json({ error: 'List failed' });
        }
    });

    router.post('/cohorts/:id/segmentation', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const id = req.params && req.params.id;
        try {
            const out = await tenantDbApi.applyCohortSegmentationVars(
                tenantContext.pool,
                org.orgId,
                id,
                req.body && req.body.vars
            );
            res.status(200).json(out);
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'vars_required') return res.status(400).json({ error: msg });
            console.error('internal segmentation:', e);
            res.status(500).json({ error: 'Apply failed' });
        }
    });

    router.get('/segmentation/manifest', async (req, res) => {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const vid =
            req.query && req.query.visitor_id != null
                ? String(req.query.visitor_id).trim()
                : req.query && req.query.visitor_key != null
                  ? String(req.query.visitor_key).trim()
                  : '';
        if (!vid) {
            return res.status(400).json({ error: 'visitor_id or visitor_key query required' });
        }
        try {
            const vars = await tenantDbApi.getSegmentationManifestForVisitor(
                tenantContext.pool,
                org.orgId,
                vid
            );
            res.status(200).json({ vars });
        } catch (e) {
            console.error('internal manifest:', e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    router.get('/search/events', async (req, res) => {
        const q = req.query || {};
        const orgSlug = q.org_slug != null ? String(q.org_slug).trim() : '';
        const session_id_substr =
            q.session_id_substr != null && String(q.session_id_substr).trim() !== ''
                ? String(q.session_id_substr).trim()
                : q.session_url != null && String(q.session_url).trim() !== ''
                  ? extractSessionIdFromFsUrl(String(q.session_url))
                  : null;
        const visitor_key =
            q.visitor_key != null && String(q.visitor_key).trim() !== ''
                ? String(q.visitor_key).trim()
                : q.nexus_user_key != null
                  ? String(q.nexus_user_key).trim()
                  : null;
        const since = q.since != null && String(q.since).trim() !== '' ? String(q.since).trim() : null;
        const until = q.until != null && String(q.until).trim() !== '' ? String(q.until).trim() : null;
        const limit = parseSearchLimit(req);
        try {
            let data;
            if (orgSlug) {
                const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, orgSlug);
                if (!org) return res.status(404).json({ error: 'Unknown org_slug' });
                data = await tenantDbApi.searchBehaviorEvents(tenantContext.pool, org.id, {
                    session_id_substr,
                    visitor_key,
                    since,
                    until,
                    limit,
                });
            } else {
                data = await tenantDbApi.searchBehaviorEventsAllOrgs(tenantContext.pool, {
                    session_id_substr,
                    visitor_key,
                    since,
                    until,
                    limit,
                    org_slug: null,
                });
            }
            res.setHeader('X-Search-Lines-Returned', String(data.length));
            res.status(200).json(data);
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'session_or_visitor_required') {
                return res.status(400).json({
                    error: 'Provide session_url or session_id_substr, or visitor_key',
                });
            }
            console.error('internal search/events:', e);
            res.status(500).json({ error: 'Search failed' });
        }
    });

    async function internalHandleFullstoryCsvUpload(req, res) {
        const org = await orgFromReq(req);
        if (!org) {
            return res.status(400).json({ error: 'org_slug required (query or body)' });
        }
        const text = typeof req.body === 'string' ? req.body : '';
        if (!text || !String(text).trim()) {
            return res.status(400).json({ error: 'empty body' });
        }
        const prep = fullstoryCsv.fullstoryCsvToInserts(text, { maxRows: 50000 });
        try {
            const batch = await tenantDbApi.insertFullstoryEventsBatch(tenantContext.pool, org.orgId, prep.inserts);
            await tenantDbApi.recomputeFsSessionMetrics(tenantContext.pool, org.orgId, prep.sessionsTouched);
            res.status(200).json({
                inserted: batch.inserted,
                skipped: batch.skipped,
                sessions: prep.sessionsTouched,
                rowCount: prep.rowCount,
                truncated: Boolean(prep.truncated),
            });
        } catch (e) {
            console.error('internal POST /fullstory/events/upload-csv:', e);
            res.status(500).json({ error: 'Upload failed' });
        }
    }

    if (csvUploadMiddleware) {
        router.post('/fullstory/events/upload-csv', csvUploadMiddleware, internalHandleFullstoryCsvUpload);
    }

    router.get('/fullstory/events', async (req, res) => {
        const q = req.query || {};
        const orgSlug = q.org_slug != null ? String(q.org_slug).trim() : '';
        if (!orgSlug) {
            return res.status(400).json({ error: 'org_slug query required' });
        }
        const session_id =
            q.session_id != null && String(q.session_id).trim() !== ''
                ? String(q.session_id).trim()
                : null;
        const session_url =
            q.session_url != null && String(q.session_url).trim() !== ''
                ? String(q.session_url).trim()
                : null;
        const visitor_key =
            q.visitor_key != null && String(q.visitor_key).trim() !== ''
                ? String(q.visitor_key).trim()
                : null;
        const since = q.since != null && String(q.since).trim() !== '' ? String(q.since).trim() : null;
        const until = q.until != null && String(q.until).trim() !== '' ? String(q.until).trim() : null;
        const limit = parseSearchLimit(req);
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, orgSlug);
            if (!org) return res.status(404).json({ error: 'Unknown org_slug' });
            const data = await tenantDbApi.listFullstoryEvents(tenantContext.pool, org.id, {
                session_id,
                session_url,
                visitor_key,
                since,
                until,
                limit,
            });
            res.setHeader('X-Fullstory-Events-Returned', String(data.length));
            res.status(200).json(data);
        } catch (e) {
            const msg = e && e.message;
            if (msg === 'session_or_visitor_required') {
                return res.status(400).json({
                    error: 'Provide session_id, session_url, or visitor_key',
                });
            }
            console.error('internal GET /fullstory/events:', e);
            res.status(500).json({ error: 'Read failed' });
        }
    });

    router.get('/fullstory/sessions', async (req, res) => {
        const q = req.query || {};
        const orgSlug = q.org_slug != null ? String(q.org_slug).trim() : '';
        if (!orgSlug) {
            return res.status(400).json({ error: 'org_slug query required' });
        }
        const sessionIdsRaw = q.session_ids != null ? String(q.session_ids).trim() : '';
        const sessionIds = sessionIdsRaw
            ? sessionIdsRaw.split(',').map((s) => s.trim()).filter(Boolean)
            : [];
        const since = q.since != null && String(q.since).trim() !== '' ? String(q.since).trim() : null;
        const until = q.until != null && String(q.until).trim() !== '' ? String(q.until).trim() : null;
        const limit = parseSearchLimit(req);
        try {
            const org = await tenantDbApi.getOrganizationBySlug(tenantContext.pool, orgSlug);
            if (!org) return res.status(404).json({ error: 'Unknown org_slug' });
            let rows;
            if (sessionIds.length) {
                rows = await tenantDbApi.getFullstorySessionMetricsByIds(tenantContext.pool, org.id, sessionIds);
            } else {
                rows = await tenantDbApi.listFullstorySessionMetrics(tenantContext.pool, org.id, {
                    since,
                    until,
                    limit,
                });
            }
            res.status(200).json(rows);
        } catch (e) {
            console.error('internal GET /fullstory/sessions:', e);
            res.status(500).json({ error: 'Read failed' });
        }
    });
}

module.exports = {
    mountV1DashboardRoutes,
    addInternalDashboardRoutes,
    extractSessionIdFromFsUrl,
};
