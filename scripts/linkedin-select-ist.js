const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    // click the "Istanbul, Türkiye" suggestion
    const clicked = await browser.evaluate(tab.id, `(() => {
        const opts = Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] li, [role="listbox"] button'));
        const target = opts.find(o => (o.innerText||'').replace(/\\s+/g,' ').trim() === 'Istanbul, Türkiye');
        if (!target) return { ok: false, opts: opts.map(o => (o.innerText||'').trim().slice(0,40)).slice(0,10) };
        target.scrollIntoView({ block: 'center' });
        const r = target.getBoundingClientRect();
        return { ok: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: target.tagName };
    })()`);
    console.log('click target:', JSON.stringify(clicked));
    if (clicked.ok) {
        const client = await browser.getPageClient(tab.id);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: clicked.x, y: clicked.y, button: 'none' });
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: clicked.x, y: clicked.y, button: 'left', clickCount: 1 });
    }
    await sleep(6000);
    const info = await browser.getTabInfo({ tabId: tab.id });
    console.log('FINAL URL:', info.tab.url);
    console.log('TITLE:', info.tab.title);

    const state = await browser.evaluate(tab.id, `(() => {
        const inLinks = Array.from(document.querySelectorAll('a[href*="/in/"]')).map(a => a.href);
        const chips = Array.from(document.querySelectorAll('[class*="filter"]')).map(c => (c.innerText||'').trim()).filter(Boolean).slice(0, 20);
        const noRes = (document.body.innerText||'').includes('No results found');
        const firstLi = document.querySelector('li');
        return { inLinksCount: inLinks.length, noRes, chips, liClass: firstLi ? (firstLi.className||'').toString().slice(0,80) : null };
    })()`);
    console.log('STATE:', JSON.stringify(state, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });