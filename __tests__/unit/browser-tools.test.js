const fs = require('node:fs');
const path = require('node:path');

function loadBrowserTools() {
    // Load the source directly because the repo's Jest setup does not transpile this ESM file.
    const source = fs.readFileSync(path.join(__dirname, '../../browser-tools.js'), 'utf8');
    const transformed = source.replace(/export default BrowserTools;\s*$/, 'module.exports = BrowserTools;');
    const module = { exports: {} };
    const factory = new Function('module', 'exports', 'require', transformed);
    factory(module, module.exports, require);
    return module.exports;
}

const BrowserTools = loadBrowserTools();

function createMockWebview({
    url = 'https://example.com/search',
    loading = false,
    executeResult = { ok: true },
    stateReadError = null
} = {}) {
    const listeners = new Map();
    let currentUrl = url;

    const webview = {
        loadURL: jest.fn(),
        getURL: jest.fn(() => currentUrl),
        isLoading: jest.fn(() => {
            if (stateReadError) {
                throw stateReadError;
            }
            return loading;
        }),
        canGoBack: jest.fn(() => {
            if (stateReadError) {
                throw stateReadError;
            }
            return false;
        }),
        executeJavaScript: jest.fn().mockResolvedValue(executeResult),
        sendInputEvent: jest.fn(),
        addEventListener: jest.fn((eventName, handler) => {
            const handlers = listeners.get(eventName) || [];
            handlers.push(handler);
            listeners.set(eventName, handlers);
        }),
        removeEventListener: jest.fn((eventName, handler) => {
            const handlers = listeners.get(eventName) || [];
            listeners.set(
                eventName,
                handlers.filter((registered) => registered !== handler)
            );
        }),
        dispatch(eventName, payload = {}) {
            const handlers = listeners.get(eventName) || [];
            handlers.forEach((handler) => handler(payload));
        },
        setCurrentUrl(nextUrl) {
            currentUrl = nextUrl;
        }
    };

    return webview;
}

function createTabManager(tab) {
    const manager = {
        tabs: [tab],
        activeTabId: tab.id,
        getTabById: jest.fn((tabId) => (tabId === tab.id ? tab : null)),
        getActiveTab: jest.fn(() => tab),
        switchToTab: jest.fn((tabId) => {
            manager.activeTabId = tabId;
        }),
        createTab: jest.fn(),
        closeTab: jest.fn()
    };

    return manager;
}

describe('BrowserTools load handling', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.restoreAllMocks();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    test('navigateTab surfaces a navigation that never starts', async () => {
        const webview = createMockWebview({
            url: 'https://example.com/search'
        });
        const tab = {
            id: 'tab-1',
            title: 'Example',
            url: 'https://example.com/search',
            loadUrl: 'https://example.com/search',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.navigateTab({
            tabId: 'tab-1',
            url: 'https://example.com/results',
            timeoutMs: 1000
        });

        await jest.advanceTimersByTimeAsync(400);
        const result = await resultPromise;

        expect(webview.loadURL).toHaveBeenCalledWith('https://example.com/results');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Navigation did not start');
    });

    test('waitForLoad reports an observed network block without guessing login or geo causes', async () => {
        const webview = createMockWebview({ url: 'https://example.com/search' });
        const tab = {
            id: 'tab-1', title: 'Example', url: 'https://example.com/search', loadUrl: 'https://example.com/search',
            role: 'regular', assistantOwned: true, internal: false, webview
        };
        const browserTools = new BrowserTools(createTabManager(tab));

        const resultPromise = browserTools.waitForLoad({ tabId: 'tab-1', timeoutMs: 1_000 });
        webview.dispatch('did-fail-load', { errorDescription: 'ERR_BLOCKED_BY_CLIENT' });
        const result = await resultPromise;

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: 'ERR_BLOCKED_BY_CLIENT',
            errorInfo: expect.objectContaining({
                code: 'browser_network_blocked',
                retryable: false,
                certainty: 'observed',
                actionMayHaveCompleted: false
            })
        }));
    });

    test('waitForLoad marks a deadline as retryable only because it is a safe read', async () => {
        const webview = createMockWebview({ url: 'https://example.com/search', loading: true });
        const tab = {
            id: 'tab-1', title: 'Example', url: 'https://example.com/search', loadUrl: 'https://example.com/search',
            role: 'regular', assistantOwned: true, internal: false, webview
        };
        const browserTools = new BrowserTools(createTabManager(tab));

        const resultPromise = browserTools.waitForLoad({ tabId: 'tab-1', timeoutMs: 500 });
        await jest.advanceTimersByTimeAsync(500);
        const result = await resultPromise;

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorInfo: expect.objectContaining({
                code: 'browser_timeout',
                retryable: true,
                certainty: 'observed',
                actionMayHaveCompleted: false
            })
        }));
    });

    test('typeInto with submit returns a failure when submit does not navigate', async () => {
        const webview = createMockWebview({
            url: 'https://example.com/search',
            executeResult: { ok: true }
        });
        const tab = {
            id: 'tab-1',
            title: 'Example',
            url: 'https://example.com/search',
            loadUrl: 'https://example.com/search',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.typeInto({
            tabId: 'tab-1',
            selector: 'input[name="q"]',
            text: 'used bike',
            submit: true
        });

        await jest.advanceTimersByTimeAsync(400);
        const result = await resultPromise;

        expect(webview.executeJavaScript).toHaveBeenCalled();
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Navigation did not start');
        expect(result.submitted).toBe(true);
    });

    test('searchSite surfaces a failed search submission to the caller', async () => {
        const webview = createMockWebview({
            url: 'https://example.com/search',
            executeResult: {
                ok: true,
                submitted: true,
                beforeState: {
                    url: 'https://example.com/search',
                    title: 'Search',
                    textSample: 'Old content'
                },
                selected: {
                    selector: '#search-box',
                    id: 'search-box',
                    score: 100
                },
                candidates: [
                    {
                        selector: '#search-box',
                        id: 'search-box',
                        score: 100
                    }
                ]
            }
        });
        webview.executeJavaScript
            .mockResolvedValueOnce({
                ok: true,
                submitted: true,
                beforeState: {
                    url: 'https://example.com/search',
                    title: 'Search',
                    textSample: 'Old content'
                },
                selected: {
                    selector: '#search-box',
                    id: 'search-box',
                    score: 100
                },
                candidates: [
                    {
                        selector: '#search-box',
                        id: 'search-box',
                        score: 100
                    }
                ]
            })
            .mockResolvedValueOnce({
                ok: false,
                currentUrl: 'https://example.com/search',
                currentTitle: 'search',
                queryInUrl: false,
                queryInTitle: false,
                queryInText: false,
                urlChanged: false,
                titleChanged: false,
                textChanged: false
            });
        const tab = {
            id: 'tab-1',
            title: 'Example',
            url: 'https://example.com/search',
            loadUrl: 'https://example.com/search',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.searchSite({
            tabId: 'tab-1',
            query: 'used bike',
            siteHint: 'ebay',
            timeoutMs: 1000
        });

        await jest.advanceTimersByTimeAsync(700);
        const result = await resultPromise;

        expect(webview.executeJavaScript).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('Navigation did not start');
        expect(result.selected).toEqual(expect.objectContaining({ selector: '#search-box' }));
        expect(result.candidates).toHaveLength(1);
    });

    test('searchSite accepts an already-updated same-document results page', async () => {
        const webview = createMockWebview({
            url: 'https://www.marktplaats.nl/q/fiets+onder+300/',
            executeResult: {
                ok: true,
                submitted: true,
                beforeState: {
                    url: 'https://www.marktplaats.nl/q/fiets+onder+300/',
                    title: 'Old title',
                    textSample: 'Old page content'
                },
                selected: {
                    selector: 'input[name="query"]',
                    id: null,
                    score: 25
                },
                candidates: [
                    {
                        selector: 'input[name="query"]',
                        id: null,
                        score: 25
                    }
                ]
            }
        });
        webview.executeJavaScript
            .mockResolvedValueOnce({
                ok: true,
                submitted: true,
                beforeState: {
                    url: 'https://www.marktplaats.nl/q/fiets+onder+300/',
                    title: 'Old title',
                    textSample: 'Old page content'
                },
                selected: {
                    selector: 'input[name="query"]',
                    id: null,
                    score: 25
                },
                candidates: [
                    {
                        selector: 'input[name="query"]',
                        id: null,
                        score: 25
                    }
                ]
            })
            .mockResolvedValueOnce({
                ok: true,
                currentUrl: 'https://www.marktplaats.nl/q/fiets+onder+300/',
                currentTitle: 'vind fiets onder 300 op marktplaats',
                queryInUrl: true,
                queryInTitle: true,
                queryInText: true,
                urlChanged: false,
                titleChanged: true,
                textChanged: true
            });

        const tab = {
            id: 'tab-1',
            title: 'Marktplaats',
            url: 'https://www.marktplaats.nl/q/fiets+onder+300/',
            loadUrl: 'https://www.marktplaats.nl/q/fiets+onder+300/',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.searchSite({
            tabId: 'tab-1',
            query: 'fiets onder 300',
            siteHint: 'marktplaats',
            timeoutMs: 1000
        });

        await jest.advanceTimersByTimeAsync(700);
        const result = await resultPromise;

        expect(result.ok).toBe(true);
        expect(result.waitResult).toEqual(expect.objectContaining({
            ok: true,
            sameDocument: true
        }));
        expect(result.selected).toEqual(expect.objectContaining({ selector: 'input[name="query"]' }));
        expect(webview.executeJavaScript).toHaveBeenCalledTimes(2);
    });

    test('searchSite surfaces structured page-script failures', async () => {
        const webview = createMockWebview({
            url: 'https://www.ebay.nl/',
            executeResult: {
                ok: false,
                error: 'Page script failed: requestSubmit crashed',
                stack: 'Error: requestSubmit crashed'
            }
        });
        const tab = {
            id: 'tab-1',
            title: 'eBay',
            url: 'https://www.ebay.nl/',
            loadUrl: 'https://www.ebay.nl/',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.searchSite({
            tabId: 'tab-1',
            query: 'fiets',
            siteHint: 'ebay',
            timeoutMs: 1000
        });
        await jest.advanceTimersByTimeAsync(400);
        const result = await resultPromise;

        expect(result.ok).toBe(false);
        expect(result.error).toContain('Page script failed: requestSubmit crashed');
        expect(result.stack).toContain('requestSubmit crashed');
    });

    test('searchSite real injected script does not reference missing helpers', async () => {
        document.body.innerHTML = `
            <form action="/search">
                <input id="gh-ac" name="_nkw" type="search" />
            </form>
        `;

        jest.spyOn(window, 'getComputedStyle').mockReturnValue({
            display: 'block',
            visibility: 'visible',
            opacity: '1'
        });
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 0,
            width: 200,
            height: 40,
            top: 0,
            right: 200,
            bottom: 40,
            left: 0,
            toJSON() {}
        });

        const webview = createMockWebview({
            url: 'https://www.ebay.nl/',
            executeResult: {}
        });
        webview.executeJavaScript.mockImplementation((script) => Promise.resolve(eval(script)));

        const tab = {
            id: 'tab-1',
            title: 'eBay',
            url: 'https://www.ebay.nl/',
            loadUrl: 'https://www.ebay.nl/',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.searchSite({
            tabId: 'tab-1',
            query: 'fiets',
            siteHint: 'ebay',
            timeoutMs: 1000
        });

        await jest.advanceTimersByTimeAsync(700);
        const result = await resultPromise;

        expect(result.error || '').not.toContain('normalizeText is not defined');
    });

    test('extractSearchResults parses marketplace cards from an eBay-like results page', async () => {
        document.body.innerHTML = `
            <ul>
                <li class="s-item">
                    <a class="s-item__link" href="https://www.ebay.nl/itm/123">New listing Trek bike</a>
                    <h3 class="s-item__title">New listing Trek bike</h3>
                    <span class="s-item__price">EUR 250.00</span>
                    <span class="s-item__shipping">Free shipping</span>
                    <span class="s-item__location">Amsterdam</span>
                </li>
            </ul>
        `;

        jest.spyOn(window, 'getComputedStyle').mockReturnValue({
            display: 'block',
            visibility: 'visible',
            opacity: '1'
        });
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            top: 0,
            right: 200,
            bottom: 80,
            left: 0,
            toJSON() {}
        });

        const webview = createMockWebview({
            url: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            executeResult: []
        });
        webview.executeJavaScript.mockImplementation((script) => {
            return Promise.resolve(eval(script));
        });

        const tab = {
            id: 'tab-1',
            title: 'eBay search results',
            url: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            loadUrl: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const result = await browserTools.extractSearchResults({
            tabId: 'tab-1',
            siteHint: 'ebay'
        });

        expect(result.ok).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toEqual(expect.objectContaining({
            title: 'Trek bike',
            href: 'https://www.ebay.nl/itm/123',
            price: 'EUR 250.00',
            shipping: 'Free shipping',
            location: 'Amsterdam',
            source: 'ebay'
        }));
    });

    test('extractSearchResults prefers real bike listings over noisy accessories', async () => {
        document.body.innerHTML = `
            <ul>
                <li class="s-item">
                    <a class="s-item__link" href="https://www.ebay.nl/itm/111">Euro5 Adapter 6 Pin für Motorrad Bike & Diagnosegerät</a>
                    <h3 class="s-item__title">Euro5 Adapter 6 Pin für Motorrad Bike & Diagnosegerät</h3>
                    <span class="s-item__price">EUR 49.95</span>
                </li>
                <li class="s-item">
                    <a class="s-item__link" href="https://www.ebay.nl/itm/222">Trek city bike used</a>
                    <h3 class="s-item__title">Trek city bike used</h3>
                    <span class="s-item__price">EUR 275.00</span>
                </li>
            </ul>
        `;

        jest.spyOn(window, 'getComputedStyle').mockReturnValue({
            display: 'block',
            visibility: 'visible',
            opacity: '1'
        });
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            top: 0,
            right: 200,
            bottom: 80,
            left: 0,
            toJSON() {}
        });

        const webview = createMockWebview({
            url: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            executeResult: []
        });
        webview.executeJavaScript.mockImplementation((script) => {
            return Promise.resolve(eval(script));
        });

        const tab = {
            id: 'tab-1',
            title: 'eBay search results',
            url: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            loadUrl: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const result = await browserTools.extractSearchResults({
            tabId: 'tab-1',
            siteHint: 'ebay'
        });

        expect(result.ok).toBe(true);
        expect(result.items).toHaveLength(2);
        expect(result.items[0]).toEqual(expect.objectContaining({
            title: 'Trek city bike used',
            href: 'https://www.ebay.nl/itm/222',
            price: 'EUR 275.00',
            source: 'ebay'
        }));
    });

    test('extractSearchResults retries when the webview is not ready yet', async () => {
        document.body.innerHTML = `
            <ul>
                <li class="s-item">
                    <a class="s-item__link" href="https://www.ebay.nl/itm/123">New listing Trek bike</a>
                    <h3 class="s-item__title">New listing Trek bike</h3>
                    <span class="s-item__price">EUR 250.00</span>
                </li>
            </ul>
        `;

        jest.spyOn(window, 'getComputedStyle').mockReturnValue({
            display: 'block',
            visibility: 'visible',
            opacity: '1'
        });
        jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
            x: 0,
            y: 0,
            width: 200,
            height: 80,
            top: 0,
            right: 200,
            bottom: 80,
            left: 0,
            toJSON() {}
        });

        const webview = createMockWebview({
            url: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            executeResult: []
        });
        webview.executeJavaScript
            .mockRejectedValueOnce(new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.'))
            .mockImplementation((script) => Promise.resolve(eval(script)));

        const tab = {
            id: 'tab-1',
            title: 'eBay search results',
            url: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            loadUrl: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.extractSearchResults({
            tabId: 'tab-1',
            siteHint: 'ebay'
        });

        await jest.advanceTimersByTimeAsync(400);
        const result = await resultPromise;

        expect(webview.executeJavaScript).toHaveBeenCalledTimes(2);
        expect(result.ok).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items[0]).toEqual(expect.objectContaining({
            title: 'Trek bike',
            href: 'https://www.ebay.nl/itm/123',
            price: 'EUR 250.00',
            source: 'ebay'
        }));
    });

    test('readPageText retries after a dom-ready error without forcing tab focus', async () => {
        const webview = createMockWebview({
            url: 'https://example.com/article'
        });
        webview.executeJavaScript
            .mockRejectedValueOnce(new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.'))
            .mockResolvedValueOnce('Loaded content');

        const tab = {
            id: 'tab-1',
            title: 'Example article',
            url: 'https://example.com/article',
            loadUrl: 'https://example.com/article',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        tabManager.activeTabId = 'tab-0';
        const browserTools = new BrowserTools(tabManager);

        const resultPromise = browserTools.readPageText({
            tabId: 'tab-1',
            maxChars: 2000
        });

        await jest.advanceTimersByTimeAsync(400);
        const result = await resultPromise;

        expect(tabManager.switchToTab).not.toHaveBeenCalled();
        expect(webview.executeJavaScript).toHaveBeenCalledTimes(2);
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            text: 'Loaded content'
        }));
    });

    test('listTabs and getActiveTab tolerate an unready webview', () => {
        const webview = createMockWebview({
            url: 'https://example.com/search',
            stateReadError: new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.')
        });
        const tab = {
            id: 'tab-1',
            title: 'Example',
            url: 'https://example.com/search',
            loadUrl: 'https://example.com/search',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        const browserTools = new BrowserTools(tabManager);

        expect(() => browserTools.getActiveTab()).not.toThrow();
        expect(browserTools.getActiveTab()).toEqual(expect.objectContaining({
            id: 'tab-1',
            loading: false,
            canGoBack: false
        }));
        expect(() => browserTools.listTabs()).not.toThrow();
        expect(browserTools.listTabs()[0]).toEqual(expect.objectContaining({
            id: 'tab-1',
            loading: false,
            canGoBack: false
        }));
    });
});

describe('BrowserTools compact selector extraction', () => {
    function createSelectorTools() {
        const webview = createMockWebview({ url: 'https://example.com/results' });
        webview.executeJavaScript.mockImplementation((script) => Promise.resolve(eval(script)));
        const tab = {
            id: 'tab-compact',
            title: 'Results',
            url: 'https://example.com/results',
            loadUrl: 'https://example.com/results',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        return new BrowserTools(createTabManager(tab));
    }

    test('bounds selected results and provides a deterministic continuation offset', async () => {
        document.body.innerHTML = `
            <a class="result" href="/one">first matching result</a>
            <a class="result" href="/two">second matching result</a>
            <a class="result" href="/three">third matching result</a>
        `;
        const browserTools = createSelectorTools();

        const firstPage = await browserTools.querySelectorAll({
            tabId: 'tab-compact',
            selector: '.result',
            fields: ['text', 'href'],
            maxResults: 2,
            maxTextChars: 6
        });
        const remaining = await browserTools.querySelectorAll({
            tabId: 'tab-compact',
            selector: '.result',
            fields: ['text', 'href'],
            offset: firstPage.nextOffset,
            maxResults: 2
        });
        const nextTextChunk = await browserTools.querySelectorAll({
            tabId: 'tab-compact',
            selector: '.result',
            fields: ['text'],
            maxResults: 2,
            maxTextChars: 6,
            textOffset: firstPage.nextTextOffset
        });

        expect(firstPage).toEqual(expect.objectContaining({
            ok: true,
            totalMatches: 3,
            offset: 0,
            nextOffset: 2,
            truncated: expect.objectContaining({ results: true, text: true })
        }));
        expect(firstPage.items.map((item) => item.index)).toEqual([0, 1]);
        expect(firstPage.items[0].text).toBe('first ');
        expect(remaining.items).toEqual([
            expect.objectContaining({ index: 2, text: 'third matching result', href: 'http://localhost/three' })
        ]);
        expect(remaining.nextOffset).toBeNull();
        expect(nextTextChunk.items.map((item) => item.text)).toEqual(['matchi', ' match']);
        expect(nextTextChunk.nextTextOffset).toBe(12);
    });

    test('compact mode bounds a single large matching element before serialization', async () => {
        const largeText = 'very large rendered result '.repeat(800);
        document.body.innerHTML = `<article class="result">${largeText}</article>`;
        const browserTools = createSelectorTools();

        const result = await browserTools.querySelectorAll({
            tabId: 'tab-compact',
            selector: '.result',
            compact: true
        });

        expect(result.ok).toBe(true);
        expect(result.items).toHaveLength(1);
        expect(result.items[0].text.length).toBeLessThanOrEqual(280);
        expect(result.truncated.text).toBe(true);
        expect(result.nextTextOffset).toBe(280);
        expect(result.itemOutputChars).toBeLessThanOrEqual(6_000);
    });

    test('legacy selector reads retain complete text when no compact limits are requested', async () => {
        document.body.innerHTML = '<p class="result">Complete legacy response</p>';
        const browserTools = createSelectorTools();

        const result = await browserTools.querySelectorAll({
            tabId: 'tab-compact',
            selector: '.result',
            fields: ['text']
        });

        expect(result.items[0].text).toBe('Complete legacy response');
        expect(result.truncated).toEqual({ results: false, text: false, output: false });
    });

    test('stops before a result that exceeds an explicit output budget without discarding it', async () => {
        document.body.innerHTML = `<p class="result">${'evidence '.repeat(100)}</p>`;
        const browserTools = createSelectorTools();

        const result = await browserTools.querySelectorAll({
            tabId: 'tab-compact',
            selector: '.result',
            fields: ['text'],
            maxOutputChars: 256
        });

        expect(result.items).toEqual([]);
        expect(result.truncated).toEqual({ results: true, text: false, output: true });
        expect(result.truncatedItemIndexes).toEqual([0]);
        expect(result.nextOffset).toBe(0);
    });
});

describe('BrowserTools find page text', () => {
    function createFindTools() {
        const webview = createMockWebview({ url: 'https://example.com/article' });
        webview.executeJavaScript.mockImplementation((script) => Promise.resolve(eval(script)));
        webview.findInPage = jest.fn();
        const tab = {
            id: 'tab-find',
            title: 'Article',
            url: 'https://example.com/article',
            loadUrl: 'https://example.com/article',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        return { browserTools: new BrowserTools(createTabManager(tab)), webview };
    }

    test('finds repeated Unicode text in stable source order without native find state', async () => {
        document.title = 'Café notes';
        document.body.innerHTML = '<main>Café café CAFÉ. Résumé follows.</main>';
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(document.querySelector('main').firstChild);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        const initialSelectionOffset = selection.anchorOffset;
        const { browserTools, webview } = createFindTools();

        const result = await browserTools.findPageText({
            tabId: 'tab-find',
            query: 'CAFÉ',
            contextChars: 2,
            maxMatches: 10
        });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            query: 'CAFÉ',
            caseSensitive: false,
            matchCount: 3,
            matchCountExact: true,
            noMatches: false,
            observed: expect.objectContaining({ url: 'http://localhost/', title: 'Café notes', documentId: expect.any(String) }),
            scope: { frame: 'main_frame', subframes: 'not_searched' },
            truncated: { matches: false, scan: false }
        }));
        expect(result.matches.map((match) => match.match)).toEqual(['Café', 'café', 'CAFÉ']);
        expect(result.matches.map((match) => match.start)).toEqual([...result.matches.map((match) => match.start)].sort((a, b) => a - b));
        expect(webview.findInPage).not.toHaveBeenCalled();
        expect(window.getSelection().anchorOffset).toBe(initialSelectionOffset);
    });

    test('reports no match, result limits, and a bounded scan explicitly', async () => {
        document.body.textContent = 'needle '.repeat(5);
        const { browserTools } = createFindTools();

        const limited = await browserTools.findPageText({
            tabId: 'tab-find',
            query: 'needle',
            contextChars: 1,
            maxMatches: 2,
            caseSensitive: true
        });
        const noMatch = await browserTools.findPageText({
            tabId: 'tab-find',
            query: 'missing'
        });

        expect(limited.matchCount).toBe(5);
        expect(limited.matches).toHaveLength(2);
        expect(limited.matches.every((match) => match.snippet.length <= 8)).toBe(true);
        expect(limited.truncated).toEqual({ matches: true, scan: false });
        expect(noMatch).toEqual(expect.objectContaining({
            matchCount: 0,
            noMatches: true,
            matches: [],
            truncated: { matches: false, scan: false }
        }));

        document.body.textContent = `${'x'.repeat(1_000_000)}needle`;
        const scanLimited = await browserTools.findPageText({
            tabId: 'tab-find',
            query: 'needle'
        });
        expect(scanLimited).toEqual(expect.objectContaining({
            matchCount: 0,
            matchCountExact: false,
            noMatches: true,
            scannedChars: 1_000_000,
            truncated: { matches: false, scan: true }
        }));
    });

    test('rejects an overlong literal query before reading the page', async () => {
        const { browserTools, webview } = createFindTools();

        const result = await browserTools.findPageText({
            tabId: 'tab-find',
            query: 'x'.repeat(513)
        });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: 'findPageText query must be at most 512 characters.'
        }));
        expect(webview.executeJavaScript).not.toHaveBeenCalled();
    });
});

