const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const dump = await browser.evaluate(tab.id, `(() => {
        try {
            const lis = Array.from(document.querySelectorAll('li')).filter(li => li.querySelector('a[href*="/in/"]') && li.getBoundingClientRect().width > 0);
            const first = lis[0];
            const findResultRoot = (li) => {
                const a = li.querySelector('a[href*="/in/"]');
                let node = a;
                const candidates = [];
                for (let i = 0; i < 8 && node; i++, node = node.parentElement) {
                    const cls = (node.className || '').toString();
                    const hasName = node.querySelector('[class*="entity-result__title"], [class*="actor-name"], [class*="search-result"]');
                    if (hasName) candidates.push(node);
                }
                return candidates[0] ? candidates[0].outerHTML.slice(0, 5000) : (a ? a.closest('li')?.outerHTML?.slice(0, 5000) : 'no-li');
            };
            return { count: lis.length, html: first ? findResultRoot(first) : 'no-lis' };
        } catch (e) { return { error: String(e) }; }
    })()`);
    console.log('card count:', dump.count);
    console.log(dump.html);
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });