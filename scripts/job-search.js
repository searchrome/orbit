#!/usr/bin/env node
'use strict';

// Drives the browser via CDP to search Java developer roles on
// yenibiris.com and kariyer.net, extracting structured listings.
// kariyer.net currently serves an Akamai press-and-hold anti-bot wall to
// automated sessions; if that page is detected the site is reported blocked.

const fs = require('fs');
const path = require('path');
const { CdpBrowserSession } = require('./cdp-browser-session.js');

const PORT = parseInt(process.env.PORT || '9222', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// yenibiris uses path-slug results pages: /is-ilanlari/<slug>
// kariyer uses the same pattern but is behind a bot wall.
const SITES = [
    { key: 'yenibiris', name: 'yenibiris.com', url: 'https://www.yenibiris.com/is-ilanlari/java-developer' },
    { key: 'kariyer', name: 'kariyer.net', url: 'https://www.kariyer.net/is-ilanlari/java-developer' },
];

function isBotWall(text) {
    return /güvenlik doğrulaması|Access to this page has been denied|Performing security verification|press and hold|basılı tutarak/i.test(text || '');
}

async function extract(browser, tabId) {
    return browser.evaluate(tabId, `(() => {
        const n = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
        const abs = (v) => { try { return new URL(v, document.baseURI).href; } catch { return v || null; } };
        const SENIOR = /\\b(senior|kıdemli|sr\\.?|lead|principal|staff)\\b/i;
        const out = [];
        const seen = new Set();
        const links = Array.from(document.querySelectorAll('a[href*="/is-ilani/"], a[href*="/ilan/"]'));
        for (const a of links) {
            const href = abs(a.getAttribute('href') || a.href);
            if (!href || seen.has(href)) continue;
            const card = a.closest('article, li, [class*="list" i], [class*="card" i], [class*="ilan" i]') || a.parentElement;
            let title = n(a.innerText);
            // "DETAY" links and bare buttons: pull the real title from the card heading.
            if (!title || /^detay$/i.test(title) || title.length < 4) {
                const h = card && card.querySelector('h2, h3, [class*="title" i], [class*="position" i]');
                title = n(h && h.innerText) || title;
            }
            if (!title || /^detay$/i.test(title)) continue;
            seen.add(href);
            const cardText = n(card && card.innerText);
            // Heuristic company/location: look for known label rows in the card.
            out.push({
                title,
                href,
                senior: SENIOR.test(title) || SENIOR.test(cardText),
                context: cardText.slice(0, 200),
            });
        }
        return out.slice(0, 60);
    })()`, { timeoutMs: 25000 });
}

async function run() {
    const browser = new CdpBrowserSession({ baseUrl: `http://127.0.0.1:${PORT}` });
    await browser.initialize();
    const report = {};
    try {
        const { tab } = await browser.openTab({ url: 'about:blank', activate: true });
        const tabId = tab.id;
        for (const site of SITES) {
            log(`── ${site.name} ──  ${site.url}`);
            try {
                await browser.navigate(tabId, site.url);
                await sleep(4500);
                const info = await browser.getTabInfo({ tabId });
                const head = await browser.readPageText({ tabId, maxChars: 400 });
                if (isBotWall(head.text)) {
                    log(`BLOCKED: anti-bot wall`);
                    report[site.key] = { site: site.name, url: site.url, blocked: true, reason: 'anti-bot verification wall', jobs: [] };
                    continue;
                }
                const jobs = await extract(browser, tabId);
                log(`extracted ${jobs.length} listings (${jobs.filter(j => j.senior).length} senior-flagged)`);
                report[site.key] = { site: site.name, url: info.tab && info.tab.url, blocked: false, jobs };
            } catch (e) {
                log(`ERROR: ${e.message}`);
                report[site.key] = { site: site.name, url: site.url, error: e.message, jobs: [] };
            }
        }
        const outDir = path.join(__dirname, 'logs');
        fs.mkdirSync(outDir, { recursive: true });
        const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const outFile = path.join(outDir, `job-search-${ts}.json`);
        fs.writeFileSync(outFile, JSON.stringify({ query: 'java developer (senior)', scrapedAt: new Date().toISOString(), report }, null, 2));
        log(`written: ${outFile}`);

        // Print a readable summary.
        for (const key of Object.keys(report)) {
            const r = report[key];
            console.log(`\n========== ${r.site} ==========`);
            if (r.blocked) { console.log(`  [blocked: ${r.reason}]`); continue; }
            if (r.error) { console.log(`  [error: ${r.error}]`); continue; }
            const senior = r.jobs.filter(j => j.senior);
            const rest = r.jobs.filter(j => !j.senior);
            const printJob = (j) => console.log(`  • ${j.title}\n    ${j.href}`);
            if (senior.length) { console.log(`  --- Senior-matching (${senior.length}) ---`); senior.forEach(printJob); }
            if (rest.length) { console.log(`  --- Other Java roles (${rest.length}) ---`); rest.forEach(printJob); }
            if (!r.jobs.length) console.log('  (no listings extracted)');
        }
    } finally {
        await browser.close();
    }
}

run().catch((e) => { console.error(e); process.exit(1); });
