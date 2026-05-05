# Cluster tags (HITL / Overseer labels)

Human labels for **saved cluster prototypes** live in **`behavior_cluster_tags`**, linked to **`behavior_clusters`**. The collector already exposes create/list via the dashboard API.

## Data model (short)

| Table | Role |
|--------|------|
| **`behavior_clusters`** | Named prototype per org: `name`, `centroid` (16-D), `filters`, etc. |
| **`behavior_cluster_tags`** | Rows: `tag_kind`, `value`, `cluster_id`. |

**`tag_kind`** must be one of: **`label_pattern`**, **`module`**, **`metric`**, **`note`**, **`fs_signal`**. For overseer vocabulary (*Confusion*, *Comparison*, …), use **`note`** or **`label_pattern`** depending on whether you treat the value as free text vs a controlled pattern.

## HTTP API

### Publishable key (org scoped)

- **`GET /v1/clusters`** — list clusters; each row includes **`tags`** (array of `{ id, tag_kind, value, created_at }`).
- **`POST /v1/clusters/:id/tags`** — body `{ "tag_kind": "note", "value": "Confusion" }`.  
  Implemented in [collector/dashboard-routes.js](collector/dashboard-routes.js).

### Internal admin (master / Retool)

- **`GET /internal/v1/clusters?org_slug=my-org`** — clusters for one org (includes **`tags`**).
- **`POST /internal/v1/clusters/:id/tags?org_slug=my-org`** — same body as above.  
  **`org_slug`** is required as query (or body) for internal routes.

## Master dashboard UI

**[collector/admin-portal/master-dash/index.html](collector/admin-portal/master-dash/index.html)** — section **Cluster prototypes & cohorts**:

- **Saved prototype** dropdown (`dash-cohort-cluster-select`) lists **`behavior_clusters.id`** for the active org.
- **Overseer tag** row: choose **`tag_kind`**, enter label text, **Add tag** — calls **`POST …/clusters/:id/tags`** and refreshes prototypes so **Personas** strip shows updated tags.

**K-means slots** (`lastClusterResult.clusters[i]`) are *ephemeral* UI groupings until you click **Save prototype**; only **saved** clusters have stable **`id`**s for tagging.

## Retool

See [docs/RETOOL_NEXUS_COMMAND_DECK.md](RETOOL_NEXUS_COMMAND_DECK.md) section 6.
