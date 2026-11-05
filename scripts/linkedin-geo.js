const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    // Use the typeahead API (same-origin, session-authenticated) to resolve the Istanbul geo URN
    const res = await browser.evaluate(tab.id, `(async () => {
        const url = 'https://www.linkedin.com/typeahead/hits?q=' + encodeURIComponent('İstanbul') + '&filterContext=people&maxResults=8';
        const r = await fetch(url, { credentials: 'include' });
        const data = await r.json();
        const hits = data?.elements || [];
        return hits.map(h => ({ id: h?.id || h?.trackingUrn || h?.publicIdentifier, display: h?.displayName || h?.title, type: h?.type }));
    })()`);
    console.log('TYP:', JSON.stringify(res, null, 2));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });