/**
 * PRO DASHBOARD - Behavioral Visualization Logic
 */
let cloudChart, radarChart;

async function fetchData() {
    const response = await fetch('http://localhost:3000/summary');
    const data = await response.json();
    
    // Group by Session
    const sessions = {};
    data.forEach(d => {
        const sid = d.session_url.split('/').pop() || 'Unknown';
        if (!sessions[sid]) sessions[sid] = [];
        sessions[sid].push(d);
    });

    renderSessionList(sessions);
    renderCloud(sessions);
}

function renderSessionList(sessions) {
    const list = document.getElementById('session-list');
    list.innerHTML = '';
    Object.keys(sessions).forEach(sid => {
        const div = document.createElement('div');
        div.className = 'session-item';
        div.innerText = `> ${sid} (${sessions[sid].length} evts)`;
        div.onclick = () => renderUserRadar(sessions[sid]);
        list.appendChild(div);
    });
}

function renderCloud(sessions) {
    const ctx = document.getElementById('cloudChart').getContext('2d');
    
    // For the Cloud, we use the first 2 dimensions of the embedding
    // In a real app, we would use PCA/t-SNE here
    const datasets = Object.keys(sessions).map(sid => {
        return {
            label: sid,
            data: sessions[sid].map(d => ({ x: d.fingerprint[0], y: d.fingerprint[1] })),
            backgroundColor: sid === 'CALIBRATION' ? '#94a3b8' : '#6366f1'
        };
    });

    if (cloudChart) cloudChart.destroy();
    cloudChart = new Chart(ctx, {
        type: 'scatter',
        data: { datasets },
        options: { 
            responsive: true, 
            maintainAspectRatio: false,
            scales: { x: { display: false }, y: { display: false } },
            plugins: { legend: { display: false } }
        }
    });
}

function renderUserRadar(userEvents) {
    const ctx = document.getElementById('radarChart').getContext('2d');
    
    // Calculate Scores based on Research Lab Metrics
    // 1. Precision: High reading/calibration similarity
    const precision = userEvents.filter(e => e.label.includes('READING')).length / userEvents.length;
    
    // 2. Urgency: Sum of vector magnitude (using first 4 components as proxy)
    const urgency = userEvents.reduce((acc, e) => acc + Math.abs(e.fingerprint[2]), 0) / userEvents.length;
    
    // 3. Resilience: Low retry count vs high friction duration 
    const frictionEvents = userEvents.filter(e => e.label.includes('FRICTION'));
    const resilience = frictionEvents.length > 0 ? (1 / frictionEvents.length) : 1;

    const data = {
        labels: ['Precision', 'Urgency', 'Resilience', 'Focus', 'Methodology'],
        datasets: [{
            label: 'User Persona',
            data: [precision * 100, urgency * 100, resilience * 100, 70, 60],
            fill: true,
            backgroundColor: 'rgba(99, 102, 241, 0.2)',
            borderColor: '#6366f1',
            pointBackgroundColor: '#6366f1',
        }]
    };

    if (radarChart) radarChart.destroy();
    radarChart = new Chart(ctx, {
        type: 'radar',
        data: data,
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: { r: { min: 0, max: 100, ticks: { display: false }, grid: { color: '#334155' } } },
            plugins: { legend: { display: false } }
        }
    });
}

fetchData();