const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, '..', 'linkedin', 'deepseek_last.csv');
const csv = fs.readFileSync(csvPath, 'utf8');
const header = csv.trim().split('\n')[0];

function parseCSVLine(line) {
    const out = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
            else cur += ch;
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

const existingLines = csv.trim().split('\n').slice(1);
const existingUrls = new Set(existingLines.map((l) => parseCSVLine(l)[9].split('?')[0].replace(/\/$/, '').toLowerCase()));

const profiles = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.tmp', 'linkedin_profiles.json'), 'utf8'));
const newOnes = profiles.filter((r) => r.verdict && r.profile && r.profile.name && !r.error
    && !existingUrls.has(new URL(r.url).href.split('?')[0].replace(/\/$/, '').toLowerCase()));

console.log('new to add:', newOnes.length);

// Judgment overrides: profile URLs -> status (+ note)
const UYGUN_OVERRIDE = new Set([
    'https://www.linkedin.com/in/y%C3%BCcel-adig%C3%BCzel-5390ba69/',   // Muhasebe Yönetmeni, e-Fatura/e-Arşiv/e-Defter, 1996-...
    'https://www.linkedin.com/in/mustafa-arslan-7b26ab63/',             // SAP, 2003-present
    'https://www.linkedin.com/in/burak-saka-281843b7/',                 // Mali İşler Direktörü, 35 yıl, SAP
    'https://www.linkedin.com/in/caner-g%C3%BCven-1815345a/',           // Muhasebe Müdür Yrd., 15 yıl
    'https://www.linkedin.com/in/nurg%C3%BCl-hedef-77460a116/',         // Genel Muhasebe Müdürü - Digiturk
    'https://www.linkedin.com/in/havva-do%C4%9Fan-12a38b59/',           // Vergi Yöneticisi (tax director level)
]);

const SMMM_TITLE_RE = /SMMM|Mali Müşavir|Staj\.? Mali Müşavir|\bCPA\b|Bağımsız Denet/i;

const rows = [];
for (const r of newOnes) {
    const p = r.profile;
    const url = p.url.split('?')[0];
    const kw = (p.kws || '');
    const expHint = (p.expHint || '');
    const about = (p.about || '').slice(0, 180).replace(/\s+/g, ' ').trim();
    const senior = /Kıdemli|Kıdem|Senior|Yönetici|Müdür|Şef|Lider/i.test(p.headline || '');
    const o2w = p.o2wSort ? 'EVET' : 'Görünmüyor';
    const sirket = p.company && !/follower|takip/i.test(p.company) ? p.company : '(Görünmüyor)';
    const deneyim = expHint ? expHint.replace(/\s*\|\s*/g, ', ').slice(0, 60) : (senior ? 'Kıdemli (yıl görünmüyor)' : 'Bilinmiyor');

    let durum;
    let not;
    const smmm = 'Hayır';

    if (url === 'https://www.linkedin.com/in/veli-%C3%B6zdemir-661b1118a') {
        // Mali Müşavir title but 12 yıl logo/genel muhasebe - keep SMMM convention
        durum = 'ELENDİ'; not = 'Mali Müşavir Ünvanı - ELENDİ';
    } else if (SMMM_TITLE_RE.test(p.headline || '')) {
        durum = 'ELENDİ'; not = 'SMMM/Mali Müşavir Ünvanı - ELENDİ';
    } else if (UYGUN_OVERRIDE.has(url)) {
        durum = 'UYGUN';
        const bits = [];
        const erpList = kw.split(',').filter((k) => ['logo', 'mikro', 'netsis', 'luca', 'nebim', 'sap'].includes(k));
        if (erpList.length) bits.push(erpList.join('/') + ' deneyimi');
        if (/e-fatura|efatura|e-arşiv|e-arsiv|e-defter/i.test(kw)) bits.push('e-Fatura/e-Arşiv/e-Defter');
        if (/cari hesap|mutabakat/i.test(kw)) bits.push('cari/mutabakat');
        if (expHint) bits.push(expHint.replace(/\s*\|\s*/g, ', '));
        not = 'Güçlü muhasebe deneyimi; ' + (bits.join(', ') || 'kıdemli') + '; O2W kontrol edilmeli';
    } else if (p.o2wSort) {
        durum = 'DOĞRULANMALI';
        not = 'O2W ✓; deneyim yılı ve genel muhasebe uygunluğu kontrol edilmeli';
    } else {
        durum = 'DOĞRULANMALI';
        not = 'O2W kontrol edilmeli; ' + (kw ? 'sinyal: ' + kw.slice(0, 50) : 'deneyim detayları doğrulanmalı');
    }

    rows.push([durum, p.name, (p.headline || '').replace(/^[^|│]*şirketinde /, '').slice(0, 70), sirket, p.location || 'İstanbul', o2w, deneyim, smmm, not, url]);
}

// skip rows whose URL already present (idempotent)
const toAppend = rows.filter((arr) => !existingUrls.has(arr[9].split('?')[0].replace(/\/$/, '').toLowerCase()));
const out = [header].concat(existingLines, toAppend.map(joinCSV));
fs.writeFileSync(csvPath, out.join('\n') + '\n');

let cnt = { UYGUN: 0, DOĞRULANMALI: 0, ELENDİ: 0 };
for (const arr of toAppend) cnt[arr[0]] = (cnt[arr[0]] || 0) + 1;
console.log('appended:', toAppend.length, JSON.stringify(cnt));
console.log('total rows:', out.length - 1);