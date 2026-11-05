const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // Click Locations chip
    const loc = await browser.evaluate(tab.id, `(() => {
        const els = Array.from(document.querySelectorAll('div,button')).filter(d =>
            (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
        );
        if (!els.length) return { found: false };
        const el = els[0];
        el.scrollIntoView({block:'center'});
        const r = el.getBoundingClientRect();
        return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);
    if (!loc.found) { console.log('no loc chip'); await browser.close(); return; }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await sleep(2500);

    const hasInput = await browser.evaluate(tab.id, `!!Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder))`);
    console.log('popup open?', hasInput);
    if (!hasInput) { await browser.close(); return; }

    await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        inp.focus();
    })()`);
    await client.send('Input.insertText', { text: 'İstanbul' });
    await sleep(2500);

    // Dump the whole popup container HTML around the input (search up from input)
    const popup = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        let html = null;
        if (inp) {
            let p = inp.closest('[role="dialog"]') || inp.parentElement.parentElement;
            html = p.outerHTML;
        }
        // also collect visible buttons anywhere
        const buttons = Array.from(document.querySelectorAll('button')).filter(b => {
            const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        }).map(b => ({ text: (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40), aria: b.getAttribute('aria-label')||'' })).filter(b => b.text || b.aria);
        return { popupHtml: html ? html.slice(0, 6000) : null, buttons: buttons.slice(-25) };
    })()`);
    console.log('--- POPUP HTML (first 6000) ---');
    console.log(popup.popupHtml);
    console.log('--- visible buttons tail ---');
    console.log(JSON.stringify(popup.buttons, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });