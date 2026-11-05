/**
 * Tests for scripts/cdp-agent.js
 *
 * Verifies:
 *  - env loading
 *  - LLM response parsing (tool_call, ask_user, final, malformed)
 *  - tool dispatch (list_targets, navigate, evaluate, read_page_text, search_page, wait)
 *  - system prompt construction
 *  - agent loop orchestration (LLM → tool → LLM → final)
 *  - error handling (bad JSON, unknown tool, CDP failure, LLM failure)
 *  - ask_user flow
 */

// Mock fetch before requiring module
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock ws
const mockWsSend = jest.fn();
const mockWsClose = jest.fn();
const mockWsOn = jest.fn();
jest.mock('ws', () => jest.fn().mockImplementation(() => ({
    send: mockWsSend,
    close: mockWsClose,
    on: mockWsOn,
})));

// Mock readline
jest.mock('readline', () => ({
    createInterface: jest.fn(() => ({
        question: jest.fn((q, cb) => cb('user answer')),
        close: jest.fn(),
    })),
}));

// Use fake timers for wait tests
jest.useFakeTimers();

const {
    CONFIG,
    TOOLS,
    parseAction,
    buildSystemPrompt,
    classifyIntent,
    callLLM,
    discoverTargets,
    createSession,
    runTurn,
    executeAgentLoop,
    closeAllConnections,
    createSessionLog,
    flushSessionLog,
    parseCliArgs,
    _connections,
} = require('../../scripts/cdp-agent');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockFetchTargets(targets = []) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => targets,
    });
}

function makeFakeTargets() {
    return [
        { id: 'tab-1', type: 'webview', title: 'Test Page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-1' },
        { id: 'tab-2', type: 'webview', title: 'AI Workspace', url: 'file:///assistant.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/tab-2' },
    ];
}

function mockLLMResponse(content) {
    mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
    });
}

function mockLLMFailure(status, text) {
    mockFetch.mockResolvedValueOnce({
        ok: false,
        status,
        text: async () => text,
    });
}

function mockCdpConnection(targetId, evaluateResult) {
    const conn = {
        send: jest.fn().mockResolvedValue(evaluateResult || { result: { value: 'test' } }),
        close: jest.fn(),
    };
    _connections.set(targetId, conn);
    return conn;
}

const savedApiKey = CONFIG.apiKey;

beforeEach(() => {
    jest.clearAllMocks();
    _connections.clear();
    CONFIG.apiKey = savedApiKey;
});

afterAll(() => {
    closeAllConnections();
    jest.useRealTimers();
});

// ---------------------------------------------------------------------------
// parseAction
// ---------------------------------------------------------------------------

describe('parseAction', () => {
    test('parses a tool_call action', () => {
        const raw = '{"type":"tool_call","message":"listing tabs","tool":"list_targets","arguments":{}}';
        const action = parseAction(raw);
        expect(action.type).toBe('tool_call');
        expect(action.tool).toBe('list_targets');
    });

    test('parses a final action', () => {
        const raw = '{"type":"final","message":"Here are the results."}';
        const action = parseAction(raw);
        expect(action.type).toBe('final');
        expect(action.message).toBe('Here are the results.');
    });

    test('parses an ask_user action', () => {
        const raw = '{"type":"ask_user","question":"What is your budget?"}';
        const action = parseAction(raw);
        expect(action.type).toBe('ask_user');
        expect(action.question).toBe('What is your budget?');
    });

    test('strips code fences around JSON', () => {
        const raw = '```json\n{"type":"final","message":"done"}\n```';
        const action = parseAction(raw);
        expect(action.type).toBe('final');
    });

    test('extracts JSON from surrounding text', () => {
        const raw = 'Here is my plan: {"type":"tool_call","tool":"wait","arguments":{"ms":1000}} I will wait.';
        const action = parseAction(raw);
        expect(action.tool).toBe('wait');
    });

    test('throws on no JSON', () => {
        expect(() => parseAction('I have no idea what to do')).toThrow(/No JSON/);
    });

    test('throws on invalid JSON', () => {
        expect(() => parseAction('{type: bad}')).toThrow();
    });
});

// ---------------------------------------------------------------------------
// buildSystemPrompt
// ---------------------------------------------------------------------------

describe('buildSystemPrompt', () => {
    test('includes target info', () => {
        const targets = [{ id: 'tab-1', title: 'eBay', url: 'https://ebay.nl' }];
        const prompt = buildSystemPrompt(targets);
        expect(prompt).toContain('tab-1');
        expect(prompt).toContain('eBay');
    });

    test('includes all tool names', () => {
        const prompt = buildSystemPrompt([]);
        expect(prompt).toContain('list_targets');
        expect(prompt).toContain('navigate');
        expect(prompt).toContain('evaluate');
        expect(prompt).toContain('read_page_text');
        expect(prompt).toContain('search_page');
        expect(prompt).toContain('wait');
    });

    test('includes all action types', () => {
        const prompt = buildSystemPrompt([]);
        expect(prompt).toContain('tool_call');
        expect(prompt).toContain('ask_user');
        expect(prompt).toContain('final');
    });

    test('lookup intent includes lookup guidance', () => {
        const prompt = buildSystemPrompt([], 'lookup');
        expect(prompt).toContain('LOOKUP');
        expect(prompt).toContain('One source is enough');
    });

    test('explore intent includes explore guidance', () => {
        const prompt = buildSystemPrompt([], 'explore');
        expect(prompt).toContain('EXPLORE');
        expect(prompt).toContain('AT LEAST 3');
    });

    test('auto intent includes conditional guidance', () => {
        const prompt = buildSystemPrompt([], 'auto');
        expect(prompt).toContain('Decide based on the request');
    });
});

// ---------------------------------------------------------------------------
// TOOLS.list_targets
// ---------------------------------------------------------------------------

describe('TOOLS.list_targets', () => {
    test('returns non-assistant webview targets', async () => {
        mockFetchTargets(makeFakeTargets());
        const result = await TOOLS.list_targets({ cdpPort: 9222 });
        expect(result.ok).toBe(true);
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].id).toBe('tab-1');
    });

    test('filters out assistant workspace', async () => {
        mockFetchTargets(makeFakeTargets());
        const result = await TOOLS.list_targets({ cdpPort: 9222 });
        const ids = result.targets.map(t => t.id);
        expect(ids).not.toContain('tab-2');
    });

    test('returns empty when no webviews', async () => {
        mockFetchTargets([{ id: 'p1', type: 'page', title: 'Shell', url: 'file:///index.html', webSocketDebuggerUrl: 'ws://x' }]);
        const result = await TOOLS.list_targets({ cdpPort: 9222 });
        expect(result.ok).toBe(true);
        expect(result.targets).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// TOOLS.evaluate
// ---------------------------------------------------------------------------

describe('TOOLS.evaluate', () => {
    test('returns evaluated value from a tab', async () => {
        mockFetchTargets(makeFakeTargets());
        mockCdpConnection('tab-1', { result: { value: 'Hello World' } });
        const result = await TOOLS.evaluate({ cdpPort: 9222, targetId: 'tab-1', expression: 'document.title' });
        expect(result.ok).toBe(true);
        expect(result.value).toBe('Hello World');
    });

    test('fails when target not found', async () => {
        mockFetchTargets(makeFakeTargets());
        const result = await TOOLS.evaluate({ cdpPort: 9222, targetId: 'nonexistent', expression: '1+1' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('not found');
    });

    test('handles JS exceptions', async () => {
        mockFetchTargets(makeFakeTargets());
        mockCdpConnection('tab-1', { exceptionDetails: { text: 'ReferenceError' } });
        const result = await TOOLS.evaluate({ cdpPort: 9222, targetId: 'tab-1', expression: 'badVar' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('ReferenceError');
    });

    test('truncates long string values to 12000 chars', async () => {
        mockFetchTargets(makeFakeTargets());
        const longStr = 'x'.repeat(20000);
        mockCdpConnection('tab-1', { result: { value: longStr } });
        const result = await TOOLS.evaluate({ cdpPort: 9222, targetId: 'tab-1', expression: '"x".repeat(20000)' });
        expect(result.ok).toBe(true);
        expect(result.value.length).toBe(12000);
    });

    test('returns non-string values as-is', async () => {
        mockFetchTargets(makeFakeTargets());
        mockCdpConnection('tab-1', { result: { value: 42 } });
        const result = await TOOLS.evaluate({ cdpPort: 9222, targetId: 'tab-1', expression: '21+21' });
        expect(result.ok).toBe(true);
        expect(result.value).toBe(42);
    });

    test('surfaces CDP connection errors', async () => {
        mockFetchTargets(makeFakeTargets());
        const conn = { send: jest.fn().mockRejectedValue(new Error('WebSocket closed')), close: jest.fn() };
        _connections.set('tab-1', conn);
        const result = await TOOLS.evaluate({ cdpPort: 9222, targetId: 'tab-1', expression: '1' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('WebSocket closed');
    });
});

// ---------------------------------------------------------------------------
// TOOLS.read_page_text
// ---------------------------------------------------------------------------

describe('TOOLS.read_page_text', () => {
    test('reads page text', async () => {
        mockFetchTargets(makeFakeTargets());
        mockCdpConnection('tab-1', { result: { value: 'Page content here' } });
        const result = await TOOLS.read_page_text({ cdpPort: 9222, targetId: 'tab-1' });
        expect(result.ok).toBe(true);
        expect(result.value).toBe('Page content here');
    });

    test('respects maxChars param', async () => {
        mockFetchTargets(makeFakeTargets());
        const conn = mockCdpConnection('tab-1', { result: { value: 'short' } });
        await TOOLS.read_page_text({ cdpPort: 9222, targetId: 'tab-1', maxChars: 500 });
        const expression = conn.send.mock.calls[0][1].expression;
        expect(expression).toContain('500');
    });
});

// ---------------------------------------------------------------------------
// TOOLS.navigate
// ---------------------------------------------------------------------------

describe('TOOLS.navigate', () => {
    test('navigates and returns title', async () => {
        jest.useRealTimers();
        mockFetchTargets(makeFakeTargets());
        const conn = {
            send: jest.fn()
                .mockResolvedValueOnce({ frameId: 'f1' })
                .mockResolvedValueOnce({ result: { value: 'New Page' } }),
            close: jest.fn(),
        };
        _connections.set('tab-1', conn);
        const result = await TOOLS.navigate({ cdpPort: 9222, targetId: 'tab-1', url: 'https://marktplaats.nl' });
        expect(result.ok).toBe(true);
        expect(result.title).toBe('New Page');
        expect(conn.send).toHaveBeenCalledWith('Page.navigate', { url: 'https://marktplaats.nl' });
        jest.useFakeTimers();
    }, 10000);

    test('fails when target missing', async () => {
        mockFetchTargets([]);
        const result = await TOOLS.navigate({ cdpPort: 9222, targetId: 'bad', url: 'https://x.com' });
        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// TOOLS.wait
// ---------------------------------------------------------------------------

describe('TOOLS.wait', () => {
    test('waits the requested duration', async () => {
        const promise = TOOLS.wait({ ms: 100 });
        jest.advanceTimersByTime(100);
        const result = await promise;
        expect(result.ok).toBe(true);
        expect(result.waited).toBe(100);
    });

    test('caps at 10 seconds', async () => {
        const promise = TOOLS.wait({ ms: 99999 });
        jest.advanceTimersByTime(10000);
        const result = await promise;
        expect(result.waited).toBe(10000);
    });

    test('defaults to 3000ms', async () => {
        const promise = TOOLS.wait({});
        jest.advanceTimersByTime(3000);
        const result = await promise;
        expect(result.waited).toBe(3000);
    });
});

// ---------------------------------------------------------------------------
// TOOLS.search_page
// ---------------------------------------------------------------------------

describe('TOOLS.search_page', () => {
    test('calls evaluate with search JS and returns ok', async () => {
        jest.useRealTimers();
        mockFetchTargets(makeFakeTargets());
        mockCdpConnection('tab-1', { result: { value: '{"ok":true,"query":"ps4"}' } });
        const result = await TOOLS.search_page({ cdpPort: 9222, targetId: 'tab-1', query: 'ps4' });
        expect(result.ok).toBe(true);
        expect(result.query).toBe('ps4');
        jest.useFakeTimers();
    }, 10000);

    test('fails when target not found', async () => {
        mockFetchTargets([]);
        const result = await TOOLS.search_page({ cdpPort: 9222, targetId: 'nope', query: 'test' });
        expect(result.ok).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// callLLM
// ---------------------------------------------------------------------------

describe('callLLM', () => {
    beforeEach(() => {
        CONFIG.apiKey = 'test-key-12345';
    });

    test('sends messages to OpenRouter and returns content', async () => {
        mockLLMResponse('{"type":"final","message":"done"}');
        const result = await callLLM([{ role: 'user', content: 'hello' }]);
        expect(result).toBe('{"type":"final","message":"done"}');
        const fetchCall = mockFetch.mock.calls[0];
        expect(fetchCall[0]).toContain('/chat/completions');
        const body = JSON.parse(fetchCall[1].body);
        expect(body.messages[0].content).toBe('hello');
    });

    test('retries on failure then throws', async () => {
        jest.useRealTimers();
        mockLLMFailure(500, 'server error');
        mockLLMFailure(500, 'server error');
        mockLLMFailure(500, 'server error');
        await expect(callLLM([{ role: 'user', content: 'hi' }])).rejects.toThrow(/500/);
        jest.useFakeTimers();
    }, 15000);

    test('includes auth headers', async () => {
        mockLLMResponse('{"type":"final","message":"ok"}');
        await callLLM([{ role: 'user', content: 'test' }]);
        const headers = mockFetch.mock.calls[0][1].headers;
        expect(headers['Authorization']).toBe('Bearer test-key-12345');
        expect(headers['Content-Type']).toBe('application/json');
    });

    test('throws when API key is not set', async () => {
        CONFIG.apiKey = '';
        await expect(callLLM([{ role: 'user', content: 'hi' }])).rejects.toThrow(/API_KEY/);
    });
});

// ---------------------------------------------------------------------------
// Agent loop integration (unit-level)
// ---------------------------------------------------------------------------

describe('agent loop flow', () => {
    beforeEach(() => {
        CONFIG.apiKey = 'test-key-12345';
    });

    test('tool_call → tool result → final produces output', async () => {
        // Step 1: discover targets
        mockFetchTargets(makeFakeTargets());
        const targets = await discoverTargets(9222);
        expect(targets).toHaveLength(1);

        // Step 2: LLM returns list_targets tool_call
        mockLLMResponse('{"type":"tool_call","message":"listing tabs","tool":"list_targets","arguments":{}}');
        const raw1 = await callLLM([{ role: 'user', content: 'find deals' }]);
        const action1 = parseAction(raw1);
        expect(action1.type).toBe('tool_call');
        expect(action1.tool).toBe('list_targets');

        // Step 3: execute tool
        mockFetchTargets(makeFakeTargets());
        const toolResult = await TOOLS[action1.tool]({ cdpPort: 9222, ...action1.arguments });
        expect(toolResult.ok).toBe(true);
        expect(toolResult.targets).toHaveLength(1);

        // Step 4: LLM returns final
        mockLLMResponse('{"type":"final","message":"Found 1 tab: Test Page at example.com"}');
        const raw2 = await callLLM([
            { role: 'user', content: 'find deals' },
            { role: 'assistant', content: raw1 },
            { role: 'user', content: `Tool result: ${JSON.stringify(toolResult)}` },
        ]);
        const action2 = parseAction(raw2);
        expect(action2.type).toBe('final');
        expect(action2.message).toContain('Found');
    });

    test('ask_user action is parsed correctly', () => {
        const action = parseAction('{"type":"ask_user","question":"What is your budget?"}');
        expect(action.type).toBe('ask_user');
        expect(action.question).toBe('What is your budget?');
    });

    test('unknown tool name detected', () => {
        const toolFn = TOOLS['nonexistent_tool'];
        expect(toolFn).toBeUndefined();
    });

    test('malformed LLM response throws for retry', () => {
        expect(() => parseAction('I think we should search eBay first.')).toThrow(/No JSON/);
    });

    test('multi-step: navigate → read_page_text → final', async () => {
        // LLM says navigate
        mockLLMResponse('{"type":"tool_call","tool":"navigate","arguments":{"targetId":"tab-1","url":"https://example.com"}}');
        const raw1 = await callLLM([{ role: 'user', content: 'go to example' }]);
        const a1 = parseAction(raw1);
        expect(a1.tool).toBe('navigate');

        // LLM says read_page_text
        mockLLMResponse('{"type":"tool_call","tool":"read_page_text","arguments":{"targetId":"tab-1"}}');
        const raw2 = await callLLM([{ role: 'user', content: 'read it' }]);
        const a2 = parseAction(raw2);
        expect(a2.tool).toBe('read_page_text');

        // LLM says final
        mockLLMResponse('{"type":"final","message":"The page says Hello World."}');
        const raw3 = await callLLM([{ role: 'user', content: 'done' }]);
        const a3 = parseAction(raw3);
        expect(a3.type).toBe('final');
    });
});

// ---------------------------------------------------------------------------
// TOOLS.open_tab
// ---------------------------------------------------------------------------

describe('TOOLS.open_tab', () => {
    test('requires a url', async () => {
        const result = await TOOLS.open_tab({ cdpPort: 9222 });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('url');
    });

    test('fails when main page not found', async () => {
        // Return only webviews, no page type
        mockFetchTargets([
            { id: 'w1', type: 'webview', title: 'Tab', url: 'https://a.com', webSocketDebuggerUrl: 'ws://x' },
        ]);
        const result = await TOOLS.open_tab({ cdpPort: 9222, url: 'https://example.com' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('main browser page');
    });
});

// ---------------------------------------------------------------------------
// Multi-turn session
// ---------------------------------------------------------------------------

describe('multi-turn session', () => {
    beforeEach(() => {
        CONFIG.apiKey = 'test-key-12345';
    });

    test('createSession builds conversation with system prompt', async () => {
        mockFetchTargets(makeFakeTargets());
        const session = await createSession();
        expect(session.conversation).toHaveLength(1);
        expect(session.conversation[0].role).toBe('system');
        expect(session.conversation[0].content).toContain('list_targets');
        expect(session.turnCount).toBe(0);
    });

    test('runTurn adds user message and runs agent loop', async () => {
        // createSession
        mockFetchTargets(makeFakeTargets());
        const session = await createSession();

        // "list my tabs" classifies as 'auto', no bouncing
        mockFetchTargets(makeFakeTargets()); // refresh at turn start
        mockLLMResponse('{"type":"final","message":"Found 1 tab."}');

        const result = await runTurn(session, 'list my tabs');
        expect(result).not.toBeNull();
        expect(result.type).toBe('final');
        expect(session.turnCount).toBe(1);
        // conversation should have: system + user + assistant(final)
        expect(session.conversation.length).toBeGreaterThanOrEqual(3);
        expect(session.conversation[1].role).toBe('user');
        expect(session.conversation[1].content).toBe('list my tabs');
    });

    test('second turn preserves conversation context', async () => {
        // createSession
        mockFetchTargets(makeFakeTargets());
        const session = await createSession();

        // Turn 1: 'find' triggers explore intent; first final gets bounced (0 sources < 3),
        // second final also bounced (still 0 sources), third final accepted (max bounces reached)
        mockFetchTargets(makeFakeTargets());
        mockLLMResponse('{"type":"final","message":"Here are your football options."}');
        mockLLMResponse('{"type":"final","message":"Here are your football options."}');
        mockLLMResponse('{"type":"final","message":"Here are your football options."}');
        await runTurn(session, 'find football for girls in Den Haag');
        expect(session.turnCount).toBe(1);
        const afterTurn1 = session.conversation.length;

        // Turn 2 (follow-up) — "prices" triggers explore; same bounce pattern
        mockFetchTargets(makeFakeTargets());
        mockLLMResponse('{"type":"final","message":"Prices range from 20 to 50 euro per month."}');
        mockLLMResponse('{"type":"final","message":"Prices range from 20 to 50 euro per month."}');
        mockLLMResponse('{"type":"final","message":"Prices range from 20 to 50 euro per month."}');
        const result2 = await runTurn(session, 'what are the prices and starting dates?');
        expect(session.turnCount).toBe(2);
        expect(result2.message).toContain('Prices');
        // conversation grew: previous context + new user + new assistant
        expect(session.conversation.length).toBeGreaterThan(afterTurn1);
        // The follow-up question should be in conversation
        const userMessages = session.conversation.filter(m => m.role === 'user');
        expect(userMessages.some(m => m.content.includes('prices'))).toBe(true);
    });

    test('turn with tool_call then final works within session', async () => {
        mockFetchTargets(makeFakeTargets());
        const session = await createSession();

        // Turn 1: LLM does a tool call then final
        mockFetchTargets(makeFakeTargets()); // refresh
        mockLLMResponse('{"type":"tool_call","tool":"list_targets","arguments":{}}');
        // list_targets internally calls fetch
        mockFetchTargets(makeFakeTargets());
        // After tool, LLM returns final — also refresh targets
        mockFetchTargets(makeFakeTargets());
        mockLLMResponse('{"type":"final","message":"Done with tool."}');

        const result = await runTurn(session, 'check tabs');
        expect(result.type).toBe('final');
        expect(session.turnCount).toBe(1);

        // Turn 2: follow-up
        mockFetchTargets(makeFakeTargets());
        mockLLMResponse('{"type":"final","message":"Follow-up answer."}');
        const result2 = await runTurn(session, 'now do something else');
        expect(result2.type).toBe('final');
        expect(session.turnCount).toBe(2);
    });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
    test('discoverTargets fetch failure propagates', async () => {
        mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await expect(discoverTargets(9222)).rejects.toThrow('ECONNREFUSED');
    });

    test('parseAction handles nested JSON in expression', () => {
        const raw = '{"type":"tool_call","tool":"evaluate","arguments":{"targetId":"t1","expression":"JSON.stringify({a:1})"}}';
        const action = parseAction(raw);
        expect(action.tool).toBe('evaluate');
        expect(action.arguments.expression).toContain('JSON.stringify');
    });

    test('parseAction with results array in final', () => {
        const raw = '{"type":"final","message":"found items","results":[{"title":"PS4","price":"€90","url":"https://x.com"}]}';
        const action = parseAction(raw);
        expect(action.type).toBe('final');
        expect(action.results).toHaveLength(1);
        expect(action.results[0].title).toBe('PS4');
    });

    test('list_targets handles mixed target types', async () => {
        mockFetchTargets([
            { id: 't1', type: 'webview', title: 'Tab', url: 'https://a.com', webSocketDebuggerUrl: 'ws://x' },
            { id: 't2', type: 'page', title: 'Shell', url: 'file:///index.html', webSocketDebuggerUrl: 'ws://y' },
            { id: 't3', type: 'iframe', title: 'Frame', url: 'https://b.com', webSocketDebuggerUrl: 'ws://z' },
            { id: 't4', type: 'service_worker', title: 'SW', url: 'https://c.com/sw.js', webSocketDebuggerUrl: 'ws://w' },
        ]);
        const result = await TOOLS.list_targets({ cdpPort: 9222 });
        expect(result.targets).toHaveLength(1);
        expect(result.targets[0].id).toBe('t1');
    });
});

// ---------------------------------------------------------------------------
// classifyIntent
// ---------------------------------------------------------------------------

describe('classifyIntent', () => {
    test('lookup: "what is the website of google"', () => {
        expect(classifyIntent('what is the website of google')).toBe('lookup');
    });

    test('lookup: "go to ebay.nl"', () => {
        expect(classifyIntent('go to ebay.nl')).toBe('lookup');
    });

    test('lookup: "what time is it in Tokyo"', () => {
        expect(classifyIntent('what time is it in Tokyo')).toBe('lookup');
    });

    test('explore: "find me a ps4 deal in NL"', () => {
        expect(classifyIntent('find me a ps4 deal in NL')).toBe('explore');
    });

    test('explore: "best football training for girls near Den Haag"', () => {
        expect(classifyIntent('best football training for girls near Den Haag')).toBe('explore');
    });

    test('explore: "cheapest used cars in Amsterdam"', () => {
        expect(classifyIntent('cheapest used cars in Amsterdam')).toBe('explore');
    });

    test('explore: "compare prices for iPhone 15"', () => {
        expect(classifyIntent('compare prices for iPhone 15')).toBe('explore');
    });

    test('auto: ambiguous prompt', () => {
        expect(classifyIntent('tell me about the weather in Amsterdam')).toBe('lookup');
    });

    test('auto: generic question without signals', () => {
        expect(classifyIntent('hello world')).toBe('auto');
    });

    test('explore wins over lookup when both match', () => {
        // "how to find the best deal" has both lookup ("how to") and explore ("find", "best", "deal")
        expect(classifyIntent('how to find the best deal')).toBe('explore');
    });
});

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe('parseCliArgs', () => {
    test('parses --model flag', () => {
        const flags = parseCliArgs(['node', 'script.js', '--model', 'gpt-4', 'hello world']);
        expect(flags.model).toBe('gpt-4');
        expect(flags.prompt).toBe('hello world');
    });

    test('parses --model=value format', () => {
        const flags = parseCliArgs(['node', 'script.js', '--model=x-ai/grok-4.3', 'search ps4']);
        expect(flags.model).toBe('x-ai/grok-4.3');
        expect(flags.prompt).toBe('search ps4');
    });

    test('parses --session flag', () => {
        const flags = parseCliArgs(['node', 'script.js', '--session', 'find deals']);
        expect(flags.session).toBe(true);
        expect(flags.prompt).toBe('find deals');
    });

    test('parses --output flag', () => {
        const flags = parseCliArgs(['node', 'script.js', '--output', '/tmp/logs', 'test query']);
        expect(flags.output).toBe('/tmp/logs');
        expect(flags.prompt).toBe('test query');
    });

    test('defaults when no flags', () => {
        const flags = parseCliArgs(['node', 'script.js', 'just a prompt']);
        expect(flags.model).toBeNull();
        expect(flags.session).toBe(false);
        expect(flags.output).toBeNull();
        expect(flags.prompt).toBe('just a prompt');
    });

    test('all flags combined', () => {
        const flags = parseCliArgs(['node', 'script.js', '--session', '--model', 'claude', '--output', './out', 'my query']);
        expect(flags.session).toBe(true);
        expect(flags.model).toBe('claude');
        expect(flags.output).toBe('./out');
        expect(flags.prompt).toBe('my query');
    });
});

// ---------------------------------------------------------------------------
// Session logging
// ---------------------------------------------------------------------------

describe('createSessionLog', () => {
    test('creates log structure with metrics', () => {
        const sl = createSessionLog('gpt-4', 'find ps4 deals', 'explore', '/tmp/logs');
        expect(sl.model).toBe('gpt-4');
        expect(sl.initialPrompt).toBe('find ps4 deals');
        expect(sl.intent).toBe('explore');
        expect(sl.metrics.toolCalls).toBe(0);
        expect(sl.metrics.searchesSubmitted).toBe(0);
        expect(sl.metrics.questionsAskedToUser).toBe(0);
        expect(sl.metrics.pagesRead).toBe(0);
        expect(sl.dir).toBe('/tmp/logs');
        expect(sl.file).toContain('session_gpt-4_');
    });

    test('sanitizes model name in filename', () => {
        const sl = createSessionLog('x-ai/grok-4.3', 'test', 'auto');
        expect(sl.file).toContain('x-ai_grok-4.3');
        expect(sl.file).not.toContain('/grok');
    });
});
