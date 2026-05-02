# Owner playbook: manual orgs & sharing with site owners

You **provision every org** (nothing self-serve here). This doc is the checklist and the exact blocks you can paste into email or a ticket for **website owners**.

---

## Prerequisites (your side)

| Piece | You need |
|--------|-----------|
| Collector | Deployed with **Postgres** (`DATABASE_URL`, `PUBLISHABLE_KEY_PEPPER`). |
| Internal admin | `INTERNAL_ADMIN_TOKEN` set on collector → portal at **`https://<collector>/internal/admin`**. |
| CORS | Collector **`CORS_ORIGINS`** includes **each customer site origin** (scheme + host + port) and your **hosted console** origin if the browser calls the collector directly from either. |

---

## 1. Create an organization

### Option A — Internal admin (browser)

1. Open **`https://<YOUR_COLLECTOR_HOST>/internal/admin`**
2. Paste **`INTERNAL_ADMIN_TOKEN`** → Unlock.
3. **Provision org + key**: fill **Slug** (e.g. `acme-corp`) and **Display name** → **Create org & key**.
4. **Copy the publishable key** (`nx_pub_…`) immediately — it is **not** shown again.

### Option B — CLI (from your laptop)

```bash
cd collector
export DATABASE_URL="postgresql://..."
export PUBLISHABLE_KEY_PEPPER="…same as collector deploy…"
npm run create-org -- acme-corp "Acme Corp"
```

Save the printed **`nx_pub_…`** key.

---

## 2. Record what you’ll share internally

| Field | Example | Notes |
|--------|---------|--------|
| **Org slug** | `acme-corp` | Matches internal admin / CLI; used on **`login.html`** if you use magic link. |
| **Publishable key** | `nx_pub_…` | Scoped to this org; treat like a capability token (rotate/revoke if leaked). |
| **Collector public URL** | `https://your-collector.up.railway.app` | No trailing slash for snippets. |

---

## 3. Email / ticket for the **website owner** (copy-paste)

Replace placeholders `{{…}}` before sending.

### Subject (suggested)

`Nexus capture snippet for {{SITE_NAME}}`

### Body — snippet (their `<head>`)

Tell them to load this **after** their FullStory snippet (or wherever they load analytics), adjusting paths if they host the file themselves.

```html
<!-- Nexus behavioral capture — provided by {{YOUR_COMPANY}} -->
<script>
  window.NEXUS_PUBLISHABLE_KEY = "{{NX_PUB_KEY}}";
  window.NEXUS_API_BASE = "{{COLLECTOR_ORIGIN}}";
</script>
<script src="{{COLLECTOR_ORIGIN}}/sdk/nexus-snippet.js" defer></script>
```

**Snippet file:** each collector serves **`GET /sdk/nexus-snippet.js`** (same behavior as **`packages/browser/nexus-snippet.js`** in the repo — keep them in sync). After you create an org in **`/internal/admin`**, the UI fills this block for you.

Alternate: host **`packages/browser/nexus-snippet.js`** yourself if you do not want owners loading script from the collector origin — see **`packages/browser/README.md`**.

### Body — what they should verify

1. Deploy the page, open DevTools → **Network**.
2. Confirm **`POST {{COLLECTOR_ORIGIN}}/v1/ingest`** returns **200** after browsing (mouse movement / scroll helps).
3. If they see **CORS errors**, ask them for the **exact origin** they use (e.g. `https://www.acme.com`) so you can add it to **`CORS_ORIGINS`** on the collector and redeploy.

---

## 4. Console access for the customer (optional)

Pick one model and describe it clearly in the same email.

### A — Magic link (hosted console on Vercel)

- **Login URL:** `https://<YOUR_CONSOLE_HOST>/login.html`
- They need **org slug** + **their email** (see **`docs/CONSOLE_AUTH.md`** for your Resend/DNS setup).
- **Dashboard:** `https://<YOUR_CONSOLE_HOST>/dashboard.html`

### B — Pilot without magic link

- You can give them **only** the snippet and handle analytics yourself on an internal console build that uses **their** publishable key in Vercel env (single-tenant deploy). Same repo pattern as **`lab_console`** + **`NEXUS_PUBLISHABLE_KEY`** inject — not ideal at scale but fine for one pilot.

---

## 5. Revoke or rotate a key

1. Internal admin → **Revoke publishable key** (paste full `nx_pub_…`), **or**
2. CLI / DB procedure your team uses.

Then issue a **new** key and send an updated snippet block.

---

## 6. Quick checklist (you)

- [ ] Org created; slug + `nx_pub_…` stored securely.
- [ ] Customer origins on **`CORS_ORIGINS`**.
- [ ] Snippet URL reachable from customer site (HTTPS).
- [ ] Customer confirmed **`/v1/ingest`** 200.
- [ ] Console URL + login instructions sent (if they get dashboard access).

---

## Related docs

- **`DEPLOY.md`** — collector env reference.
- **`docs/PRODUCTION_ORGS.md`** — Postgres / org mode overview.
- **`docs/CONSOLE_AUTH.md`** — magic link + Resend (optional).
- **`docs/VERCEL.md`** — hosting **`lab_console`** on Vercel.
- **`packages/browser/README.md`** — snippet behavior and options.
