const fs = require('fs');
const path = require('path');
const { CdpBrowserSession } = require('./cdp-browser-session.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DELAY_MS = parseInt(process.env.DELAY_MS || '30000', 10);
const FRESH_FILE = path.join(__dirname, '..', '.tmp', 'linkedin_fresh.json');
const DONE_FILE = path.join(__dirname, '..', '.tmp', 'linkedin_profiles.json');

function parseProfile(url, raw) {
    let payload = { body: String(raw || ''), main: String(raw || '') };
    try {
        if (typeof raw === 'string' && raw.startsWith('{')) payload = JSON.parse(raw);
    } catch {}
    const body = String(payload.body || '');
    const main = String(payload.main || '');
    const lines = main.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

    const pick = (arr) => arr[0] || '';
    const name = lines[0] || '';
    const idx2nd = lines.findIndex((l) => /^[·••]\s*2nd/.test(l) || /^·\s*2nd$/.test(l));
    const afterName = idx2nd >= 0 ? lines.slice(idx2nd + 1) : lines.slice(1);
    const headline = pick(afterName.filter((l) => l.length > 1 && l.length < 140 && !/Türkiye|Turkey|istanbul|İstanbul/i.test(l) && !/Contact info/i.test(l) && l !== '·'));
    const location = pick(afterName.filter((l) => /(Türkiye|Turkey)(,|$)/.test(l)));
    const contactIdx = afterName.findIndex((l) => /^Contact info$/i.test(l));
    const afterContact = contactIdx >= 0 ? afterName.slice(contactIdx + 1) : [];
    const company = pick(afterContact.filter(Boolean));
    const uniIdx = afterContact.findIndex((l) => /Üniversit|University|Lise|High School|Meslek/i.test(l));
    const university = uniIdx >= 0 ? afterContact[uniIdx] : '';
    const connections = pick(lines.filter((l) => /^[\d,.+]+$/.test(l) && lines[lines.indexOf(l) + 1]?.toLowerCase().startsWith('connection')));

    const o2wBadge = /\b(Aktif iş Arayan|Açık Pozisyon|#openToWork|Open to work|is open to work|Open To Work)\b/i.test(body);

    const aboutIdx = body.indexOf('\nAbout');
    const actIdx = body.indexOf('Activity', aboutIdx + 1);
    const about = aboutIdx >= 0
        ? body.slice(aboutIdx + 6, (actIdx > aboutIdx ? actIdx : aboutIdx + 1500)).replace(/\s+/g, ' ').replace(/… more/g, '').trim().slice(0, 1200)
        : (body.includes('About') ? body.slice(body.indexOf('About') + 6).replace(/\s+/g, ' ').replace(/… more/g, '').trim().slice(0, 1200) : '');

    const expHint = [...new Set(
        (body.match(/\b(19[89]\d|20[01]\d|20[2-4]\d)\s*[-–—]\s*(Present|Günümüz|Halen|20[2-4]\d|\d{4})?/gi) || [])
            .concat(body.match(/\b\d{1,2}\+?\s*y[ıi]l(?:\w*)?\b/gi) || [])
    )].slice(0, 16);

    const kw = ['logo', 'mikro', 'netsis', 'luca', 'nebim', 'sap', 'e-fatura', 'efatura', 'e-arşiv', 'e-arsiv', 'e-defter', 'excel', 'tek düzen', 'genel muhasebe', 'cari hesap', 'mutabakat', 'vergi', 'banka-kasa', 'dönem sonu', 'finansal raporlama', 'bordro', 'smm'];
    const kws = kw.filter((k) => body.toLowerCase().includes(k));

    return {
        url,
        bodyLen: body.length,
        name,
        headline,
        location,
        company,
        university,
        connections,
        about,
        o2w: o2wBadge,
        expHint: expHint.join(' | '),
        kws: kws.join(',')
    };
}

function analyze(c, p) {
    const ist = /istanbul|i̇stanbul/i.test(p.location || '');
    const o2w = !!(p.o2wSort);
    const kw = (p.kws || '').split(',');
    const hasErp = kw.some((k) => ['logo', 'mikro', 'netsis', 'luca', 'nebim', 'sap'].includes(k));
    const hasEfic = kw.some((k) => /e-fatura|efatura|e-arşiv|e-arsiv|e-defter/i.test(k));
    const hasGen = kw.some((k) => /genel muhasebe|cari hesap|mutabakat|finansal raporlama/i.test(k));
    const expTxt = (p.expHint || '') + ' ' + (p.about || '').slice(0, 120);
    const expYr = (expTxt.match(/(\d{1,2})\+?\s*y[ıi]l/) || [])[1];
    const senior = /kıdemli|senior|kıdem|şef|chief|yönetici/i.test((p.headline || '') + (p.company || ''));

    if (!ist) return { verdict: 'ELENDİ', reason: 'Konum İstanbul değil: ' + (p.location || '?') };
    if (o2w && (Number(expYr || 0) >= 3 || senior || hasErp || hasGen)) {
        return { verdict: 'UYGUN', reason: 'O2W ✓; ' + (expYr ? expYr + '+ yıl' : 'kıdemli') + (hasErp ? ', ERP' : '') + (hasEfic ? ', e-Fatura' : '') };
    }
    if (hasErp && hasEfic && hasGen) {
        return { verdict: 'UYGUN', reason: 'ERP+e-Fatura+genel muhasebe sinyalleri; O2W kontrol edilmeli' };
    }
    if (o2w) return { verdict: 'DOĞRULANMALI', reason: 'O2W ✓; deneyim yılı doğrulanmalı' };
    if (Number(expYr || 0) >= 3 || senior) {
        return { verdict: 'DOĞRULANMALI', reason: (expYr ? expYr + '+ yıl' : 'kıdemli') + ' deneyim; O2W kontrol edilmeli' };
    }
    return { verdict: 'DOĞRULANMALI', reason: 'Bilinmeyen deneyim; O2W kontrol edilmeli' };
}

async function main() {
    if (!fs.existsSync(FRESH_FILE)) { console.error('no fresh file; run scan first'); process.exit(1); }
    const fresh = JSON.parse(fs.readFileSync(FRESH_FILE, 'utf8'));
    const done = fs.existsSync(DONE_FILE) ? JSON.parse(fs.readFileSync(DONE_FILE, 'utf8')) : [];
    const doneUrls = new Set(done.map((d) => new URL(d.url).href.replace(/\/$/, '').toLowerCase()));
    const todo = fresh.filter((c) => !doneUrls.has(new URL(c.url).href.replace(/\/$/, '').toLowerCase()));
    console.log('fresh:', fresh.length, 'already done:', done.length, 'todo:', todo.length);

    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find((t) => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    for (let i = 0; i < todo.length; i++) {
        const c = todo[i];
        process.stdout.write(`[${done.length + i + 1}/${todo.length}] ${(c.name || '').slice(0, 22).padEnd(22)} `);
        try {
            await browser.navigate(tab.id, c.url);
            await sleep(10000);
            const info = await browser.getTabInfo({ tabId: tab.id });
            const raw = await browser.evaluate(tab.id, `(() => {
                const main = document.querySelector('main');
                return JSON.stringify({ body: document.body.innerText, main: main ? main.innerText : '' });
            })()`);
            if (/authwall|checkpoint|login/i.test(info.tab.url)) {
                const r = { ...c, error: 'authwall', url: info.tab.url };
                done.push(r); fs.writeFileSync(DONE_FILE, JSON.stringify(done, null, 2));
                console.log('AUTHWALL');
            } else {
                let parsed;
                try { parsed = parseProfile(info.tab.url, raw); }
                catch (e) {
                    parsed = { url: info.tab.url, parseError: e.message, kws: '', expHint: '', location: '', company: '', name: '' };
                }
                const r = { ...c, profile: { ...parsed, o2wSort: parsed.o2w || !!c.o2w, o2wSearch: !!c.o2w } };
                const a = analyze(c, r.profile);
                r.verdict = a;
                done.push(r);
                fs.writeFileSync(DONE_FILE, JSON.stringify(done, null, 2));
                console.log('| ' + a.verdict.padEnd(13) + '| ' + (parsed.location || '?').slice(0, 20).padEnd(20) + '| o2w:' + String(r.profile.o2wSort).padEnd(5) + '| kw:' + (parsed.kws || '-').slice(0, 26));
                console.log('     ↳ ' + a.reason);
            }
        } catch (e) {
            console.log('ERR', e.message);
            const r = { ...c, error: e.message };
            done.push(r); fs.writeFileSync(DONE_FILE, JSON.stringify(done, null, 2));
        }
        if (i < todo.length - 1) {
            const wait = Math.min(DELAY_MS, 45000);
            process.stdout.write(`     ...waiting ${Math.round(wait / 1000)}s `);
            await sleep(wait);
            console.log('✔');
        }
    }
    await browser.close();
    console.log('done. total checked:', done.length);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });