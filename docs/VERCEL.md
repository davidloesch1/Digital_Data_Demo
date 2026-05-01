# Vercel: deploy the lab (`lab_site`)

This guide assumes you are **not** using the old single-file warehouse for production traffic—you use **Postgres + `/v1/*`** on the collector (Railway or similar), and Vercel only hosts the **static lab** with secrets coming from **Vercel environment variables**, not from git.

---

## 1. Create / configure the project

1. In [Vercel](https://vercel.com), **Import** your Git repo (or connect it).
2. Open the project → **Settings → General**:
   - **Root Directory:** `lab_site`  
     (Only this folder is deployed; `collector/` is not built on Vercel.)
3. **Settings → Build & Development**:
   - **Framework Preset:** Other (or “No framework”) — there is no Next/React build.
   - **Build Command:** `npm run build`  
     This runs `lab_site/scripts/inject-nexus-env.js` and writes `js/nexus-env.secrets.js` for that deployment.
   - **Output Directory:** `.` (current directory after build).
   - **Install Command:** `npm install` (default is fine; `lab_site/package.json` has no extra deps but keeps the workflow standard.)

If you prefer not to rely on dashboard fields, the repo includes **`lab_site/vercel.json`** with the same build/install commands.

---

## 2. Environment variables (Production / Preview)

In **Settings → Environment Variables**, add at least:

| Name | Environment | Purpose |
|------|-------------|---------|
| `NEXUS_PUBLISHABLE_KEY` | Production (and Preview if you test there) | `nx_pub_…` from `npm run create-org` — tells the lab to use **`/v1/ingest`** and **`/v1/summary`**. |
| `NEXUS_API_BASE` | Same | HTTPS origin of your collector, **no trailing slash**, e.g. `https://your-service.up.railway.app`. |

Optional (only if ingest and dashboard use different hosts):

| Name | Purpose |
|------|---------|
| `NEXUS_COLLECT_BASE` | Override collector URL for POSTs only. |
| `NEXUS_DASH_API` | Override collector URL for the dashboard fetch only. |

**Preview vs Production:** use a **Preview** key + **staging** collector URL for `product` branch previews, and **Production** vars for the live marketing site—so previews never write to prod data.

After changing env vars, **Redeploy** (Deployments → ⋮ → Redeploy) so `npm run build` runs again and regenerates `nexus-env.secrets.js`.

---

## 3. Collector CORS (Railway etc.)

The browser will call your collector from your **`.vercel.app`** (or custom) origin. On the collector service set **`CORS_ORIGINS`** to that exact origin, e.g.:

`https://your-project.vercel.app`

Use a **comma-separated list** if you have Preview URLs too (each preview hostname is different unless you use a single staging domain).

---

## 4. Smoke test after deploy

1. Open the deployed **challenges** or **dashboard** URL.
2. In the browser **Network** tab, confirm requests go to **`…/v1/ingest`** or **`…/v1/summary`** (not `/collect` if you’ve turned off legacy on the server).
3. **`GET /health`** on the collector should show **`multi_tenant: true`** and **`database: connected`**.

---

## 5. Security reminder

`NEXUS_PUBLISHABLE_KEY` ends up in **client-side JavaScript**. That’s expected for this pattern; treat it as a **scoped capability token**, rotate it from the DB side when needed, and keep **`CORS`** tight.

---

## See also

- **`docs/PRODUCTION_ORGS.md`** — Railway Postgres, pepper, `create-org`, and when to set **`DISABLE_LEGACY_FILE_WAREHOUSE`** (after you’ve confirmed `/v1` in production).
- **`DEPLOY.md`** — collector env reference.
