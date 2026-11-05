const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const dump = await browser.evaluate(tab.id, `(() => {
        const lis = Array.from(document.querySelectorAll('li')).filter(li => li.querySelector('a[href*="/in/"]'));
        const buckets = {};
        lis.slice(0, 60).forEach(li => {
            const cls = (li.className || '').split(' ')[0];
            buckets[cls] = (buckets[cls] || 0) + 1;
        });
        return { totalLisWithIn: lis.length, buckets, firstHtml: lis.slice(0,2).map(li => li.outerHTML.slice(0, 5000)) };
    })()`);
    console.log(JSON.stringify(dump, null, 2));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });