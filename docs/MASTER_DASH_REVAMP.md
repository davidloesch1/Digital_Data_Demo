# Master dashboard revamp (RFC)

Incremental revamp of [collector/admin-portal/master-dash/](collector/admin-portal/master-dash/) on the **static HTML/JS/CSS** stack. Slice 1 ships **Friction triage**: global shell (context + freshness + guided/analyst), schema health, friction signal rates, Postgres `nexus_friction_context` table, and a ranked **review queue** with focus-session actions.

## Information architecture (target)

| Area | Role |
|------|------|
| **Global shell** | Org, optional domain/site hint, environment label, time range (reuses date filters), freshness (`GET /health`), Guided vs Analyst, contract banner |
| **Home / friction (slice 1)** | Cards answering job stories 1–4 below |
| **Exploration** | Existing cloud, parallel, radar (unchanged in slice 1) |
| **Library** | Gold + prototypes + vocabulary — later slice |

## Job stories (acceptance spine)

1. Is ingestion healthy right now (volume, errors, schema mix), and did anything break after deploy or config change?  
2. For this org/domain/environment, what time range should we trust by default—and how stale is the data?  
3. Where is friction concentrated in the current window, and which silent-signal kinds show up?  
4. Which sessions look worth reviewing first (heuristic: friction signals + prototype uncertainty)?  
5. Session timeline deep-dive — **slice 2** (shipped: merged kinetic + FullStory table in Friction shell).  
6. Cluster growth — **later**.  
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

Until payloads carry a canonical `site_key`, the **Domain / site hint** field filters client-side by substring match on `session_url` + `label` (case-insensitive). Empty means “all rows in the current warehouse load.”

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
