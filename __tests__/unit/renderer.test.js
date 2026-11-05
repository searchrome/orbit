const fs = require('node:fs');
const path = require('node:path');

function loadRenderer() {
    const source = fs.readFileSync(path.join(__dirname, '../../renderer.js'), 'utf8');
    const transformed = source
        .replace("import WorkspacePanel from './workspace-panel.js';", "const WorkspacePanel = class { initialize() { this.ready = true; } autosave() { return Promise.resolve(); } updateSessionStatus() {} };")
        .replace("import TabManager from './tab-manager.js';", "const TabManager = require('__tab_manager__');")
        .replace("import Summarizer from './summarizer.js';", "const Summarizer = require('__summarizer__');")
        .replace("import HistoryManager from './history-manager.js'; // Import HistoryManager", "const HistoryManager = require('__history_manager__');")
        .replace("import AssistantController from './assistant-controller.js';", "const AssistantController = require('__assistant_controller__');")
        .replace("import BrowserActionCoordinator, { browserActionCancellationResult } from './browser-action-coordinator.js';", "const { BrowserActionCoordinator, browserActionCancellationResult } = require('__browser_action_coordinator__');")
        .replace("import BrowserToolDispatcher from './browser-tool-dispatcher.js';", "const BrowserToolDispatcher = require('__browser_tool_dispatcher__');")
        .replace("import TerminalPanel from './terminal-panel.js';", "const TerminalPanel = require('__terminal_panel__');")
        .replace("import ArtifactPanel from './artifact-panel.js';", "const ArtifactPanel = require('__artifact_panel__');")
        .replace("import SettingsPanel from './settings-panel.js';", "const SettingsPanel = require('__settings_panel__');")
        .replace("import BookmarksPanel from './bookmarks-panel.js';", "const BookmarksPanel = require('__bookmarks_panel__');")
        .replace("import TransformedViewManager from './transformed-view-manager.js';", "const TransformedViewManager = require('__transformed_view_manager__');")
        .replace("import SessionFilesPanel from './session-files-panel.js';", "const SessionFilesPanel = require('__session_files_panel__');")
        .replace("import CastPanel from './cast-panel.js';", "const CastPanel = require('__cast_panel__');");

    const state = {
        tabManager: null,
        summarizer: null,
        assistantController: null,
        browserToolDispatcher: null,
        terminalPanel: null,
        artifactPanel: null,
        settingsPanel: null,
        bookmarksPanel: null,
        transformedViewManager: null,
        sessionFilesPanel: null
    };

    class MockHistoryManager {
        constructor() {
            this.history = [];
            this.loadHistory = jest.fn().mockResolvedValue([]);
            this.getHistory = jest.fn().mockReturnValue([]);
            this.isBookmarked = jest.fn().mockReturnValue(false);
            this.addOrUpdateEntry = jest.fn().mockResolvedValue(undefined);
            this.updateBookmarkEnrichment = jest.fn().mockResolvedValue(true);
            this.markAsClosed = jest.fn().mockResolvedValue(undefined);
        }
    }

    class MockTabManager {
        constructor(container, historyManager) {
            state.tabManager = this;
            this.historyManager = historyManager;
            this.tabs = [];
            this.activeTabId = null;
            this.createTab = jest.fn((url = 'about:blank', options = {}) => {
                const id = `tab-${this.tabs.length + 1}`;
                const tab = {
                    id,
                    url,
                    title: options.title || 'Untitled',
                    role: options.role || 'regular',
                    webview: {
                        canGoBack: jest.fn().mockReturnValue(true),
                        goBack: jest.fn(),
                        getWebContentsId: jest.fn().mockReturnValue(1),
                        reload: jest.fn(),
                        send: jest.fn(),
                        style: {}
                    }
                };
                this.tabs.push(tab);
                this.activeTabId = id;
                return id;
            });
            this.switchToTab = jest.fn((tabId) => {
                this.activeTabId = tabId;
            });
            this.getActiveTab = jest.fn(() => this.tabs.find((tab) => tab.id === this.activeTabId) || null);
            this.getActiveWebview = jest.fn(() => {
                const activeTab = this.getActiveTab();
                return activeTab ? activeTab.webview : null;
            });
            this.getTabById = jest.fn((tabId) => this.tabs.find((tab) => tab.id === tabId) || null);
            this.replaceSession = jest.fn(snapshot => snapshot.tabs.forEach(tab => this.createTab(tab.url, {title: tab.title})));
            this.getSessionSnapshot = jest.fn(() => ({tabs: this.tabs, activeTabId: this.activeTabId}));
            this.updateTabTitle = jest.fn();
            this.updateTabFavicon = jest.fn();
            this.reloadTab = jest.fn();
        }
    }

    class MockSummarizer {
        constructor(webview, button) {
            state.summarizer = this;
            this.webview = webview;
            this.button = button;
            this.updateWebview = jest.fn();
            this.handleSummarizeClick = jest.fn();
        }
    }

    class MockAssistantController {
        constructor(tabManager) {
            state.assistantController = this;
            this.tabManager = tabManager;
            this.openWorkspace = jest.fn();
            this.setOpenCodeBrowserControlActive = jest.fn();
        }
    }

    class MockBrowserActionCoordinator {}

    class MockBrowserToolDispatcher {
        constructor(tabManager) {
            state.browserToolDispatcher = this;
            this.tabManager = tabManager;
            this.execute = jest.fn().mockResolvedValue({ ok: true, data: {} });
        }
    }

    class MockTerminalPanel {
        constructor(options = {}) {
            state.terminalPanel = this;
            this.show = jest.fn();
            this.setEnabled = jest.fn();
            this.onBrowserControlChange = options.onBrowserControlChange;
        }
    }

    class MockArtifactPanel {
        constructor() {
            state.artifactPanel = this;
            this.setEnabled = jest.fn();
            this.show = jest.fn();
        }
    }

    class MockSettingsPanel {
        constructor() {
            state.settingsPanel = this;
            this.setEnabled = jest.fn();
        }
    }

    class MockBookmarksPanel {
        constructor({ historyManager, tabManager }) {
            state.bookmarksPanel = this;
            this.historyManager = historyManager;
            this.tabManager = tabManager;
            this.refresh = jest.fn();
        }
    }

    class MockTransformedViewManager {
        constructor({ tabManager }) {
            state.transformedViewManager = this;
            this.tabManager = tabManager;
        }
    }

    class MockSessionFilesPanel {
        constructor() {
            state.sessionFilesPanel = this;
        }
    }

    class MockCastPanel {
        constructor(tabManager) {
            state.castPanel = this;
            this.tabManager = tabManager;
        }
    }

    const module = { exports: {} };
    const factory = new Function('module', 'exports', 'require', transformed);
    factory(module, module.exports, (specifier) => {
        if (specifier === '__tab_manager__') {
            return MockTabManager;
        }
        if (specifier === '__summarizer__') {
            return MockSummarizer;
        }
        if (specifier === '__history_manager__') {
            return MockHistoryManager;
        }
        if (specifier === '__assistant_controller__') {
            return MockAssistantController;
        }
        if (specifier === '__browser_action_coordinator__') {
            return {
                BrowserActionCoordinator: MockBrowserActionCoordinator,
                browserActionCancellationResult: jest.fn(() => ({ ok: false }))
            };
        }
        if (specifier === '__browser_tool_dispatcher__') {
            return MockBrowserToolDispatcher;
        }
        if (specifier === '__terminal_panel__') {
            return MockTerminalPanel;
        }
        if (specifier === '__artifact_panel__') {
            return MockArtifactPanel;
        }
        if (specifier === '__settings_panel__') {
            return MockSettingsPanel;
        }
        if (specifier === '__bookmarks_panel__') {
            return MockBookmarksPanel;
        }
        if (specifier === '__transformed_view_manager__') {
            return MockTransformedViewManager;
        }
        if (specifier === '__session_files_panel__') {
            return MockSessionFilesPanel;
        }
        if (specifier === '__cast_panel__') {
            return MockCastPanel;
        }
        return require(specifier);
    });

    return state;
}

describe('Renderer navigation controls', () => {
    let realCreateElement;
    let realGetElementById;
    let listeners;

    beforeEach(() => {
        document.body.innerHTML = `
            <div id="workspace-bar"></div><div id="controls"></div>
            <input id="url-input" />
            <button id="toggle-network-btn"><span class="toolbar-btn__state">On</span></button>
            <button id="toggle-js-btn"><span class="toolbar-btn__state">On</span></button>
            <button id="toggle-cache-btn"></button>
            <button id="toggle-blocklist-btn"></button>
            <button id="summarize-btn"></button>
            <button id="bookmark-btn"></button>
            <button id="bookmarks-btn"></button>
            <button id="cleanup-btn"></button>
            <button id="terminal-btn"></button>
            <div id="network-activity-bar"></div>
            <div id="network-activity-fill"></div>
            <section id="download-status-bar" hidden><button id="clear-downloads-btn"></button><div id="download-status-list"></div></section>
            <div id="content"></div>
            <div id="summary-panel"></div>
            <div id="summary-content"></div>
            <button id="close-summary-btn"></button>
            <div id="tab-bar"></div>
            <div id="error-message-overlay"></div>
        `;

        realCreateElement = Document.prototype.createElement.bind(document);
        realGetElementById = Document.prototype.getElementById.bind(document);
        document.createElement = realCreateElement;
        document.getElementById = realGetElementById;

        listeners = {};
        window.electronAPI = {
            send: jest.fn(),
            sendToHost: jest.fn(),
            on: jest.fn((channel, listener) => { listeners[channel] = listener; }),
            invoke: jest.fn().mockImplementation(channel => Promise.resolve(channel === 'get-startup-session'
                ? {workspace: {id: 'session-1'}, session: {tabs: [{url: 'about:blank', title: 'New Tab'}]}}
                : {javascriptDisabled: false, cacheEnabled: true, domainBlockingEnabled: true}))
        };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    test('does not throw when back button is missing and the tab switches', async () => {
        const state = loadRenderer();

        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(state.tabManager).not.toBeNull();
        expect(window.tabManager).toBe(state.tabManager);
        expect(state.artifactPanel.setEnabled).toHaveBeenCalledWith(true);
        expect(state.settingsPanel.setEnabled).toHaveBeenCalledWith(true);
        expect(state.bookmarksPanel.historyManager).toBeTruthy();

        state.tabManager.tabs = [
            {
                id: 'tab-1',
                url: 'https://example.com',
                role: 'regular',
                webview: {
                    canGoBack: jest.fn().mockReturnValue(true),
                    goBack: jest.fn(),
                    getWebContentsId: jest.fn().mockReturnValue(1),
                    reload: jest.fn(),
                    send: jest.fn(),
                    style: {}
                }
            }
        ];
        state.tabManager.activeTabId = 'tab-1';

        expect(() => {
            const event = document.createEvent('Event');
            event.initEvent('tab-switched', false, false);
            Object.defineProperty(event, 'detail', {
                value: {
                    tabId: 'tab-1',
                    tab: state.tabManager.tabs[0]
                },
                configurable: true,
                enumerable: true
            });
            window.dispatchEvent(event);
        }).not.toThrow();
    });

    test('network and JavaScript have independent controls and states', async () => {
        const state = loadRenderer();
        await new Promise(resolve => setTimeout(resolve, 0));
        state.tabManager.tabs = [{id: 'tab-1', webview: {getWebContentsId: () => 42}}];
        state.tabManager.activeTabId = 'tab-1';
        const network = document.getElementById('toggle-network-btn');
        const js = document.getElementById('toggle-js-btn');
        network.click();
        expect(window.electronAPI.send).toHaveBeenLastCalledWith('toggle-network', 42);
        js.click();
        expect(window.electronAPI.send).toHaveBeenLastCalledWith('toggle-js');
        listeners['network-status'](42, true);
        expect(network.getAttribute('aria-pressed')).toBe('true');
        expect(js.classList.contains('active')).toBe(false);
    });

    test('opens a safe guest popup link as a managed browser tab', async () => {
        const state = loadRenderer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        state.tabManager.createTab.mockClear();
        state.tabManager.tabs = [{
            id: 'tab-1',
            role: 'regular',
            webview: { getWebContentsId: jest.fn().mockReturnValue(91) }
        }];

        listeners['guest-open-link']({
            sourceWebContentsId: 91,
            url: 'https://example.com/news',
            activate: true
        });

        expect(state.tabManager.createTab).toHaveBeenCalledWith('https://example.com/news', {
            activate: true,
            title: 'Loading…'
        });
    });

    test('rejects non-web guest popup links', async () => {
        const state = loadRenderer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        state.tabManager.createTab.mockClear();
        state.tabManager.tabs = [{
            id: 'tab-1',
            role: 'regular',
            webview: { getWebContentsId: jest.fn().mockReturnValue(91) }
        }];

        listeners['guest-open-link']({ sourceWebContentsId: 91, url: 'javascript:alert(1)' });

        expect(state.tabManager.createTab).not.toHaveBeenCalled();
    });

    test('shows a completed summary and keeps its floating close control working', async () => {
        loadRenderer();
        await new Promise((resolve) => setTimeout(resolve, 0));

        await listeners['summary-result']('<p>Summary ready.</p>');
        const panel = document.getElementById('summary-panel');
        expect(panel.classList.contains('hidden')).toBe(false);
        expect(document.getElementById('summary-content').innerHTML).toContain('Summary ready.');

        document.getElementById('close-summary-btn').click();
        expect(panel.classList.contains('hidden')).toBe(true);
    });

    test('shows download progress and keeps completed downloads visible until cleared', async () => {
        loadRenderer();
        await new Promise((resolve) => setTimeout(resolve, 0));

        listeners['download-status']({
            id: 'download-1',
            filename: 'report.pdf',
            receivedBytes: 512,
            totalBytes: 1024,
            state: 'progressing'
        });

        const shelf = document.getElementById('download-status-bar');
        expect(shelf.hidden).toBe(false);
        expect(shelf.textContent).toContain('report.pdf');
        expect(shelf.textContent).toContain('Downloading · 50%');
        expect(shelf.querySelector('.download-status__progress-fill').style.width).toBe('50%');

        listeners['download-status']({
            id: 'download-1',
            filename: 'report.pdf',
            receivedBytes: 1024,
            totalBytes: 1024,
            state: 'completed'
        });

        expect(shelf.textContent).toContain('Downloaded · 1 KB');
        document.getElementById('clear-downloads-btn').click();
        expect(shelf.hidden).toBe(true);
    });

    test('saves the current page directly when the address-bar bookmark button is clicked', async () => {
        const state = loadRenderer();
        await new Promise((resolve) => setTimeout(resolve, 0));
        state.tabManager.tabs = [{
            id: 'tab-1',
            url: 'https://example.com/article',
            title: 'Article',
            role: 'regular',
            webview: { executeJavaScript: jest.fn().mockResolvedValue('Article text') }
        }];
        state.tabManager.activeTabId = 'tab-1';

        document.getElementById('bookmark-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(state.tabManager.historyManager.addOrUpdateEntry).toHaveBeenCalledWith(
            'https://example.com/article',
            'Article',
            'open',
            null,
            true
        );
        expect(document.getElementById('bookmark-btn').classList.contains('bookmarked')).toBe(true);
    });
});
