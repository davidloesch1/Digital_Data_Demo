# Nexus product vision

This document outlines how we evolve the lab into a **hosted behavioral layer**: a small customer-facing **snippet**, **org-scoped** data and APIs, a **central internal portal** for provisioning, and a **separate** tenant product surface later for tuning and naming. It is informed by multi-tenant SaaS patterns (e.g. config handshake, partitioned data) but is **not** a rigid implementation spec—adjust as we learn.

---

## What we’re building

Customers embed a **lightweight loader** on their properties. The loader:

1. Identifies the **organization** (and authenticates with a **publishable** credential).
2. Fetches **org-specific runtime config** (thresholds, model asset pointers, collector endpoint hints, feature flags).
3. Boots the **worker / fingerprint pipeline** under a stable contract.
4. Sends compact events (**fingerprints + metadata + replay links**) to our **tenant-partitioned** backend.

**FullStory** (or similar) remains the replay surface: we store vectors and **deep links**, not video. Positioning: *intelligent routing into existing replay*, not a competing player.

---

## 1. Customer site: snippet and script loading

**Goal:** minimal copy-paste, versioned assets from our CDN, no long-lived secrets in query strings.

**Illustrative embed:**

```html
<script
  async
  src="https://cdn.example.com/v1/nexus-loader.js"
  data-org="org_xxx"
  data-publishable-key="nx_pub_…"
></script>
```

**Loader responsibilities:**

- Read `data-org` / `data-publishable-key` (or a single `Nexus.init({ … })` if we prefer imperative bootstrap).
- Call **`GET /v1/config`** (or equivalent) with the publishable key in a **header** (e.g. `Authorization: Bearer nx_pub_…`)—avoid putting keys in URL query params (logs, referrers).
- Load **`worker.js`** (and related assets) from the CDN with paths compatible with customer **CSP**; document required `script-src`, `worker-src`, `connect-src`.
- Apply config to the worker (energy gate, inference cadence, etc.) instead of hard-coding only in-repo constants.
- Degrade gracefully: cached defaults + retry if config fetch fails.

---

## 2. Org IDs and data partitioning

**Identity**

- Opaque **`org_id`** (e.g. `org_…`).
- **Publishable key** — browser snippet (rate-limited, origin-scoped where possible).
- **Secret key** — server-to-server, webhooks, exports (optional in early phases).
- **Admin auth** — internal portal (and later customer dashboard) via session/JWT/OIDC—not the publishable key.

**Partitioning strategy (evolve over time)**

| Approach | Notes |
|----------|--------|
| **Logical (recommended MVP)** | Every row includes `org_id`; all queries filter `WHERE org_id = :org`. Middleware binds `:org` from validated key—**never** trust raw `org_id` from client body alone. |
| **Row-level security (Postgres)** | Optional hardening: policies enforce `org_id` match on read/write. |
| **Physical isolation** | Per-tenant DB or schema—ops-heavy; defer until enterprise or compliance demand. |

**Event shape (conceptual):** `org_id`, `session_id` / replay URL, `timestamp`, `fingerprint[]`, `label`, `challenge_module`, `event_id`, ingestion metadata. Replace single global `warehouse.jsonl` with **append-only, queryable** storage (tables or object store + index) with retention and per-org limits.

---

## 3. Control plane vs data plane

**Data plane**

- Ingest: `POST /v1/ingest` (name TBD; may wrap today’s `/collect` semantics).
- Read paths for analytics/dashboards: always **org-scoped**, paginated or windowed (similar spirit to “last N events” caps).

**Control plane**

- **`GET /v1/config`** — read by snippet/worker; short TTL cache / `ETag` friendly.
- **`PATCH /v1/settings`** (later) — customer admins tune thresholds and naming; auth distinct from publishable key.
- **Internal-only endpoints** — org lifecycle, key rotation, suspend, plan limits—**not** callable with the publishable snippet key.

---

## 4. Internal portal (central provisioning—not the customer dashboard)

**Users:** operators at our company (trusted access only). **Not** self-serve customer signup at first.

**MVP capabilities**

- Create **organization** (display name, slug, plan/notes).
- Issue and **rotate** publishable (and optional secret) keys; **revoke**; surface coarse usage (last seen, volume).
- Set **default AI / pipeline config** for that org (gates, inference interval, asset URLs).
- Configure **allowed origins** / domains for CORS and key use (reduces casual misuse if a key leaks).
- Optional free-text fields for **FullStory org** context (documentation only unless we build a formal FS integration).

**Access control:** e.g. SSO restricted to company email, or VPN + strong auth—match our threat model.

**Hosting:** dedicated deploy (e.g. `admin.` subdomain), **not** mixed into the public marketing `lab_site` root without hard auth and route separation.

---

## 5. Customer-facing dashboard (later phase)

Distinct from the internal portal:

- Threshold sliders, archetype / cluster naming, webhooks (Slack/Teams), team invites.
- Surfaces that reuse patterns we already proved in the **discovery dashboard** (e.g. “open in FullStory” from stored `session_url`).

Ship **after** multi-tenant ingest + config + internal ops are boringly reliable.

---

## 6. Cross-cutting concerns (set up early)

- **Key scopes:** what each key type may call; rotation and audit trail in the internal portal.
- **Rate limits and payload caps** on ingest (align with current ~2MB body limits where relevant).
- **Observability:** per-org ingest errors, config fetch failures, latency.
- **Legal / privacy:** DPA, retention, region (EU/US), customer-facing disclosure snippet for *their* privacy policies.
- **API versioning:** `/v1/` URLs and pinned loader paths so `/v2/` can ship without breaking old embeds.
- **Staging vs production:** separate Vercel Preview + staging collector/DB so `product` branch work never touches marketing prod data.

---

## 7. Loose implementation order

1. Multi-tenant storage + ingest authenticated by publishable key → enforced `org_id` on every row.  
2. **`GET /v1/config`** + loader wiring into the worker.  
3. **Internal portal** for org + key + defaults + CORS/origin policy.  
4. Harden staging/prod split (Railway + Vercel env scoping).  
5. Customer dashboard + settings write path + webhooks.  
6. Deeper isolation, RLS, enterprise controls as needed.

---

## Document status

Living document on the **`product`** branch; revise as we ship slices and learn constraints (CSP, FS URL semantics, billing, etc.).
