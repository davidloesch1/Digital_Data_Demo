# Smoke: ingest → friction → gold (local or Railway)

Repeatable checks that **Postgres**, **`POST /v1/ingest`**, auto-**friction** (when enabled), and **gold standard** internal routes work end-to-end.

**Do not** set `NEXUS_BASE_URL` to `DATABASE_URL`. The smoke script talks to the **HTTP collector**, not Postgres. See **[docs/COLLECTOR_URL_VS_DATABASE_URL.md](COLLECTOR_URL_VS_DATABASE_URL.md)**.

**GUI (no separate HTML file):** On the deployed collector, open **master dashboard** → **Gold standard vectors** card (uses **`INTERNAL_ADMIN_TOKEN`** + org slug — same pattern as cluster tags).

## Prerequisites

| Variable | Used for |
|----------|-----------|
| `NEXUS_BASE_URL` | **HTTPS collector** origin, e.g. `https://your-service.up.railway.app` or `http://127.0.0.1:8787` (no trailing slash) — **not** `postgresql://…` |
| `NEXUS_PUBLISHABLE_KEY` | `nx_pub_…` from org provisioning |
| `INTERNAL_ADMIN_TOKEN` | Same value as on the collector (Bearer for `/internal/v1/*`) |
| `ORG_SLUG` | Organization slug (e.g. `acme-corp`) |

Collector must have **`DATABASE_URL`**, **`PUBLISHABLE_KEY_PEPPER`**, and **`INTERNAL_ADMIN_TOKEN`** set. Do **not** set **`DISABLE_FRICTION_AUTOTRACK`** (or set it off) if you want the ingest step to create a **`nexus_friction_context`** row from the sample payload.

## One command (Node)

From the **`collector/`** directory:

```bash
export NEXUS_BASE_URL="https://your-collector.example"
export NEXUS_PUBLISHABLE_KEY="nx_pub_…"
export INTERNAL_ADMIN_TOKEN="…"
export ORG_SLUG="your-org-slug"
npm run smoke-nexus
```

The script prints each step and exits non-zero on the first HTTP failure.

## Manual curl sequence (same contract)

**1. Ingest** (kinetic body with `signal_buffer` containing `CONFUSION` triggers auto friction when autotrack is on):

```bash
curl -sS -X POST "$NEXUS_BASE_URL/v1/ingest" \
  -H "Authorization: Bearer $NEXUS_PUBLISHABLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "kinetic",
    "event_id": "smoke-test-1",
    "label": "smoke",
    "session_url": "https://app.fullstory.com/ui/session/abc123",
    "timestamp": 1,
    "signal_schema_version": 1,
    "fingerprint": [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.1,0.11,0.12,0.13,0.14,0.15],
    "signal_buffer": [{"kind":"CONFUSION","t":1}]
  }'
```

Expect `{"ok":true,"stored":true}`.

**2. List friction**

```bash
curl -sS "$NEXUS_BASE_URL/internal/v1/orgs/$ORG_SLUG/friction-context?limit=5" \
  -H "Authorization: Bearer $INTERNAL_ADMIN_TOKEN"
```

**3. Post gold vector**

```bash
curl -sS -X POST "$NEXUS_BASE_URL/internal/v1/orgs/$ORG_SLUG/gold-standard-vectors" \
  -H "Authorization: Bearer $INTERNAL_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "fingerprint": [0,0.1,0.2,0.3,0.4,0.5,0.6,0.7,0.8,0.9,0.1,0.11,0.12,0.13,0.14,0.15],
    "label": "SmokeConfusion",
    "notes": "smoke test",
    "verified_by": "smoke-nexus"
  }'
```

Expect `201` with `{ "ok": true, "id": "…" }`.

**4. List gold**

```bash
curl -sS "$NEXUS_BASE_URL/internal/v1/orgs/$ORG_SLUG/gold-standard-vectors?limit=5" \
  -H "Authorization: Bearer $INTERNAL_ADMIN_TOKEN"
```

## Provisioning reminder

If you do not yet have an org + key, from **`collector/`**:

```bash
export DATABASE_URL="postgresql://…"
export PUBLISHABLE_KEY_PEPPER="…same as collector…"
npm run create-org -- "$ORG_SLUG" "Display name"
```

See also [docs/OWNER_ONBOARDING.md](OWNER_ONBOARDING.md) and [docs/RAILWAY_COLLECTOR.md](RAILWAY_COLLECTOR.md).
