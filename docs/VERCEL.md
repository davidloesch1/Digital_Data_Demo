# Vercel: Nexus Console (`lab_console`)

Deploy the operator UI from **`lab_console/`** (dashboard, segmentation, console hub). Customer-facing sites are separate: you host those wherever you want and wire the snippet + publishable key there.

This guide assumes production traffic uses **Postgres + `/v1/*`** on the collector; Vercel injects secrets at **build** time from environment variables, not from git.

---

## 1. Create / configure the project

1. In [Vercel](https://vercel.com), **Import** your Git repo.
2. **Settings → General → Root Directory:** `lab_console`
3. **Settings → Build & Development:**
   - **Framework Preset:** Other (no framework build).
   - **Build Command:** `npm run build` — runs `lab_console/scripts/inject-nexus-env.js` and writes `js/nexus-env.secrets.js`.
   - **Output Directory:** `.`
   - **Install Command:** `npm install` (default).

Optional: use **`lab_console/vercel.json`** instead of typing build commands in the dashboard.

---

## 2. Environment variables

| Name | Purpose |
|------|---------|
| `NEXUS_PUBLISHABLE_KEY` | `nx_pub_…` from `npm run create-org` — switches the browser to **`/v1/ingest`** / **`/v1/summary`**. |
| `NEXUS_API_BASE` | Collector origin with **`https://`**. |

Optional: `NEXUS_COLLECT_BASE`, `NEXUS_DASH_API` — override POST vs dashboard fetch hosts.

**Preview vs Production:** Vercel injects env vars at **build** time from the deployment type. If **`NEXUS_PUBLISHABLE_KEY`** is missing at build, pages fall back to **`POST /collect`**. After fixing scopes, **Redeploy**.

---

## 3. Collector CORS

Allow your **`.vercel.app`** (or custom) console origin on **`CORS_ORIGINS`**. Allow each **customer property origin** that POSTs captures as well.

---

## 4. Smoke test

1. Open **`…/dashboard.html`** — warehouse fetch should hit **`…/v1/summary`** when the key is injected.
2. **`GET /health`** on the collector: **`multi_tenant: true`**, **`database: connected`**.

---

## See also

- **`docs/PRODUCTION_ORGS.md`** — Postgres, pepper, `create-org`, `DISABLE_LEGACY_FILE_WAREHOUSE`.
- **`DEPLOY.md`** — collector env reference.
