const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    // ensure open
    const st = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        return { open: !!inp && inp.getBoundingClientRect().width > 0, val: inp?.value || '' };
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
        if (loc.found) {
            await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
            await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: loc.x, y: loc.y, button: 'left', clickCount: 1 });
            await browser.evaluate(tab.id, `(() => {
                const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
                if (inp) inp.focus();
            })()`);
            await client.send('Input.insertText', { text: 'İstanbul' });
            await sleep(2500);
        }
    }

    // Click the role=button inside the 'Istanbul, Türkiye' option via DOM .click() (bubbles)
    const res = await browser.evaluate(tab.id, `(() => {
        const popover = document.querySelector('[popover="manual"][style*="position: fixed"]');
        const opt = Array.from((popover || document).querySelectorAll('[role="option"]')).find(o => (o.innerText||'').replace(/\\s+/g,' ').trim() === 'Istanbul, Türkiye');
        if (!opt) return { found: false };
        const btn = opt.querySelector('[role="button"]') || opt;
        btn.click();
        return { found: true };
    })()`);
    console.log('dom click:', res.found);
    await sleep(4000);

    const info = await browser.getTabInfo({ tabId: tab.id });
    console.log('URL:', info.tab.url);
    const chk = await browser.evaluate(tab.id, `(() => {
        const url = location.href;
        return {
            url,
            geoInUrl: /geo(Urn|Id|graphicCodes)=/.test(url),
            checked: Array.from(document.querySelectorAll('[aria-checked="true"]')).map(e => e.getAttribute('aria-label') || (e.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40)).filter(Boolean).slice(0,10),
            popoverOpen: !!document.querySelector('[popover="manual"][style*="position: fixed"]'),
            bodySample: (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 250)
        };
    })()`);
    console.log(JSON.stringify(chk, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });