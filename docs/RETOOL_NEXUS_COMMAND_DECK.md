# Retool: Nexus “Command Deck” (HTTP resources)

Use **Retool REST API resources** against the same collector you deploy for production. All paths below assume **`{{collector_base}}`** has **no** trailing slash (e.g. `https://your-collector.up.railway.app`).

**Not** your Postgres `DATABASE_URL` — see **[docs/COLLECTOR_URL_VS_DATABASE_URL.md](COLLECTOR_URL_VS_DATABASE_URL.md)**.

**Auth:** Retool resource header **`Authorization: Bearer {{internal_admin_token}}`** where `internal_admin_token` matches collector **`INTERNAL_ADMIN_TOKEN`**. Do **not** embed this token in the browser snippet or customer sites.

**Org scope:** Paths under **`/internal/v1/orgs/:slug/...`** require the org **slug** in the URL (path or Retool path param).

---

## 1. List friction context

| Field | Value |
|--------|--------|
| Method | `GET` |
| URL | `{{collector_base}}/internal/v1/orgs/{{org_slug}}/friction-context?limit=50` |

Returns JSON `{ "org_slug", "rows": [ … ] }`.

---

## 2. Append friction context (manual)

| Field | Value |
|--------|--------|
| Method | `POST` |
| URL | `{{collector_base}}/internal/v1/orgs/{{org_slug}}/friction-context` |
| Body (JSON) | See example below |

Example body:

```json
{
  "session_url": "https://app.fullstory.com/ui/session/ABC",
  "friction_kinds": ["CONFUSION"],
  "window_json": { "note": "manual from Retool" },
  "behavior_event_id": null
}
```

---

## 3. List gold standard vectors

| Field | Value |
|--------|--------|
| Method | `GET` |
| URL | `{{collector_base}}/internal/v1/orgs/{{org_slug}}/gold-standard-vectors?limit=50` |

---

## 4. Save gold standard vector (“Verify”)

| Field | Value |
|--------|--------|
| Method | `POST` |
| URL | `{{collector_base}}/internal/v1/orgs/{{org_slug}}/gold-standard-vectors` |
| Body (JSON) | See example below |

Example body (16 numbers required):

```json
{
  "fingerprint": [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.1,0.11,0.12,0.13,0.14,0.15],
  "label": "Confusion",
  "notes": "Verified from session replay",
  "verified_by": "retool:{{current_user.email}}",
  "source_behavior_event_id": null,
  "source_friction_context_id": null
}
```

Wire **`source_friction_context_id`** / **`source_behavior_event_id`** from list endpoints when the operator picks a row.

Full contract: **`docs/GOLD_STANDARD_VECTORS.md`**.

---

## 5. FullStory Generate Context

| Field | Value |
|--------|--------|
| Method | `POST` |
| URL | `{{collector_base}}/internal/v1/fullstory/generate-context` |
| Body (JSON) | At least one of `session_id`, `session_url` |

Example:

```json
{
  "session_url": "https://app.fullstory.com/ui/session/ABC",
  "context": { "summary": "Optional operator notes for FS" }
}
```

Requires **`FULLSTORY_API_KEY`** on the collector. See **`docs/FULLSTORY_ACTIVATION.md`**.

---

## 6. Cluster tags (publishable key or internal)

If Retool should **not** hold the internal admin token for cluster writes, use **`POST /v1/clusters/{{cluster_id}}/tags`** with **`Authorization: Bearer {{publishable_key}}`** (org inferred from key). Body:

```json
{ "tag_kind": "note", "value": "Confusion" }
```

Allowed **`tag_kind`** values match the DB check: `label_pattern`, `module`, `metric`, `note`, `fs_signal`. See **`docs/CLUSTER_TAGS_HITL.md`**.

Internal multi-org listing: **`GET {{collector_base}}/internal/v1/clusters?org_slug={{org_slug}}`** (same bearer as above).

---

## Smoke test

Automated ingest → friction → gold: **`docs/SMOKE_NEXUS_STACK.md`**.
