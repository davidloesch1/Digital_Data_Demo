# Production: org-scoped (multi-tenant) mode

Use this when you want **real product behavior**: each customer’s events live under an **organization** in Postgres, keyed by a **publishable** API key—not one shared `warehouse.jsonl` file.

---

## 1. Collector (e.g. Railway)

Railway UI (root directory, Dockerfile, “error deploying from source”): **`docs/RAILWAY_COLLECTOR.md`**.

1. Add **PostgreSQL** (Railway plugin or external URL) and set **`DATABASE_URL`** on the collector service.
2. Set **`PUBLISHABLE_KEY_PEPPER`** to a long random secret (same value every deploy; never put it in the browser).
3. Set **`CORS_ORIGINS`** to your **exact** site origins (e.g. `https://your-app.vercel.app`).
4. **Disk:** for org-only traffic you do **not** need a Railway volume for `warehouse.jsonl`. Set **`DISABLE_LEGACY_FILE_WAREHOUSE=true`** and point **`WAREHOUSE_PATH`** at a throwaway path (e.g. `/tmp/warehouse.jsonl`) if the process still expects a value—or leave defaults only if legacy routes stay on during migration.
5. After deploy, from your laptop (with network access to the DB):

   ```bash
   cd collector
   export DATABASE_URL="postgresql://…"
   export PUBLISHABLE_KEY_PEPPER="…same as Railway…"
   npm run create-org -- customer-slug "Customer display name"
   ```

   Save the printed **`nx_pub_…`** key for that customer (or for your own org during dogfood).

6. When you still need the old file API during migration, leave **`DISABLE_LEGACY_FILE_WAREHOUSE`** unset. Once every client uses **`/v1/*`**, set **`DISABLE_LEGACY_FILE_WAREHOUSE=true`** so **`/collect`**, **`/summary`**, and **`/discard`** return **410** (see local **`docker-compose.yml`** for a DB-only reference).

**Health check:** `GET /health` should show `multi_tenant: true`, `database: connected`, and `legacy_file_warehouse` as `disabled`, `enabled_parallel`, or `file_only`.

---

## 2. Static site (Vercel, root `lab_site`)

Full UI checklist: **`docs/VERCEL.md`**.

The lab loads **`js/nexus-env.secrets.js`** (optional overrides) then **`js/nexus-env.js`**. For org mode the page must set **`NEXUS_PUBLISHABLE_KEY`** (expected tradeoff for browser ingest).

### Option A — inline before `nexus-env.secrets.js` (simplest)

```html
<script>
  window.NEXUS_PUBLISHABLE_KEY = "nx_pub_…";
  window.NEXUS_API_BASE = "https://your-collector.up.railway.app";
</script>
<script src="js/nexus-env.secrets.js"></script>
<script src="js/nexus-env.js"></script>
```

That switches defaults to **`/v1/ingest`** and **`/v1/summary`** automatically.

### Option B — Vercel build inject (no key in git)

See **`docs/VERCEL.md`** (build command, env vars, Preview vs Production, redeploy after changes). Each deploy runs **`lab_site/scripts/inject-nexus-env.js`**, which rewrites **`js/nexus-env.secrets.js`**.

**Do not** commit the built file if it contains real keys after a local `npm run build`; revert or overwrite before pushing.

---

## 3. Mental model

| Piece | Role |
|-------|------|
| **`nx_pub_…`** | Tells the collector **which org** this browser belongs to (hashed in DB). |
| **`PUBLISHABLE_KEY_PEPPER`** | Server-only salt for hashing keys. |
| **`DISABLE_LEGACY_FILE_WAREHOUSE`** | Forces **org-only** API surface when Postgres is on. |

---

## 4. What’s still manual (next iterations)

- Internal **portal** to create orgs without CLI.
- **`/v1/discard`**, retention policies, and stronger abuse controls.
- Replacing inline keys with **short-lived tokens** if customers require stricter exposure.

See also **`DEPLOY.md`** and **`docs/PRODUCT_VISION.md`**.
