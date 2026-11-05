const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const res = await browser.evaluate(tab.id, `(async () => {
        const results = {};
        const tries = [
            ['typeahead/hits', 'https://www.linkedin.com/typeahead/hits?q=' + encodeURIComponent('istanbul') + '&filterContext=people&maxResults=8'],
            ['typeaheadLocation', 'https://www.linkedin.com/voyager/api/search/typeaheadLocation?query=' + encodeURIComponent('istanbul') + '&typeaheadColorFilters=0&maxResults=8'],
            ['typeahead_geo', 'https://www.linkedin.com/voyager/api/typeahead/hits?q=' + encodeURIComponent('istanbul') + '&maxResults=8&category=GEO'],
        ];
        for (const [label, url] of tries) {
            try {
                const r = await fetch(url, { credentials: 'include', headers: { 'csrf-token': 'fetch' } });
                const txt = await r.text();
                results[label] = { status: r.status, len: txt.length, txt: txt.slice(0, 600) };
            } catch (e) {
                results[label] = { error: e.message };
            }
        }
        return results;
    })()`);
    console.log(JSON.stringify(res, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });