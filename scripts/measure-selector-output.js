#!/usr/bin/env node

/*
 * Deterministic Ticket 01 benchmark. It measures the JSON returned by the
 * shared BrowserTools implementation, not a hand-written approximation.
 */
const fs = require('node:fs');
const path = require('node:path');
const { getEncoding } = require('js-tiktoken');
const { JSDOM } = require('jsdom');

function loadBrowserTools() {
    const source = fs.readFileSync(path.join(__dirname, '..', 'browser-tools.js'), 'utf8');
    const transformed = source
        .replace("import { normalizeBrowserToolUrl } from './browser-url-policy.js';", fs.readFileSync(path.join(__dirname, '../browser-url-policy.js'), 'utf8').replace('export function', 'function'))
        .replace(/export default BrowserTools;\s*$/, 'module.exports = BrowserTools;');
    const module = { exports: {} };
    new Function('module', 'exports', 'require', transformed)(module, module.exports, require);
    return module.exports;
}

function createTools() {
    const webview = {
        getURL: () => 'https://example.test/results',
        isLoading: () => false,
        canGoBack: () => false,
        executeJavaScript: (script) => Promise.resolve(eval(script))
    };
    const tab = {
        id: 'fixture-tab',
        title: 'Selector fixture',
        url: 'https://example.test/results',
        loadUrl: 'https://example.test/results',
        role: 'regular',
        assistantOwned: true,
        internal: false,
        webview
    };
    const tabManager = {
        getTabById: (tabId) => tabId === tab.id ? tab : null,
        getActiveTab: () => tab
    };
    const BrowserTools = loadBrowserTools();
    return new BrowserTools(tabManager);
}

function tokenCount(encoder, value) {
    return encoder.encode(JSON.stringify(value)).length;
}

async function main() {
    const dom = new JSDOM('<article class="result"></article>');
    global.document = dom.window.document;
    const fixtureText = 'Detailed source evidence with product facts. '.repeat(800);
    document.querySelector('.result').textContent = fixtureText;

    const tools = createTools();
    const legacy = await tools.querySelectorAll({
        tabId: 'fixture-tab',
        selector: '.result',
        fields: ['text']
    });
    const compact = await tools.querySelectorAll({
        tabId: 'fixture-tab',
        selector: '.result',
        fields: ['text'],
        compact: true
    });

    const encoder = getEncoding('o200k_base');
    const report = {
        fixture: 'one selector match containing 800 repeated evidence phrases',
        targetModel: 'openrouter/z-ai/glm-5.3-flash',
        tokenizer: 'o200k_base via js-tiktoken 1.0.21',
        note: 'This is a reproducible estimate. Confirm the provider tokenizer for a model-specific billing or context-limit claim.',
        legacy: {
            responseTokens: tokenCount(encoder, legacy),
            returnedTextChars: legacy.items[0].text.length,
            preservesCompleteText: legacy.items[0].text === fixtureText.trim()
        },
        compact: {
            responseTokens: tokenCount(encoder, compact),
            returnedTextChars: compact.items[0].text.length,
            preservesLeadingEvidence: compact.items[0].text === fixtureText.trim().slice(0, 280),
            truncated: compact.truncated,
            nextTextOffset: compact.nextTextOffset
        }
    };
    console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
});
