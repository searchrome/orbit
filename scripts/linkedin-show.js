const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // ensure open & typed
    const st = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        return { open: !!popover && popover.getBoundingClientRect().width > 0 };
    })()`);
    if (!st.open) {
        const loc = await browser.evaluate(tab.id, `(() => {
            const els = Array.from(document.querySelectorAll('div,button')).filter(d =>
                (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
            );
            if (!els.length) return { found: false };
            const r = els[0].getBoundingClientRect();
            return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        })()`);
        if (!loc.found) { console.log('no chip'); await browser.close(); return; }
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
        await browser.evaluate(tab.id, `(() => {
            const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
            if (inp) inp.focus();
        })()`);
        await client.send('Input.insertText', { text: 'İstanbul' });
        await sleep(2500);
    }
    // ensure "Istanbul, Türkiye" checkbox is checked
    let needClick = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        const cb = Array.from((popover || document).querySelectorAll('[role="checkbox"]')).find(c => c.getAttribute('aria-label') === 'Istanbul, Türkiye');
        return { exists: !!cb, checked: cb?.getAttribute('aria-checked') };
    })()`);
    console.log('Istanbul checkbox state:', JSON.stringify(needClick));
    if (needClick.exists && needClick.checked === 'false') {
        const target = await browser.evaluate(tab.id, `(() => {
            const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
            const cb = Array.from((popover || document).querySelectorAll('[role="checkbox"]')).find(c => c.getAttribute('aria-label') === 'Istanbul, Türkiye');
            cb.scrollIntoView({ block: 'center' });
            const r = cb.getBoundingClientRect();
            return { x: Math.round(r.left + 20), y: Math.round(r.top + r.height/2) };
        })()`);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300, y: target.y, button: 'none' });
        await sleep(150);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y, button: 'none' });
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
        await sleep(2500);
    }
    // verify
    let check = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        const checked = Array.from((popover || document).querySelectorAll('[role="checkbox"][aria-checked="true"]')).map(e => e.getAttribute('aria-label'));
        return { checked };
    })()`);
    console.log('checked now:', JSON.stringify(check));

    // Dump ALL visible buttons on the whole page (esp. footer 'Show results')
    const btns = await browser.evaluate(tab.id, `(() => {
        const all = Array.from(document.querySelectorAll('button')).filter(b => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && (b.innerText||'').trim();
        }).map(b => ({ text: (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60), disabled: !!b.disabled }));
        const uniq = [];
        for (const b of all) if (!uniq.some(u => u.text === b.text)) uniq.push(b);
        return uniq;
    })()`);
    console.log('ALL VISIBLE BUTTONS:', JSON.stringify(btns, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });