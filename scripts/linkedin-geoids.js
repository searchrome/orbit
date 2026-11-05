const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    // open Locations popup
    const loc = await browser.evaluate(tab.id, `(() => {
        const divs = Array.from(document.querySelectorAll('div,button')).filter(d =>
            (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
        );
        if (!divs.length) return { found: false };
        const el = divs[0];
        el.scrollIntoView({block:'center'});
        const r = el.getBoundingClientRect();
        return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);
    if (loc.found) {
        const client = await browser.getPageClient(tab.id);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
        await sleep(1500);
    }
    await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        if (inp) inp.focus();
    })()`);
    await browser.getPageClient(tab.id).then(c => c.send('Input.insertText', { text: 'İstanbul' }));
    await sleep(2500);

    const dump = await browser.evaluate(tab.id, `(() => {
        const opts = Array.from(document.querySelectorAll('[role="listbox"] [role="option"], [role="listbox"] li, [role="listbox"] button'));
        return opts.map(o => {
            const attrs = {};
            for (const a of o.attributes) attrs[a.name] = a.value.slice ? a.value.slice(0, 120) : String(a.value);
            return { attrs, text: (o.innerText||'').replace(/\\s+/g,' ').trim().slice(0, 60) };
        }).slice(0, 14);
    })()`);
    console.log(JSON.stringify(dump, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });