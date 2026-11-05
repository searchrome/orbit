const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // ensure popup still open; if not reopen, retype
    const state = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        return { open: !!inp && inp.getBoundingClientRect().width > 0 };
    })()`);
    if (!state.open) {
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

    // Dump the footer portion of the popover (after options) - buttons & html tail
    const dump = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        let html = popover ? popover.outerHTML : null;
        const footerBtns = popover ? 
            Array.from(popover.querySelectorAll('button, [role="button"]')).filter(b => (b.innerText||'').trim()).map(b => ({ text: (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50), html: b.outerHTML.slice(0, 400) })).slice(-10) : [];
        const options = popover ? Array.from(popover.querySelectorAll('[role="option"]')).map(o => ({ text: (o.innerText||'').replace(/\\s+/g,' ').trim().slice(0,50), sel: o.getAttribute('aria-selected') })) : [];
        return { footerHtml: html ? html.slice(-4000) : null, footerBtns, options };
    })()`);
    console.log('--- POPOVER FOOTER (last 4000) ---');
    console.log(dump.footerHtml);
    console.log('--- footer buttons ---');
    console.log(JSON.stringify(dump.footerBtns, null, 1));
    console.log('--- options ---');
    console.log(JSON.stringify(dump.options, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });