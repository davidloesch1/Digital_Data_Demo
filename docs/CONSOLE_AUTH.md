# Nexus Console · Magic link auth (Resend + Vercel)

Hosted **`lab_console`** on Vercel uses **first-party cookies** and **serverless routes** under **`/api/*`**. The browser never sends a session JWT to the collector cross-origin; Vercel calls the collector **server-to-server** using secrets.

## Flow

1. User opens **`/login.html`**, enters **org slug** + **email**.
2. **`POST /api/auth/magic-request`** (Vercel) calls **`POST /bff/v1/magic-token`** on the collector with **`CONSOLE_BFF_SECRET`**, stores a short-lived token in Postgres, returns plaintext token to Vercel only.
3. Vercel sends email via **[Resend](https://resend.com/)** with link  
   **`{CONSOLE_PUBLIC_URL}/api/auth/callback?token=...&next=...`**
4. **`GET /api/auth/callback`** redeems via **`POST /bff/v1/magic-redeem`**, receives a **session JWT**, sets **`nexus_console_session`** (**HttpOnly**), redirects to **`/dashboard.html`** (or `next`).
5. **`GET /api/summary`** reads the cookie, forwards **`Authorization: Bearer <jwt>`** to **`GET /bff/v1/summary`** on the collector.
6. **`dashboard.js`** tries **`/api/summary`** with **`credentials: 'same-origin'`** first; if that fails (e.g. local static serve without API routes), it falls back to **direct collector URL + publishable key** from **`nexus-env`**.

## Collector environment

| Variable | Purpose |
|----------|---------|
| **`CONSOLE_BFF_SECRET`** | Shared secret; Vercel sends **`Authorization: Bearer …`** on **`/bff/v1/magic-token`** and **`/bff/v1/magic-redeem`**. |
| **`CONSOLE_JWT_SECRET`** | Signs session JWTs (optional; defaults to **`CONSOLE_BFF_SECRET`**). Prefer a distinct long random value in production. |
| **`CONSOLE_SESSION_TTL_SEC`** | Optional JWT lifetime (default **7 days**, max **30 days**). |

Requires **Postgres** (same as **`/v1/*`**). New table **`console_magic_tokens`** is created on migrate.

## Vercel environment (Console project)

| Variable | Purpose |
|----------|---------|
| **`NEXUS_COLLECTOR_ORIGIN`** | **`https://your-collector…`** (no trailing slash). |
| **`CONSOLE_BFF_SECRET`** | Must match collector **`CONSOLE_BFF_SECRET`**. |
| **`CONSOLE_PUBLIC_URL`** | **`https://your-console.vercel.app`** (or custom domain); used in magic-link emails. |
| **`RESEND_API_KEY`** | Resend API key. |
| **`RESEND_FROM`** | Verified sender, e.g. **`Nexus &lt;nexus@yourdomain.com&gt;`**. |
| **`RESEND_MAGIC_SUBJECT`** | Optional email subject override. |

**CORS:** Browser calls only your Vercel origin for the console; the collector does not need to allow arbitrary dashboard origins for **`/bff/v1/summary`** when traffic is Vercel→collector server-side.

## Operational notes

- **Org slug** must already exist (provision via **`/internal/admin`** or **`create-org`**).
- **Any email** can request a link for that org in this MVP — add **`allowed_emails`** per org or SSO later to restrict senders.
- Some mail clients **prefetch GET links**; that can consume one-time tokens. For hardened prod, switch to a **POST confirmation** step or short-lived codes.
- **Revoke** access by clearing cookie (**Log out**) or rotating **`CONSOLE_JWT_SECRET`** / waiting for JWT expiry.

## Local development

- **`npx serve lab_console`** has **no** `/api` routes → dashboard uses **fallback** (**`NEXUS_PUBLISHABLE_KEY`** + **`NEXUS_DASH_API`**).
- Use **`vercel dev`** in **`lab_console/`** to exercise magic link + **`/api/summary`** locally.
