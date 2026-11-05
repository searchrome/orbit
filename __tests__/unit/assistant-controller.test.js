const fs = require('node:fs');
const path = require('node:path');
const plannerRequests = require('../../assistant-planner-requests.js');

function loadAssistantController() {
    const source = fs.readFileSync(path.join(__dirname, '../../assistant-controller.js'), 'utf8');
    const transformed = source
        .replace("import BrowserTools from './browser-tools.js';", "const BrowserTools = require('__browser_tools__');")
        .replace(/export default AssistantController;\s*$/, 'module.exports = AssistantController;');
    const module = { exports: {} };
    const factory = new Function('module', 'exports', 'require', transformed);
    factory(module, module.exports, (specifier) => {
        if (specifier === '__browser_tools__') {
            return class BrowserTools {
                constructor() {
                    this.getActiveTab = jest.fn().mockReturnValue(null);
                    this.listTabs = jest.fn().mockReturnValue([]);
                    this.getTabInfo = jest.fn();
                    this.openTab = jest.fn();
                    this.waitForLoad = jest.fn().mockResolvedValue({ ok: true });
                    this.waitForElement = jest.fn().mockResolvedValue({ ok: true });
                    this.readPageText = jest.fn().mockResolvedValue({ ok: true, text: '' });
                    this.findPageText = jest.fn().mockResolvedValue({ ok: true, matches: [] });
                    this.searchSite = jest.fn();
                    this.extractSearchResults = jest.fn();
                }
            };
        }
        if (specifier === './assistant-planner-requests.js') {
            return require('../../assistant-planner-requests.js');
        }
        return require(specifier);
    });
    return module.exports;
}

describe('Assistant controller', () => {
    beforeEach(() => {
        window.electronAPI = {
            send: jest.fn(),
            invoke: jest.fn()
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
        plannerRequests.resetAssistantPlannerRequests();
    });

    test('stopRun aborts the active planner request', () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);
        controller.runs.set('assistant-tab', {
            sessionId: 'session-1',
            aborted: false,
            activePlannerRequestId: 'request-1'
        });

        controller.stopRun('assistant-tab');

        expect(window.electronAPI.send).toHaveBeenCalledWith('assistant-abort-next-action', {
            requestId: 'request-1',
            sessionId: 'session-1'
        });
    });

    test('deriveTaskProfile matches harness marketplace and budget behavior', () => {
        const AssistantController = loadAssistantController();
        const tabManager = {
            tabs: [],
            getTabById: jest.fn(),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);

        expect(controller.deriveTaskProfile('Find me a used bike under 150').preferredMarketplace).toBeNull();
        expect(controller.deriveTaskProfile('Find me a used bike under 150').budgetMax).toBe(150);
        expect(controller.deriveTaskProfile('Find me a used bike on Marktplaats').preferredMarketplace).toBe('marktplaats.nl');
        expect(controller.deriveTaskProfile('Find me a used bike on eBay').preferredMarketplace).toBe('ebay.nl');
    });

    test('open_tab stays in the background unless activate is explicitly true', async () => {
        const AssistantController = loadAssistantController();
        const tabManager = {
            tabs: [],
            getTabById: jest.fn(),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);
        controller.browserTools.openTab = jest.fn().mockReturnValue({
            ok: true,
            id: 'tab-2',
            tab: { id: 'tab-2', url: 'https://example.com', title: 'Example' }
        });
        controller.browserTools.waitForLoad = jest.fn().mockResolvedValue({
            ok: true,
            tab: { id: 'tab-2', url: 'https://example.com', title: 'Example loaded' }
        });

        const run = {
            openedTabs: 0,
            taskProfile: { kind: 'general' }
        };

        await controller.executeTool('open_tab', { url: 'https://example.com' }, run);
        await controller.executeTool('open_tab', { url: 'https://example.org', activate: true }, run);

        expect(controller.browserTools.openTab).toHaveBeenNthCalledWith(1, expect.objectContaining({
            url: 'https://example.com',
            activate: false,
            hidden: true,
            partition: 'persist:assistant-agent',
            trackHistory: false
        }));
        expect(controller.browserTools.openTab).toHaveBeenNthCalledWith(2, expect.objectContaining({
            url: 'https://example.org',
            activate: true,
            hidden: true,
            partition: 'persist:assistant-agent',
            trackHistory: false
        }));
        expect(controller.browserTools.waitForLoad).toHaveBeenCalledWith(expect.objectContaining({
            tabId: 'tab-2',
            requireNavigation: false
        }));
    });

    test('find_page_text delegates to the shared browser tool as a read', async () => {
        const AssistantController = loadAssistantController();
        const controller = new AssistantController({
            tabs: [],
            getTabById: jest.fn(),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        });
        const run = { taskProfile: { kind: 'general' } };

        await controller.executeTool('find_page_text', {
            tabId: 'tab-1',
            query: 'Cafe',
            contextChars: 24,
            maxMatches: 3,
            caseSensitive: true
        }, run);

        expect(controller.browserTools.findPageText).toHaveBeenCalledWith({
            tabId: 'tab-1',
            query: 'Cafe',
            contextChars: 24,
            maxMatches: 3,
            caseSensitive: true
        });
    });

    test('wait_for_element delegates bounded conditions to the shared browser tool', async () => {
        const AssistantController = loadAssistantController();
        const controller = new AssistantController({
            tabs: [],
            getTabById: jest.fn(),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        });
        const run = { taskProfile: { kind: 'general' } };

        await controller.executeTool('wait_for_element', {
            tabId: 'tab-1',
            selector: '#save',
            visible: true,
            enabled: true,
            textChangedFrom: 'Saving',
            timeoutMs: 1_000
        }, run);

        expect(controller.browserTools.waitForElement).toHaveBeenCalledWith(expect.objectContaining({
            tabId: 'tab-1',
            selector: '#save',
            visible: true,
            enabled: true,
            textChangedFrom: 'Saving',
            timeoutMs: 1_000
        }));
    });

    test('planner payload includes the session id, request id, and remaining timeout budget', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockResolvedValue({
            type: 'final',
            message: 'Done'
        });

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Find a used laptop',
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).toHaveBeenCalledWith(
            'assistant-next-action',
            expect.objectContaining({
                sessionId: 'session-1',
                requestId: expect.any(String),
                timeoutMs: expect.any(Number)
            })
        );
        const plannerPayload = window.electronAPI.invoke.mock.calls[0][1];
        expect(plannerPayload.timeoutMs).toBeGreaterThan(0);
        expect(plannerPayload.timeoutMs).toBeLessThanOrEqual(600000);
        expect(plannerPayload.requestId).toContain('session-1');
    });

    test('planner payload sends compact browser state and recent context only', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockResolvedValue({
            type: 'final',
            message: 'Done'
        });

        const controller = new AssistantController(tabManager);
        controller.browserTools.getActiveTab.mockReturnValue({
            id: 'active-tab',
            title: 'Active',
            url: 'https://active.example',
            active: true
        });
        controller.browserTools.listTabs.mockReturnValue(
            Array.from({ length: 20 }, (_, index) => ({
                id: `tab-${index}`,
                title: `Tab ${index}`,
                url: `https://example.com/${index}`,
                active: index === 0,
                assistantOwned: index % 3 === 0
            }))
        );

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Find a used laptop',
            session: {
                messages: Array.from({ length: 20 }, (_, index) => ({
                    role: index % 2 === 0 ? 'user' : 'assistant',
                    content: `message-${index}`
                }))
            }
        });

        const plannerPayload = window.electronAPI.invoke.mock.calls[0][1];
        expect(plannerPayload.messages).toHaveLength(8);
        expect(plannerPayload.browserState.tabs.length).toBeLessThanOrEqual(8);
        expect(plannerPayload.browserState.totalTabCount).toBe(20);
        expect(plannerPayload.browserState.tabs[0]).toEqual(expect.objectContaining({
            id: 'active-tab',
            url: 'https://active.example'
        }));
    });

    test('planner timeout is surfaced as a failed run', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockRejectedValue(new Error('Planner request timed out after 1000ms.'));

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Find a used laptop',
            session: {
                messages: []
            }
        });

        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-task-failed',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'failed',
                message: 'Planner request timed out.'
            })
        );
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-status',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'failed',
                message: 'Planner request timed out.'
            })
        );
    });

    test('asks the user whether to continue after 50 tool calls', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockResolvedValue({
            type: 'tool_call',
            tool: 'list_tabs',
            arguments: {}
        });

        const controller = new AssistantController(tabManager);
        controller.browserTools.listTabs = jest.fn().mockReturnValue([]);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Research this deeply',
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).toHaveBeenCalledTimes(50);
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'clarifying',
                message: 'I have used 50 browser steps. Reply "continue" to allow 50 more, or "stop" to finish here.'
            })
        );
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-status',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'clarifying',
                message: 'Need your reply.'
            })
        );
    });

    test('declining a continuation request ends the run without calling the planner again', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'stop',
            clarificationContext: {
                question: 'I have used 50 browser steps. Reply "continue" to allow 50 more, or "stop" to finish here.',
                reason: 'continue_run',
                originalPrompt: 'Research this deeply',
                toolCallsUsed: 50
            },
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).not.toHaveBeenCalled();
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'idle',
                isFinal: true,
                message: 'Stopped here. Send another prompt when you want to continue.'
            })
        );
    });

    test('approving a continuation request resumes planning', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockResolvedValue({
            type: 'final',
            message: 'Done'
        });

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'continue',
            clarificationContext: {
                question: 'I have used 50 browser steps. Reply "continue" to allow 50 more, or "stop" to finish here.',
                reason: 'continue_run',
                originalPrompt: 'Research this deeply',
                toolCallsUsed: 50
            },
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).toHaveBeenCalledWith(
            'assistant-next-action',
            expect.objectContaining({
                prompt: expect.stringContaining('Continue the same task from the current browser state and prior conversation.')
            })
        );
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Done',
                isFinal: true
            })
        );
    });

    test('shopping prompts can still be clarified by the planner', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockResolvedValue({
            type: 'clarify',
            question: 'Which type matters most here?',
            reason: 'missing constraints',
            missingInfo: ['type']
        });

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'I need a used bike under 150 euro',
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).toHaveBeenCalledTimes(1);
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'clarifying',
                message: 'Which type matters most here?'
            })
        );
    });

    test('browser controller surfaces under-budget marketplace candidates to planner runtime state', () => {
        const AssistantController = loadAssistantController();
        const tabManager = {
            tabs: [],
            getTabById: jest.fn(),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);
        const run = {
            callCount: 1,
            openedTabs: 0,
            consecutiveToolFailures: 0,
            lastToolName: null,
            lastToolOk: null,
            lastToolError: null,
            lastMarketplaceCandidateCount: 0,
            lastPlausibleMarketplaceCandidateCount: 0,
            lastUnderBudgetMarketplaceCandidateCount: 0,
            topMarketplaceCandidates: [],
            touchedTabs: [],
            taskProfile: controller.deriveTaskProfile('Find me a used bike under 150 euro'),
            marketplaceListingKeysOpened: new Set(),
            marketplaceListingKeysInspected: new Set(),
            researchSourcePageKeysInspected: new Set()
        };
        const toolResult = {
            ok: true,
            tab: { id: 'tab-1', title: 'Results', url: 'https://example.com/results' },
            items: [
                {
                    title: 'Gazelle city bike',
                    href: 'https://example.com/itm/1',
                    price: '€ 80,00',
                    location: 'Groningen',
                    snippet: 'Used city bike in good shape',
                    score: 80
                },
                {
                    title: 'Accessory saddle',
                    href: 'https://example.com/itm/2',
                    price: '€ 10,00',
                    location: 'Utrecht',
                    snippet: 'fietsaccessoires saddle',
                    score: 95
                }
            ]
        };

        controller.updateRuntimeSignals(run, 'extract_search_results', toolResult);

        expect(controller.buildRuntimeState(run)).toEqual(
            expect.objectContaining({
                lastMarketplaceCandidateCount: 2,
                lastPlausibleMarketplaceCandidateCount: 1,
                lastUnderBudgetMarketplaceCandidateCount: 1,
                topMarketplaceCandidates: [
                    expect.objectContaining({
                        title: 'Gazelle city bike',
                        price: '€ 80,00',
                        location: 'Groningen',
                        underBudget: true
                    })
                ]
            })
        );
    });

    test('planner step messages are surfaced to the chat before tool execution', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke
            .mockResolvedValueOnce({
                type: 'tool_call',
                message: 'First I will inspect the open tabs.',
                tool: 'list_tabs',
                arguments: {}
            })
            .mockResolvedValueOnce({
                type: 'final',
                message: 'Done'
            });

        const controller = new AssistantController(tabManager);
        controller.browserTools.listTabs = jest.fn().mockReturnValue([]);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Help me research this',
            session: {
                messages: []
            }
        });

        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'First I will inspect the open tabs.',
                status: 'running',
                isFinal: false,
                source: 'planner'
            })
        );
    });

    test('shopping search extracts and inspects candidates in the same tool step', async () => {
        const AssistantController = loadAssistantController();
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue({
                id: 'assistant-tab',
                role: 'assistant',
                webview: { send: jest.fn() }
            }),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);
        controller.browserTools.searchSite = jest.fn().mockResolvedValue({
            ok: true,
            tab: { id: 'search-tab', url: 'https://market.example/search?q=bike' }
        });
        controller.browserTools.extractSearchResults = jest.fn().mockResolvedValue({
            ok: true,
            tab: { id: 'search-tab', url: 'https://market.example/search?q=bike' },
            items: [
                {
                    title: 'Used city bike 60cm',
                    href: 'https://www.ebay.nl/itm/1234567890',
                    price: 'EUR 120',
                    snippet: 'Good condition city bike'
                }
            ]
        });
        controller.browserTools.openTab = jest.fn().mockReturnValue({
            ok: true,
            id: 'listing-tab',
            tab: { id: 'listing-tab', title: 'Used city bike', url: 'https://www.ebay.nl/itm/1234567890' }
        });
        controller.browserTools.waitForLoad = jest.fn().mockResolvedValue({
            ok: true,
            tab: { id: 'listing-tab', title: 'Used city bike', url: 'https://www.ebay.nl/itm/1234567890' }
        });
        controller.browserTools.readPageText = jest.fn().mockResolvedValue({
            ok: true,
            tab: { id: 'listing-tab', title: 'Used city bike', url: 'https://www.ebay.nl/itm/1234567890' },
            text: 'Used city bike in good shape for EUR 120'
        });

        const run = {
            tabId: 'assistant-tab',
            sessionId: 'session-1',
            openedTabs: 0,
            taskProfile: { kind: 'shopping', budgetMax: 150 },
            touchedTabs: [],
            marketplaceListingTabsOpened: 0,
            marketplaceListingKeysOpened: new Set(),
            marketplaceListingKeysInspected: new Set()
        };

        const result = await controller.executeTool('search_site', {
            tabId: 'search-tab',
            query: 'used city bike under 150',
            siteHint: 'ebay'
        }, run);

        expect(result.ok).toBe(true);
        expect(controller.browserTools.extractSearchResults).toHaveBeenCalledWith({
            tabId: 'search-tab',
            siteHint: 'ebay'
        });
        expect(controller.browserTools.openTab).toHaveBeenCalledWith(expect.objectContaining({
            url: 'https://www.ebay.nl/itm/1234567890',
            hidden: true
        }));
        expect(result.extractedResults.items).toHaveLength(1);
        expect(result.openedCandidateTabs).toHaveLength(1);
        expect(run.marketplaceListingKeysInspected.size).toBe(1);
    });

    test('repeated list_tabs loop is broken by reading the relevant tab', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke
            .mockResolvedValueOnce({
                type: 'tool_call',
                message: 'I will inspect the tabs.',
                tool: 'list_tabs',
                arguments: {}
            })
            .mockResolvedValueOnce({
                type: 'tool_call',
                message: 'I need to inspect the TradingView tab.',
                tool: 'list_tabs',
                arguments: {}
            })
            .mockResolvedValueOnce({
                type: 'tool_call',
                message: 'I still need the TradingView tab.',
                tool: 'list_tabs',
                arguments: {}
            })
            .mockResolvedValueOnce({
                type: 'final',
                message: 'Gold summary based on the page text.'
            });

        const controller = new AssistantController(tabManager);
        const xauTab = {
            id: 'tab-5',
            title: 'XAUUSD Chart',
            url: 'https://www.tradingview.com/symbols/XAUUSD/',
            assistantOwned: true,
            hidden: true
        };
        controller.browserTools.listTabs = jest.fn().mockReturnValue([xauTab]);
        controller.browserTools.getTabInfo = jest.fn().mockReturnValue(xauTab);
        controller.browserTools.readPageText = jest.fn().mockResolvedValue({
            ok: true,
            tab: xauTab,
            text: 'XAUUSD 3360. Gold is rising on weaker dollar expectations.'
        });

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Check the gold price and trend',
            session: {
                messages: []
            }
        });

        const executedListTabLogs = tab.webview.send.mock.calls.filter(([channel, payload]) => (
            channel === 'assistant-log' &&
            payload?.message === 'Running tool: list_tabs'
        ));
        expect(executedListTabLogs).toHaveLength(2);
        expect(controller.browserTools.readPageText).toHaveBeenCalledWith({
            tabId: 'tab-5',
            maxChars: 6000
        });
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-progress',
            expect.objectContaining({
                level: 'warn',
                message: expect.stringContaining('Repeated list_tabs detected')
            })
        );
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Gold summary based on the page text.',
                isFinal: true
            })
        );
    });

    test('underspecified non-bike shopping prompts can still be clarified by the planner', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockResolvedValue({
            type: 'clarify',
            question: 'What budget should I use?',
            reason: 'The request is missing a budget.',
            missingInfo: ['budget']
        });

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'I need a used laptop',
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).toHaveBeenCalledTimes(1);
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'What budget should I use?',
                status: 'clarifying',
                isFinal: false,
                meta: expect.objectContaining({
                    clarification: expect.objectContaining({
                        question: 'What budget should I use?',
                        originalPrompt: 'I need a used laptop'
                    })
                })
            })
        );
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-status',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'clarifying',
                message: 'Need your reply.'
            })
        );
        expect(tab.webview.send).not.toHaveBeenCalledWith(
            'assistant-task-finished',
            expect.anything()
        );
    });

    test('underspecified local search prompts are classified for clarification before browsing', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockImplementation((channel, payload) => {
            expect(channel).toBe('assistant-next-action');
            expect(payload.taskProfile.kind).toBe('local_search');
            return Promise.resolve({
                type: 'clarify',
                question: 'Which sport should I search for?'
            });
        });

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Find me a sports club in Den Haag',
            session: {
                messages: []
            }
        });

        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Which sport should I search for?',
                status: 'clarifying'
            })
        );
    });

    test('recommendation prompts are classified for clarification before browsing', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke.mockImplementation((channel, payload) => {
            expect(channel).toBe('assistant-next-action');
            expect(payload.taskProfile.kind).toBe('recommendation');
            return Promise.resolve({
                type: 'clarify',
                question: 'What genre are you in the mood for?'
            });
        });

        const controller = new AssistantController(tabManager);

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'I like these movies, what should I watch tonight?',
            session: {
                messages: []
            }
        });

        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'What genre are you in the mood for?',
                status: 'clarifying'
            })
        );
    });

    test('recommendation runs count query-only content pages while ignoring tracking variants', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const plannerActions = [
            {
                type: 'tool_call',
                tool: 'open_tab',
                arguments: {
                    url: 'https://www.google.com/search?q=best+movies',
                    title: 'Search results'
                }
            },
            {
                type: 'tool_call',
                tool: 'read_page_text',
                arguments: {
                    tabId: 'search-results',
                    maxChars: 2000
                }
            },
            {
                type: 'final',
                message: 'A search results page is enough.'
            },
            {
                type: 'tool_call',
                tool: 'open_tab',
                arguments: {
                    url: 'https://example.com/?id=123&utm_source=a',
                    title: 'Content A'
                }
            },
            {
                type: 'tool_call',
                tool: 'read_page_text',
                arguments: {
                    tabId: 'content-a-1',
                    maxChars: 2000
                }
            },
            {
                type: 'final',
                message: 'One source page is enough.',
            },
            {
                type: 'tool_call',
                tool: 'open_tab',
                arguments: {
                    url: 'https://example.com/?id=123&utm_source=b',
                    title: 'Content A duplicate'
                }
            },
            {
                type: 'tool_call',
                tool: 'read_page_text',
                arguments: {
                    tabId: 'content-a-2',
                    maxChars: 2000
                }
            },
            {
                type: 'final',
                message: 'Query variants are enough.',
            },
            {
                type: 'tool_call',
                tool: 'open_tab',
                arguments: {
                    url: 'https://example.com/?id=456',
                    title: 'Content B'
                }
            },
            {
                type: 'tool_call',
                tool: 'read_page_text',
                arguments: {
                    tabId: 'content-b',
                    maxChars: 2000
                }
            },
            {
                type: 'final',
                message: 'Use these two sources.',
                results: [
                    {
                        title: 'Content A',
                        url: 'https://example.com/?id=123&utm_source=a'
                    },
                    {
                        title: 'Content B',
                        url: 'https://example.com/?id=456'
                    }
                ]
            }
        ];

        window.electronAPI.invoke.mockImplementation(() => Promise.resolve(plannerActions.shift()));

        const controller = new AssistantController(tabManager);
        controller.browserTools.openTab = jest.fn((options) => ({
            ok: true,
            id: options.url.includes('id=123') && options.url.includes('utm_source=a')
                ? 'content-a-1'
                : options.url.includes('id=123') && options.url.includes('utm_source=b')
                    ? 'content-a-2'
                    : options.url.includes('id=456')
                        ? 'content-b'
                        : 'search-results',
            tab: {
                id: options.url.includes('id=123') && options.url.includes('utm_source=a')
                    ? 'content-a-1'
                    : options.url.includes('id=123') && options.url.includes('utm_source=b')
                        ? 'content-a-2'
                        : options.url.includes('id=456')
                            ? 'content-b'
                            : 'search-results',
                url: options.url,
                title: options.title,
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            }
        }));
        controller.browserTools.readPageText = jest.fn((options) => ({
            ok: true,
            tab: {
                id: options.tabId,
                url: options.tabId === 'content-a-1'
                    ? 'https://example.com/?id=123&utm_source=a'
                    : options.tabId === 'content-a-2'
                        ? 'https://example.com/?id=123&utm_source=b'
                        : options.tabId === 'content-b'
                            ? 'https://example.com/?id=456'
                            : 'https://www.google.com/search?q=best+movies',
                title: options.tabId === 'content-a-1'
                    ? 'Content A'
                    : options.tabId === 'content-a-2'
                        ? 'Content A duplicate'
                        : options.tabId === 'content-b'
                            ? 'Content B'
                            : 'Search results',
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            },
            text: options.tabId === 'content-a-1'
                ? 'Content A details'
                : options.tabId === 'content-a-2'
                    ? 'Content A duplicate details'
                    : options.tabId === 'content-b'
                        ? 'Content B details'
                        : 'Search results page'
        }));

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'I like these movies, what should I watch tonight?',
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke.mock.calls.length).toBeGreaterThanOrEqual(12);
        expect(controller.browserTools.openTab).toHaveBeenCalledTimes(4);
        expect(controller.browserTools.openTab.mock.calls.map((call) => call[0].url)).toEqual([
            'https://www.google.com/search?q=best+movies',
            'https://example.com/?id=123&utm_source=a',
            'https://example.com/?id=123&utm_source=b',
            'https://example.com/?id=456'
        ]);
        expect(controller.browserTools.readPageText).toHaveBeenCalledTimes(4);
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-progress',
            expect.objectContaining({
                sessionId: 'session-1',
                level: 'warn',
                message: 'Open and inspect at least 2 distinct source pages before finalizing this research task.'
            })
        );
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Use these two sources.',
                isFinal: true
            })
        );
    });

    test('shopping runs auto-open candidate listings and wait for inspection before accepting a final answer', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const plannerActions = [
            {
                type: 'tool_call',
                tool: 'extract_search_results',
                arguments: {
                    tabId: 'search-tab',
                    siteHint: 'ebay'
                }
            },
            {
                type: 'final',
                message: 'Done'
            }
        ];

        window.electronAPI.invoke.mockImplementation(() => Promise.resolve(plannerActions.shift()));

        const controller = new AssistantController(tabManager);
        controller.browserTools.extractSearchResults = jest.fn().mockResolvedValue({
            ok: true,
            tab: {
                id: 'search-tab',
                title: 'eBay results',
                url: 'https://www.ebay.nl/sch/i.html?_nkw=used+bike',
                role: 'regular',
                assistantOwned: false,
                internal: false,
                active: false,
                loading: false,
                canGoBack: false
            },
            items: [
                {
                    title: 'Used Cross DXT300',
                    href: 'https://www.ebay.nl/itm/111',
                    price: 'EUR 250.00',
                    score: 120
                },
                {
                    title: 'Used Cross DXT300 duplicate',
                    href: 'https://www.ebay.nl/itm/111?hash=itemabc',
                    price: 'EUR 245.00',
                    score: 119
                },
                {
                    title: 'Used Retro Trek',
                    href: 'https://www.ebay.nl/itm/222',
                    price: 'EUR 275.00',
                    score: 110
                }
            ]
        });
        controller.browserTools.waitForLoad = jest.fn().mockResolvedValue({
            ok: true,
            tab: {
                id: 'listing-load',
                url: 'https://www.ebay.nl/itm/111',
                title: 'Listing load',
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            },
            alreadyLoaded: true
        });
        controller.browserTools.readPageText = jest.fn((options) => ({
            ok: true,
            tab: {
                id: options.tabId,
                url: options.tabId === 'listing-1'
                    ? 'https://www.ebay.nl/itm/111'
                    : 'https://www.ebay.nl/itm/222',
                title: options.tabId === 'listing-1' ? 'Listing 1' : 'Listing 2',
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            },
            text: options.tabId === 'listing-1'
                ? 'Listing 1 details'
                : 'Listing 2 details'
        }));
        controller.browserTools.openTab = jest.fn((options) => ({
            ok: true,
            id: options.url.includes('111') ? 'listing-1' : 'listing-3',
            tab: {
                id: options.url.includes('111') ? 'listing-1' : 'listing-3',
                url: options.url,
                title: options.title,
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            }
        }));

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'I need a used city bike under 300 euro for a woman size 54',
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).toHaveBeenCalledTimes(2);
        expect(controller.browserTools.extractSearchResults).toHaveBeenCalledTimes(1);
        expect(controller.browserTools.openTab).toHaveBeenCalledTimes(2);
        expect(controller.browserTools.readPageText).toHaveBeenCalledTimes(2);
        expect(controller.browserTools.openTab.mock.calls.map((call) => call[0].url)).toEqual([
            'https://www.ebay.nl/itm/111',
            'https://www.ebay.nl/itm/222'
        ]);
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-progress',
            expect.objectContaining({
                sessionId: 'session-1',
                level: 'info',
                message: 'Opened and inspected candidate listing tabs. Compare them before finalizing.'
            })
        );
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                message: 'Done',
                isFinal: true
            })
        );
    });

    test('shopping comparison cards preserve prices while skipping duplicate listing urls', async () => {
        const AssistantController = loadAssistantController();
        const workspaceTab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockImplementation((tabId) => (tabId === 'assistant-tab' ? workspaceTab : null)),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);
        controller.browserTools.openTab = jest.fn((options) => ({
            ok: true,
            id: options.url.includes('111') ? 'listing-1' : 'listing-2',
            tab: {
                id: options.url.includes('111') ? 'listing-1' : 'listing-2',
                url: options.url,
                title: options.title,
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            }
        }));
        controller.browserTools.waitForLoad = jest.fn().mockResolvedValue({
            ok: true,
            alreadyLoaded: true,
            tab: {
                id: 'listing-1',
                url: 'https://www.ebay.nl/itm/111',
                title: 'Listing load',
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            }
        });
        controller.browserTools.readPageText = jest.fn((options) => ({
            ok: true,
            tab: {
                id: options.tabId,
                url: options.tabId === 'listing-1'
                    ? 'https://www.ebay.nl/itm/111'
                    : 'https://www.ebay.nl/itm/222',
                title: options.tabId === 'listing-1' ? 'Listing 1' : 'Listing 2',
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            },
            text: options.tabId === 'listing-1'
                ? 'Listing 1 details'
                : 'Listing 2 details'
        }));

        const run = {
            tabId: 'assistant-tab',
            sessionId: 'session-1',
            taskProfile: {
                kind: 'shopping'
            },
            openedTabs: 0,
            marketplaceListingTabsOpened: 0,
            marketplaceListingKeysOpened: new Set(),
            marketplaceListingKeysInspected: new Set(),
            touchedTabs: []
        };

        const result = {
            items: [
                {
                    title: 'Used Cross DXT300',
                    href: 'https://www.ebay.nl/itm/111',
                    price: 'EUR 250.00'
                },
                {
                    title: 'Used Cross DXT300 duplicate',
                    href: 'https://www.ebay.nl/itm/111?hash=itemabc',
                    price: 'EUR 245.00'
                },
                {
                    title: 'Used Retro Trek',
                    href: 'https://www.ebay.nl/itm/222',
                    price: 'EUR 275.00'
                }
            ]
        };

        await controller.maybeAutoOpenMarketplaceListings(run, result);

        expect(controller.browserTools.openTab).toHaveBeenCalledTimes(2);
        expect(controller.browserTools.openTab.mock.calls.map((call) => call[0].url)).toEqual([
            'https://www.ebay.nl/itm/111',
            'https://www.ebay.nl/itm/222'
        ]);
        expect(result.openedCandidateTabs).toEqual([
            expect.objectContaining({
                id: 'listing-1',
                price: 'EUR 250.00'
            }),
            expect.objectContaining({
                id: 'listing-2',
                price: 'EUR 275.00'
            })
        ]);
    });

    test('auto-open skips category-like marketplace results and opens only plausible listings', async () => {
        const AssistantController = loadAssistantController();
        const workspaceTab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockImplementation((tabId) => (tabId === 'assistant-tab' ? workspaceTab : null)),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const controller = new AssistantController(tabManager);
        controller.browserTools.openTab = jest.fn((options) => ({
            ok: true,
            id: options.url.includes('111') ? 'listing-1' : 'listing-2',
            tab: {
                id: options.url.includes('111') ? 'listing-1' : 'listing-2',
                url: options.url,
                title: options.title,
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            }
        }));
        controller.browserTools.waitForLoad = jest.fn().mockResolvedValue({
            ok: true,
            alreadyLoaded: true,
            tab: {
                id: 'listing-1',
                url: 'https://www.ebay.nl/itm/111',
                title: 'Listing load',
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            }
        });
        controller.browserTools.readPageText = jest.fn((options) => ({
            ok: true,
            tab: {
                id: options.tabId,
                url: options.tabId === 'listing-1'
                    ? 'https://www.ebay.nl/itm/111'
                    : 'https://www.ebay.nl/itm/222',
                title: options.tabId === 'listing-1' ? 'Listing 1' : 'Listing 2',
                role: 'browser',
                assistantOwned: true,
                internal: false,
                active: true,
                loading: false,
                canGoBack: false
            },
            text: 'Listing details'
        }));

        const run = {
            tabId: 'assistant-tab',
            sessionId: 'session-1',
            taskProfile: {
                kind: 'shopping'
            },
            openedTabs: 0,
            marketplaceListingTabsOpened: 0,
            marketplaceListingKeysOpened: new Set(),
            marketplaceListingKeysInspected: new Set(),
            touchedTabs: []
        };

        const result = {
            items: [
                {
                    title: 'Sport en vrije tijd',
                    href: 'https://www.ebay.nl/sch/888/i.html?_nkw=fiets&_from=R40',
                    price: null,
                    snippet: 'Category page'
                },
                {
                    title: 'Used City Bike',
                    href: 'https://www.ebay.nl/itm/111',
                    price: 'EUR 120.00',
                    snippet: 'Good used bike'
                },
                {
                    title: 'Used Road Bike',
                    href: 'https://www.ebay.nl/itm/222',
                    price: 'EUR 145.00',
                    snippet: 'Another used bike'
                }
            ]
        };

        await controller.maybeAutoOpenMarketplaceListings(run, result);

        expect(controller.browserTools.openTab).toHaveBeenCalledTimes(2);
        expect(controller.browserTools.openTab.mock.calls.map((call) => call[0].url)).toEqual([
            'https://www.ebay.nl/itm/111',
            'https://www.ebay.nl/itm/222'
        ]);
    });

    test('repeated tool failures are surfaced back to the planner through runtime state', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        const plannerActions = [
            {
                type: 'tool_call',
                tool: 'search_site',
                arguments: {
                    tabId: 'tab-1',
                    query: 'used car'
                }
            },
            {
                type: 'tool_call',
                tool: 'search_site',
                arguments: {
                    tabId: 'tab-1',
                    query: 'used car'
                }
            },
            {
                type: 'clarify',
                question: 'The searches are failing. Which marketplace or location should I prioritize?'
            }
        ];
        window.electronAPI.invoke.mockImplementation((channel, payload) => {
            const action = plannerActions.shift();
            if (plannerActions.length === 0) {
                expect(payload.runtimeState.consecutiveToolFailures).toBe(2);
                expect(payload.runtimeState.lastToolError).toBe('Search failed twice.');
            }
            return Promise.resolve(action);
        });

        const controller = new AssistantController(tabManager);
        controller.browserTools.searchSite = jest.fn()
            .mockResolvedValueOnce({ ok: false, error: 'Search failed once.' })
            .mockResolvedValueOnce({ ok: false, error: 'Search failed twice.' });

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Find me a used car',
            session: {
                messages: []
            }
        });

        expect(window.electronAPI.invoke).toHaveBeenCalledTimes(3);
        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'clarifying',
                message: 'The searches are failing. Which marketplace or location should I prioritize?'
            })
        );
    });

    test('noisy marketplace signals are surfaced back to the planner through runtime state', async () => {
        const AssistantController = loadAssistantController();
        const tab = {
            id: 'assistant-tab',
            role: 'assistant',
            webview: {
                send: jest.fn()
            }
        };
        const tabManager = {
            tabs: [],
            getTabById: jest.fn().mockReturnValue(tab),
            switchToTab: jest.fn(),
            createTab: jest.fn()
        };

        window.electronAPI.invoke
            .mockResolvedValueOnce({
                type: 'tool_call',
                tool: 'extract_search_results',
                arguments: {
                    tabId: 'search-tab',
                    siteHint: 'ebay'
                }
            })
            .mockImplementationOnce((channel, payload) => {
                expect(payload.runtimeState.lastPlausibleMarketplaceCandidateCount).toBe(0);
                return Promise.resolve({
                    type: 'clarify',
                    question: 'I am seeing mostly category and accessory results. What exact bike type or marketplace should I focus on?'
                });
            });

        const controller = new AssistantController(tabManager);
        controller.browserTools.extractSearchResults = jest.fn().mockResolvedValue({
            ok: true,
            tab: {
                id: 'search-tab',
                title: 'eBay results',
                url: 'https://www.ebay.nl/sch/i.html?_nkw=fiets',
                role: 'regular',
                assistantOwned: false,
                internal: false,
                active: false,
                loading: false,
                canGoBack: false
            },
            items: [
                {
                    title: 'Sport en vrije tijd',
                    href: 'https://www.ebay.nl/sch/888/i.html?_nkw=fiets&_from=R40',
                    price: null,
                    snippet: 'Category page'
                },
                {
                    title: 'Fietsaccessoires',
                    href: 'https://www.ebay.nl/sch/177832/i.html?_nkw=fiets&_from=R40',
                    price: null,
                    snippet: 'Accessory category'
                }
            ]
        });

        await controller.startRun(tab, {
            sessionId: 'session-1',
            prompt: 'Find me a used bike under 150 euro',
            session: {
                messages: []
            }
        });

        expect(tab.webview.send).toHaveBeenCalledWith(
            'assistant-response',
            expect.objectContaining({
                sessionId: 'session-1',
                status: 'clarifying',
                message: 'I am seeing mostly category and accessory results. What exact bike type or marketplace should I focus on?'
            })
        );
    });
});
