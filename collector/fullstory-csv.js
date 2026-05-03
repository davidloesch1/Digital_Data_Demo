'use strict';

const crypto = require('crypto');

/**
 * RFC4180-ish CSV parser (handles quoted fields with commas and doubled quotes).
 * @returns {{ headers: string[], rows: string[][] }}
 */
function parseCsvText(text) {
    const rows = [];
    let row = [];
    let field = '';
    let i = 0;
    let inQuotes = false;
    const s = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    while (i < s.length) {
        const c = s[i];
        if (inQuotes) {
            if (c === '"') {
                if (s[i + 1] === '"') {
                    field += '"';
                    i += 2;
                    continue;
                }
                inQuotes = false;
                i++;
                continue;
            }
            field += c;
            i++;
            continue;
        }
        if (c === '"') {
            inQuotes = true;
            i++;
            continue;
        }
        if (c === ',') {
            row.push(field);
            field = '';
            i++;
            continue;
        }
        if (c === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
            i++;
            continue;
        }
        field += c;
        i++;
    }
    row.push(field);
    if (field.length > 0 || row.length > 1 || (row.length === 1 && row[0] !== '')) {
        rows.push(row);
    }
    while (rows.length && rows[rows.length - 1].every((cell) => cell === '')) {
        rows.pop();
    }
    if (!rows.length) return { headers: [], rows: [] };
    const headers = rows[0].map((h) => String(h || '').trim());
    const dataRows = rows.slice(1).filter((r) => r.some((cell) => String(cell || '').trim() !== ''));
    return { headers, rows: dataRows };
}

function normBool(v) {
    if (v === undefined || v === null) return false;
    const t = String(v).trim().toLowerCase();
    return t === 'true' || t === '1' || t === 'yes';
}

function normNum(v) {
    if (v === undefined || v === null || String(v).trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function parseTs(v) {
    if (!v || String(v).trim() === '') return null;
    const d = new Date(String(v).trim());
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function ingestHashFromParts(indvId, eventStart, eventType, targetSel, pageOffset) {
    const base = [indvId, eventStart, eventType, targetSel, pageOffset].join('|');
    return crypto.createHash('sha1').update(base, 'utf8').digest('hex');
}

/**
 * Build header map: lower(trim(header)) -> column index
 */
function headerIndexMap(headers) {
    const m = Object.create(null);
    let h;
    for (h = 0; h < headers.length; h++) {
        const k = String(headers[h] || '')
            .trim()
            .toLowerCase();
        if (k) m[k] = h;
    }
    return m;
}

function getCol(row, m, ...names) {
    let n;
    for (n = 0; n < names.length; n++) {
        const key = names[n].toLowerCase();
        if (m[key] !== undefined) {
            const v = row[m[key]];
            return v === undefined || v === null ? '' : String(v);
        }
    }
    return '';
}

/**
 * @returns {import('./tenant-db.js').FsInsertRow | null}
 */
function mapFsCsvRow(headers, row) {
    const m = headerIndexMap(headers);
    const sessionId = getCol(row, m, 'sessionid', 'session_id');
    const eventStart = getCol(row, m, 'eventstart', 'event_start');
    if (!sessionId || !eventStart) return null;
    const indvId = getCol(row, m, 'indvid', 'indv_id', 'userid', 'user_id');
    const eventType = getCol(row, m, 'eventtype', 'event_type');
    const targetSel = getCol(row, m, 'eventtargetselector', 'event_target_selector');
    const pageOff = getCol(row, m, 'eventpageoffset', 'event_page_offset');

    const payload = {};
    let hi;
    for (hi = 0; hi < headers.length; hi++) {
        const name = String(headers[hi] || '').trim();
        if (!name) continue;
        payload[name] = row[hi];
    }

    let parsedEventVars = {};
    let parsedUserVars = {};
    let parsedPageVars = {};
    try {
        const evs = getCol(row, m, 'eventvars', 'event_vars');
        if (evs) parsedEventVars = JSON.parse(evs);
    } catch {
        parsedEventVars = {};
    }
    try {
        const uvs = getCol(row, m, 'uservars', 'user_vars');
        if (uvs) parsedUserVars = JSON.parse(uvs);
    } catch {
        parsedUserVars = {};
    }
    try {
        const pvs = getCol(row, m, 'pagevars', 'page_vars');
        if (pvs) parsedPageVars = JSON.parse(pvs);
    } catch {
        parsedPageVars = {};
    }
    payload._parsed = { eventVars: parsedEventVars, userVars: parsedUserVars, pageVars: parsedPageVars };

    const isoStart = parseTs(eventStart);
    if (!isoStart) return null;

    const ih = ingestHashFromParts(indvId || '', eventStart, eventType || '', targetSel || '', pageOff || '');

    const sessionStartVal = parseTs(getCol(row, m, 'sessionstart', 'session_start'));

    return {
        fs_session_id: sessionId.trim(),
        fs_user_id: getCol(row, m, 'userid', 'user_id').trim() || null,
        fs_indv_id: getCol(row, m, 'indvid', 'indv_id').trim() || null,
        fs_page_id: getCol(row, m, 'pageid', 'page_id').trim() || null,
        event_type: getCol(row, m, 'eventtype', 'event_type').trim() || null,
        event_sub_type: getCol(row, m, 'eventsubtype', 'event_sub_type').trim() || null,
        event_custom_name: getCol(row, m, 'eventcustomname', 'event_custom_name').trim() || null,
        event_target_text: getCol(row, m, 'eventtargettext', 'event_target_text').trim() || null,
        event_target_selector: targetSel.trim() || null,
        event_session_offset_ms: normNum(getCol(row, m, 'eventsessionoffset', 'event_session_offset')),
        event_page_offset_ms: normNum(pageOff),
        mod_frustrated: normBool(getCol(row, m, 'eventmodfrustrated', 'event_mod_frustrated')),
        mod_dead: normBool(getCol(row, m, 'eventmoddead', 'event_mod_dead')),
        mod_error: normBool(getCol(row, m, 'eventmoderror', 'event_mod_error')),
        mod_suspicious: normBool(getCol(row, m, 'eventmodsuspicious', 'event_mod_suspicious')),
        page_url: getCol(row, m, 'pageurl', 'page_url').trim() || null,
        page_device: getCol(row, m, 'pagedevice', 'page_device').trim() || null,
        page_browser: getCol(row, m, 'pagebrowser', 'page_browser').trim() || null,
        page_platform: getCol(row, m, 'pageplatform', 'page_platform').trim() || null,
        page_max_scroll_depth_pct: normNum(getCol(row, m, 'pagemaxscrolldepthpercent', 'page_max_scroll_depth_percent')),
        event_start: isoStart,
        session_start: sessionStartVal,
        payload,
        ingest_hash: ih,
    };
}

/**
 * @returns {{ inserts: import('./tenant-db.js').FsInsertRow[], rowCount: number, sessionsTouched: string[] }}
 */
function fullstoryCsvToInserts(csvText, opts) {
    opts = opts || {};
    const maxRows = opts.maxRows != null ? opts.maxRows : 50000;
    const { headers, rows } = parseCsvText(csvText);
    if (!headers.length) return { inserts: [], rowCount: 0, sessionsTouched: [] };
    const inserts = [];
    const sessions = new Set();
    let r;
    for (r = 0; r < rows.length && inserts.length < maxRows; r++) {
        const mapped = mapFsCsvRow(headers, rows[r]);
        if (mapped) {
            inserts.push(mapped);
            sessions.add(mapped.fs_session_id);
        }
    }
    return {
        inserts,
        rowCount: rows.length,
        sessionsTouched: [...sessions],
        truncated: rows.length > maxRows,
    };
}

module.exports = {
    parseCsvText,
    mapFsCsvRow,
    fullstoryCsvToInserts,
    ingestHashFromParts,
};
