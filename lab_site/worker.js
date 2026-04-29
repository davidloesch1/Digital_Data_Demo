importScripts("https://cdn.jsdelivr.net/npm/@tensorflow/tfjs");

// --- CONFIGURATION ---
const CONFIG = {
    WINDOW_SIZE: 50,
    MATCH_THRESHOLD: 0.96,        // Slightly stricter
    SMOOTHING_WINDOW: 5,
    ENERGY_THRESHOLD: 0.05,       // 👈 MINIMUM movement required to trigger AI (Adjustable)
    INFERENCE_FREQUENCY: 20,      // Check every 20 events
    WEIGHTS_PATH: 'model_weights.json',
    SIGNATURES_PATH: 'signatures.json'
};

// --- STATE ---
let model = null;
let signatures = {};
let eventBuffer = [];
let predictionHistory = [];
let lastEventTime = 0;
let currentLabel = "none";
let currentChallengeModule = null;
let currentUserKey = null;
let currentSessionUrl = "unknown";

/**
 * Calculates "Kinetic Energy" in the buffer.
 * Sums the Euclidean distance between all points in the window.
 */
function calculateEnergy(buffer) {
    let energy = 0;
    for (let i = 1; i < buffer.length; i++) {
        const dx = buffer[i][1] - buffer[i-1][1];
        const dy = buffer[i][2] - buffer[i-1][2];
        // Pythagorean distance
        energy += Math.sqrt(dx * dx + dy * dy);
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

async function init() {
    try {
        self.postMessage({ type: 'STATUS', msg: '🏗️ LOADING MODEL...' });
        model = tf.sequential();
        model.add(tf.layers.lstm({ units: 32, inputShape: [CONFIG.WINDOW_SIZE, 4], returnSequences: true, kernelInitializer: 'zeros' }));
        model.add(tf.layers.lstm({ units: 16, returnSequences: false, kernelInitializer: 'zeros' }));
        
        const weights = await (await fetch(CONFIG.WEIGHTS_PATH)).json();
        model.setWeights(weights.map(w => tf.tensor(w)));
        signatures = await (await fetch(CONFIG.SIGNATURES_PATH)).json();
        
        model.predict(tf.zeros([1, CONFIG.WINDOW_SIZE, 4]));
        self.postMessage({ type: 'STATUS', msg: '✅ DETECTION ACTIVE' });
    } catch (e) {
        self.postMessage({ type: 'STATUS', msg: '⚠️ LOAD ERROR' });
    }
}

init();

self.onmessage = async (e) => {
    const { type, payload, sessionUrl, challenge_module, nexus_user_key } = e.data;
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

                tf.tidy(() => {
                    const input = tf.tensor3d([eventBuffer]);
                    const rawEmbedding = Array.from(model.predict(input).dataSync());

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
                        fetch('http://localhost:3000/collect', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(kineticPayload)
                        }).catch(() => {});
                    }
                });
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