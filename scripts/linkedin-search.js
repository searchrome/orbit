#!/usr/bin/env node
'use strict';

const { CdpBrowserSession } = require('./cdp-browser-session.js');

const PORT = parseInt(process.env.PORT || '9222', 10);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const browser = new CdpBrowserSession({ baseUrl: `http://127.0.0.1:${PORT}` });
    await browser.initialize();

    const tabs = browser.listTabs();
    console.log('TABS:', JSON.stringify(tabs.map(t => ({ id: t.id.slice(0,8), url: t.url })), null, 2));

    const linkedinTab = tabs.find(t => t.url.includes('linkedin.com'));
    if (!linkedinTab) {
        console.log('No LinkedIn tab found');
        await browser.close();
        return;
    }

    const tabId = linkedinTab.id;
    const url = 'https://www.linkedin.com/search/results/people/?keywords=' + encodeURIComponent('muhasebe uzmanı') + '&geoUrn=%5B%22103155411%22%5D';
    console.log('Navigating to:', url);
    await browser.navigate(tabId, url);
    await sleep(6000);

    const info = await browser.getTabInfo({ tabId });
    console.log('NOW AT:', info.tab.url);

    const head = await browser.readPageText({ tabId, maxChars: 3000 });
    console.log('--- PAGE TEXT (head) ---');
    console.log(head.text.slice(0, 3000));

    await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });