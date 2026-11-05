const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // ensure popup open & typed
    const st = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        return { open: !!inp && inp.getBoundingClientRect().width > 0, val: inp?.value || '' };
    })()`);
    console.log('popup state:', JSON.stringify(st));
    if (!st.open || !st.val) {
        const loc = await browser.evaluate(tab.id, `(() => {
            const els = Array.from(document.querySelectorAll('div,button')).filter(d =>
                (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
            );
            if (!els.length) return { found: false };
            const r = els[0].getBoundingClientRect();
            return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        })()`);
        if (loc.found) {
            await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
            await browser.evaluate(tab.id, `(() => {
                const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
                if (inp) inp.focus();
            })()`);
            await client.send('Input.insertText', { text: 'İstanbul' });
            await sleep(2500);
        }
    }

    // Find the "Istanbul, Türkiye" option and trusted-click it
    const target = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        const opt = Array.from((popover || document).querySelectorAll('[role="option"]')).find(o => (o.innerText||'').replace(/\\s+/g,' ').trim() === 'Istanbul, Türkiye');
        if (!opt) return { found: false };
        opt.scrollIntoView({ block: 'center' });
        const r = opt.getBoundingClientRect();
        return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), w: r.width, h: r.height };
    })()`);
    console.log('option target:', JSON.stringify(target));
    if (!target.found) { await browser.close(); return; }

    // mouse move in a few steps (hover) then press+release
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: target.y, button: 'none' });
    await sleep(200);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
    await sleep(300);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(150);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(4000);

    const info = await browser.getTabInfo({ tabId: tab.id });
    console.log('URL NOW:', info.tab.url);
    const chk = await browser.evaluate(tab.id, `(() => {
        const filtBar = document.querySelector('#SearchResults_SearchResultsFilterBar');
        return {
            filtTxt: filtBar ? (filtBar.innerText||'').replace(/\\s+/g,' ').slice(0,300) : null,
            chips: Array.from(document.querySelectorAll('[class*="filter"], [class*="chip"]')).map(c => (c.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50)).filter(t => t && /istanbul|türkiye|i̇stanbul/i.test(t)).slice(0,10),
            inLinks: document.querySelectorAll('a[href*="/in/"]').length,
            popupStillOpen: !!document.querySelector('[role="option"][aria-selected="true"], [popover="manual"][style*="position: fixed"]')
        };
    })()`);
    console.log('CHECK:', JSON.stringify(chk, null, 1));

    // If no geo in URL, try clicking the checkbox item 'Türkiye' style? Instead grab tracking id if present
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });