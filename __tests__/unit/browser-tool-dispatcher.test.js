const fs = require('node:fs');
const path = require('node:path');

function loadDispatcher(state) {
    const source = fs.readFileSync(path.join(__dirname, '../../browser-tool-dispatcher.js'), 'utf8');
    const transformed = source
        .replace("import { normalizeBrowserToolUrl } from './browser-url-policy.js';", fs.readFileSync(path.join(__dirname, '../../browser-url-policy.js'), 'utf8').replace('export function', 'function'))
        .replace("import BrowserTools from './browser-tools.js';", "const BrowserTools = require('__browser_tools__');")
        .replace("import BrowserActionCoordinator, { MUTATING_BROWSER_TOOLS } from './browser-action-coordinator.js';", "const { BrowserActionCoordinator, MUTATING_BROWSER_TOOLS } = require('__browser_action_coordinator__');")
        .replace('export default class BrowserToolDispatcher', 'class BrowserToolDispatcher')
        .concat('\nmodule.exports = BrowserToolDispatcher;');

    class MockBrowserTools {
        constructor() {
            state.browserTools = this;
            state.tabs ||= new Map();
            this.getTab = jest.fn(id => state.tabs.get(id));
            this.openTab = jest.fn(options => {
                const id = `opened-${state.tabs.size}`;
                state.tabs.set(id, {...options, id});
                return {ok: true, id};
            });
            this.closeTab = jest.fn(({tabId}) => {state.tabs.delete(tabId); return {ok: true};});
            this.readPageText = jest.fn().mockResolvedValue({ ok: true, text: '' });
            this.querySelectorAll = jest.fn().mockResolvedValue({ ok: true, items: [] });
            this.findPageText = jest.fn().mockResolvedValue({ ok: true, matches: [] });
            this.waitForElement = jest.fn().mockResolvedValue({ ok: true, observed: {} });
            this.clickElement = jest.fn().mockResolvedValue({ ok: true });
            this.batchRead = jest.fn(async ({ requests, executeRead }) => Promise.all(requests.map(async (request) => ({
                id: request.id,
                tool: request.tool,
                tabId: request.tabId,
                result: await executeRead(request),
                document: {
                    initial: { tabId: request.tabId, url: `https://before.example/${request.tabId}`, title: 'Before', documentId: 'before' },
                    source: { tabId: request.tabId, url: `https://source.example/${request.tabId}`, title: 'Source', documentId: 'source' },
                    current: { tabId: request.tabId, url: `https://current.example/${request.tabId}`, title: 'Current', documentId: 'current' },
                    identityVerified: true,
                    sourceIsCurrent: false
                }
            }))));
        }
    }

    class MockCoordinator {
        async execute(request, run) {
            return run({ signal: request.signal });
        }
    }

    const module = { exports: {} };
    new Function('module', 'exports', 'require', transformed)(module, module.exports, (specifier) => {
        if (specifier === '__browser_tools__') return MockBrowserTools;
        if (specifier === '__browser_action_coordinator__') {
            return { BrowserActionCoordinator: MockCoordinator, MUTATING_BROWSER_TOOLS: new Set(['refresh_transformed_view']) };
        }
        return require(specifier);
    });
    return module.exports;
}

describe('BrowserToolDispatcher selector limits', () => {
    test.each(['file:///tmp/private.txt', 'javascript:alert(1)', 'data:text/html,test', 'about:config', 'browser://view/test', 'ftp://example.com', 'not a URL'])(
        'rejects unsafe AI URL %s before tab creation or navigation', async url => {
            const state = {};
            const Dispatcher = loadDispatcher(state);
            const dispatcher = new Dispatcher({});
            state.browserTools.navigateTab = jest.fn();
            for (const tool of ['open_tab', 'navigate_tab']) {
                const result = await dispatcher.execute(tool, {url, tabId: 'original'});
                expect(result.error.code).toBe('unsafe_url_scheme');
            }
            expect(state.browserTools.openTab).not.toHaveBeenCalled();
            expect(state.browserTools.navigateTab).not.toHaveBeenCalled();
        }
    );
    test('task cleanup preserves original tabs, results, retained tabs, and live-artifact sources', async () => {
        const state = {};
        const Dispatcher = loadDispatcher(state);
        const dispatcher = new Dispatcher({});
        state.tabs.set('original', {id: 'original', url: 'https://user.example', role: 'browser', assistantOwned: true});
        const open = async url => (await dispatcher.execute('open_tab', {url, _taskId: 'task-a'})).data.id;
        const temporary = await open('https://temporary.example');
        const source = await open('https://live.example');
        const result = await open('http://127.0.0.1:1234/artifact/result/token/view');
        const retained = await open('https://keep.example');
        const other = (await dispatcher.execute('open_tab', {url: 'https://other.example', _taskId: 'task-b'})).data.id;
        const cleanup = await dispatcher.execute('cleanup_task_tabs', {taskId: 'task-a', keepTabIds: [retained], protectedUrls: ['https://live.example']});
        expect(cleanup.ok).toBe(true);
        expect(cleanup.data.closedTabIds).toEqual([temporary]);
        expect([...state.tabs.keys()]).toEqual(['original', source, result, retained, other]);
        expect(cleanup.data.keptTabs).toContainEqual({tabId: source, reason: 'live_artifact_source'});
    });

    test('cleanup cannot close a new tab reusing an old ID and retries failed closes', async () => {
        const state = {};
        const Dispatcher = loadDispatcher(state);
        const dispatcher = new Dispatcher({});
        const old = (await dispatcher.execute('open_tab', {url: 'https://old.example', _taskId: 'task'})).data.id;
        const replacement = {id: old, url: 'https://user.example', role: 'browser', assistantOwned: true};
        state.tabs.set(old, replacement);
        const failing = (await dispatcher.execute('open_tab', {url: 'https://failing.example', _taskId: 'task'})).data.id;
        state.browserTools.closeTab.mockReturnValueOnce({ok: false});
        expect((await dispatcher.execute('cleanup_task_tabs', {taskId: 'task'})).ok).toBe(false);
        expect(state.tabs.get(old)).toBe(replacement);
        const retried = await dispatcher.execute('cleanup_task_tabs', {taskId: 'task'});
        expect(retried.data.closedTabIds).toEqual([failing]);
        expect(state.tabs.get(old)).toBe(replacement);
    });
    test('creates a saved transformed view through the renderer manager', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const transformedViews = {
            create: jest.fn().mockResolvedValue({
                view: { id: 'd3d8a119-751f-48e6-b1f2-1a49d00091fb', name: 'Reader' },
                tabId: 'tab-9'
            })
        };
        const dispatcher = new BrowserToolDispatcher({}, undefined, transformedViews);

        const result = await dispatcher.execute('create_transformed_view', {
            name: 'Reader',
            sourceUrl: 'https://example.test/article',
            recipe: { rootSelector: 'article', removeSelectors: ['.ad'] }
        });

        expect(transformedViews.create).toHaveBeenCalledWith({
            name: 'Reader',
            sourceUrl: 'https://example.test/article',
            recipe: {
                rootSelector: 'article',
                titleSelector: 'h1',
                readySelector: '',
                removeSelectors: ['.ad'],
                theme: 'light'
            }
        });
        expect(result).toEqual({
            ok: true,
            data: { view: { id: 'd3d8a119-751f-48e6-b1f2-1a49d00091fb', name: 'Reader' }, tabId: 'tab-9' }
        });
    });

    test('forwards cancellation to transformed refreshes and does not report a cancelled refresh as success', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const controller = new AbortController();
        const transformedViews = {
            refresh: jest.fn(async (_tabId, { signal }) => {
                controller.abort('OpenCode session stopped.');
                await Promise.resolve();
                throw new Error(String(signal.reason));
            })
        };
        const dispatcher = new BrowserToolDispatcher({}, undefined, transformedViews);

        const result = await dispatcher.execute('refresh_transformed_view', { tabId: 'view-tab' }, { signal: controller.signal });

        expect(transformedViews.refresh).toHaveBeenCalledWith('view-tab', { signal: controller.signal });
        expect(result).toEqual({
            ok: false,
            error: {
                code: 'browser_action_cancelled',
                message: 'OpenCode session stopped.',
                retryable: false
            },
            actionMayHaveCompleted: false
        });
    });

    test('stops the source load for a cancelled transformed refresh', () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const transformedViews = { cancelRefresh: jest.fn() };
        const dispatcher = new BrowserToolDispatcher({}, undefined, transformedViews);

        dispatcher.cancel('refresh_transformed_view', { tabId: 'view-tab' });

        expect(transformedViews.cancelRefresh).toHaveBeenCalledWith('view-tab', 'Browser action was cancelled.');
    });

    test('forwards compact extraction options to the shared browser tool', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});

        const result = await dispatcher.execute('query_selector_all', {
            tabId: 'tab-1',
            selector: ' article a ',
            fields: ['text', 'href', 'ignored'],
            compact: true,
            offset: 4,
            maxResults: 3,
            maxTextChars: 80,
            textOffset: 160,
            maxOutputChars: 1_024
        });

        expect(state.browserTools.querySelectorAll).toHaveBeenCalledWith({
            tabId: 'tab-1',
            selector: 'article a',
            fields: ['text', 'href'],
            compact: true,
            offset: 4,
            maxResults: 3,
            maxTextChars: 80,
            textOffset: 160,
            maxOutputChars: 1_024
        });
        expect(result).toEqual({ ok: true, data: { ok: true, items: [] } });
    });

    test('forwards bounded literal page-find options without changing the query', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});

        const result = await dispatcher.execute('find_page_text', {
            tabId: 'tab-1',
            query: ' Exact query ',
            contextChars: 12,
            maxMatches: 4,
            caseSensitive: true
        });

        expect(state.browserTools.findPageText).toHaveBeenCalledWith({
            tabId: 'tab-1',
            query: ' Exact query ',
            contextChars: 12,
            maxMatches: 4,
            caseSensitive: true
        });
        expect(result).toEqual({ ok: true, data: { ok: true, matches: [] } });
    });

    test('forwards targeted page-read options through the shared tool', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});

        const result = await dispatcher.execute('read_page_text', {
            tabId: 'tab-1',
            maxChars: 500,
            selector: ' main.product ',
            contentMode: 'main'
        });

        expect(state.browserTools.readPageText).toHaveBeenCalledWith({
            tabId: 'tab-1',
            maxChars: 500,
            selector: 'main.product',
            contentMode: 'main'
        });
        expect(result).toEqual({ ok: true, data: { ok: true, text: '' } });
    });

    test('forwards bounded condition wait options and its cancellation signal', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});
        const controller = new AbortController();

        const result = await dispatcher.execute('wait_for_element', {
            tabId: 'tab-1',
            selector: ' button.continue ',
            index: 1,
            visible: true,
            enabled: true,
            text: 'Continue',
            textChangedFrom: 'Loading',
            caseSensitive: true,
            timeoutMs: 1_500,
            pollIntervalMs: 75
        }, { signal: controller.signal });

        expect(state.browserTools.waitForElement).toHaveBeenCalledWith(expect.objectContaining({
            tabId: 'tab-1',
            selector: 'button.continue',
            index: 1,
            present: true,
            visible: true,
            enabled: true,
            text: 'Continue',
            textChangedFrom: 'Loading',
            caseSensitive: true,
            timeoutMs: 1_500,
            pollIntervalMs: 75,
            signal: controller.signal
        }));
        expect(result).toEqual({ ok: true, data: { ok: true, observed: {} } });
    });

    test('rejects contradictory disappearing-element conditions before browser execution', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});

        const result = await dispatcher.execute('wait_for_element', {
            tabId: 'tab-1',
            selector: '.loading',
            present: false,
            visible: false
        });

        expect(result).toEqual({
            ok: false,
            error: {
                code: 'invalid_request',
                message: 'present: false cannot be combined with visible, enabled, text, or textChangedFrom.'
            }
        });
        expect(state.browserTools.waitForElement).not.toHaveBeenCalled();
    });

    test('runs allowlisted tab reads independently and bounds the combined response', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});
        state.browserTools.readPageText.mockResolvedValue({ ok: true, text: 'x'.repeat(20_000), observed: { url: 'https://source.example/a', title: 'A', documentId: 'source-a' } });
        state.browserTools.findPageText.mockResolvedValue({ ok: false, error: 'Target tab was closed.', errorInfo: { code: 'browser_tab_closed', message: 'Target tab was closed.', retryable: false, certainty: 'observed' } });

        const result = await dispatcher.execute('batch_read_tabs', {
            maxOutputChars: 10_000,
            requests: [
                { id: 'first', tool: 'read_page_text', args: { tabId: 'tab-a', maxChars: 20_000 } },
                { id: 'second', tool: 'find_page_text', args: { tabId: 'tab-b', query: 'needle' } }
            ]
        });

        expect(state.browserTools.batchRead).toHaveBeenCalledTimes(1);
        expect(state.browserTools.readPageText).toHaveBeenCalledWith(expect.objectContaining({
            tabId: 'tab-a',
            includeDocumentIdentity: true
        }));
        expect(state.browserTools.findPageText).toHaveBeenCalledWith(expect.objectContaining({
            tabId: 'tab-b',
            query: 'needle'
        }));
        expect(result).toEqual(expect.objectContaining({
            ok: true,
            data: expect.objectContaining({
                items: expect.arrayContaining([
                    expect.objectContaining({ id: 'first', result: expect.objectContaining({ ok: true }) }),
                    expect.objectContaining({
                        id: 'second',
                        result: expect.objectContaining({ error: expect.objectContaining({ code: 'browser_tab_closed' }) })
                    })
                ]),
                output: expect.objectContaining({ maxChars: 10_000, truncated: true })
            })
        }));
        expect(JSON.stringify(result.data.items).length).toBeLessThanOrEqual(10_000);
    });

    test('rejects non-read batch tools before dispatching any tab work', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});

        const result = await dispatcher.execute('batch_read_tabs', {
            requests: [{ id: 'unsafe', tool: 'click_element', args: { tabId: 'tab-1', selector: '#buy' } }]
        });

        expect(result).toEqual({
            ok: false,
            error: expect.objectContaining({ code: 'invalid_request' })
        });
        expect(state.browserTools.batchRead).not.toHaveBeenCalled();
    });

    test('preserves structured actionable browser errors for remote clients', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});
        state.browserTools.clickElement.mockResolvedValue({
            ok: false,
            error: 'Element not found',
            errorInfo: {
                code: 'browser_element_not_found',
                message: 'Element not found',
                retryable: false,
                certainty: 'observed'
            },
            actionMayHaveCompleted: true
        });

        const result = await dispatcher.execute('click_element', { tabId: 'tab-1', selector: '#missing' });

        expect(result).toEqual(expect.objectContaining({
            ok: false,
            error: {
                code: 'browser_element_not_found',
                message: 'Element not found',
                retryable: false,
                certainty: 'observed'
            },
            actionMayHaveCompleted: true
        }));
        expect(result.data).toEqual(expect.objectContaining({ errorInfo: expect.objectContaining({ code: 'browser_element_not_found' }) }));
    });

    test('rejects selector limits outside the remote contract before browser execution', async () => {
        const state = {};
        const BrowserToolDispatcher = loadDispatcher(state);
        const dispatcher = new BrowserToolDispatcher({});

        const result = await dispatcher.execute('query_selector_all', {
            tabId: 'tab-1',
            selector: '.result',
            maxOutputChars: 255
        });

        expect(result).toEqual({
            ok: false,
            error: {
                code: 'invalid_request',
                message: 'maxOutputChars must be a number between 256 and 64000.'
            }
        });
        expect(state.browserTools.querySelectorAll).not.toHaveBeenCalled();
    });
});
