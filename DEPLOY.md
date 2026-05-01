# Deploying the Nexus lab + shared warehouse

Target: **one collector API** (Node + JSONL on disk) and **static hosting** for `lab_site`, with **≤20 concurrent users** and a **single shared warehouse**.

## Environment variables (collector)


| Variable                   | Purpose                                                                                                                                 | Default              |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| `PORT`                     | HTTP port                                                                                                                               | `3000`               |
| `WAREHOUSE_PATH`         | Absolute path to append-only JSONL                                                                                                      | `./warehouse.jsonl`  |
| `CORS_ORIGINS`             | Comma-separated allowed browser origins. Omit or `*` for open CORS (dev only).                                                          | (open)               |
| `WAREHOUSE_MAX_BYTES`      | After each write, the oldest JSONL lines are removed until the file is under ~90% of this size (keeps disk usage bounded).                | `524288000` (500 MiB) |
| `SUMMARY_MAX_LINES`      | `GET /summary` returns only the **most recent** *N* non-empty lines (parsed JSON), so the dashboard payload stays small.                    | `1000`               |
| `SUMMARY_QUERY_LIMIT_CAP` | Maximum allowed `?limit=` on `/summary` (caps ad-hoc browser queries).                                                                  | `5000`               |
| `DATABASE_URL`            | Postgres connection string. When set with `PUBLISHABLE_KEY_PEPPER`, **`/v1/ingest`** and **`/v1/summary`** are enabled (multi-tenant). File `/collect` still works in parallel unless you remove it later. | (unset)              |
| `PUBLISHABLE_KEY_PEPPER`  | Server secret used to hash browser publishable keys (`nx_pub_…`). **Must** match the value used when running `npm run create-org` in `collector/`. | (unset)              |

Endpoints: `POST /collect`, `GET /summary` (optional `?limit=`), `POST /discard`, `GET /health`.

**Multi-tenant (Postgres):** `POST /v1/ingest`, `GET /v1/summary?limit=` — authenticate with **`Authorization: Bearer <nx_pub_…>`** or header **`X-Nexus-Publishable-Key`**. Returns **503** if `DATABASE_URL` is not set. Provision orgs and keys from your machine:

```bash
cd collector
export DATABASE_URL="postgresql://user:pass@host:5432/dbname"
export PUBLISHABLE_KEY_PEPPER="long-random-secret"
npm run create-org -- my-org-slug "Display name"
```

The script prints a **`nx_pub_…`** key once; store it in your customer/snippet config. Keys are stored **hashed**; the pepper must never ship to browsers.

### Summary vs disk

- **Disk:** every event is still appended; when the file exceeds `WAREHOUSE_MAX_BYTES`, the **head** of the file is dropped in full lines until size is back under the cap. Oldest data falls off first.
- **Dashboard:** by default the UI only **fetches** the last `SUMMARY_MAX_LINES` rows. That matches ~1000 points in **kinetic** (per-row) mode. In **per session** or **per visitor** mode, one session can own many kinetic rows—if the list looks sparse, raise `SUMMARY_MAX_LINES` (e.g. `15000`) so the last N **lines** still cover enough distinct sessions.

## Local Docker (API + volume)

From the repo root:

```bash
docker compose up --build
```

