const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(bodyParser.json());

// THE STORAGE ENDPOINT
app.post('/collect', (req, res) => {
    const dnaPackage = req.body;
    dnaPackage.server_timestamp = new Date().toISOString();
    const logEntry = JSON.stringify(dnaPackage) + '\n';
    
    fs.appendFile('warehouse.jsonl', logEntry, (err) => {
        if (err) return res.status(500).send("Storage Error");
        console.log(`📥 DNA Captured | Label: ${dnaPackage.label}`);
        res.status(200).send("Stored");
    });
});

// NEW: DATA SUMMARY ENDPOINT FOR DASHBOARD
app.get('/summary', (req, res) => {
    try {
        if (!fs.existsSync('warehouse.jsonl')) return res.json([]);
        const data = fs.readFileSync('warehouse.jsonl', 'utf-8')
            .split('\n')
            .filter(line => line.trim())
            .map(line => JSON.parse(line));
        res.status(200).json(data);
    } catch (e) {
        res.status(500).send("Read Error");
    }
});

// THE DISCARD ENDPOINT
app.post('/discard', (req, res) => {
    const { session_url } = req.body;
    if (!fs.existsSync('warehouse.jsonl')) return res.status(404).send();
    
    const lines = fs.readFileSync('warehouse.jsonl', 'utf-8').split('\n');
    let count = 0;
    const filtered = lines.reverse().filter(line => {
        if (!line) return false;
        const entry = JSON.parse(line);
        if (entry.session_url === session_url && count < 20) {
            count++;
            return false; 
        }
        return true;
    }).reverse();

    fs.writeFileSync('warehouse.jsonl', filtered.join('\n'));
    console.log(`🗑️  Discarded last ${count} entries for session.`);
    res.status(200).send("Discarded");
});

app.listen(PORT, () => console.log(`🚀 Collector live at http://localhost:${PORT}`));