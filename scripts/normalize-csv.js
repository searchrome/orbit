const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'linkedin', 'deepseek_last.csv');
const csv = fs.readFileSync(csvPath, 'utf8');
const lines = csv.trim().split('\n');

function parseCSVLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') {
                if (line[i + 1] === '"') { cur += '"'; i++; }
                else inQ = false;
            } else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out;
}

function joinCSV(arr) {
    return arr.map((v) => {
        const s = String(v ?? '');
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
}

const header = parseCSVLine(lines[0]);
const COL = { Durum: 0, AdSoyad: 1, Unvan: 2, Sirket: 3, Lokasyon: 4, O2W: 5, Deneyim: 6, SMMM: 7, Not: 8, URL: 9 };

function normalize(fields, rowNo) {
    const arr = [...fields];
    const status = String(arr[0] || '').replace(/^"|"$/g, '');
    const name = String(arr[1] || '').replace(/^"|"$/g, '');

    // YENİ placeholder rows: <status>,<name>,,,,,,,,<note>,<url>  ->  11 fields, note+url in cols 8..9
    if (arr.length === 11 && status === 'YENİ') {
        const note = arr[9] || '';
        const url = arr[10] || '';
        return [status, name, '', '', '', '', '', '', note, url];
    }

    // pad / truncate to exactly 10
    if (arr.length < 10) {
        while (arr.length < 10) arr.push('');
    } else if (arr.length > 10) {
        arr.length = 10;
    }
    return arr;
}

const out = [joinCSV(header)];
let fixed = 0;
for (let i = 1; i < lines.length; i++) {
    const fields = parseCSVLine(lines[i]);
    const norm = normalize(fields, i + 1);
    if (norm.length !== 10) throw new Error(`row ${i + 1} normalized to ${norm.length} fields`);
    if (norm.join(',') !== fields.join(',')) fixed++;
    out.push(joinCSV(norm));
}

fs.writeFileSync(csvPath, out.join('\n') + '\n');
console.log('normalized:', fixed, 'rows | total:', out.length - 1);

// verify
let malformed = 0;
for (const l of out.slice(1)) {
    if (parseCSVLine(l).length !== 10) malformed++;
}
console.log('remaining malformed rows:', malformed);