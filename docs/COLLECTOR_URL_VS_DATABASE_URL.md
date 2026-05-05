# Collector URL vs `DATABASE_URL` (common confusion)

| Value | What it is | Example | Used where |
|--------|----------------|----------|------------|
| **Collector public URL** | HTTPS (or HTTP) **origin of the Node/Express app** — the same host where **`GET /health`** works | `https://my-collector.up.railway.app` | Browser **`fetch`**, snippet **`NEXUS_COLLECT_BASE`**, smoke script **`NEXUS_BASE_URL`**, curl to **`/v1/ingest`** |
| **`DATABASE_URL`** | **Postgres** connection URI for the collector process only | `postgresql://user:pass@host:port/railway` | **Railway env** on the collector service, **`npm run create-org`**, **`npm run gold-nearest`** — **never** paste into a browser tool as “API base” |

Browsers **cannot** call `postgresql://…` with `fetch()`. URLs that embed `user:password@` are also blocked or unsafe for `fetch`.

**Rule:** Anything you type into a “base URL” field for HTTP APIs must start with **`https://`** (or **`http://`** for local dev).

See also: [docs/SMOKE_NEXUS_STACK.md](SMOKE_NEXUS_STACK.md).
