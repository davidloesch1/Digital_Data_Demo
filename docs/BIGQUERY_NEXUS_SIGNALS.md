# BigQuery: Nexus kinetic + silent signals

This doc supports **NEXUS_PLAN Phase 2** (warehouse / FS sync) without assuming a specific FullStory export SKU. Adjust table and column names to match your **Data Destinations** (or event API) layout.

**Example view DDL (commented sketch):** `scripts/sql/nexus_dna_discovery.example.sql`.

## 1. FullStory custom properties

The snippet sends **`nexus_kinetic_fingerprint`** (or your `event_name`) with properties including:

| Property | Type (typical) | Notes |
|----------|----------------|--------|
| `fingerprint` | array of numbers | 16-D vector |
| `signal_schema_version` | number | currently `1` |
| `signal_buffer_json` | string | JSON array of rolling semantic events |
| `surface_viewport_w` / `surface_viewport_h` | number | layout context |
| `surface_dpr` | number | device pixel ratio |
| `surface_color_scheme` | string | `dark` / `light` / `unknown` |
| `surface_reduced_motion` | boolean | motion preference |
| `surface_root_font_px` | number | optional |

**Indexing:** In FullStory, mark these custom properties for **analysis / export** so they appear in BigQuery (or your warehouse) with stable types. Re-run or refresh the export schema after adding properties.

## 2. Parsing `signal_buffer_json` in SQL (BigQuery example)

After sync, events often land as a row per FS event with a JSON payload column (name varies, e.g. `event_properties` or nested `properties`). Example extraction:

```sql
-- Illustrative: replace table/column names with your FS export model.
SELECT
  event_start,
  user_id,
  SAFE_CAST(JSON_VALUE(props, '$.signal_schema_version') AS INT64) AS signal_schema_version,
  JSON_QUERY(props, '$.signal_buffer_json') AS signal_buffer_json,
  ARRAY_LENGTH(JSON_QUERY_ARRAY(JSON_VALUE(props, '$.signal_buffer_json'))) AS signal_buffer_len
FROM `your_project.your_dataset.fullstory_events` AS e,
  UNNEST([STRUCT(JSON_QUERY(e.properties, '$') AS props)]) AS _
WHERE JSON_VALUE(props, '$.source') = 'nexus_snippet'
  AND JSON_VALUE(props, '$.type') = 'kinetic';
```

Use **`JSON_QUERY_ARRAY` / `JSON_VALUE`** on the **parsed** string if your pipeline stores `signal_buffer_json` as a stringified array (as emitted to FullStory).

## 3. Dual-write: `behavior_events.payload`

When **`NEXUS_DUAL_WRITE`** is on, `POST /v1/ingest` stores the full body as **`payload` JSONB** (`signal_buffer` as native JSON array, `css_meta` object). Example:

```sql
SELECT
  created_at,
  payload->>'org_slug' AS org_slug,
  payload->'signal_buffer' AS signal_buffer,
  payload->'css_meta' AS css_meta
FROM behavior_events
WHERE payload->>'type' = 'kinetic'
ORDER BY created_at DESC
LIMIT 100;
```

## 4. View sketch: `nexus_dna_discovery` (NEXUS_PLAN)

A cross-domain “DNA discovery” view is org-specific in production. Pattern:

1. **Partition or filter** by `org_id` / `domain` (from your site dimension or payload `label` / hostname).
2. **Join** kinetic rows to FullStory **`pages`** / **`elements`** (or session-level tables) on **`session_url`** / **`fs_session_id`** / time window—exact join keys depend on your FS export.
3. Materialize or schedule queries if row volume is high.

Ship the first version as **documented SQL in-repo** (this file + `scripts/`) before automating view creation in Terraform.

## 5. “Rolling window” table (high-friction events)

NEXUS_PLAN calls for storing rolling-window strings for high-friction incidents. **Collector (Postgres):** on **`POST /v1/ingest`**, when `payload.signal_buffer` contains **`CONFUSION`** or **`DWELL`**, a row is appended to **`nexus_friction_context`** (linked to **`behavior_events.id`** unless disabled with **`DISABLE_FRICTION_AUTOTRACK`**). Operators may still **`POST /internal/v1/orgs/:slug/friction-context`** manually.

Typical warehouse follow-up:

- **Batch or streaming job** reads `signal_buffer` / `signal_buffer_json`, scores friction (e.g. presence of `CONFUSION`, `DWELL`, spike in `FLUSH` frequency), and **INSERT**s into `nexus_friction_context (org_id, event_id, session_url, window_json, created_at)` (table name illustrative).
- Keep payloads **PII-scrubbed** per NEXUS_PLAN principles (no raw `id`/`class` from DOM in buffers today).

---

**Operational note:** Warehouse work lives in **your** GCP / FS console; this repository ships the **browser + collector contract**. Update this doc when your canonical BigQuery table names are fixed.

## 6. FullStory indexing checklist (operator)

Do these in **FullStory** (names vary by product generation); goal is stable types in **Data Destinations / BigQuery** (or your export).

1. Confirm custom events from **`nexus_kinetic_fingerprint`** (or your `event_name`) appear in the event catalog.
2. Mark **analysis** (and export, if separate toggles) for each custom property you rely on: **`fingerprint`**, **`signal_buffer_json`**, **`signal_schema_version`**, **`session_url`**, **`label`**, **`surface_*`**, **`css_meta`** (or flattened keys you actually emit).
3. After changing property shapes, **refresh** the warehouse schema or wait for the next sync; re-run any **scheduled queries** that cast JSON.
4. Document your canonical **BQ table + JSON path** in this file (replace placeholders in section 2) so joins do not rot silently.

## 7. Postgres `gold_standard_vectors` and `nexus_friction_context` in BigQuery

These tables live **only in Postgres** today. To use them next to FullStory exports:

| Approach | When to use |
|----------|-------------|
| **Batch export** (cron / Cloud Run) | `SELECT … FROM gold_standard_vectors` / `nexus_friction_context` → GCS → **BQ load** or **external table**. |
| **Federated query** from BQ to Postgres | Small ad-hoc joins; watch latency and cost. |
| **Mirror on write** | Collector hook or outbox (not shipped here) to push new rows to Pub/Sub. |

Example **BQ external table** DDL is environment-specific (connection id, region). Sketch columns to mirror:

- **`gold_standard_vectors`:** `id`, `org_id` (join to your org dimension), `fingerprint` (repeat `FLOAT64` column family or JSON, depending on load), `label`, `notes`, `verified_by`, `source_behavior_event_id`, `source_friction_context_id`, `created_at`.
- **`nexus_friction_context`:** `id`, `org_id`, `behavior_event_id`, `session_url`, `friction_kinds`, `window_json`, `created_at`.

**Phase 4 prototype (cosine vs gold, still in Postgres):** from `collector/` run **`npm run gold-nearest -- --org-slug YOUR_ORG --top 5 --fp '[…16 numbers…]'`** (see [collector/scripts/gold-nearest-neighbors.js](../collector/scripts/gold-nearest-neighbors.js)); pipe a JSON array on stdin if you omit **`--fp`**.
