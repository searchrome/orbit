const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    const target = await browser.evaluate(tab.id, `(() => {
        const a = Array.from(document.querySelectorAll('a')).find(x => x.innerText && x.innerText.trim() === 'Show results' && x.getBoundingClientRect().width > 0);
        if (!a) return { found: false };
        a.scrollIntoView({ block: 'center' });
        const r = a.getBoundingClientRect();
        return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), href: a.getAttribute('href') };
    })()`);
    console.log('show button:', JSON.stringify(target));
    if (!target.found) { await browser.close(); return; }

    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: target.y, button: 'none' });
    await sleep(200);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(7000);

    const info = await browser.getTabInfo({ tabId: tab.id });
    console.log('URL NOW:', info.tab.url);
    const chk = await browser.evaluate(tab.id, `(() => ({
        url: location.href,
        geoInUrl: /geoUrn|geoId|GeoId/.test(location.href),
        inLinks: document.querySelectorAll('a[href*="/in/"]').length,
        noRes: (document.body.innerText||'').includes('No results found'),
        filtText: (document.querySelector('#SearchResults_SearchResultsFilterBar')?.innerText||'').replace(/\\s+/g,' ').slice(0,200)
    }))()`);
    console.log('CHECK:', JSON.stringify(chk, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });