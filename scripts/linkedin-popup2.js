const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }
    const client = await browser.getPageClient(tab.id);

    const okInp = await browser.evaluate(tab.id, `(() => {
        const inp = document.querySelector('input[data-testid="typeahead-input"]') || Array.from(document.querySelectorAll('input')).find(i => i.placeholder && /add a location/i.test(i.placeholder));
        if (!inp) return false;
        inp.focus();
        // clear value via native setter to trigger React change
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(inp, '');
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
    })()`);
    console.log('cleared:', okInp);

    // Type via CDP dispatchKeyEvent (reliable for React typeahead)
    for (const ch of 'istanbul') {
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', text: ch, key: ch, code: `Key${ch.toUpperCase()}` });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, code: `Key${ch.toUpperCase()}` });
    }
    // also insertText fallback
    // await client.send('Input.insertText', { text: 'istanbul' });
    await sleep(2500);

    const dump = await browser.evaluate(tab.id, `(() => {
        const listbox = document.querySelector('[role="listbox"]');
        const container = listbox ? listbox.closest('[data-floating-ui]') || listbox.parentElement : null;
        return {
            listboxId: listbox ? listbox.id : null,
            optionCount: listbox ? listbox.querySelectorAll('[role="option"]').length : 0,
            options: listbox ? Array.from(listbox.querySelectorAll('[role="option"]')).slice(0, 10).map(o => ({
                text: (o.innerText||o.textContent||'').replace(/\\s+/g,' ').trim().slice(0, 60),
                html: o.outerHTML.slice(0, 600)
            })) : [],
            containerHtml: container ? container.outerHTML.slice(0, 4000) : null,
            visibleButtons: Array.from(document.querySelectorAll('button')).filter(b => b.getBoundingClientRect().width > 0 && (b.innerText||'').trim()).map(b => (b.innerText||'').replace(/\\s+/g,' ').trim().slice(0,40)).filter((v,i,a) => a.indexOf(v) === i).slice(0, 25)
        };
    })()`);
    console.log(JSON.stringify(dump, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });