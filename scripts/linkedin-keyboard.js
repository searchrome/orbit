const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // Ensure focused on the typeahead input
    const ok = await browser.evaluate(tab.id, `(() => {
        const inp = document.querySelector('input[data-testid="typeahead-input"]') || Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        if (!inp) return false;
        inp.focus();
        return true;
    })()`);
    console.log('focused on typeahead:', ok);

    // Press ArrowDown then Enter
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await sleep(500);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await sleep(2500);

    const state = await browser.evaluate(tab.id, `(() => {
        const chips = Array.from(document.querySelectorAll('[class*="pill"], [class*="chip"], li[class*="filter"]')).filter(e => {
            const t = (e.innerText||'').trim(); const r = e.getBoundingClientRect();
            return (t.includes('Istanbul') || t.includes('İstanbul')) && r.width > 0;
        }).map(e => ({ text: (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60), html: e.outerHTML.slice(0, 500) }));
        const buttons = Array.from(document.querySelectorAll('button')).filter(b => {
            const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (b.innerText||'').trim();
        }).map(b => ({ text: (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40), cls: (b.className||'').toString().slice(0,40) })).filter(Boolean);
        const urlNow = location.href;
        const selectedOpts = Array.from(document.querySelectorAll('[role="option"]')).filter(o => (o.getAttribute('aria-selected') === 'true')).map(o => (o.innerText||'').trim().slice(0,50));
        return { chips, buttons: buttons.slice(0, 20), urlNow, selectedOpts };
    })()`);
    console.log('AFTER KEY selection:', JSON.stringify(state, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });