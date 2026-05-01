importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs");

// --- CONFIGURATION ---
const CONFIG = {
    WINDOW_SIZE: 50,
    MATCH_THRESHOLD: 0.96,        // Slightly stricter
    SMOOTHING_WINDOW: 5,
    ENERGY_THRESHOLD: 0.00,       // 👈 MINIMUM movement required to trigger AI (Adjustable)
    INFERENCE_FREQUENCY: 20,      // Check every 20 events
    WEIGHTS_PATH: 'model_weights.json',
    SIGNATURES_PATH: 'signatures.json'
};

// --- STATE ---
let model = null;
/** False until weights + signatures load; inference and kinetic POSTs are skipped when false. */
let modelReady = false;
let signatures = {};
let eventBuffer = [];
let predictionHistory = [];
let lastEventTime = 0;
let currentLabel = "none";
let currentChallengeModule = null;
let currentUserKey = null;
let currentSessionUrl = "unknown";
/** Set from main thread CONFIG message (matches window.NEXUS_COLLECT_BASE). */
let collectBase = "http://localhost:3000";
/** Relative path e.g. /collect or /v1/ingest */
let ingestPath = "/collect";
/** Bearer token for /v1/ingest (empty for legacy file ingest). */
let publishableKey = "";

/**
 * Calculates "Kinetic Energy" in the buffer.
 * Uses pointer displacement plus (when planar motion is tiny) a small boost per step so
 * keyboard-heavy labs (e.g. speed–accuracy) still accumulate enough signal once the window is full.
 */
function calculateEnergy(buffer) {
    let energy = 0;
    for (let i = 1; i < buffer.length; i++) {
        const dx = buffer[i][1] - buffer[i-1][1];
        const dy = buffer[i][2] - buffer[i-1][2];
        const planar = Math.sqrt(dx * dx + dy * dy);
        energy += planar;
        const dtFeat = buffer[i][3] - buffer[i-1][3];
        energy += Math.abs(dtFeat) * 0.18;
        if (planar < 1e-12) {
            energy += 0.00115;
        }
    }
    return energy;
}

function normalizeEvent(evt) {
    const timeDelta = lastEventTime ? (evt.When - lastEventTime) : 0;
    lastEventTime = evt.When;
    let typeID = 0, x = 0, y = 0;
    if (evt.Kind === 57 && evt.Args && evt.Args[0] === 12) {
        typeID = 1; 
        x = (evt.Args[4] || 0) / 2000; 
        y = (evt.Args[5] || 0) / 2000;
    } else if (evt.Kind === 57 && evt.Args && evt.Args[0] === 10) {
        typeID = 2; 
        y = (evt.Args[2] || 0) / 2000;
    }
    return [typeID, x, y, Math.min(timeDelta / 1000, 10)];
}

/** True if the vector has finite values and is not numerically all zeros (avoids junk warehouse rows). */
function isUsableEmbedding(v) {
    if (!v || !v.length) return false;
    let sumSq = 0;
    for (let i = 0; i < v.length; i++) {
        const x = v[i];
        if (!Number.isFinite(x)) return false;
        sumSq += x * x;
    }
    return sumSq > 1e-12;
}

async function init() {
    try {
        self.postMessage({ type: 'STATUS', msg: '🏗️ LOADING MODEL...' });
        const m = tf.sequential();
        m.add(tf.layers.lstm({ units: 32, inputShape: [CONFIG.WINDOW_SIZE, 4], returnSequences: true, kernelInitializer: 'zeros' }));
        m.add(tf.layers.lstm({ units: 16, returnSequences: false, kernelInitializer: 'zeros' }));

        const weights = await (await fetch(CONFIG.WEIGHTS_PATH)).json();
        m.setWeights(weights.map(w => tf.tensor(w)));
        signatures = await (await fetch(CONFIG.SIGNATURES_PATH)).json();

        tf.tidy(() => {
            m.predict(tf.zeros([1, CONFIG.WINDOW_SIZE, 4]));
        });

        model = m;
        modelReady = true;
        self.postMessage({ type: 'STATUS', msg: '✅ DETECTION ACTIVE' });
    } catch (e) {
        model = null;
        modelReady = false;
        signatures = {};
        const detail = e && e.message ? String(e.message) : String(e);
        self.postMessage({ type: 'STATUS', msg: '⚠️ LOAD ERROR', detail });
    }
}

init();

self.onmessage = async (e) => {
    const { type, payload, sessionUrl, challenge_module, nexus_user_key } = e.data;
    if (type === "CONFIG") {
        if (e.data.collectBase) {
            collectBase = String(e.data.collectBase).replace(/\/?$/, "");
        }
        if (e.data.ingestPath != null && String(e.data.ingestPath).trim() !== "") {
            let p = String(e.data.ingestPath).trim();
            ingestPath = p.indexOf("/") === 0 ? p : "/" + p;
        }
        if (e.data.publishableKey != null) {
            publishableKey = String(e.data.publishableKey).trim();
        }
        return;
    }
    if (type === 'SET_LABEL') {
        currentLabel = payload;
        currentChallengeModule =
            challenge_module !== undefined && challenge_module !== null && String(challenge_module).trim() !== ""
                ? String(challenge_module).trim()
                : null;
        currentUserKey =
            nexus_user_key !== undefined && nexus_user_key !== null && String(nexus_user_key).trim() !== ""
                ? String(nexus_user_key).trim()
                : null;
        return;
    }
    if (sessionUrl) currentSessionUrl = sessionUrl;

    try {
        const stream = new Response(payload).body;
        const decompressed = await new Response(stream.pipeThrough(new DecompressionStream('gzip'))).text();
        const data = JSON.parse(decompressed);
        if (!data.Evts) return;

        data.Evts.forEach((evt, index) => {
            eventBuffer.push(normalizeEvent(evt));
            if (eventBuffer.length > CONFIG.WINDOW_SIZE) eventBuffer.shift();

            // --- THE ENERGY GATE ---
            // Only consider inference if we have a full buffer AND we hit our frequency interval
            if (eventBuffer.length === CONFIG.WINDOW_SIZE && (index % CONFIG.INFERENCE_FREQUENCY === 0)) {
                
                const currentEnergy = calculateEnergy(eventBuffer);

                // If energy is below threshold, the mouse is "Dead" or "Off-screen"
                if (currentEnergy < CONFIG.ENERGY_THRESHOLD) {
                    // Reset history so we don't carry "ghost" readings into the next movement
                    predictionHistory = []; 
                    return; 
                }

                if (!modelReady || !model) return;

                const rawEmbedding = tf.tidy(() => {
                    const input = tf.tensor3d([eventBuffer]);
                    const y = model.predict(input);
                    return Array.from(y.dataSync());
                });

                if (!isUsableEmbedding(rawEmbedding)) return;

                predictionHistory.push(rawEmbedding);
                if (predictionHistory.length > CONFIG.SMOOTHING_WINDOW) predictionHistory.shift();

                const smoothed = predictionHistory[0].map((_, i) =>
                    predictionHistory.reduce((acc, row) => acc + row[i], 0) / predictionHistory.length
                );

                for (const [name, vector] of Object.entries(signatures)) {
                    const score = cosineSimilarity(smoothed, vector);
                    if (score > CONFIG.MATCH_THRESHOLD) {
                        self.postMessage({ type: 'SIGNAL_MATCH', signalName: name, confidence: score });
                    }
                }

                if (currentLabel !== "none") {
                    const eventId = (self.crypto && self.crypto.randomUUID)
                        ? self.crypto.randomUUID()
                        : ('k_' + Date.now() + '_' + Math.random().toString(16).slice(2));
                    const kineticPayload = {
                        type: 'kinetic',
                        event_id: eventId,
                        fingerprint: rawEmbedding,
                        label: currentLabel,
                        session_url: currentSessionUrl,
                        timestamp: Date.now()
                    };
                    if (currentChallengeModule) {
                        kineticPayload.challenge_module = currentChallengeModule;
                    }
                    if (currentUserKey) {
                        kineticPayload.nexus_user_key = currentUserKey;
                    }
                    const headers = { 'Content-Type': 'application/json' };
                    if (publishableKey) headers['Authorization'] = 'Bearer ' + publishableKey;
                    fetch(collectBase + ingestPath, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(kineticPayload)
                    }).catch(() => {});
                }
            }
        });
    } catch (err) {}
};

function cosineSimilarity(a, b) {
    let dot = 0, mA = 0, mB = 0;
    for(let i=0; i<a.length; i++) {
        dot += a[i]*b[i]; mA += a[i]*a[i]; mB += b[i]*b[i];
    }
    const sim = dot / (Math.sqrt(mA) * Math.sqrt(mB));
    return isNaN(sim) ? 0 : sim;
}