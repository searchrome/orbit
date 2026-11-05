const fs = require('node:fs');
const path = require('node:path');

function loadAssistantStore() {
    const source = fs.readFileSync(path.join(__dirname, '../../assistant-store.js'), 'utf8');
    const transformed = source.replace(/export default AssistantStore;\s*$/, 'module.exports = AssistantStore;');
    const module = { exports: {} };
    const factory = new Function('module', 'exports', 'require', transformed);
    factory(module, module.exports, require);
    return module.exports;
}

function loadAssistantRenderer() {
    const assistantStore = loadAssistantStore();
    const source = fs.readFileSync(path.join(__dirname, '../../assistant-renderer.js'), 'utf8');
    const transformed = source.replace(
        "import AssistantStore from './assistant-store.js';",
        "const AssistantStore = require('__assistant_store__');"
    );
    const module = { exports: {} };
    const factory = new Function('module', 'exports', 'require', transformed);
    factory(module, module.exports, (specifier) => {
        if (specifier === '__assistant_store__') {
            return assistantStore;
        }
        return require(specifier);
    });
    return module.exports;
}

describe('Assistant renderer workspace state', () => {
    beforeEach(() => {
        window.localStorage.clear();
        document.body.innerHTML = `
            <div id="assistant-app" class="assistant-shell">
                <header class="assistant-header">
                    <div class="assistant-header-copy">
                        <p class="eyebrow">Browser-integrated assistant</p>
                        <h1 id="assistant-session-title">New chat</h1>
                    </div>
                    <div class="assistant-header-meta">
                        <span id="assistant-status" class="status-pill" data-state="idle">Idle</span>
                        <button id="assistant-new-chat" class="ghost-button" type="button">New chat</button>
                    </div>
                </header>
                <section class="assistant-quick-actions" aria-label="Quick actions">
                    <div id="assistant-session-list" class="session-list"></div>
                    <div class="assistant-monitoring">
                        <div class="monitor-panel">
                            <div class="panel-label">Tabs touched</div>
                            <div id="assistant-tab-list" class="assistant-tab-list" aria-live="polite"></div>
                        </div>
                    </div>
                    <div class="quick-actions">
                        <button class="quick-action" type="button" data-prompt="Inspect tabs">Inspect tabs</button>
                    </div>
                </section>
                <main class="assistant-main">
                    <section class="assistant-thread-panel" aria-label="Conversation">
                        <div id="assistant-messages" class="assistant-messages"></div>
                    </section>
                    <aside class="assistant-log-panel" aria-label="Action log">
                        <div class="panel-label">Action log</div>
                        <div id="assistant-log-list" class="assistant-log-list"></div>
                    </aside>
                </main>
                <footer class="assistant-composer-bar">
                    <form id="assistant-composer-form" class="assistant-composer">
                        <textarea id="assistant-input" rows="3"></textarea>
                        <div class="composer-actions">
                            <button id="assistant-stop" class="ghost-button danger" type="button">Stop</button>
                            <button id="assistant-send" class="primary-button" type="submit">Send</button>
                        </div>
                    </form>
                </footer>
            </div>
        `;

        document.getElementById = Document.prototype.getElementById.bind(document);
        document.createElement = Document.prototype.createElement.bind(document);

        window.electronAPI = {
            sendToHost: jest.fn(),
            on: jest.fn()
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    function seedSessions(activeSessionId, sessions) {
        window.localStorage.setItem('browser-assistant:sessions', JSON.stringify({
            activeSessionId,
            sessions
        }));
    }

    test('shows waiting approval state and touched tabs', () => {
        seedSessions('session-1', [
            {
                id: 'session-1',
                title: 'Bike search',
                createdAt: 1,
                updatedAt: 1,
                messages: [],
                logs: [],
                status: 'waiting'
            }
        ]);

        loadAssistantRenderer();

        const progressHandler = window.electronAPI.on.mock.calls.find(([channel]) => channel === 'assistant-progress')[1];
        const responseHandler = window.electronAPI.on.mock.calls.find(([channel]) => channel === 'assistant-response')[1];

        progressHandler({
            message: 'Opened eBay results',
            meta: {
                touchedTabs: [
                    { id: 'tab-1', title: 'eBay', url: 'https://www.ebay.nl/' },
                    { id: 'tab-2', title: 'Used bike listing', url: 'https://www.ebay.nl/itm/123' }
                ]
            }
        });

        responseHandler({
            message: 'Approval required before entering sensitive information.',
            status: 'waiting',
            isFinal: true
        });

        expect(document.getElementById('assistant-status').textContent).toBe('Waiting for approval');
        expect(document.getElementById('assistant-status').dataset.state).toBe('waiting');
        expect(document.getElementById('assistant-send').disabled).toBe(true);
        expect(document.getElementById('assistant-stop').disabled).toBe(false);
        expect(document.querySelectorAll('#assistant-tab-list .assistant-tab-chip')).toHaveLength(2);
        expect(document.querySelector('#assistant-tab-list .assistant-tab-chip .tab-title').textContent).toBe('Used bike listing');
    });

    test('blocks session switching while a run is active', () => {
        seedSessions('session-1', [
            {
                id: 'session-1',
                title: 'Bike search',
                createdAt: 1,
                updatedAt: 1,
                messages: [],
                logs: [],
                status: 'idle'
            },
            {
                id: 'session-2',
                title: 'Older chat',
                createdAt: 2,
                updatedAt: 2,
                messages: [],
                logs: [],
                status: 'idle'
            }
        ]);

        loadAssistantRenderer();

        const startHandler = window.electronAPI.on.mock.calls.find(([channel]) => channel === 'assistant-task-started')[1];
        const progressHandler = window.electronAPI.on.mock.calls.find(([channel]) => channel === 'assistant-progress')[1];

        startHandler({
            sessionId: 'session-1',
            message: 'Assistant task started.'
        });

        progressHandler({
            sessionId: 'session-1',
            message: 'Opened eBay results',
            meta: {
                touchedTabs: [
                    { id: 'tab-1', title: 'eBay', url: 'https://www.ebay.nl/' }
                ]
            }
        });

        document.querySelectorAll('.assistant-session-chip')[1].click();

        expect(document.getElementById('assistant-status').textContent).toBe('Working');
        expect(document.getElementById('assistant-status').dataset.state).toBe('running');
        expect(document.getElementById('assistant-send').disabled).toBe(true);
        expect(document.getElementById('assistant-stop').disabled).toBe(false);
        expect(document.getElementById('assistant-session-title').textContent).toBe('Bike search');
        expect(document.querySelectorAll('#assistant-tab-list .assistant-tab-chip')).toHaveLength(1);
        expect(document.querySelector('#assistant-tab-list .assistant-tab-chip .tab-title').textContent).toBe('eBay');
        expect(document.getElementById('assistant-log-list').textContent).toContain('Stop the current task before switching sessions.');
    });

    test('blocks composer actions on a persisted waiting session', () => {
        seedSessions('session-1', [
            {
                id: 'session-1',
                title: 'Bike search',
                createdAt: 1,
                updatedAt: 1,
                messages: [],
                logs: [],
                status: 'waiting'
            }
        ]);

        loadAssistantRenderer();

        const input = document.getElementById('assistant-input');
        input.value = 'used bike';
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        document.querySelector('[data-prompt]').click();
        document.getElementById('assistant-new-chat').click();

        expect(window.electronAPI.sendToHost).not.toHaveBeenCalled();
        expect(document.getElementById('assistant-status').dataset.state).toBe('waiting');
        expect(document.getElementById('assistant-session-title').textContent).toBe('Bike search');
        expect(document.getElementById('assistant-log-list').textContent).toContain('The assistant is already working or waiting for approval. Stop the current task before sending another prompt.');
        expect(document.getElementById('assistant-log-list').textContent).toContain('Stop the current task before starting a new chat.');
    });

    test('allows replying to a persisted clarification without blocking the composer', () => {
        seedSessions('session-1', [
            {
                id: 'session-1',
                title: 'Bike search',
                createdAt: 1,
                updatedAt: 1,
                messages: [
                    {
                        role: 'assistant',
                        content: 'What budget should I use?',
                        meta: {
                            clarification: {
                                question: 'What budget should I use?',
                                originalPrompt: 'I need a used bike'
                            }
                        }
                    }
                ],
                logs: [],
                status: 'clarifying',
                pendingClarification: {
                    question: 'What budget should I use?',
                    originalPrompt: 'I need a used bike'
                }
            }
        ]);

        loadAssistantRenderer();

        expect(document.getElementById('assistant-status').textContent).toBe('Need your reply');
        expect(document.getElementById('assistant-status').dataset.state).toBe('clarifying');
        expect(document.getElementById('assistant-send').disabled).toBe(false);
        expect(document.getElementById('assistant-stop').disabled).toBe(true);
        expect(document.getElementById('assistant-input').placeholder).toBe('Reply with the missing detail to continue...');

        const input = document.getElementById('assistant-input');
        input.value = 'around 300 euro';
        document.getElementById('assistant-send').click();

        expect(window.electronAPI.sendToHost).toHaveBeenCalledWith(
            'assistant-user-message',
            expect.objectContaining({
                sessionId: 'session-1',
                prompt: 'around 300 euro',
                clarificationContext: expect.objectContaining({
                    question: 'What budget should I use?',
                    originalPrompt: 'I need a used bike'
                })
            })
        );
        expect(document.getElementById('assistant-status').dataset.state).toBe('running');
    });

    test('clarification state does not bleed into another session when switching away', () => {
        seedSessions('session-1', [
            {
                id: 'session-1',
                title: 'Bike search',
                createdAt: 1,
                updatedAt: 1,
                messages: [],
                logs: [],
                status: 'clarifying',
                pendingClarification: {
                    question: 'What budget should I use?',
                    originalPrompt: 'I need a used bike'
                }
            },
            {
                id: 'session-2',
                title: 'Older chat',
                createdAt: 2,
                updatedAt: 2,
                messages: [],
                logs: [],
                status: 'idle'
            }
        ]);

        loadAssistantRenderer();

        document.querySelectorAll('.assistant-session-chip')[1].click();

        expect(document.getElementById('assistant-session-title').textContent).toBe('Older chat');
        expect(document.getElementById('assistant-status').dataset.state).toBe('idle');
        expect(document.getElementById('assistant-send').disabled).toBe(false);
        expect(document.getElementById('assistant-stop').disabled).toBe(true);
    });

    test('starts a fresh session instead of surfacing a legacy Gemini failure', () => {
        seedSessions('session-legacy', [
            {
                id: 'session-legacy',
                title: 'Old failed chat',
                createdAt: 1,
                updatedAt: 1,
                messages: [
                    {
                        role: 'assistant',
                        content: "Assistant failed: Error invoking remote method 'assistant-next-action': Error: Failed to get assistant action from Gemini: [GoogleGenerativeAI Error]: API Key not found.",
                        meta: {}
                    }
                ],
                logs: [
                    {
                        message: "Assistant failed: Error invoking remote method 'assistant-next-action': Error: Failed to get assistant action from Gemini: [GoogleGenerativeAI Error]: API Key not found.",
                        level: 'error',
                        meta: {}
                    }
                ],
                status: 'failed'
            }
        ]);

        loadAssistantRenderer();

        const persisted = JSON.parse(window.localStorage.getItem('browser-assistant:sessions'));
        expect(persisted.sessions).toHaveLength(2);
        expect(persisted.activeSessionId).not.toBe('session-legacy');
        expect(document.getElementById('assistant-session-title').textContent).toBe('New chat');
        expect(document.getElementById('assistant-status').dataset.state).toBe('idle');
        expect(document.getElementById('assistant-send').disabled).toBe(false);
    });
});
