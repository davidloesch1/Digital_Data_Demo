# Nexus browser snippet

Minimal integration: load **FullStory** first, then **`nexus-snippet.js`**. Each flush emits a **FullStory analytics event** via **`FS('trackEvent', { name, properties })`** ([Analytics Events](https://developer.fullstory.com/browser/capture-events/analytics-events/)) with a **16-number `fingerprint`**, `event_id`, `label`, `timestamp`, **`session_url`** (prefers **`FS.getCurrentSessionURL(true)`** when available), **`signal_schema_version`**, **`signal_buffer_json`** (stringified rolling buffer of silent signals + flushes), and flattened **`surface_*`** fields from **`css_meta`** (viewport, DPR, color scheme, reduced-motion, root font size).

**Collector POST** (`POST /v1/ingest`) is **optional**: set **`window.NEXUS_DUAL_WRITE = true`** and configure **`NEXUS_PUBLISHABLE_KEY`** + **`NEXUS_API_BASE`** / **`NEXUS_COLLECT_BASE`** so the same JSON body is also sent to the warehouse (`signal_buffer` as JSON array, `css_meta` object, plus the same `signal_schema_version`).

## Prerequisites (FS-first)

1. **FullStory** recording/snippet on the page **before** `nexus-snippet.js` so `window.FS` exists at flush time.
2. **Optional dual-write:** collector running with Postgres, **`nx_pub_…`** key, and **`CORS_ORIGINS`** including the site origin — only needed when **`NEXUS_DUAL_WRITE`** is true.

## Paste on your site

Use **HTTPS** in production.

```html
<!-- 0) FullStory bootstrap first (your org snippet). -->

<!-- 1) Optional inline config before nexus-snippet.js -->
<script>
  // window.NexusSnippet = {
  //   label: "SITE",
  //   event_name: "nexus_kinetic_fingerprint",  // FS event name; max 250 chars
  //   flushMs: 8000,  // clamped 2000–60000; default ~7.5 events/min (under FS ~60/user/page/min)
  //   disabled: false,
  //   heuristics: { hoverLongMs: 1500, dwellIdleMs: 3000, confusionMinPathPx: 2000, signalBufferMax: 20 },
  // };
  // window.NEXUS_HEURISTICS = { dwellEnabled: false };  // optional; overrides NexusSnippet.heuristics
  // window.NEXUS_USER_KEY = "visitor-stable-id";  // optional; sent as a property
  // window.NEXUS_DUAL_WRITE = true;  // optional; also POST to collector:
  // window.NEXUS_PUBLISHABLE_KEY = "nx_pub_…";
  // window.NEXUS_API_BASE = "https://your-collector.example.com";
</script>
<!-- 2) Host from CDN or collector -->
<script src="/packages/browser/nexus-snippet.js" defer></script>
```

### Load order

FullStory must run first so **`session_url`** uses the replay URL API and **`trackEvent`** succeeds. If FS is missing and dual-write is off, the snippet logs a one-time console warning.

### Rate limits

FullStory documents roughly **60 events per user per page per minute** (with burst limits). Default **`flushMs: 8000`** is about **7.5 events/minute**. If you lower **`flushMs`**, stay under FS caps or add your own throttling.

### Privacy (PII)

**`session_url`** may contain sensitive query fragments. Treat custom event properties like any other FS data: use **masking / exclude rules** and your DPA with FullStory as appropriate.

## Behavior

- Samples **`mousemove`**, **`wheel`**, **`click`** on **`document`** (passive where possible).
- Every **`flushMs`**, on tab hide, and on **`pagehide`**, builds one payload (including **`signal_buffer`** / **`css_meta`**) and calls **`FS('trackEvent', …)`** (and optionally **`fetch`** to the collector when **`NEXUS_DUAL_WRITE`** is set). Heuristic thresholds can be tuned via **`NexusSnippet.heuristics`** or **`window.NEXUS_HEURISTICS`** (see **`NEXUS_PLAN.md`** Phase 1).
- Exposes **`window.NexusSnippetFlush()`** for a manual flush.

## Files

| File | Role |
|------|------|
| **`nexus-snippet.js`** | Self-contained: optional **`nexus-env`–compatible** `window.NEXUS_*` defaults when dual-writing, then capture. |

The collector also serves a copy at **`GET /sdk/nexus-snippet.js`** (**`collector/sdk/nexus-snippet.js`**). **Keep those two files in sync** when you change capture logic.

Env normalization should stay aligned with **`lab_console/js/nexus-env.js`** when dual-write paths use collector URLs.

## Security note

When dual-writing, the publishable key is visible in the browser. Rotate keys from the collector/DB side when needed; scope **`CORS`** to known origins.
