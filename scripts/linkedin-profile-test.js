const { CdpBrowserSession } = require('./cdp-browser-session.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
    const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
    await browser.initialize();
    const tab = browser.listTabs().find((t) => t.url.includes('linkedin.com'));
    if (!tab) { console.error('no linkedin tab'); await browser.close(); process.exit(1); }

    const url = 'https://www.linkedin.com/in/ferhat-%C3%A7ak%C4%B1r/';
    await browser.navigate(tab.id, url);
    await sleep(8000);
    const info = await browser.getTabInfo({ tabId: tab.id });
    console.log('URL:', info.tab.url);
    console.log('TITLE:', info.tab.title);

    const dump = await browser.evaluate(tab.id, `(() => {
        const body = (document.body.innerText || '').replace(/\\n+/g, ' \\\\n ');
        return { len: body.length, head: body.slice(0, 2500), topCard: (document.querySelector('.pv-top-card, [class*="top-card"], section')?.innerText || '').replace(/\\s+/g,' ').slice(0,500) };
    })()`);
    console.log('BODY HEAD:');
    console.log(dump.head);
    console.log('TOP CARD:', dump.topCard);
    await browser.close();
})().catch((e) => { console.error('ERR', e); process.exit(1); });