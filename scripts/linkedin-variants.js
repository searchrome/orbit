const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VARIANTS = [
    ['no-geo', 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent('muhasebe uzmanı')],
    ['geo-103155411', 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent('muhasebe uzmanı') + '&geoUrn=%5B%22103155411%22%5D'],
    ['geo-103155411-simple', 'https://www.linkedin.com/search/results/people/?geoUrn=%5B%22103155411%22%5D&keywords=' + encodeURIComponent('muhasebe') ],
    ['linkedin-mobile-ist', 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent('muhasebe uzmanı') + '&GeoId=103155411' ],
];

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    for (const [label, url] of VARIANTS) {
        await browser.navigate(tab.id, url);
        await sleep(6500);
        const info = await browser.getTabInfo({ tabId: tab.id });
        const state = await browser.evaluate(tab.id, `(() => {
            const resultItems = document.querySelectorAll('li').length;
            const inLinks = document.querySelectorAll('a[href*="/in/"]').length;
            const bodyText = (document.body?.innerText || '');
            const noRes = bodyText.includes('No results found');
            const placeholder = bodyText.includes('Sign in') ? 'SIGNIN_WALL' : '';
            return { li: resultItems, inLinks, noRes, len: bodyText.length, snippet: bodyText.slice(0, 300) };
        })()`);
        console.log(`--- ${label} ---`);
        console.log('  url:', info.tab.url);
        console.log('  state:', JSON.stringify(state));
    }
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });