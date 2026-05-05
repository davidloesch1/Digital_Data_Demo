# Master dashboard revamp (RFC)

Incremental revamp of [collector/admin-portal/master-dash/](collector/admin-portal/master-dash/) on the **static HTML/JS/CSS** stack. Slice 1 ships **Friction triage**: global shell (context + freshness + guided/analyst), schema health, friction signal rates, Postgres `nexus_friction_context` table, and a ranked **review queue** with focus-session actions.

## Single-org focus (product contract)

**Decision:** The master dashboard treats **exactly one organization as “in focus”** at a time for interpretation of the warehouse load and for org-scoped internal APIs (friction, snippet config, FullStory helpers, clusters, gold). Cross-tenant views are **secondary**: an explicit **“All orgs”** (or compare) mode may exist later, but the default operator path is **pick org → pick time window → explore**.

**Why:** Aligns the UI with how operators debug (“this tenant”) and with the long-term **org-scoped read** model in [docs/PRODUCT_VISION.md](PRODUCT_VISION.md). Reduces confusion where `master-summary` returns all orgs but side actions required a separate org dropdown.

**Implementation phases (plan only until built):**

1. **Phase A (UI):** After each `master-summary` fetch, **filter rows in memory** to the focused org using `_master_org_slug` (or `org_slug` on the payload). All charts, friction aggregates, and session lists use that filtered set. One **primary org** control (may subsume or sync with today’s prototype-org selector) drives both display and `getMasterOrgSlugForSave()` / `getEffectiveOrgSlugForInternal()`.
2. **Phase B (optional collector):** Add optional `org_slug` (or `org_slugs[]`) query params to `GET /internal/v1/master-summary` (and `GET /local/v1/master-summary`) so the server returns a narrower slice—better for scale and clarity than client-only filtering.

**Escape hatch:** Power users may switch to **all orgs in window** for rare cross-tenant triage; that mode should be clearly labeled and should not be the default.

## Information architecture (target)

| Area | Role |
|------|------|
| **Global shell** | **Primary org (required or strongly defaulted)**, optional domain/site hint (within focused org), environment label, time range (reuses date filters), freshness (`GET /health`), Guided vs Analyst, contract banner; optional explicit **all-orgs** mode (non-default) |
| **Home / friction (slice 1)** | Cards answering job stories 1–4 below |
| **Exploration** | Existing cloud, parallel, radar (unchanged in slice 1) |
| **Library** | Gold + prototypes + vocabulary — later slice |

## Job stories (acceptance spine)

1. Is ingestion healthy right now (volume, errors, schema mix), and did anything break after deploy or config change?  
2. For this org/domain/environment, what time range should we trust by default—and how stale is the data?  
3. Where is friction concentrated in the current window, and which silent-signal kinds show up?  
4. Which sessions look worth reviewing first (heuristic: friction signals + prototype uncertainty)?  
5. Session timeline deep-dive — **slice 2** (shipped: merged kinetic + FullStory table in Friction shell).  
6. Cluster growth — **slice 3 (next; see below)**.  
7. Unified pattern library — **later** (partial today: Gold card + cluster tags).  
8. Compare week-over-week — **after overview compare**.  
9. Stakeholder export — **low priority**.

## Slice 2 — definition of done

- With **session** or **visitor** focus (same as Exploration scope), the **Session timeline (slice 2)** card lists kinetic rows (label, `signal_buffer` summary, nearest prototype when prototypes are loaded) and ingested **FullStory** events with parseable timestamps, **sorted by time**.  
- **Guided** copy explains sources and the jump control to the chart timeline; **Analyst** JSON includes `session_timeline_dive` (counts + preview rows).  
- **No new collector endpoints**: the view composes `warehouse.jsonl` rows already in memory plus `lastFsEvents` from existing `GET /v1/fullstory/events` (or internal equivalent).

## Slice 1 — definition of done

- A user with **internal admin token** and **org slug** can answer **1–4** using only the new **Friction triage** strip and cards (no curl).  
- **Guided** copy explains each card; **Analyst** exposes JSON for the same aggregates + friction API response.  
- **Contract banner** appears when `signal_schema_version` in loaded rows is not exclusively `1` (configurable constant in `js/friction-triage.js`).  
- **Focus session** from the review queue calls the existing session focus behavior.

## Domain / multi-tenant assumptions

Until payloads carry a canonical `site_key`, the **Domain / site hint** field filters client-side by substring match on `session_url` + `label` (case-insensitive). Under **single-org focus**, empty means “all rows for the **focused org** in the current load”; under an explicit all-orgs mode, empty means all rows in that load.

