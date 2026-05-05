-- Example: BigQuery view sketch for `nexus_dna_discovery` (NEXUS_PLAN Phase 2).
-- Replace project/dataset/table names with your FullStory export + Nexus dual-write export.
--
-- Assumptions (adjust to your pipeline):
--   `fs_events` — FullStory events table with custom properties (or nested JSON column `properties`).
--   `nexus_kinetic` — Rows from dual-write OR FS export filtered to source = nexus_snippet, type = kinetic.
-- Join key: normalized session URL or FS session id available on both sides.

/*
CREATE OR REPLACE VIEW `your_project.your_dataset.nexus_dna_discovery` AS
WITH nk AS (
  SELECT
    TIMESTAMP(event_start) AS event_ts,
    user_id,
    JSON_VALUE(properties, '$.session_url') AS session_url,
    JSON_VALUE(properties, '$.label') AS nexus_label,
    SAFE_CAST(JSON_VALUE(properties, '$.timestamp') AS INT64) AS client_ts,
    ARRAY(
      SELECT SAFE_CAST(x AS FLOAT64)
      FROM UNNEST(JSON_VALUE_ARRAY(properties, '$.fingerprint')) AS x
    ) AS fingerprint,
    JSON_VALUE(properties, '$.signal_buffer_json') AS signal_buffer_json,
    JSON_VALUE(properties, '$.signal_schema_version') AS signal_schema_version
  FROM `your_project.your_dataset.fs_events`
  WHERE JSON_VALUE(properties, '$.source') = 'nexus_snippet'
    AND JSON_VALUE(properties, '$.type') = 'kinetic'
),
pages AS (
  SELECT
    session_id,
    page_url,
    page_start,
    page_duration_ms
  FROM `your_project.your_dataset.fs_pages`
)
SELECT
  nk.*,
  p.page_url,
  p.page_duration_ms
FROM nk
LEFT JOIN pages AS p
  ON nk.session_url = p.page_url   -- illustrative; prefer stable session_id join when available
;
*/

-- Minimal join on session_url + time window (when session_id not exported):
-- AND TIMESTAMP_DIFF(nk.event_ts, p.page_start, SECOND) BETWEEN 0 AND 3600

SELECT 1 AS placeholder_run_replace_before_execute;

-- ---------------------------------------------------------------------------
-- Optional: after ETL from Postgres, mirror `nexus_friction_context` and
-- `gold_standard_vectors` into BigQuery tables, then join on org_id + session_url
-- or behavior_event_id. Fingerprint column type (JSON vs ARRAY<FLOAT64>) depends
-- on your load job; cast before cosine similarity in a scheduled query.
