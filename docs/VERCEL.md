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
| `NEXUS_API_BASE` | Same | Collector origin: **`https://…`** (include the scheme). Without `https://`, the browser treats the value as a path on your Vercel domain and requests look like `…vercel.app/your-host…/v1/ingest`. **`nexus-env.js`** prepends `https://` for non-local hosts if you omit it. |

Optional (only if ingest and dashboard use different hosts):

| Name | Purpose |
|------|---------|
| `NEXUS_COLLECT_BASE` | Override collector URL for POSTs only. |
| `NEXUS_DASH_API` | Override collector URL for the dashboard fetch only. |

**Preview vs Production:** use a **Preview** key + **staging** collector URL for `product` branch previews, and **Production** vars for the live marketing site—so previews never write to prod data.

**Important — Production vs Preview deployments:** Vercel decides which env vars exist at **build** time from the **deployment type**, not only from branch filters on each variable.

| Git push target | Deployment type | Which env scopes apply |
|-----------------|-----------------|-------------------------|
| Your **Production Branch** (Settings → Git → Production Branch) | **Production** | Only variables enabled for **Production** |
| Any **other** branch | **Preview** | Variables enabled for **Preview** (optional branch / pattern filters) |

So if **Production Branch** is **`product`**, every push to `product` is a **Production** deployment: **Preview-only** `NEXUS_*` variables are **never** injected—your build log will show `(no NEXUS_PUBLISHABLE_KEY)`. Fix one of:

1. Add **`NEXUS_PUBLISHABLE_KEY`** and **`NEXUS_API_BASE`** for **Production** as well (same values, or product-specific ones), **or**
2. Set **Production Branch** to **`main`** if `main` is your “live” branch—then **`product`** pushes become **Preview** deployments and your Preview-scoped vars apply.

Also: variables checked only for **Production** are **not** available on **Preview** builds from other branches—enable **Preview** for `NEXUS_*` there too.

If `NEXUS_PUBLISHABLE_KEY` is missing at build time, the lab falls back to **`POST /collect`** (see `js/nexus-env.js`). After fixing scopes, **Redeploy**.

**If `nexus-env.secrets.js` has `NEXUS_API_BASE` but `NEXUS_PUBLISHABLE_KEY` is still empty:** the build sees one variable but not the other. In the dashboard, open **`NEXUS_PUBLISHABLE_KEY`** and **`NEXUS_API_BASE`** side by side and make **Preview** / **Production** and any **Git branch** restrictions **identical**. Fix a typo (`NEXUS_PUBLISHABLE_KEY` spelling). If the key is marked **Sensitive**, try temporarily duplicating an unsensitive test entry to confirm scope (the publishable key is already exposed in client JS after build).

After changing env vars, **Redeploy** (Deployments → ⋮ → Redeploy) so `npm run build` runs again and regenerates `nexus-env.secrets.js`.

---

## 3. Collector CORS (Railway etc.)

The browser will call your collector from your **`.vercel.app`** (or custom) origin. On the collector service set **`CORS_ORIGINS`** to that exact origin, e.g.:

`https://your-project.vercel.app`

Use a **comma-separated list** for multiple exact origins. For **Vercel Preview** deployments (unique URLs per branch/deploy), you can add **`https://*.vercel.app`** as an extra entry so any `https://…vercel.app` preview is allowed without updating Railway on every deploy (keep your production custom domain as an exact entry if you use one).

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
