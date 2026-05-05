This plan serves as the "source of truth" for the platform's technical and philosophical trajectory.

---

# 🚀 Project Nexus: Behavioral Intelligence Roadmap
**Mission:** To transform raw user telemetry into a self-learning "Digital Soul" that understands human sentiment and autonomously optimizes for zero friction.

---

## 🏗️ The 4-Phase Roadmap

### Phase 1: The Sensor Upgrade (browser `nexus-snippet.js`; server `collector/` for ingest)
*Focus: Capturing high-resolution behavioral intent at the source.*
* [x] **Client-Side Buffer:** Implement a rolling (default 20) event array in **`packages/browser/nexus-snippet.js`** (mirrored at **`collector/sdk/nexus-snippet.js`**) to store the recent event stream.
* [x] **Heuristic Signal Layer:** Code the "Silent Signal" logic:
    * **HOVER_LONG:** `mouseenter` > 1500ms > No `mouseleave`.
    * **DWELL:** Zero activity for >3000ms + Viewport Center identification.
    * **CONFUSION:** High velocity + rapid direction changes ($>2000px$ in 3s).
* [x] **Enriched Payload:** Update the `FS('trackEvent')` to bundle the **16D Vector**, the **Signal Buffer**, and **CSS Metadata**.

**Progressive rollout (heuristics → config)** — keep Phase 1 aligned with `docs/PRODUCT_VISION.md` without skipping “learn in production”:

1. **Defaults in the snippet** — ship NEXUS_PLAN thresholds in code; keep each silent signal as a small, isolated block of logic.
2. **Optional `window.NexusSnippet` / `window.NEXUS_HEURISTICS` overrides** — per-site or per-lab tuning (thresholds, toggles) before any new backend contract.
3. **`signal_schema_version` on emitted payloads** — when the signal buffer ships on `trackEvent` / ingest, version the JSON shape so BigQuery and dashboards stay stable as fields evolve.
4. **`GET /v1/config`** — org-scoped thresholds and feature flags **merged over defaults**, short-TTL cache, degrade to defaults if the fetch fails.
5. **`PATCH /v1/settings`** (or internal-only tuning first) — only after multi-tenant ingest, auth, and basic ops are boringly reliable.

### Phase 2: The Platinum Schema (BigQuery)
*Focus: Wiring math to visual reality across multiple domains.*

*Warehouse notes:* SQL sketches and property inventory live in **`docs/BIGQUERY_NEXUS_SIGNALS.md`**. Example BigQuery view sketch: **`scripts/sql/nexus_dna_discovery.example.sql`**. Browser runtime policy is served by **`GET /v1/config`** (collector) and stored per org in **`organizations.snippet_runtime_config`** (**`GET` / `PATCH /internal/v1/orgs/:slug/snippet-runtime-config`**).

* [ ] **FullStory Indexing:** Ensure all new custom properties are indexed and available in the BigQuery sync.
* [ ] **The Multi-Tenant View:** Re-create `nexus_dna_discovery` to join Fingerprints with FullStory `pages` and `elements` tables, partitioned by `domain`.
* [x] **Contextual Table (Postgres MVP):** **`nexus_friction_context`** + **`GET` / `POST /internal/v1/orgs/:slug/friction-context`** + **auto-row on `POST /v1/ingest`** when **`signal_buffer`** contains **CONFUSION** or **DWELL** (opt out **`DISABLE_FRICTION_AUTOTRACK`**). BigQuery mirror / dedupe / scoring: TBD (see **`docs/BIGQUERY_NEXUS_SIGNALS.md`**).*

### Phase 3: The Command Deck (Retool & HITL)
*Focus: Closing the loop between AI math and human meaning.*
* [ ] **Deep-Link Integration:** Wire the **FullStory Generate Context API** to a "Watch Highlights" button. *(Collector **backend**: **`POST /internal/v1/fullstory/generate-context`** — **`docs/FULLSTORY_ACTIVATION.md`**; Retool / app button TBD — see **`docs/RETOOL_NEXUS_COMMAND_DECK.md`**.)*
* [x] **The Verification UI (minimal):** Overseer labels on **saved prototypes** via **`POST /v1/clusters/:id/tags`** (publishable key) or internal **`POST /internal/v1/clusters/:id/tags`**, plus master-dash **Add tag to prototype** — **`docs/CLUSTER_TAGS_HITL.md`**. Full Retool-dedicated labeling workspace TBD.
* [x] **Gold Standard Export (backend):** Postgres **`gold_standard_vectors`** + **`GET` / `POST /internal/v1/orgs/:slug/gold-standard-vectors`** (see **`docs/GOLD_STANDARD_VECTORS.md`**). **Master-dash UI:** list + save on **`/internal/admin/master-dash`** (Gold card). Retool-only workspace TBD (**`docs/RETOOL_NEXUS_COMMAND_DECK.md`**).

### Phase 4: The Intelligence Refiner (Self-Learning)
*Focus: Automating the naming and evolutionary process.*
* [x] **Phase 4 prototype (CLI):** Top-k cosine vs Postgres **`gold_standard_vectors`** — **`npm run gold-nearest`** in **`collector/`** ([`collector/scripts/gold-nearest-neighbors.js`](collector/scripts/gold-nearest-neighbors.js)); warehouse notes in **`docs/BIGQUERY_NEXUS_SIGNALS.md`** (section 7).
* [ ] **Centroid Mapping:** Automate the calculation of "Behavioral Centroids" using Cosine Similarity:
    $$\text{similarity} = \frac{\mathbf{A} \cdot \mathbf{B}}{\|\mathbf{A}\| \|\mathbf{B}\|}$$
* [ ] **Auto-Labeling Service:** Implement a Vercel function that auto-names incoming fingerprints based on proximity to Gold Centroids.
* [ ] **Gemini Audit Loop:** Schedule a weekly task where Gemini analyzes "Low Confidence" clusters and suggests Manifesto updates.

---

## 🧠 Guiding Principles (The Philosophy)
1.  **Context is King:** A vector without a rolling window is just noise. Always prioritize "The Why" over "The What."
2.  **Explainable AI:** If a human can't understand why the AI made a decision by watching the 10-second replay, the AI is wrong.
3.  **Privacy by Design:** All raw context must be scrubbed of PII (Personal Identifiable Information) before hitting the buffer.
4.  **Sovereign Data:** While we use FullStory for the "Replay," the "Behavioral Library" (Vectors + Sentiments) belongs exclusively to the Nexus platform.



---

## 📊 Success Metrics (KPIs)
| Metric | Goal | How to Measure |
| :--- | :--- | :--- |
| **Label Accuracy** | >90% | Percentage of AI labels verified as "Correct" by humans. |
| **Friction Reduction** | <0.3 Avg | The rolling `dna_v1` score across all managed domains. |
| **AI Autonomy** | <5% Review | Percentage of incidents requiring manual human labeling. |
| **Evolution Velocity** | 1 PR / Week | Number of successful code optimizations merged via the Heartbeat. |

---
