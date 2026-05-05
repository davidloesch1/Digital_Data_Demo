# Gold standard vectors (Postgres + internal API)

Human-verified **16-dimensional** kinetic fingerprints are stored in **`gold_standard_vectors`** for org-scoped training and centroid work (NEXUS_PLAN Phase 3–4). The collector creates the table on startup via **`ensureSchema`**.

## Auth

Same as other internal org routes: **`Authorization: Bearer <INTERNAL_ADMIN_TOKEN>`**.

## Endpoints

Base: **`https://<collector>/internal/v1/orgs/:org_slug/...`**

### `POST .../gold-standard-vectors`

JSON body:

| Field | Required | Notes |
|--------|-----------|--------|
| **`fingerprint`** | yes | Array of **exactly 16** finite numbers (matches snippet kinetic vector). |
| **`label`** | yes | Non-empty string, max **256** chars (e.g. *Confusion*, *Comparison*). |
| **`notes`** | no | Stored as text (truncated server-side). |
| **`verified_by`** | no | Short string (e.g. email or Retool user id). |
| **`source_behavior_event_id`** | no | UUID of a **`behavior_events`** row if known. |
| **`source_friction_context_id`** | no | UUID of a **`nexus_friction_context`** row if known. |

Invalid UUIDs in optional FK fields are ignored (stored as null). If a UUID is present but references a missing row, the API returns **400** with a foreign-key hint.

**201** response: `{ "ok": true, "id": "<new uuid>" }`.

### `GET .../gold-standard-vectors?limit=50`

Returns `{ "org_slug": "...", "rows": [ ... ] }` ordered by **`created_at`** descending. **`limit`** is clamped **1–500**.

Response headers: **`X-Gold-Limit`**, **`X-Gold-Rows`**.

## BigQuery

Warehouse export of this table is not automatic; mirror or ETL as needed when you promote Phase 4 scoring. See [docs/BIGQUERY_NEXUS_SIGNALS.md](BIGQUERY_NEXUS_SIGNALS.md) section 7.

## Smoke test

Automated sequence with the same collector: [docs/SMOKE_NEXUS_STACK.md](SMOKE_NEXUS_STACK.md) (`npm run smoke-nexus` from `collector/`).

## Master dashboard (browser, same origin as collector)

Open **`/internal/admin/master-dash`**, paste **`INTERNAL_ADMIN_TOKEN`** in the sidebar, then use the **Gold standard vectors** card: **Org slug override** (e.g. `0002`) or the master org dropdown, **Refresh list**, edit fingerprint JSON + label, **Save gold row**. Avoids CORS issues from a separate `file://` HTML tool. URL confusion: [docs/COLLECTOR_URL_VS_DATABASE_URL.md](COLLECTOR_URL_VS_DATABASE_URL.md).
