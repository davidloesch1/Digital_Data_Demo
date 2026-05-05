# Railway: deploy the collector

## Recommended settings

| Setting | Value |
|--------|--------|
| **Root Directory** | `collector` — **no leading slash** (use `collector`, not `/collector`). |
| **Builder** | **Dockerfile** (Docker), not Railpack/Nixpacks alone. |
| **Dockerfile path** | `Dockerfile` (default when root is `collector`). |

If Railway does **not** offer “Root Directory,” leave the repo root and instead set **Dockerfile path** to **`collector/Dockerfile`** and **Start command** to **`node collector.js`** (or rely on the image `CMD`).

---

## If you see “error deploying from source”

Work through these in order:

1. **Root directory typo**  
   Railway expects `collector`, not `/collector`.

2. **Build logs**  
   Open the failed deployment → **Build Logs** (not just Deploy Logs). Common failures:
   - **`npm ci`** — lockfile out of sync (run `npm install` in `collector/` locally and commit `package-lock.json`).
   - **Docker Hub / registry** — rare pull timeouts; redeploy.

3. **Repo access**  
   Confirm the Railway GitHub app can read the repo and branch you selected.

4. **Postgres not required for the image to build**  
   The Docker **build** does not need `DATABASE_URL`. If the **runtime** crashes, that’s a separate step (variables + deploy logs after the container starts).

5. **Start command override**  
   The running container should execute **`node collector.js`** (same as the Dockerfile `CMD`). If you set a custom start command in the Railway UI, use that — **not** `node index.js` from the repo root.

---

## Runtime variables (after the image builds)

Set on the **collector** service (see **`docs/PRODUCTION_ORGS.md`**):

- `DATABASE_URL` (from Postgres plugin / reference)
- `PUBLISHABLE_KEY_PEPPER`
- `INTERNAL_ADMIN_TOKEN` (optional long random secret — enables **`https://<your-service>/internal/admin`** and **`/internal/v1/*`** ops API)
- `CORS_ORIGINS`
- `DISABLE_LEGACY_FILE_WAREHOUSE=true` when using only `/v1/*`
- `DISABLE_FRICTION_AUTOTRACK=true` — skip auto-append to **`nexus_friction_context`** on **`POST /v1/ingest`** when **`signal_buffer`** contains **CONFUSION** or **DWELL** (default: autotrack on)

Then **`GET /health`** on your public URL.
