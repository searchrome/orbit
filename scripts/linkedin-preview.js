const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    // First check whether a Locations popup is ALREADY open (from previous run)
    let state = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).filter(i => i.placeholder && /add a location/i.test(i.placeholder));
        return { addLocationInputs: inp.length, url: location.href };
    })()`);
    console.log('state before:', JSON.stringify(state));

    // Open popup
    const loc = await browser.evaluate(tab.id, `(() => {
        const divs = Array.from(document.querySelectorAll('div,button')).filter(d =>
            (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
        );
        if (!divs.length) return { found: false };
        const el = divs[0];
        el.scrollIntoView({block:'center'});
        const r = el.getBoundingClientRect();
        return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2), tag: el.tagName, cls: (el.className||'').toString().slice(0,60) };
    })()`);
    console.log('loc:', JSON.stringify(loc));

    if (loc.found) {
        // Some chips open via a hover+click; try clicking the inner text element too
        // Use a real mouse click AND a DOM .click()
        const client = await browser.getPageClient(tab.id);
        await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
        await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
        await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
        await sleep(2000);
        await browser.evaluate(tab.id, `(() => {
            const divs = Array.from(document.querySelectorAll('div,button')).filter(d =>
                (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
            );
            if (divs.length) divs[0].click();
        })()`);
        await sleep(2000);
    }

    state = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).filter(i => i.placeholder && /add a location/i.test(i.placeholder));
        const dialogs = Array.from(document.querySelectorAll('[role="dialog"], .artdeco-dropdown__content')).filter(d => d.getBoundingClientRect().width > 0);
        const body = (document.body.innerText||'').replace(/\\s+/g,' ').slice(0,200);
        return { addLocationInputs: inp.length, dialogs: dialogs.length, bodyStart: body };
    })()`);
    console.log('state after:', JSON.stringify(state, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });