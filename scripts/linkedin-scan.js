const fs = require('fs');
const path = require('path');
const { CdpBrowserSession } = require('./cdp-browser-session.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = 'https://www.linkedin.com/search/results/people/';
const GEO = 'geoUrn=%5B%22119068902%22%2C%22102424322%22%5D';
const KEYWORDS = encodeURIComponent('muhasebe uzmanı');
const PAGES = parseInt(process.env.PAGES || '15', 10);

const EXTRACTOR = `(() => {
    const cards = [];
    for (const root of Array.from(document.querySelectorAll('div[role="listitem"]'))) {
        const a = root.querySelector('a[href*="/in/"]');
        if (!a) continue;
        const url = new URL(a.href, location.href).href;
        const name = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        const normName = name.split(' •')[0].replace(/^\\s*(Connect|Follow|Message|Invite|Pending)\\s*/i, '').trim();
        const nameHz = (root.innerText || '').slice(0, 500).replace(/\\s+/g, ' ');
        const o2w = /\\b(is open to work|#openToWork)\\b/i.test(nameHz);
        const pTexts = Array.from(root.querySelectorAll('p'))
            .map((p) => (p.innerText || '').replace(/\\s+/g, ' ').trim())
            .filter((t) => t && t.length < 160 && !/•\\s*2nd/.test(t) && !/mutual connection/i.test(t));
        const dedup = [...new Set(pTexts)];
        const headline = dedup.find((t) => t && t !== normName) || '';
        const loc = dedup.find((t) => /,?\\s*(Türkiye|Turkey|Istanbul|İstanbul|Ankara|İzmir|Izmir|Bursa|Kocaeli)/.test(t)) || '';
        const snippetEl = root.querySelector('[componentkey*="Snippet"], [id^="SearchResultssnippet"]');
        const snippet = (snippetEl ? (snippetEl.innerText || '').replace(/\\n+/g, ' | ').replace(/\\s+/g, ' ').trim() : '');
        cards.push({ name: normName, raw: name, url, headline, loc, o2w, snippet, pAll: dedup.join(' | ') });
    }
    return cards;
})()`;

function normUrl(u) {
    try {
        return new URL(u).href
            .replace(/\/en\/?$/i, '/')
            .replace(/\/tr\/?$/i, '/')
            .replace(/\/$/,'')
            .toLowerCase();
    } catch { return String(u).toLowerCase(); }
}

async function collectPage(browser, tabId, pageNumber) {
    const url = `${BASE}?keywords=${KEYWORDS}&origin=FACETED_SEARCH&${GEO}&page=${pageNumber}`;
    await browser.navigate(tabId, url);
    await sleep(7000);
    const info = await browser.getTabInfo({ tabId });
    if (/authwall|checkpoint|login/.test(info.tab.url)) {
        return { error: info.tab.url, cards: [] };
    }
    const cards = await browser.evaluate(tabId, EXTRACTOR);
    if (!Array.isArray(cards)) { console.log('  extractor returned', JSON.stringify(cards)); cards = []; }
    return { cards, page: pageNumber };
}

async function main() {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find((t) => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const csvPath = path.join(__dirname, '..', 'linkedin', 'deepseek_last.csv');
    const csv = fs.readFileSync(csvPath, 'utf8');
    const existing = new Set();
    for (const line of csv.split('\n').slice(1)) {
        const cols = line.split(',');
        const urlCol = cols[cols.length - 1].trim();
        if (urlCol && urlCol.startsWith('http')) existing.add(normUrl(urlCol));
    }
    console.log('existing csv candidates:', existing.size, '| PAGES:', PAGES);

    const all = [];
    for (let p = 1; p <= PAGES; p++) {
        const res = await collectPage(browser, tab.id, p);
        if (res.error) { console.log('page', p, 'ERROR', res.error); break; }
        const newOnes = res.cards.filter((c) => !existing.has(normUrl(c.url)));
        all.push(...res.cards);
        console.log(`page ${p}: ${res.cards.length} cards | ${newOnes.length} NEW`);
        newOnes.forEach((c) => console.log('   NEW:', (c.name || '?').slice(0, 28).padEnd(28), '| O2W:', String(c.o2w).padEnd(5), '|', (c.headline || '').slice(0, 40).padEnd(40), '|', (c.loc || '').slice(0, 22).padEnd(22), '|', c.url.slice(0, 55)));
    }
    console.log('TOTAL cards:', all.length);

    // save raw + new to json cache for the profile-scan step
    const seen = new Set();
    const unique = all.filter((c) => { const k = normUrl(c.url); if (seen.has(k)) return false; seen.add(k); return true; });
    const fresh = unique.filter((c) => !existing.has(normUrl(c.url)));
    fs.writeFileSync(path.join(__dirname, '..', '.tmp', 'linkedin_candidates.json'), JSON.stringify(unique, null, 2));
    fs.writeFileSync(path.join(__dirname, '..', '.tmp', 'linkedin_fresh.json'), JSON.stringify(fresh, null, 2));
    console.log('unique cards:', unique.length, '| fresh (not in csv):', fresh.length);
    await browser.close();
}

main().catch((e) => { console.error('ERR', e); process.exit(1); });