const {
    StandaloneBrowserAgent,
    deriveTaskProfile,
    createContinuationQuestion,
    parseBudgetMax,
    parsePriceValue
} = require('../../scripts/browser-agent-harness-lib.js');

function createFakeBrowser(overrides = {}) {
    const state = {
        activeTab: {
            id: 'tab-1',
            title: 'Example',
            url: 'https://example.com',
            role: 'regular',
            assistantOwned: false,
            internal: false,
            active: true,
            loading: false,
            canGoBack: false
        }
    };

    return {
        refreshTargets: jest.fn().mockResolvedValue([]),
        listTabs: jest.fn().mockImplementation(() => [state.activeTab]),
        getActiveTab: jest.fn().mockImplementation(() => state.activeTab),
        getActiveTabInfo: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab }),
        getTabInfo: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab }),
        openTab: jest.fn().mockResolvedValue({ ok: true, id: 'tab-2', tab: { ...state.activeTab, id: 'tab-2', active: false } }),
        focusTab: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab }),
        closeTab: jest.fn().mockResolvedValue({ ok: true, closedTabId: 'tab-2' }),
        navigateTab: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab }),
        waitForLoad: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab, loaded: true }),
        readPageText: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab, text: 'Example body text' }),
        querySelectorAll: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab, items: [] }),
        clickElement: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab }),
        typeInto: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab, submitted: true }),
        scrollPage: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab }),
        searchSite: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab, submitted: true }),
        extractSearchResults: jest.fn().mockResolvedValue({ ok: true, tab: state.activeTab, items: [] }),
        ...overrides
    };
}

function createFakeIo(answers = []) {
    return {
        info: jest.fn().mockResolvedValue(undefined),
        warn: jest.fn().mockResolvedValue(undefined),
        error: jest.fn().mockResolvedValue(undefined),
        assistant: jest.fn().mockResolvedValue(undefined),
        ask: jest.fn().mockImplementation(async () => answers.shift() || '')
    };
}

describe('browser agent harness', () => {
    test('deriveTaskProfile matches the browser agent categories', () => {
        expect(deriveTaskProfile('Find me a used bike under 150').kind).toBe('shopping');
        expect(deriveTaskProfile('Find me a used bike under 150').preferredMarketplace).toBeNull();
        expect(deriveTaskProfile('Find me a used bike under 150').budgetMax).toBe(150);
        expect(deriveTaskProfile('Find me a used bike on Marktplaats').preferredMarketplace).toBe('marktplaats.nl');
        expect(deriveTaskProfile('Find me a used bike on eBay').preferredMarketplace).toBe('ebay.nl');
        expect(deriveTaskProfile('Find me a sports club in Den Haag').kind).toBe('local_search');
        expect(deriveTaskProfile('What should I watch tonight?').kind).toBe('recommendation');
        expect(deriveTaskProfile('Summarize this page').kind).toBe('general');
    });

    test('parses budget and marketplace prices robustly', () => {
        expect(parseBudgetMax('find a bike under 150 euro')).toBe(150);
        expect(parseBudgetMax('budget €275')).toBe(275);
        expect(parsePriceValue('€ 85,00 5 apr 26')).toBe(85);
        expect(parsePriceValue('Bieden 5 mei 26')).toBeNull();
    });

    test('surfaces planner-authored tool messages before execution', async () => {
        const browser = createFakeBrowser();
        const io = createFakeIo();
        const planner = jest.fn()
            .mockResolvedValueOnce({
                type: 'tool_call',
                message: 'First I will inspect the open tabs.',
                tool: 'list_tabs',
                arguments: {}
            })
            .mockResolvedValueOnce({
                type: 'final',
                message: 'Done',
                results: []
            });

        const agent = new StandaloneBrowserAgent({ planner, browser, io });
        const result = await agent.run('Help me research this');

        expect(result.message).toBe('Done');
        expect(io.assistant).toHaveBeenCalledWith('First I will inspect the open tabs.');
    });

    test('clarification answers are folded back into the next planner prompt', async () => {
        const browser = createFakeBrowser();
        const io = createFakeIo(['male bike, 185 cm']);
        const planner = jest.fn()
            .mockResolvedValueOnce({
                type: 'clarify',
                question: 'What size and rider profile should I use?'
            })
            .mockResolvedValueOnce({
                type: 'final',
                message: 'Thanks',
                results: []
            });

        const agent = new StandaloneBrowserAgent({ planner, browser, io });
        await agent.run('Find a used bicycle under 150 euro');

        expect(planner).toHaveBeenNthCalledWith(
            2,
            expect.objectContaining({
                prompt: expect.stringContaining('Clarification answer: male bike, 185 cm')
            })
        );
    });

    test('asks for continuation after the configured tool budget', async () => {
        const browser = createFakeBrowser();
        const io = createFakeIo(['continue']);
        const planner = jest.fn()
            .mockResolvedValueOnce({ type: 'tool_call', tool: 'list_tabs', arguments: {} })
            .mockResolvedValueOnce({ type: 'tool_call', tool: 'list_tabs', arguments: {} })
            .mockResolvedValueOnce({ type: 'final', message: 'Finished', results: [] });

        const agent = new StandaloneBrowserAgent({
            planner,
            browser,
            io,
            maxToolCalls: 2
        });

        const result = await agent.run('Research this');

        expect(result.message).toBe('Finished');
        expect(io.ask).toHaveBeenCalledWith(createContinuationQuestion(2));
        expect(planner).toHaveBeenCalledTimes(3);
    });

    test('surfaces repeated tool failures back into runtime state for the planner', async () => {
        const browser = createFakeBrowser({
            searchSite: jest.fn()
                .mockResolvedValueOnce({ ok: false, error: 'Search failed once.' })
                .mockResolvedValueOnce({ ok: false, error: 'Search failed twice.' })
        });
        const io = createFakeIo();
        const planner = jest.fn()
            .mockResolvedValueOnce({ type: 'tool_call', tool: 'search_site', arguments: { tabId: 'tab-1', query: 'used car' } })
            .mockResolvedValueOnce({ type: 'tool_call', tool: 'search_site', arguments: { tabId: 'tab-1', query: 'used car' } })
            .mockImplementationOnce(async (payload) => {
                expect(payload.runtimeState.consecutiveToolFailures).toBe(2);
                expect(payload.runtimeState.lastToolError).toBe('Search failed twice.');
                return { type: 'final', message: 'Stopped', results: [] };
            });

        const agent = new StandaloneBrowserAgent({ planner, browser, io });
        const result = await agent.run('Find me a used car');

        expect(result.message).toBe('Stopped');
        expect(browser.searchSite).toHaveBeenCalledTimes(2);
    });

    test('surfaces top marketplace candidates and under-budget counts in runtime state', async () => {
        const browser = createFakeBrowser({
            extractSearchResults: jest.fn().mockResolvedValue({
                ok: true,
                tab: {
                    id: 'tab-1',
                    title: 'Results',
                    url: 'https://example.com/results'
                },
                items: [
                    {
                        title: 'Gazelle city bike',
                        href: 'https://example.com/v/1',
                        price: '€ 80,00',
                        location: 'Groningen',
                        snippet: 'Used city bike in good shape',
                        score: 80
                    },
                    {
                        title: 'Accessory saddle',
                        href: 'https://example.com/v/2',
                        price: '€ 10,00',
                        location: 'Utrecht',
                        snippet: 'fietsaccessoires saddle',
                        score: 95
                    }
                ]
            })
        });
        const io = createFakeIo();
        const planner = jest.fn()
            .mockResolvedValueOnce({ type: 'tool_call', tool: 'extract_search_results', arguments: { tabId: 'tab-1' } })
            .mockImplementationOnce(async (payload) => {
                expect(payload.runtimeState.lastMarketplaceCandidateCount).toBe(2);
                expect(payload.runtimeState.lastPlausibleMarketplaceCandidateCount).toBe(1);
                expect(payload.runtimeState.lastUnderBudgetMarketplaceCandidateCount).toBe(1);
                expect(payload.runtimeState.topMarketplaceCandidates).toEqual([
                    expect.objectContaining({
                        title: 'Gazelle city bike',
                        price: '€ 80,00',
                        location: 'Groningen',
                        underBudget: true
                    })
                ]);
                return { type: 'final', message: 'Done', results: [] };
            });

        const agent = new StandaloneBrowserAgent({ planner, browser, io });
        const result = await agent.run('Find me a used bike under 150 euro');

        expect(result.message).toBe('Done');
    });

    test('non-interactive clarification failures surface clearly instead of auto-continuing', async () => {
        const browser = createFakeBrowser();
        const io = createFakeIo();
        io.ask.mockRejectedValue(new Error('Interactive input required but no TTY is available: Continue?'));
        const planner = jest.fn().mockResolvedValue({
            type: 'clarify',
            question: 'Continue?'
        });

        const agent = new StandaloneBrowserAgent({ planner, browser, io });

        await expect(agent.run('Research this')).rejects.toThrow(
            'Interactive input required but no TTY is available: Continue?'
        );
    });
});