describe('BrowserTools targeted page text', () => {
    function createTargetedReadTools() {
        const webview = createMockWebview({ url: 'https://example.com/product' });
        webview.executeJavaScript.mockImplementation((script) => Promise.resolve(eval(script)));
        const tab = {
            id: 'tab-content',
            title: 'Product',
            url: 'https://example.com/product',
            loadUrl: 'https://example.com/product',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        return { browserTools: new BrowserTools(createTabManager(tab)), webview };
    }

    test('keeps legacy full-page reads compatible', async () => {
        document.body.innerHTML = '<nav>Navigation</nav><main>Legacy page evidence</main>';
        Object.defineProperty(document.body, 'innerText', {
            configurable: true,
            value: 'NavigationLegacy page evidence'
        });
        const { browserTools } = createTargetedReadTools();

        const result = await browserTools.readPageText({ tabId: 'tab-content', maxChars: 100 });

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            text: 'NavigationLegacy page evidence',
            length: 'NavigationLegacy page evidence'.length,
            truncated: false
        }));
        expect(result).not.toHaveProperty('extraction');
        delete document.body.innerText;
    });

    test('extracts article and main regions without modifying the rendered document', async () => {
        document.body.innerHTML = `
            <header>Global navigation</header>
            <article><h1>Article evidence</h1><p>Important supporting fact.</p></article>
            <main><h1>Product evidence</h1><p>€99 and in stock.</p></main>
            <footer>Footer links</footer>
        `;
        const originalMarkup = document.body.innerHTML;
        const { browserTools } = createTargetedReadTools();

        const article = await browserTools.readPageText({
            tabId: 'tab-content',
            contentMode: 'article',
            maxChars: 40
        });
        const product = await browserTools.readPageText({
            tabId: 'tab-content',
            contentMode: 'main'
        });

        expect(article).toEqual(expect.objectContaining({
            ok: true,
            truncated: true,
            extraction: expect.objectContaining({
                mode: 'article',
                selector: 'article',
                element: 'article',
                fallback: false,
                scope: 'main_frame'
            })
        }));
        expect(article.text).toContain('Article evidence');
        expect(article.text.length).toBeLessThanOrEqual(40);
        expect(product.text).toContain('Product evidence');
        expect(product.text).toContain('€99 and in stock.');
        expect(product.text).not.toContain('Global navigation');
        expect(product.text).not.toContain('Footer links');
        expect(product.extraction).toEqual(expect.objectContaining({ mode: 'main', selector: 'main', fallback: false }));
        expect(document.body.innerHTML).toBe(originalMarkup);
    });

    test('reports semantic fallback and explicit selector failures', async () => {
        document.body.innerHTML = '<nav>Navigation remains in fallback</nav><section id="details">Relevant evidence</section>';
        const { browserTools } = createTargetedReadTools();

        const fallback = await browserTools.readPageText({
            tabId: 'tab-content',
            contentMode: 'main'
        });
        const selected = await browserTools.readPageText({
            tabId: 'tab-content',
            selector: '#details',
            contentMode: 'article'
        });
        const invalid = await browserTools.readPageText({ tabId: 'tab-content', selector: '[' });
        const unmatched = await browserTools.readPageText({ tabId: 'tab-content', selector: '#missing' });

        expect(fallback).toEqual(expect.objectContaining({
            ok: true,
            text: 'Navigation remains in fallbackRelevant evidence',
            extraction: expect.objectContaining({
                mode: 'full',
                selector: 'body',
                fallback: true,
                fallbackReason: 'main_region_not_found'
            })
        }));
        expect(selected).toEqual(expect.objectContaining({
            ok: true,
            text: 'Relevant evidence',
            extraction: expect.objectContaining({ mode: 'selector', selector: '#details', element: 'section' })
        }));
        expect(invalid).toEqual(expect.objectContaining({
            ok: false,
            error: expect.stringContaining('Invalid selector:'),
            extraction: expect.objectContaining({ status: 'invalid_selector' })
        }));
        expect(unmatched).toEqual(expect.objectContaining({
            ok: false,
            error: 'No element matched selector: #missing',
            extraction: expect.objectContaining({ status: 'selector_not_found' })
        }));
    });
});

describe('BrowserTools actionable mutation errors', () => {
    function createActionTools(webview) {
        const tab = {
            id: 'tab-action',
            title: 'Action page',
            url: 'https://example.com/action',
            loadUrl: 'https://example.com/action',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        return new BrowserTools(createTabManager(tab));
    }

    test('classifies a missing clicked element before an action happens', async () => {
        document.body.innerHTML = '';
        const webview = createMockWebview();
        webview.executeJavaScript.mockImplementation((script) => Promise.resolve(eval(script)));
        const browserTools = createActionTools(webview);

        const result = await browserTools.clickElement({ tabId: 'tab-action', selector: '#missing' });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: 'Element not found',
            errorInfo: expect.objectContaining({
                code: 'browser_element_not_found',
                retryable: false,
                certainty: 'observed',
                actionMayHaveCompleted: false
            })
        }));
        expect(result.actionMayHaveCompleted).toBeUndefined();
    });

    test('does not retry a click after a transient DOM-ready failure', async () => {
        const webview = createMockWebview();
        webview.executeJavaScript.mockRejectedValue(new Error('The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.'));
        const browserTools = createActionTools(webview);

        const result = await browserTools.clickElement({ tabId: 'tab-action', selector: '#buy' });

        expect(webview.executeJavaScript).toHaveBeenCalledTimes(1);
        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorInfo: expect.objectContaining({
                code: 'browser_tab_not_ready',
                retryable: false,
                actionMayHaveCompleted: false
            })
        }));
        expect(result.actionMayHaveCompleted).toBeUndefined();
    });

    test('labels an unclassified mutation failure as uncertain and possibly completed', async () => {
        const webview = createMockWebview();
        webview.executeJavaScript.mockRejectedValue(new Error('Unexpected host transport failure'));
        const browserTools = createActionTools(webview);

        const result = await browserTools.clickElement({ tabId: 'tab-action', selector: '#buy' });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            actionMayHaveCompleted: true,
            errorInfo: expect.objectContaining({
                code: 'browser_operation_failed',
                certainty: 'unknown',
                retryable: false,
                actionMayHaveCompleted: true
            })
        }));
    });
});

