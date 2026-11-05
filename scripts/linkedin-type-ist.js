const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const client = await browser.getPageClient(tab.id);

    // Focus the "Add a location" input and type via trusted key events
    const focusOk = await browser.evaluate(tab.id, `(() => {
        const inp = Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        if (!inp) return { ok: false };
        inp.focus();
        return { ok: true };
    })()`);
    console.log('focus:', focusOk.ok);

    await client.send('Input.insertText', { text: 'İstanbul' });
    await sleep(2500);

    // Dump suggestion listbox
    const sugg = await browser.evaluate(tab.id, `(() => {
        const listboxes = Array.from(document.querySelectorAll('[role="listbox"]'));
        const items = listboxes.flatMap(lb => Array.from(lb.querySelectorAll('[role="option"], li, button')).map(o => ({
            text: (o.innerText||o.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 80),
            cls: (o.className||'').toString().slice(0, 60)
        })));
        return { count: items.length, items: items.slice(0, 12) };
    })()`);
    console.log('SUGGESTIONS:', JSON.stringify(sugg, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });