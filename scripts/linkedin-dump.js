const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEARCH_URL = 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent('muhasebe uzmanı') + '&geoUrn=%5B%22103155411%22%5D';

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();

    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    console.log('tab', tab.id.slice(0, 8), tab.url);

    await browser.navigate(tab.id, SEARCH_URL);
    await sleep(7000);

    const info = await browser.getTabInfo({ tabId: tab.id });
    console.log('NOW AT:', info.tab.url, '| title:', info.tab.title);

    const dump = await browser.evaluate(tab.id, `(() => {
        const items = Array.from(document.querySelectorAll('li'))
            .filter(li => li.querySelector('a[href*="/in/"]') && /entity-result|reusable-search|search-result|result-container/i.test(li.className));
        const out = items.slice(0, 3).map((li, i) => ({
            i,
            cls: li.className.slice(0, 120),
            html: li.outerHTML.slice(0, 4000)
        }));
        return { count: items.length, sample: out };
    })()`);
    console.log(JSON.stringify(dump, null, 2));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });