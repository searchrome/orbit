const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

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
    if (!loc.found) { console.log('no chip'); await browser.close(); return; }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await sleep(2500);

    await browser.evaluate(tab.id, `(() => {
        const inp = document.querySelector('input[data-testid="typeahead-input"]') || Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        if (inp) inp.focus();
    })()`);
    await client.send('Input.insertText', { text: 'Istanbul' });
    await sleep(2500);

    // Dump ALL suggestion option elements with full attributes + inner html head
    const dump = await browser.evaluate(tab.id, `(() => {
        const opts = Array.from(document.querySelectorAll('[role="option"]'));
        return {
            count: opts.length,
            items: opts.slice(0, 12).map(o => {
                const attrs = {};
                for (const a of o.attributes) attrs[a.name] = (a.value || '').toString().slice(0, 200);
                return { attrs, text: (o.innerText||o.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 80), html: o.outerHTML.slice(0, 700) };
            })
        };
    })()`);
    console.log(JSON.stringify(dump, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });