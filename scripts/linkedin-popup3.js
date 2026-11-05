const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // close any stray popovers by pressing Escape
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await sleep(800);

    const loc = await browser.evaluate(tab.id, `(() => {
        const els = Array.from(document.querySelectorAll('div,button')).filter(d =>
            (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
        );
        if (!els.length) return { found: false };
        const el = els[0];
        const r = el.getBoundingClientRect();
        return { found: true, x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
    })()`);
    if (!loc.found) { console.log('no chip'); await browser.close(); return; }
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
    await sleep(2500);

    const okInp = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        if (!inp) return false;
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    console.log('focused loc input:', okInp);
    if (!okInp) { await browser.close(); return; }

    // Type İstanbul (with dotless i) via insertText
    await client.send('Input.insertText', { text: 'İstanbul' });
    await sleep(3000);

    // Dump the full dropdown container: from the input upward
    const dump = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        let container = null, was = inp;
        if (inp) {
            let p = inp;
            for (let i = 0; i < 8 && p; i++) {
                const html = p.outerHTML || '';
                if (html.includes('typeahead-results-popover') || /location/i.test(html) && p.querySelectorAll && p.querySelector('[data-testid="typeahead-results-popover"]')) { container = p; break; }
                p = p.parentElement;
            }
            container = container || inp.closest('[popover]') || inp.closest('[role="dialog"]');
        }
        return {
            containerHtml: container ? container.outerHTML : null,
            options: Array.from(document.querySelectorAll('[data-testid="typeahead-results-popover"] [role="option"]')).map(o => ({
                text: (o.innerText||'').replace(/\\s+/g,' ').trim().slice(0,60),
                html: o.outerHTML.slice(0, 900)
            })).slice(0, 6)
        };
    })()`);
    const html = dump.containerHtml || '';
    console.log('container len:', html.length);
    console.log(html.slice(0, 7000));
    console.log('--- FIRST OPTION FULL ---');
    console.log(dump.options[0] ? JSON.stringify(dump.options[0], null, 1) : 'none');
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });