/**
 * BEHAVIORAL SERVICE
 * Handles AI Worker and Network Interception
 */
const BehavioralService = (function() {
    // Initialize the AI Worker [cite: 86]
    const worker = new Worker('worker.js');

    // Intercept FullStory Network Bundles [cite: 83]
    const oldSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function(body) {
        if (this._url && this._url.includes('rs.fullstory.com/rec/bundle')) {
            // Forward the raw bundle to the AI Worker for analysis [cite: 83, 104]
            worker.postMessage({ 
                payload: body, 
                sessionUrl: (window.FS && FS.getCurrentSessionURL()) || "no-session" 
            });
        }
        return oldSend.apply(this, arguments);
    };

    const oldOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(m, u) { this._url = u; return oldOpen.apply(this, arguments); };

    return {
        setLabel: (label) => worker.postMessage({ type: 'SET_LABEL', payload: label }),
        onSignal: (callback) => {
            worker.onmessage = (e) => callback(e.data);
        }
    };
})();