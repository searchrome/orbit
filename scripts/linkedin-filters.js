const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find(t => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const dump = await browser.evaluate(tab.id, `(() => {
        const visibleButtons = Array.from(document.querySelectorAll('button')).filter(b => {
            const style = window.getComputedStyle(b);
            const r = b.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        }).map(b => ({ text: (b.innerText || '').replace(/\\s+/g,' ').trim().slice(0, 60), cls: b.className.slice(0, 80), aria: b.getAttribute('aria-label') || '' })).slice(0, 60);
        const inputs = Array.from(document.querySelectorAll('input')).map(i => ({ placeholder: i.placeholder || '', cls: i.className.slice(0, 80), name: i.name || '' })).slice(0, 30);
        return { buttons: visibleButtons, inputs };
    })()`);
    console.log(JSON.stringify(dump, null, 1));
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });