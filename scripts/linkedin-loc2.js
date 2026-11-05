const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    // Click the Locations chip (text-based)
    const byText = await browser.evaluate(tab.id, `(() => {
        const divs = Array.from(document.querySelectorAll('div,button')).filter(d =>
            (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
        );
        if (divs.length) {
            const el = divs[0];
            el.scrollIntoView({block:'center'});
            const r = el.getBoundingClientRect();
            return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        }
        return { found: false };
    })()`);
    console.log('loc at:', JSON.stringify(byText));
    if (byText.found) {
        const client = await browser.getPageClient(tab.id);
        const { x, y } = byText;
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
        client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        await sleep(2000);
    }

    // Dump all inputs with full attrs + surrounding html of any popup-ish containers
    const state = await browser.evaluate(tab.id, `(() => {
        const info = { inputs: [], dialogs: [], htmlFrags: [] };
        Array.from(document.querySelectorAll('input')).forEach(i => {
            const r = i.getBoundingClientRect();
            const visible = r.width > 0 && r.height > 0;
            info.inputs.push({ id: i.id||'', ph: i.placeholder||'', aria: i.getAttribute('aria-label')||'', visible, cls: (i.className||'').toString().slice(0,60) });
        });
        Array.from(document.querySelectorAll('.artdeco-dropdown__content, [role="listbox"], [role="presentation"]')).slice(0,4).forEach(el => {
            info.dialogs.push({ cls: (el.className||'').toString().slice(0,80), text: (el.innerText||'').replace(/\\s+/g,' ').slice(0,300) });
        });
        // find container holding 'Locations' chip
        const chip = Array.from(document.querySelectorAll('div')).find(d => (d.innerText||'').trim() === 'Locations');
        if (chip) {
            let p = chip.parentElement;
            for (let i=0; i<6 && p; i++, p = p.parentElement) {
                const html = p.outerHTML || '';
                if (html.includes('artdeco-dropdown') || html.includes('typeahead')) {
                    info.htmlFrags.push(p.outerHTML.slice(0, 2500));
                    break;
                }
            }
            if (!info.htmlFrags.length && p) info.htmlFrags.push(p.outerHTML.slice(0, 1800));
        }
        return info;
    })()`);
    console.log(JSON.stringify(state, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });