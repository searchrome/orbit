const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // Ensure popover is open & typed
    const st = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        return { open: !!popover && popover.getBoundingClientRect().width > 0, val: inp?.value || '' };
    })()`);
    if (!st.open || !st.val) {
        const loc = await browser.evaluate(tab.id, `(() => {
            const els = Array.from(document.querySelectorAll('div,button')).filter(d =>
                (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
            );
            if (!els.length) return { found: false };
            const r = els[0].getBoundingClientRect();
            return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        })()`);
        if (!loc.found) { console.log('no chip'); await browser.close(); return; }
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

    // Click the checkbox "Istanbul, Türkiye" using a trusted mouse click
    const target = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        const cb = Array.from((popover || document).querySelectorAll('[role="checkbox"]')).find(c => c.getAttribute('aria-label') === 'Istanbul, Türkiye' || (c.innerText||'').replace(/\\s+/g,' ').trim() === 'Istanbul, Türkiye');
        if (!cb) return { found: false };
        cb.scrollIntoView({ block: 'center' });
        const r = cb.getBoundingClientRect();
        return { found: true, x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) };
    })()`);
    console.log('checkbox cell:', JSON.stringify(target));
    if (!target.found) { await browser.close(); return; }

    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: target.y, button: 'none' });
    await sleep(200);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
    await sleep(200);
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(150);
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await sleep(3000);

    const state = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        const checked = Array.from((popover || document).querySelectorAll('[role="checkbox"][aria-checked="true"]')).map(e => e.getAttribute('aria-label') || (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40));
        const buttons = popover ? Array.from(popover.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0 && (b.innerText||'').trim()).map(b => ({ text: (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50), disabled: b.disabled })) : [];
        return { popoverOpen: !!popover && popover.getBoundingClientRect().width > 0, checked, buttons, url: location.href };
    })()`);
    console.log('AFTER CHECKBOX CLICK:', JSON.stringify(state, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });