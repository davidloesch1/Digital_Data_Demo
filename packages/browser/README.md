# Nexus browser snippet

Minimal **two-script-tag** integration: configure your collector + publishable key, then load **`nexus-snippet.js`**. It periodically POSTs coarse pointer/scroll **kinetic** rows to **`POST /v1/ingest`** (same JSON shape as the rest of this repo’s warehouse). Your operator dashboard (**`lab_console`**) reads them via **`GET /v1/summary`**.

## Prerequisites

1. **Collector** running with Postgres (**`DATABASE_URL`**, **`PUBLISHABLE_KEY_PEPPER`**).
2. **`nx_pub_…`** key from **`collector`** → **`npm run create-org`**.
3. **`CORS_ORIGINS`** on the collector must include your site’s **exact origin** (scheme + host + port).

## Paste on your site

Use **HTTPS** in production. Replace origins and the key.

```html
<!-- 1) Configure (inline). Must run before the snippet. -->
<script>
  window.NEXUS_PUBLISHABLE_KEY = "nx_pub_YOUR_KEY_HERE";
  window.NEXUS_API_BASE = "https://your-collector.example.com";
  // Optional tuning:
  // window.NexusSnippet = { label: "SITE", challenge_module: "site-generic", flushMs: 8000 };
  // Optional stable visitor id (if you set it yourself or via FS.identify flows):
  // window.NEXUS_USER_KEY = "visitor-stable-id";
</script>
<!-- 2) Host this file from your CDN or static origin (same repo path shown for copy/paste). -->
<script src="/packages/browser/nexus-snippet.js" defer></script>
```

**FullStory:** Load FullStory **before** this snippet if you want **`session_url`** to prefer **`FS.getCurrentSessionURL`** when that API exists; otherwise the snippet falls back to **`window.location.href`**.

## Behavior

- Samples **`mousemove`**, **`wheel`**, **`click`** on **`document`** (passive where possible).
- Every **`flushMs`** (default **8000** ms), on tab hide, and on **`pagehide`**, sends one **`type: "kinetic"`** payload with a **16-D** **`fingerprint`** derived from recent movement (not ML-grade—enough to populate the discovery dashboard).
- Exposes **`window.NexusSnippetFlush()`** for manual flush if you need it.

## Files

| File | Role |
|------|------|
| **`nexus-snippet.js`** | Self-contained: applies **`nexus-env`–compatible** `window.NEXUS_*` defaults, then starts capture. |

The collector also serves a copy at **`GET /sdk/nexus-snippet.js`** (file **`collector/sdk/nexus-snippet.js`**). **Keep those two files in sync** when you change capture logic.

Env normalization should stay aligned with **`lab_console/js/nexus-env.js`**; if you change collector URL rules there, mirror the same block at the top of **`nexus-snippet.js`**.

## Security note

The publishable key is visible in the browser (same model as **`lab_console`** build inject). Rotate keys from the collector/DB side when needed; scope **`CORS`** to known origins.