Collector listens on **[http://localhost:3000](http://localhost:3000)**. Data persists in the `warehouse-data` Docker volume.

Serve the UI locally (separate terminal), for example:

```bash
npx --yes serve lab_site -p 4173
```

Edit `**lab_site/js/nexus-env.js**` and set the collector URL to match where the API runs (for Docker Compose, `http://localhost:3000` is usually correct). Redeploy or hard-refresh the browser after changing it.

Optionally set `**CORS_ORIGINS**` in `docker-compose.yml` to your static origin, e.g. `http://localhost:4173`.

## Frontend API URL

Scripts load `**lab_site/js/nexus-env.js**` first. It sets:

- `window.NEXUS_COLLECT_BASE` — collector origin for kinetic + label POSTs
- `window.NEXUS_DASH_API` — dashboard warehouse fetch (same host as collector unless overridden)
- `window.NEXUS_PUBLISHABLE_KEY` *(optional)* — when set before `nexus-env.js`, defaults switch to **`/v1/ingest`** and **`/v1/summary`** with `Authorization: Bearer …` (multi-tenant Postgres). Override paths with `NEXUS_INGEST_PATH` / `NEXUS_SUMMARY_PATH` if needed.

Example before `nexus-env.js` on a staging page:

```html
<script>window.NEXUS_PUBLISHABLE_KEY = "nx_pub_…";</script>
<script src="js/nexus-env.js"></script>
```

You can set a single base before `nexus-env.js`:

```html
<script>window.NEXUS_API_BASE = "https://your-collector.example.com";</script>
```

Or override only the dashboard: `window.NEXUS_DASH_API`.

## Static hosting (lab only)

Point **Netlify**, **Cloudflare Pages**, or **Vercel** at the `**lab_site`** directory (no build step required). Publish URL becomes your “share with colleagues” link.

After deploy:

1. Deploy the collector to a **public HTTPS** URL (see below).
2. Update `**nexus-env.js`** (or inline `NEXUS_API_BASE`) to that URL and redeploy the static site.

## Collector on Fly.io (example)

From `**collector/`** (where the `Dockerfile` lives):

```bash
cd collector
fly launch --no-deploy   # choose app name, region; Dockerfile detected
fly volumes create warehouse_data --size 1 --region iad
```

Set on the app:

- `WAREHOUSE_PATH=/data/warehouse.jsonl`
- Mount volume `**warehouse_data**` → `**/data**`
- `CORS_ORIGINS=https://your-netlify-site.netlify.app` (your static origin)

```bash
fly secrets set CORS_ORIGINS="https://your-static-origin.example.com"
fly deploy
```

Note the HTTPS app URL (e.g. `https://nexus-collector.fly.dev`) and put it in `**nexus-env.js**`, then redeploy static files.

## Collector on Railway / Render

Create a **Web Service** from this repo, root directory `**collector`**, start command `**npm start`**, attach a **persistent disk** mounted at `/data`, set `WAREHOUSE_PATH=/data/warehouse.jsonl` and `CORS_ORIGINS` as above.

### Railway: persistent volume (warehouse JSONL)

Without a **volume**, `warehouse.jsonl` lives on the container filesystem and is **wiped on redeploy**. Use a volume so `/collect` appends survive restarts and new deployments.

1. In the Railway project, open your **collector** service → **Settings** (or use **⌘K** / right‑click the canvas → create a **Volume** and attach it to this service).
2. **Mount path:** `/data` (must match what the app uses). This repo’s `Dockerfile` defaults `WAREHOUSE_PATH=/data/warehouse.jsonl`.
3. **Variables** on the same service:
   - `WAREHOUSE_PATH=/data/warehouse.jsonl` (redundant with the Dockerfile default but explicit is clearer).
   - `CORS_ORIGINS=https://your-static-site.vercel.app` (comma‑separate multiple origins if needed).
4. **Redeploy** the service after the volume is attached. Volumes are mounted at **container start**, not during the image build ([Railway volumes](https://docs.railway.com/volumes)).
5. **Verify:** `GET https://<your-collector>.up.railway.app/health` — after at least one successful `POST /collect`, `"warehouse": true` means the file exists on disk (usually under the mounted path).

At runtime, Railway sets `RAILWAY_VOLUME_MOUNT_PATH` to your mount path (for logging or future use). Keeping `WAREHOUSE_PATH=/data/warehouse.jsonl` is enough when the volume mount is `/data`.

**Note:** If the Node process ran as a non‑root user, you might need `RAILWAY_RUN_UID=0` so the process can write the volume (see Railway docs). The provided `node:alpine` image runs as root by default.

## Backups

Copy `**warehouse.jsonl`** (or the mounted volume) on a schedule; it is the full dataset.

## Security note

The collector as configured is intended for **trusted pilots**. For wider exposure, add authentication, rate limits, and stricter CORS.