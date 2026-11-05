const { CdpBrowserSession } = require('./cdp-browser-session.js');

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const EXTRACTOR = `(() => {
        const results = [];
        const items = Array.from(document.querySelectorAll('div[role="listitem"]'));
        for (const root of items) {
            const a = root.querySelector('a[href*="/in/"]');
            if (!a) continue;
            const url = a.href;
            const name = (a.innerText || a.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
            const text = (root.innerText || '').replace(/\\n+/g, ' \\\\n ');
            const titleMatch = text.match(/• 2nd|[0-9]+\\+?[a-z]* [A-Z]?/);
            const headline = (root.querySelector('[class*="headline"], [class*="subtitle"], div[role="listitem"] > div > div > div > div:nth-child(2) > div:nth-child(2)')?.innerText || '').replace(/\\s+/g,' ').trim();
            const o2w = /open to work/i.test(text) || /#open.?to.?work/i.test(text);
            results.push({ url, name, text: text.slice(0, 700) });
        }
        return { count: results.length, results };
    })()`;

    const dump = await browser.evaluate(tab.id, EXTRACTOR);
    console.log('COUNT:', dump.count);
    for (const r of dump.results) {
        console.log('---');
        console.log(r.name.slice(0, 80));
        console.log(r.url.slice(0, 90));
        console.log(r.text.slice(0, 300));
    }
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });