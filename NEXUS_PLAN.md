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
* [ ] **FullStory Indexing:** Ensure all new custom properties are indexed and available in the BigQuery sync.
* [ ] **The Multi-Tenant View:** Re-create `nexus_dna_discovery` to join Fingerprints with FullStory `pages` and `elements` tables, partitioned by `domain`.
* [ ] **Contextual Table:** Create a schema to store the "Rolling Window" strings for every high-friction event.

### Phase 3: The Command Deck (Retool & HITL)
*Focus: Closing the loop between AI math and human meaning.*
* [ ] **Deep-Link Integration:** Wire the **FullStory Generate Context API** to a "Watch Highlights" button.
* [ ] **The Verification UI:** Build a labeling interface where an Overseer can tag clusters as *Confusion, Comparison, Hesitation, or Analysis*.
* [ ] **Gold Standard Export:** Create a one-click "Verify" action that pushes human-labeled vectors to the `gold_standard_vectors` table.

### Phase 4: The Intelligence Refiner (Self-Learning)
*Focus: Automating the naming and evolutionary process.*
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