describe('BrowserTools batch reads', () => {
    test('retains the page-side source identity when the tab navigates during a read', async () => {
        const webview = createMockWebview({ url: 'https://example.com/before' });
        const tab = {
            id: 'tab-batch',
            title: 'Before',
            url: 'https://example.com/before',
            loadUrl: 'https://example.com/before',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const browserTools = new BrowserTools(createTabManager(tab));

        const items = await browserTools.batchRead({
            requests: [{ id: 'first', tool: 'read_page_text', tabId: 'tab-batch', args: { tabId: 'tab-batch' } }],
            executeRead: async () => {
                webview.setCurrentUrl('https://example.com/after');
                return {
                    ok: true,
                    data: {
                        observed: {
                            url: 'https://example.com/before',
                            title: 'Before',
                            documentId: 'document-before'
                        },
                        text: 'Evidence from the first document.'
                    }
                };
            }
        });

        expect(items).toEqual([expect.objectContaining({
            id: 'first',
            result: expect.objectContaining({ ok: true }),
            document: expect.objectContaining({
                initial: expect.objectContaining({ url: 'https://example.com/before' }),
                source: expect.objectContaining({ url: 'https://example.com/before', documentId: 'document-before' }),
                current: expect.objectContaining({ url: 'https://example.com/after' }),
                sourceIsCurrent: false
            })
        })]);
    });
});

describe('BrowserTools condition waits', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.restoreAllMocks();
        jest.useRealTimers();
        jest.clearAllMocks();
    });

    function makeTools({ loading = false } = {}) {
        const webview = createMockWebview({ loading });
        const tab = {
            id: 'tab-wait',
            title: 'Dynamic page',
            url: 'https://example.com/dynamic',
            loadUrl: 'https://example.com/dynamic',
            role: 'regular',
            assistantOwned: true,
            internal: false,
            webview
        };
        const tabManager = createTabManager(tab);
        return { browserTools: new BrowserTools(tabManager), tabManager, webview };
    }

    test('waits for a delayed visible enabled element without waiting for background traffic', async () => {
        const { browserTools, webview } = makeTools({ loading: true });
        webview.executeJavaScript
            .mockResolvedValueOnce({
                satisfied: false,
                observed: { present: false, visible: false, enabled: false, text: '', matchCount: 0, url: 'https://example.com/dynamic', title: 'Dynamic page' }
            })
            .mockResolvedValueOnce({
                satisfied: true,
                observed: { present: true, visible: true, enabled: true, text: 'Ready', matchCount: 1, url: 'https://example.com/dynamic', title: 'Dynamic page' }
            });

        const resultPromise = browserTools.waitForElement({
            tabId: 'tab-wait',
            selector: '#continue',
            visible: true,
            enabled: true,
            timeoutMs: 1_000,
            pollIntervalMs: 100
        });
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(100);
        const result = await resultPromise;

        expect(result).toEqual(expect.objectContaining({
            ok: true,
            condition: { present: true, visible: true, enabled: true },
            observed: expect.objectContaining({ present: true, visible: true, enabled: true }),
            navigated: false
        }));
        expect(webview.isLoading).toHaveBeenCalled();
        expect(webview.executeJavaScript).toHaveBeenCalledTimes(2);
    });

    test('waits for an element to disappear without dispatching a page action', async () => {
        const { browserTools, webview } = makeTools();
        webview.executeJavaScript
            .mockResolvedValueOnce({
                satisfied: false,
                observed: { present: true, visible: true, enabled: true, text: 'Loading', matchCount: 1, url: 'https://example.com/dynamic', title: 'Dynamic page' }
            })
            .mockResolvedValueOnce({
                satisfied: true,
                observed: { present: false, visible: false, enabled: false, text: '', matchCount: 0, url: 'https://example.com/dynamic', title: 'Dynamic page' }
            });

        const resultPromise = browserTools.waitForElement({
            tabId: 'tab-wait',
            selector: '.loading-mask',
            present: false,
            timeoutMs: 1_000,
            pollIntervalMs: 100
        });
        await Promise.resolve();
        await jest.advanceTimersByTimeAsync(100);

        await expect(resultPromise).resolves.toEqual(expect.objectContaining({
            ok: true,
            condition: { present: false },
            observed: expect.objectContaining({ present: false })
        }));
        expect(webview.sendInputEvent).not.toHaveBeenCalled();
    });

    test('returns a bounded timeout with the last observed condition state', async () => {
        const { browserTools, webview } = makeTools();
        webview.executeJavaScript.mockResolvedValue({
            satisfied: false,
            observed: { present: true, visible: true, enabled: false, text: 'Please wait', matchCount: 1, url: 'https://example.com/dynamic', title: 'Dynamic page' }
        });

        const resultPromise = browserTools.waitForElement({
            tabId: 'tab-wait',
            selector: '#submit',
            enabled: true,
            timeoutMs: 500,
            pollIntervalMs: 100
        });
        await jest.advanceTimersByTimeAsync(500);
        const result = await resultPromise;

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorInfo: expect.objectContaining({ code: 'browser_timeout', retryable: true }),
            observed: expect.objectContaining({ enabled: false })
        }));
    });

    test('cancels a pending wait without stopping the tab or clicking again', async () => {
        const { browserTools, webview } = makeTools();
        webview.executeJavaScript.mockResolvedValue({
            satisfied: false,
            observed: { present: false, visible: false, enabled: false, text: '', matchCount: 0, url: 'https://example.com/dynamic', title: 'Dynamic page' }
        });
        const controller = new AbortController();

        const resultPromise = browserTools.waitForElement({
            tabId: 'tab-wait',
            selector: '#later',
            signal: controller.signal
        });
        await Promise.resolve();
        controller.abort('Stopped by user.');
        const result = await resultPromise;

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            errorInfo: expect.objectContaining({ code: 'browser_action_cancelled', retryable: false })
        }));
        expect(webview.sendInputEvent).not.toHaveBeenCalled();
    });

    test('reports a target tab that closes while the condition is pending', async () => {
        const { browserTools, tabManager, webview } = makeTools();
        webview.executeJavaScript.mockResolvedValue({
            satisfied: false,
            observed: { present: false, visible: false, enabled: false, text: '', matchCount: 0, url: 'https://example.com/dynamic', title: 'Dynamic page' }
        });

        const resultPromise = browserTools.waitForElement({
            tabId: 'tab-wait',
            selector: '#later',
            timeoutMs: 1_000,
            pollIntervalMs: 100
        });
        await Promise.resolve();
        tabManager.getTabById.mockReturnValue(null);
        await jest.advanceTimersByTimeAsync(100);
        const result = await resultPromise;

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            tabId: 'tab-wait',
            targetTabClosed: true,
            errorInfo: expect.objectContaining({ code: 'browser_tab_closed', certainty: 'observed' })
        }));
    });
});

describe('BrowserTools pressAndHold', () => {
    afterEach(() => {
        jest.restoreAllMocks();
        jest.clearAllMocks();
    });

    function makeTab(executeResult) {
        const webview = createMockWebview({ executeResult });
        const tab = {
            id: 'tab-1',
            title: 'Verify',
            url: 'https://example.com/verify',
            loadUrl: 'https://example.com/verify',
            role: 'regular',
            webview
        };
        return { tab, webview };
    }

    test('dispatches trusted mouseDown, hold, then mouseUp on the located button', async () => {
        const { tab, webview } = makeTab({ ok: true, x: 120, y: 45 });
        const browserTools = new BrowserTools(createTabManager(tab));

        const result = await browserTools.pressAndHold({ tabId: 'tab-1', selector: '#hold', holdMs: 200, jitter: false });

        expect(result.ok).toBe(true);
        expect(result.heldMs).toBe(200);
        const types = webview.sendInputEvent.mock.calls.map((call) => call[0].type);
        expect(types[0]).toBe('mouseMove');
        expect(types).toContain('mouseDown');
        expect(types[types.length - 1]).toBe('mouseUp');
        const down = webview.sendInputEvent.mock.calls.find((call) => call[0].type === 'mouseDown')[0];
        expect(down).toEqual(expect.objectContaining({ x: 120, y: 45, button: 'left' }));
    });

    test('returns an error when the element cannot be located', async () => {
        const { tab, webview } = makeTab({ ok: false, error: 'Element not found' });
        const browserTools = new BrowserTools(createTabManager(tab));

        const result = await browserTools.pressAndHold({ tabId: 'tab-1', selector: '#missing', holdMs: 200 });

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not found/i);
        expect(webview.sendInputEvent).not.toHaveBeenCalled();
    });

    test('requires a selector', async () => {
        const { tab } = makeTab({ ok: true, x: 1, y: 1 });
        const browserTools = new BrowserTools(createTabManager(tab));

        const result = await browserTools.pressAndHold({ tabId: 'tab-1' });

        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/requires a selector/i);
    });
});
