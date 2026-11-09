const fs = require('node:fs');
const path = require('node:path');

function loadManager() {
    const source = fs.readFileSync(path.join(__dirname, '../../transformed-view-manager.js'), 'utf8');
    const transformed = source
        .replace('export default class TransformedViewManager', 'class TransformedViewManager')
        .concat('\nmodule.exports = TransformedViewManager;');
    const module = { exports: {} };
    new Function('module', 'exports', transformed)(module, module.exports);
    return module.exports;
}

describe('TransformedViewManager', () => {
    beforeEach(() => {
        window.electronAPI = { invoke: jest.fn() };
    });

    function createManager(tabManager = {}) {
        const TransformedViewManager = loadManager();
        return new TransformedViewManager({
            tabManager: {
                tabs: [],
                createTab: jest.fn(),
                closeTab: jest.fn(),
                getTabById: jest.fn(),
                ...tabManager
            }
        });
    }

    test('waits for a dynamic ready selector instead of checking it only once', async () => {
        jest.useFakeTimers();
        const manager = createManager();
        const webview = {
            executeJavaScript: jest.fn()
                .mockResolvedValueOnce(false)
                .mockResolvedValueOnce(true)
        };

        const ready = manager.waitForReady(webview, '.article-loaded');
        await Promise.resolve();
        jest.advanceTimersByTime(125);
        await ready;

        expect(webview.executeJavaScript).toHaveBeenCalledTimes(2);
        expect(webview.executeJavaScript).toHaveBeenCalledWith(
            'Boolean(document.querySelector(".article-loaded"))',
            true
        );
        jest.useRealTimers();
    });

    test('cancels an in-flight source load immediately', async () => {
        const manager = createManager();
        const listeners = {};
        const webview = {
            addEventListener: jest.fn((name, listener) => { listeners[name] = listener; }),
            removeEventListener: jest.fn()
        };
        const controller = new AbortController();
        const loading = manager.waitForLoad(webview, controller.signal);

        controller.abort('The transformed view tab was closed.');

        await expect(loading).rejects.toMatchObject({
            code: 'browser_action_cancelled',
            message: 'The transformed view tab was closed.'
        });
        expect(webview.removeEventListener).toHaveBeenCalledWith('did-finish-load', expect.any(Function));
        expect(webview.removeEventListener).toHaveBeenCalledWith('did-fail-load', expect.any(Function));
    });

    test('requires the configured root selector instead of silently using the whole page', async () => {
        const manager = createManager();
        const webview = { executeJavaScript: jest.fn().mockResolvedValue({ content: 'article body' }) };

        await manager.extractSource(webview, {
            rootSelector: '.article',
            titleSelector: 'h1',
            removeSelectors: []
        });

        const script = webview.executeJavaScript.mock.calls[0][0];
        expect(script).toContain('const source = document.querySelector(config.rootSelector);');
        expect(script).not.toContain('|| document.body');
    });

    test('resumes the hidden source after load listeners are installed and closes it after extraction', async () => {
        const sourceTab = {id: 'source', webview: {}, deferredUrl: 'https://example.com'};
        const order = [];
        const manager = createManager({
            createTab: jest.fn(() => sourceTab.id), getTabById: jest.fn(() => sourceTab),
            _resumeTab: jest.fn(() => order.push('resume'))
        });
        manager.waitForLoad = jest.fn(() => {order.push('listen'); return Promise.resolve();});
        manager.waitForReady = jest.fn().mockResolvedValue(undefined);
        manager.extractSource = jest.fn().mockResolvedValue({content: 'Article', url: 'https://example.com'});
        manager.send = jest.fn();
        window.electronAPI.invoke.mockResolvedValue({});
        await manager.refreshView({id: 'view-tab'}, {id: 'view', name: 'Reader', sourceUrl: 'https://example.com', recipe: {rootSelector: 'article'} });
        expect(order).toEqual(['listen', 'resume']);
        expect(manager.tabManager.closeTab).toHaveBeenCalledWith(sourceTab.id);
        expect(manager.send).toHaveBeenCalledWith({id: 'view-tab'}, expect.objectContaining({state: 'ready', content: 'Article'}));
    });
});
