const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    // 1. Click the "Locations" filter chip (it's a DIV role=button)
    const clickRes = await browser.trustedClickElement({ tabId: tab.id, selector: 'div.b0aa260c, [class*="select"]', index: 0 });
    console.log('clickLocations:', JSON.stringify(clickRes.ok));
    await sleep(1500);

    // Pretend the chip may be a specific one; try text-based click fallback
    const byText = await browser.evaluate(tab.id, `(() => {
        const divs = Array.from(document.querySelectorAll('div,button')).filter(d =>
            (d.innerText||'').trim() === 'Locations' && d.getBoundingClientRect().width > 0 && d.getBoundingClientRect().height > 0
        );
        if (divs.length) {
            // scroll + dispatch a real mousedown/up for toggle
            const el = divs[0];
            el.scrollIntoView({block:'center'});
            const r = el.getBoundingClientRect();
            return { found: true, x: r.left + r.width/2, y: r.top + r.height/2, tag: el.tagName };
        }
        return { found: false };
    })()`);
    console.log('byText:', JSON.stringify(byText));

    if (byText.found) {
        const client = await browser.getPageClient(tab.id);
        const x = byText.x, y = byText.y;
        await client.send('Input.dispatchMouseEvent', { type:'mouseMoved', x, y, button:'none' });
        await client.send('Input.dispatchMouseEvent', { type:'mousePressed', x, y, button:'left', clickCount:1 });
        await client.send('Input.dispatchMouseEvent', { type:'mouseReleased', x, y, button:'left', clickCount:1 });
        console.log('clicked Locations by text');
    }
    await sleep(1800);

    // 2. Dump page state: any visible popups / inputs now present
    const state = await browser.evaluate(tab.id, `(() => {
        const inputs = Array.from(document.querySelectorAll('input')).filter(i => {
            const r = i.getBoundingClientRect(); return r.width > 0 && r.height > 0;
        }).map(i => ({ ph: i.placeholder, aria: i.getAttribute('aria-label')||'', id: i.id || '', cls: (i.className||'').toString().slice(0,50) }));
        const popups = Array.from(document.querySelectorAll('[role="listbox"], [role="dialog"], .artdeco-dropdown__content, div[data-test-artdeco-toast]')).map(p => ({ tag: p.tagName, role: p.getAttribute('role'), text: (p.innerText||'').replace(/\\s+/g,' ').slice(0,200) }));
        const bodySnippet = (document.body.innerText||'').replace(/\\s+/g,' ').slice(0, 300);
        return { inputs, popups, bodySnippet };
    })()`);
    console.log('STATE:', JSON.stringify(state, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });