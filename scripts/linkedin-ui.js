const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const url = 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent('muhasebe uzmanı');
    await browser.navigate(tab.id, url);
    await sleep(8000);

    console.log('URL:', (await browser.getTabInfo({ tabId: tab.id })).tab.url);

    // Dump the filter buttons under the search bar (the "chips" row), and any dropdown toggles
    const dump = await browser.evaluate(tab.id, `(() => {
        const btns = Array.from(document.querySelectorAll('button, [role="button"]')).filter(b => {
            const s = window.getComputedStyle(b);
            const r = b.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        }).map(b => ({
            text: (b.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 50),
            aria: b.getAttribute('aria-label') || '',
            type: b.tagName,
            cls: (b.className || '').toString().slice(0, 60)
        }));
        const seen = new Set();
        return btns.filter(b => {
            const k = b.text + '|' + b.aria + '|' + b.type;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    })()`);
    console.log('FILTER BUTTONS:');
    console.log(JSON.stringify(dump, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });