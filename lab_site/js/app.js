/**
 * APP CONTROLLER
 * Manages UI Transitions and Lab Challenges
 */
const App = (function() {
    const state = {
        retryCount: 0,
        sessionID: 'USR-' + Math.random().toString(36).substr(2, 6).toUpperCase()
    };

    function init() {
        // Display the unique session ID for the dashboard reference
        document.getElementById('session-id').innerText = '#' + state.sessionID;
        initCalibration();
        
        // Listen for AI detections from the service
        BehavioralService.onSignal((data) => {
            if (data.type === 'STATUS') document.getElementById('dev-status').innerText = 'AI: ' + data.msg;
            // Matches against signatures.json are logged here [cite: 114]
            if (data.type === 'SIGNAL_MATCH') console.log("DNA MATCH:", data.signalName);
        });
    }

    function initCalibration() {
        const track = document.getElementById('captcha-track');
        const target = document.getElementById('captcha-target');
        const btn = document.getElementById('btn-start-quiz');
        
        track.onmousemove = (e) => {
            const rect = track.getBoundingClientRect();
            const x = Math.min(Math.max(4, e.clientX - rect.left - 26), rect.width - 56);
            target.style.left = x + 'px';
            if (x > rect.width - 80 && !btn.onclick) {
                target.innerHTML = "✓"; target.style.background = "#22c55e";
                btn.disabled = false; btn.innerText = "BEGIN CHALLENGE";
                btn.onclick = () => App.switchView('reading');
                BehavioralService.setLabel('CALIBRATION');
            }
        };
    }

    return {
        init,
        switchView: (viewId) => {
            // Standard SPA view switching [cite: 67, 68]
            document.querySelectorAll('.view-container').forEach(v => v.classList.add('hidden'));
            document.getElementById('view-' + viewId).classList.remove('hidden');
            document.getElementById('progress-indicator').classList.remove('hidden');
            
            // Tag all incoming data with the current module name [cite: 70, 105]
            BehavioralService.setLabel(viewId.toUpperCase());
        },
        handleFriction: () => {
            const btn = document.getElementById('btn-submit-friction');
            const msg = document.getElementById('friction-msg');
            state.retryCount++;

            if (state.retryCount < 3) {
                btn.disabled = true; btn.innerText = "PROCESSING...";
                setTimeout(() => {
                    btn.disabled = false;
                    btn.innerText = "RETRY GENERATION";
                    msg.style.display = "block";
                    // Baiting a Rage Swirl via button drift [cite: 58]
                    btn.style.transform = `translate(${state.retryCount * 25}px, 0)`;
                }, 1000);
            } else {
                // Final Success State - Moves to Results View [cite: 43]
                btn.innerText = "SUCCESS! ANALYZING...";
                setTimeout(() => App.switchView('results'), 1500);
            }
        }
    };
})();

App.init();