Row provenance for master-summary payloads: **`_master_org_slug`** / **`_master_org_id`** (set by the collector on cross-org reads)—use these for org scoping in Phase A.

## Adding a new card module (for contributors)

1. Prefer a new file under `js/` or `data-cards/`, attach one namespace on `window`.  
2. Do not edit the global shell markup for card-only changes; inject into a dedicated container `id="dash-friction-cards"` or sibling.  
3. Read context only through **init** getters (`getRows`, `getOrgSlug`, …) so tests and refactors stay localized.

## References

- Internal APIs: `GET /health`, `GET /internal/v1/master-summary`, `GET /internal/v1/orgs/:slug/friction-context`  
- Plan: `.cursor/plans/master_dash_revamp_ebf42d8d.plan.md` (do not edit from agents without user request)  
- URL vs DB: [docs/COLLECTOR_URL_VS_DATABASE_URL.md](COLLECTOR_URL_VS_DATABASE_URL.md)

## Implementation (slice 1 shipped in repo)

- Shell + cards + queue: [collector/admin-portal/master-dash/index.html](collector/admin-portal/master-dash/index.html), [collector/admin-portal/master-dash/css/dashboard.css](collector/admin-portal/master-dash/css/dashboard.css)  
- Logic: [collector/admin-portal/master-dash/js/friction-triage.js](collector/admin-portal/master-dash/js/friction-triage.js), wired from [collector/admin-portal/master-dash/dashboard.js](collector/admin-portal/master-dash/dashboard.js) after warehouse loads  
- Collector origin defaults: [collector/admin-portal/master-dash/js/nexus-env.js](collector/admin-portal/master-dash/js/nexus-env.js) (prefer same-origin / localhost over a fixed remote URL)

## Implementation (slice 2 shipped in repo)

- Session timeline card + styles: same [index.html](collector/admin-portal/master-dash/index.html) / [dashboard.css](collector/admin-portal/master-dash/css/dashboard.css)  
- Merge + render: [collector/admin-portal/master-dash/js/session-timeline-dive.js](collector/admin-portal/master-dash/js/session-timeline-dive.js); `init` / `refresh` from [dashboard.js](collector/admin-portal/master-dash/dashboard.js); analyst field from [friction-triage.js](collector/admin-portal/master-dash/js/friction-triage.js)

## Next slice (3) — cluster growth (job story 6)

**Choice:** Ship **cluster growth** before Library / compare / export — it extends Exploration metrics already on the page and stays warehouse-first.

### Slice 3 — definition of done (draft)

- Operators can see **whether clusters / archetypes are stable or shifting** in the current warehouse window **for the focused org** (counts, reassignment signal, or simple growth delta — exact metric TBD in spike).  
- **Guided** explains the metric; **Analyst** exposes the underlying series or JSON.  
- Prefer **no new Postgres** unless the spike shows warehouse-only is insufficient.

## Housekeeping — merge and deploy

- Open a **PR from `behavioral_intelligence_roadmap` into `main`** (or merge locally) when ready for production parity.  
- After merge, confirm **Railway** (or your host) builds the collector image from `main` and that the master-dash static assets are served as expected.

## Explorer copy / UX cleanup (shipped)

- Removed legacy **Challenge module** controls from the behavioral cloud and dimension strips; charts use **all kinetic rows** in the current warehouse load (date range and cloud granularity unchanged). Once **single-org focus** ships, that row set is interpreted as **within the focused org** (or explicit all-orgs mode).  
- Warehouse field **`challenge_module`** and **`resolveChallengeModule`** remain for row typing, prototype lanes, and saved prototype metadata; saved prototypes store `filters.challenge_module` as empty unless the API is extended later.

## Single-org focus — implementation (planned; not shipped)

- Wire **one primary org** control to: in-memory row set after fetch (Phase A), `getMasterOrgSlugForSave`, friction/snippet/FS internal URLs, and gold override semantics (avoid divergent “bag vs API org”).  
- Files likely touched: [collector/admin-portal/master-dash/index.html](collector/admin-portal/master-dash/index.html), [dashboard.js](collector/admin-portal/master-dash/dashboard.js), [friction-triage.js](collector/admin-portal/master-dash/js/friction-triage.js); optional [collector/collector.js](collector/collector.js) + [tenant-db.js](collector/tenant-db.js) for Phase B query params.  
- Mirror changes in [lab_console/](lab_console/) HTML/JS if those entrypoints remain supported.
