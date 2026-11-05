const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const state = await browser.evaluate(tab.id, `(() => {
        const body = (document.body.innerText || '').replace(/\\n+/g, ' \\n ');
        const filtBar = document.querySelector('#SearchResults_SearchResultsFilterBar, [componentkey*="FilterBar"]');
        const filtText = filtBar ? (filtBar.innerText || '').replace(/\\s+/g, ' ').slice(0, 400) : null;
        const inAnchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));
        const sampleHtml = inAnchors.length ? inAnchors[0].closest('li, article, div.entity-result')?.outerHTML.slice(0, 3000) : null;
        return { filtText, bodyStart: body.slice(0, 900), inCount: inAnchors.length, sampleContainerTag: inAnchors.length ? inAnchors[0].closest('li, article, div.entity-result')?.tagName : null, sampleHtml: sampleHtml || null };
    })()`);
    console.log('filter text:', state.filtText);
    console.log('--- body start ---');
    console.log(state.bodyStart);
    console.log('--- sample container tag:', state.sampleContainerTag, '---');
    console.log(state.sampleHtml);
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });