const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // Open Locations popup
    const loc = await browser.evaluate(tab.id, `(() => {
        const els = Array.from(document.querySelectorAll('div,button')).filter(d =>
            (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
        );
        if (!els.length) return { found: false };
        const r = els[0].getBoundingClientRect();
        return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);
    if (!loc.found) { console.log('no loc chip'); await browser.close(); return; }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await sleep(2500);

    // focus typeahead & type
    await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        if (inp) inp.focus();
    })()`);
    await client.send('Input.insertText', { text: 'İstanbul' });
    await sleep(3000);

    // Dump checkbox & option items and any buttons in the popover
    const dump = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        if (!popover) return { popover: false };
        const items = Array.from(popover.querySelectorAll('[role="checkbox"], [role="option"], [role="button"]'))
            .filter(e => (e.innerText||'').trim())
            .map(e => ({ role: e.getAttribute('role'), label: e.getAttribute('aria-label') || '', text: (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,55), checked: e.getAttribute('aria-checked'), tag: e.tagName }));
        const buttons = Array.from(popover.querySelectorAll('button')).filter(b => (b.innerText||'').trim() && b.getBoundingClientRect().width > 0).map(b => ({ text: (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50), html: b.outerHTML.slice(0, 350) }));
        return { popover: true, items: items.slice(0, 30), buttons: buttons.slice(-12) };
    })()`);
    console.log(JSON.stringify(dump, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });