const fs = require('node:fs');
const path = require('node:path');

function loadTabManager() {
  const source = fs.readFileSync(path.join(__dirname, '../../tab-manager.js'), 'utf8');
  const transformed = source
    .replace("import HistoryManager from './history-manager.js';", "const HistoryManager = require('__history_manager__');")
    .replace(/export default TabManager;\s*$/, 'module.exports = TabManager;');
  const module = { exports: {} };
  const factory = new Function('module', 'exports', 'require', transformed);
  factory(module, module.exports, (specifier) => {
    if (specifier === '__history_manager__') {
      return class HistoryManager {
        constructor() {
          this.addOrUpdateEntry = jest.fn();
          this.markAsClosed = jest.fn();
          this.getHistory = jest.fn().mockReturnValue([]);
          this.isBookmarked = jest.fn().mockReturnValue(false);
        }
      };
    }
    return require(specifier);
  });
  return module.exports;
}

// Unit tests for TabManager

describe('TabManager', () => {
  let TabManager;
  let tabManager;
  let mockContentContainer;
  let realCreateElement;
  let realGetElementById;

  // Set up the DOM environment before each test
  beforeEach(() => {
    realCreateElement = Document.prototype.createElement.bind(document);
    realGetElementById = Document.prototype.getElementById.bind(document);
    document.createElement = realCreateElement;
    document.getElementById = realGetElementById;

    // Reset the document body
    document.body.innerHTML = `
      <div id="tab-bar">
        <button id="new-tab-btn">+</button>
      </div>
      <div id="content"></div>
      <input type="text" id="url-input" />
    `;

    // Mock the content container
    mockContentContainer = document.getElementById('content');
    
    TabManager = loadTabManager();
    
    // Create a new TabManager instance
    tabManager = new TabManager(mockContentContainer);
    
    // Mock window.electronAPI
    window.electronAPI = {
      send: jest.fn(),
      on: jest.fn(),
      invoke: jest.fn().mockResolvedValue({
        javascriptDisabled: false,
        cacheEnabled: true,
        domainBlockingEnabled: true
      })
    };
  });

    // Clean up after each test
  afterEach(() => {
    document.createElement = jest.fn().mockImplementation((tag) => {
      if (tag === 'webview') {
        return {
          id: '',
          className: '',
          setAttribute: jest.fn(),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          executeJavaScript: jest.fn().mockResolvedValue(''),
          loadURL: jest.fn(),
          send: jest.fn(),
          reload: jest.fn(),
          goBack: jest.fn(),
          canGoBack: jest.fn().mockReturnValue(false),
          isLoading: jest.fn().mockReturnValue(false),
          getWebContentsId: jest.fn().mockReturnValue(1),
          style: {},
          remove: jest.fn()
        };
      }
      return {
        id: '',
        className: '',
        innerHTML: '',
        appendChild: jest.fn(),
        addEventListener: jest.fn(),
        setAttribute: jest.fn(),
        style: {},
        remove: jest.fn()
      };
    });
    document.getElementById = jest.fn().mockImplementation((id) => {
      if (id === 'tab-bar' || id === 'content' || id === 'new-tab-btn' || id === 'test-webview' || id === 'summarize-btn' || id === 'toggle-network-btn' || id === 'search-results-panel' || id === 'search-panel-close-btn' || id === 'url-input' || id === 'assistant-btn') {
        return {
          appendChild: jest.fn(),
          insertBefore: jest.fn(),
          querySelector: jest.fn(),
          querySelectorAll: jest.fn().mockReturnValue([]),
          addEventListener: jest.fn(),
          removeEventListener: jest.fn(),
          classList: {
            add: jest.fn(),
            remove: jest.fn(),
            contains: jest.fn()
          },
          style: {}
        };
      }
      return null;
    });
    jest.clearAllMocks();
  });

  test('should create a new tab with default URL', () => {
    // Act
    const tabId = tabManager.createTab();
    
    // Assert
    expect(tabId).toBeDefined();
    expect(tabManager.tabs.length).toBe(1);
    expect(tabManager.activeTabId).toBe(tabId);
    expect(tabManager.tabs[0].url).toBe('about:blank');
    
    // Check if the tab element was added to the DOM
    const tabElement = document.querySelector('.tab');
    expect(tabElement).not.toBeNull();
    
    // Check if the webview was created
    const webview = document.querySelector('.tab-webview');
    expect(webview).not.toBeNull();
    expect(webview.getAttribute('src')).toBe('about:blank');
    
    // Verify that the network state was set to ON for the new tab
    webview.getWebContentsId = jest.fn().mockReturnValue(1);
    webview.dispatchEvent(new Event('dom-ready'));
    expect(window.electronAPI.send).toHaveBeenCalledWith('set-network-status-for-tab', expect.any(Number), false);
  });

  test('should create a new tab with specified URL', () => {
    // Act
    const url = 'https://example.com';
    const tabId = tabManager.createTab(url);
    
    // Assert
    expect(tabId).toBeDefined();
    expect(tabManager.tabs.length).toBe(1);
    expect(tabManager.activeTabId).toBe(tabId);
    expect(tabManager.tabs[0].url).toBe(url);
    
    // Check if the webview was created with the correct URL
    const webview = document.querySelector('.tab-webview');
    expect(webview).not.toBeNull();
    expect(webview.getAttribute('src')).toBe(url);
  });

  test('uses an absolute guest preload URL for normal web pages', () => {
    tabManager.createTab('https://example.com');

    const webview = document.querySelector('.tab-webview');
    expect(webview.getAttribute('preload')).toBe(new URL('./guest-preload.js', window.location.href).href);
    expect(webview.hasAttribute('allowpopups')).toBe(true);
  });

  test('does not expose the Electron preload bridge to local artifact pages', () => {
    tabManager.createTab('http://127.0.0.1:45678/artifact/123e4567-e89b-12d3-a456-426614174000/capability_token/view');

    const webview = document.querySelector('.tab-webview');
    expect(webview.getAttribute('nodeintegration')).toBe('false');
    expect(webview.getAttribute('preload')).toBeNull();
  });

  test('only bundled reading and recovery pages receive their narrow preload', () => {
    const local = `file://${new URL('./transformed-view.html', window.location.href).pathname}?viewId=example`;
    const view = tabManager._createTabWebview('reader', null, local);
    expect(view.getAttribute('preload')).toContain('transformed-preload.js');
    const remote = tabManager._createTabWebview('remote', null, 'https://attacker.example/transformed-view.html');
    expect(remote.getAttribute('preload')).toContain('guest-preload.js');
    const recovery = tabManager._createTabWebview('crashed', null, `file://${new URL('./tab-crashed.html', window.location.href).pathname}`);
    expect(recovery.getAttribute('preload')).toContain('tab-crashed-preload.js');
  });

  test('should create hidden tabs without showing them in the tab bar', () => {
    const tabId = tabManager.createTab('https://example.com/agent', {
      activate: false,
      hidden: true,
      assistantOwned: true,
      partition: 'persist:assistant-agent',
      trackHistory: false
    });

    expect(tabId).toBeDefined();
    expect(tabManager.tabs).toHaveLength(1);
    expect(tabManager.tabs[0].hidden).toBe(true);
    expect(tabManager.tabs[0].partition).toBe('persist:assistant-agent');
    expect(document.querySelectorAll('.tab')).toHaveLength(0);

    const webview = document.querySelector('.tab-webview');
    expect(webview).not.toBeNull();
    expect(webview.getAttribute('partition')).toBe('persist:assistant-agent');
  });

  test('does not mark deferred background tabs as loading in crash recovery', () => {
    const tabId = tabManager.createTab('https://example.com/background', { deferLoad: true, activate: false });

    expect(tabManager.getTabById(tabId).loadState).toBe('idle');
    expect(tabManager.getSessionSnapshot().tabs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: tabId, loadState: 'idle' })
    ]));
  });

  test('should switch between tabs', () => {
    // Arrange
    const firstTabId = tabManager.createTab('https://example.com');
    const secondTabId = tabManager.createTab('https://example.org');
    
    // Act - Switch back to the first tab
    tabManager.switchToTab(firstTabId);
    
    // Assert
    expect(tabManager.activeTabId).toBe(firstTabId);
    
    // Check if the correct tab is visible
    const tabs = document.querySelectorAll('.tab');
    expect(tabs[0].classList.contains('active')).toBe(true);
    expect(tabs[1].classList.contains('active')).toBe(false);
    
    // Check if the correct webview is visible
    const webviews = document.querySelectorAll('.tab-webview');
    expect(webviews[0].style.display).toBe('flex');
    expect(webviews[1].style.display).toBe('none');
    
    // Check if the URL input was updated
    const urlInput = document.getElementById('url-input');
    expect(urlInput.value).toBe('https://example.com');
  });

  test('reorders tabs and writes the displayed order into the session snapshot', () => {
    const firstTabId = tabManager.createTab('https://example.com');
    const secondTabId = tabManager.createTab('https://example.org');
    const thirdTabId = tabManager.createTab('https://example.net');

    expect(tabManager.reorderTab(thirdTabId, firstTabId)).toBe(true);
    expect(tabManager.tabs.map((tab) => tab.id)).toEqual([thirdTabId, firstTabId, secondTabId]);
    expect([...document.querySelectorAll('.tab')].map((tab) => tab.id)).toEqual([
      `tab-element-${thirdTabId}`,
      `tab-element-${firstTabId}`,
      `tab-element-${secondTabId}`
    ]);
    expect(tabManager.getSessionSnapshot().tabs.map((tab) => tab.url)).toEqual([
      'https://example.net',
      'https://example.com',
      'https://example.org'
    ]);

    expect(tabManager.reorderTab(firstTabId, firstTabId)).toBe(false);
    expect(tabManager.reorderTab('missing-tab', firstTabId)).toBe(false);
  });

  test('should close a tab', () => {
    // Arrange
    const firstTabId = tabManager.createTab('https://example.com');
    const secondTabId = tabManager.createTab('https://example.org');
    
    // Act - Close the second tab
    tabManager.closeTab(secondTabId);
    
    // Assert
    expect(tabManager.tabs.length).toBe(1);
    expect(tabManager.activeTabId).toBe(firstTabId);
    
    // Check if only one tab element remains
    const tabs = document.querySelectorAll('.tab');
    expect(tabs.length).toBe(1);
    
    // Check if only one webview remains
    const webviews = document.querySelectorAll('.tab-webview');
    expect(webviews.length).toBe(1);
  });

  test('should close tabs to the right of the selected tab', () => {
    const firstTabId = tabManager.createTab('https://example.com');
    const secondTabId = tabManager.createTab('https://example.org');
    const thirdTabId = tabManager.createTab('https://example.net');

    tabManager.closeTabsToRight(firstTabId);

    expect(tabManager.tabs.map((tab) => tab.id)).toEqual([firstTabId]);
    expect(tabManager.getTabById(secondTabId)).toBeUndefined();
    expect(tabManager.getTabById(thirdTabId)).toBeUndefined();
  });

  test('should create a new tab when closing the last tab', () => {
    // Arrange
    const tabId = tabManager.createTab('https://example.com');
    
    // Act - Close the only tab
    tabManager.closeTab(tabId);
    
    // Assert
    expect(tabManager.tabs.length).toBe(1); // A new tab should be created
    expect(tabManager.activeTabId).not.toBe(tabId); // The active tab should be the new tab
    
    // Check if a new tab element was created
    const tabs = document.querySelectorAll('.tab');
    expect(tabs.length).toBe(1);
    
    // Check if a new webview was created
    const webviews = document.querySelectorAll('.tab-webview');
    expect(webviews.length).toBe(1);
  });

  test('should update tab title', () => {
    // Arrange
    const tabId = tabManager.createTab('https://example.com');
    const newTitle = 'Example Website';
    
    // Act
    tabManager.updateTabTitle(tabId, newTitle);
    
    // Assert
    expect(tabManager.tabs[0].title).toBe(newTitle);
    
    // Check if the title element was updated
    const titleElement = document.querySelector('.tab-title');
    expect(titleElement.textContent).toBe(newTitle);
  });

  test('should update tab favicon', () => {
    // Arrange
    const tabId = tabManager.createTab('https://example.com');
    const faviconUrl = 'https://example.com/favicon.ico';
    
    // Act
    tabManager.updateTabFavicon(tabId, faviconUrl);
    
    // Assert
    expect(tabManager.tabs[0].favicon).toBe(faviconUrl);
    
    // Check if the favicon element was updated
    const faviconElement = document.querySelector('.tab-favicon');
    expect(faviconElement.src).toBe(faviconUrl);
  });

  test('should get the active tab', () => {
    // Arrange
    const firstTabId = tabManager.createTab('https://example.com');
    tabManager.createTab('https://example.org');
    
    // Switch to the first tab
    tabManager.switchToTab(firstTabId);
    
    // Act
    const activeTab = tabManager.getActiveTab();
    
    // Assert
    expect(activeTab).not.toBeNull();
    expect(activeTab.id).toBe(firstTabId);
    expect(activeTab.url).toBe('https://example.com');
  });

  test('should get a tab by ID', () => {
    // Arrange
    const firstTabId = tabManager.createTab('https://example.com');
    const secondTabId = tabManager.createTab('https://example.org');
    
    // Act
    const tab = tabManager.getTabById(secondTabId);
    
    // Assert
    expect(tab).not.toBeNull();
    expect(tab.id).toBe(secondTabId);
    expect(tab.url).toBe('https://example.org');
  });

  test('should get the active webview', () => {
    // Arrange
    tabManager.createTab('https://example.com');
    
    // Act
    const webview = tabManager.getActiveWebview();
    
    // Assert
    expect(webview).not.toBeNull();
    expect(webview.getAttribute('src')).toBe('https://example.com');
  });

  test('should update back button state', () => {
    // Arrange
    tabManager.createTab('https://example.com');
    const backBtn = document.createElement('button');
    backBtn.id = 'back-btn';
    document.body.appendChild(backBtn);
    
    // Mock the canGoBack method
    const activeWebview = tabManager.getActiveWebview();
    activeWebview.canGoBack = jest.fn().mockReturnValue(true);
    
    // Act
    tabManager.updateBackButtonState();
    
    // Assert
    expect(backBtn.disabled).toBe(false);
    
    // Change the mock to return false
    activeWebview.canGoBack = jest.fn().mockReturnValue(false);
    
    // Act again
    tabManager.updateBackButtonState();
    
    // Assert again
    expect(backBtn.disabled).toBe(true);
  });

  test('should disable the back button when the tab is not ready yet', () => {
    tabManager.createTab('https://example.com');
    const backBtn = document.createElement('button');
    backBtn.id = 'back-btn';
    document.body.appendChild(backBtn);

    const activeWebview = tabManager.getActiveWebview();
    activeWebview.canGoBack = jest.fn(() => {
      throw new Error('WebView must be attached to the DOM and dom-ready must fire first');
    });

    expect(() => tabManager.updateBackButtonState()).not.toThrow();
    expect(backBtn.disabled).toBe(true);
  });

  test('keeps an interrupted loading tab paused until the user explicitly reloads it', () => {
    tabManager._getCrashedTabPageUrl = () => `file://${new URL('./tab-crashed.html', window.location.href).pathname}`;
    const errorOverlay = document.createElement('div');
    errorOverlay.id = 'error-message-overlay';
    document.body.appendChild(errorOverlay);
    const tabId = tabManager.createTab('https://example.com/report', {
      recoveryPaused: true,
      title: 'Report'
    });
    const tab = tabManager.getTabById(tabId);

    expect(tab.crashed).toBe(true);
    expect(tab.recoveryUrl).toBe('https://example.com/report');
    expect(tab.loadState).toBe('crashed');
    expect(tab.webview.getAttribute('src')).toContain('tab-crashed.html');
    expect(tab.webview.getAttribute('preload')).toContain('tab-crashed-preload.js');
    expect(document.getElementById('error-message-overlay').textContent).toBe('');

    tab.webview.loadURL = jest.fn();
    expect(tabManager.recoverTab(tabId)).toBe(true);
    expect(tab.webview.loadURL).toHaveBeenCalledWith('https://example.com/report');
  });

  test('contains a page-renderer failure to its tab and records it for recovery', () => {
    const errorOverlay = document.createElement('div');
    errorOverlay.id = 'error-message-overlay';
    document.body.appendChild(errorOverlay);
    const firstTabId = tabManager.createTab('https://example.com/healthy');
    const crashedTabId = tabManager.createTab('https://example.com/crashed');
    const crashedTab = tabManager.getTabById(crashedTabId);
    crashedTab.webview.getWebContentsId = jest.fn().mockReturnValue(42);

    expect(tabManager.markTabRendererGone(crashedTabId, { reason: 'crashed' })).toBe(true);

    expect(tabManager.getTabById(firstTabId).crashed).toBeFalsy();
    expect(crashedTab.crashed).toBe(true);
    expect(crashedTab.loadState).toBe('crashed');
    expect(tabManager.getSessionSnapshot()).toEqual(expect.objectContaining({
      activeTabId: crashedTabId,
      tabs: expect.arrayContaining([
        expect.objectContaining({ url: 'https://example.com/crashed', crashed: true, loadState: 'crashed' })
      ])
    }));
    expect(document.getElementById('error-message-overlay').textContent).toContain('Reload tab');
  });
  test('brings tabs into a named group and saves the membership and order', () => {
    const first = tabManager.createTab('https://example.com/a');
    const middle = tabManager.createTab('https://example.com/b');
    const last = tabManager.createTab('https://example.com/c');
    tabManager.setTabGroup(first, 'Research');
    tabManager.setTabGroup(last, 'Research');
    expect(tabManager.getSessionSnapshot().tabs.map(tab => [tab.id, tab.group])).toEqual([
      [first, 'Research'], [last, 'Research'], [middle, '']
    ]);
    tabManager.setTabGroup(last, '');
    expect(tabManager.getTabById(last).element.querySelector('.tab-group-badge').hidden).toBe(true);
  });

  test('accepts a dropped tab on a collapsed group and reveals it under the heading', () => {
    const grouped = tabManager.createTab('https://example.com/a');
    const incoming = tabManager.createTab('https://example.com/b');
    tabManager.setTabGroup(grouped, 'Research');
    tabManager.toggleTabGroup('Research');
    expect(tabManager.getTabById(grouped).element.hidden).toBe(true);
    tabManager.draggedTabId = incoming;
    document.querySelector('.tab-group-header').dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    expect(tabManager.getTabById(incoming).group).toBe('Research');
    expect(tabManager.getTabById(grouped).element.hidden).toBe(false);
    expect(tabManager.getTabById(incoming).element.hidden).toBe(false);
    expect(tabManager.getSessionSnapshot().tabs.map(tab => tab.id)).toEqual([grouped, incoming]);
  });

  test('adds a tab to an existing group by clicking its name in the context menu', () => {
    const grouped = tabManager.createTab('https://example.com/a');
    const incoming = tabManager.createTab('https://example.com/b');
    tabManager.setTabGroup(grouped, 'Research');
    tabManager.showTabContextMenu(incoming, {preventDefault() {}, stopPropagation() {}, clientX: 5, clientY: 5});
    const choice = document.querySelector('[data-action="existing-group"]');
    expect(choice.textContent).toBe('Research');
    choice.click();
    expect(tabManager.getTabById(incoming).group).toBe('Research');
  });

  test('filters open tabs by title or URL without changing the active page or saved session', () => {
    const titleMatch = tabManager.createTab('https://example.com/one', {title: 'Project RESEARCH'});
    const addressMatch = tabManager.createTab('https://research.example.org/notes', {title: 'Notes'});
    const other = tabManager.createTab('https://example.net/two', {title: 'Other page'});
    const before = tabManager.getSessionSnapshot();
    tabManager.setTabSearchQuery('  RESEARCH  ');
    expect(tabManager.getTabById(titleMatch).element.hidden).toBe(false);
    expect(tabManager.getTabById(addressMatch).element.hidden).toBe(false);
    expect(tabManager.getTabById(other).element.hidden).toBe(true);
    expect(tabManager.activeTabId).toBe(other);
    expect(tabManager.getSessionSnapshot()).toEqual(before);
  });
  test('temporarily reveals matching tabs inside collapsed groups and restores collapse when cleared', () => {
    const match = tabManager.createTab('https://example.com/research', {title: 'Research'});
    const other = tabManager.createTab('https://example.com/work', {title: 'Work'});
    tabManager.setTabGroup(match, 'Reading');
    tabManager.setTabGroup(other, 'Other group');
    tabManager.toggleTabGroup('Reading');
    tabManager.setTabSearchQuery('research');
    expect(tabManager.getTabById(match).element.hidden).toBe(false);
    expect([...document.querySelectorAll('.tab-group-header')].map(header => header.dataset.group)).toEqual(['Reading']);
    expect(tabManager.getSessionSnapshot().collapsedGroups).toContain('Reading');
    tabManager.setTabSearchQuery('');
    expect(tabManager.getTabById(match).element.hidden).toBe(true);
    expect(tabManager.getTabById(other).element.hidden).toBe(false);
  });
  test('shows an empty result without closing tabs and keeps the new-tab button available', () => {
    tabManager.createTab('https://example.com', {title: 'Example'});
    tabManager.setTabSearchQuery('no match for this');
    expect(document.getElementById('tab-search-empty').textContent).toBe('No matching tabs');
    expect(document.getElementById('new-tab-btn').hidden).toBe(false);
    expect(tabManager.getSessionSnapshot().tabs).toHaveLength(1);
    tabManager.setTabSearchQuery('');
    expect(document.getElementById('tab-search-empty')).toBeNull();
  });
  test('refreshes filtered results when page titles and addresses change', () => {
    const id = tabManager.createTab('https://example.com', {title: 'Original'});
    const tab = tabManager.getTabById(id);
    tabManager.setTabSearchQuery('new title');
    expect(tab.element.hidden).toBe(true);
    tabManager.updateTabTitle(id, 'My new title');
    expect(tab.element.hidden).toBe(false);
    tabManager.setTabSearchQuery('example.net');
    expect(tab.element.hidden).toBe(true);
    const navigation = new Event('did-navigate');
    navigation.url = 'https://example.net/updated';
    tab.webview.dispatchEvent(navigation);
    expect(tab.element.hidden).toBe(false);
  });
  test('matches human-readable encoded addresses', () => {
    const id = tabManager.createTab('https://example.com/project%20notes', {title: 'Page'});
    tabManager.setTabSearchQuery('project notes');
    expect(tabManager.getTabById(id).element.hidden).toBe(false);
  });

  test('combines title and website terms across unloaded tabs without resuming them', () => {
    const match = tabManager.createTab('https://github.com/searchrome/orbit', {title: 'Orbit release notes'});
    const other = tabManager.createTab('https://example.com/notes', {title: 'Orbit release notes'});
    tabManager.setTabGroup(match, 'Saved');
    tabManager.setTabGroup(other, 'Saved');
    tabManager.toggleTabGroup('Saved');
    tabManager.setTabSearchQuery('  GITHUB.COM   release  ');
    expect(tabManager.getTabById(match).element.hidden).toBe(false);
    expect(tabManager.getTabById(other).element.hidden).toBe(true);
    expect(tabManager.getTabById(match).webview).toBeNull();
    expect(tabManager.getTabById(other).webview).toBeNull();
  });

  test('replaces the workspace without merging old tabs or exposing partially restored snapshots', () => {
    tabManager.createTab('https://old.example.com', {title: 'Old'});
    const states = [];
    const onChange = event => states.push(event.detail);
    window.addEventListener('tab-session-changed', onChange);
    try {
      tabManager.replaceSession({tabs: [
        {id: 'one', title: 'First', url: 'https://new.example.com/one', group: 'Work'},
        {id: 'two', title: 'Second', url: 'https://new.example.com/two', group: 'Later'}
      ], activeTabId: 'one', collapsedGroups: ['Later']});
      expect(tabManager.tabs.map(tab => tab.url)).toEqual(['https://new.example.com/one', 'https://new.example.com/two']);
      expect(tabManager.getActiveTab().title).toBe('First');
      expect(tabManager.tabs[1].webview).toBeNull();
      expect(states).toHaveLength(1);
      expect(states[0].tabs).toHaveLength(2);
      expect(states[0].collapsedGroups).toEqual(['Later']);
    } finally { window.removeEventListener('tab-session-changed', onChange); }
  });

  test('restores the saved active tab by ID when multiple tabs have the same address and pauses interrupted pages', () => {
    tabManager.replaceSession({tabs: [
      {id: 'one', title: 'First', url: 'https://example.com'},
      {id: 'two', title: 'Second', url: 'https://example.com'}
    ], activeTabId: 'two'}, {interrupted: true});
    expect(tabManager.getActiveTab().title).toBe('Second');
    expect(tabManager.getActiveTab().crashed).toBe(true);
    const placeholderTitle = new Event('page-title-updated');
    placeholderTitle.title = 'Page paused after crash';
    tabManager.getActiveTab().webview.dispatchEvent(placeholderTitle);
    expect(tabManager.getActiveTab().title).toBe('Second');
    expect(tabManager.tabs[0].webview.isConnected).toBe(false);
  });

  test('collapsing a group removes its live page views while preserving tab metadata', () => {
    const a = tabManager.createTab('https://example.com/a', {title: 'Alpha'});
    const b = tabManager.createTab('https://example.com/b', {title: 'Beta'});
    const outside = tabManager.createTab('https://example.com/outside');
    tabManager.setTabGroup(a, 'Research'); tabManager.setTabGroup(b, 'Research');
    const before = tabManager.getSessionSnapshot();
    const oldView = tabManager.getTabById(a).webview;
    tabManager.toggleTabGroup('Research');
    expect(oldView.isConnected).toBe(false);
    expect(tabManager.getTabById(a).webview).toBeNull();
    expect(tabManager.getTabById(b).webview).toBeNull();
    expect(tabManager.getTabById(a).deferredUrl).toBe('https://example.com/a');
    expect(tabManager.getSessionSnapshot().tabs.map(tab => [tab.id, tab.title, tab.url, tab.group])).toEqual(before.tabs.map(tab => [tab.id, tab.title, tab.url, tab.group]));
    expect(tabManager.activeTabId).toBe(outside);
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(1);
  });
  test('expanding loads only the first tab, and clicking another loads just that page', () => {
    const a = tabManager.createTab('https://example.com/a', {partition: 'persist:work'});
    const b = tabManager.createTab('https://example.com/b');
    tabManager.setTabGroup(a, 'Work'); tabManager.setTabGroup(b, 'Work');
    tabManager.toggleTabGroup('Work');
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(0);
    expect(document.getElementById('collapsed-groups-placeholder')).not.toBeNull();
    tabManager.toggleTabGroup('Work');
    expect(tabManager.activeTabId).toBe(a);
    expect(tabManager.getTabById(a).webview.getAttribute('src')).toBe('https://example.com/a');
    expect(tabManager.getTabById(a).webview.getAttribute('partition')).toBe('persist:work');
    expect(tabManager.getTabById(a).webview.hasAttribute('preload')).toBe(true);
    expect(tabManager.getTabById(b).webview).toBeNull();
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(1);
    expect(document.getElementById('collapsed-groups-placeholder')).toBeNull();
    tabManager.switchToTab(b);
    expect(tabManager.getTabById(b).webview.getAttribute('src')).toBe('https://example.com/b');
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(2);
  });
  test('searches unloaded tabs by title and address without loading them or matching group names', () => {
    const a = tabManager.createTab('https://example.com/alpha', {title: 'First report'});
    const b = tabManager.createTab('https://example.com/beta', {title: 'Second report'});
    tabManager.setTabGroup(a, 'Research'); tabManager.setTabGroup(b, 'Research');
    tabManager.toggleTabGroup('Research');
    tabManager.setTabSearchQuery('first report');
    expect(tabManager.getTabById(a).element.hidden).toBe(false);
    expect(tabManager.getTabById(b).element.hidden).toBe(true);
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(0);
    tabManager.setTabSearchQuery('/beta');
    expect(tabManager.getTabById(b).element.hidden).toBe(false);
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(0);
    tabManager.setTabSearchQuery('Research');
    expect(document.getElementById('tab-search-empty')).not.toBeNull();
    tabManager.setTabSearchQuery('/beta');
    tabManager.switchToTab(b);
    expect(tabManager.activeTabId).toBe(b);
    expect(tabManager.getTabById(a).webview).toBeNull();
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(1);
  });
  test('ignores late events and renderer-failure reports from a deliberately unloaded view', () => {
    const id = tabManager.createTab('https://example.com/original', {title: 'Original'});
    tabManager.setTabGroup(id, 'Work');
    const oldView = tabManager.getTabById(id).webview;
    tabManager.toggleTabGroup('Work');
    const navigation = new Event('did-navigate'); navigation.url = 'about:blank';
    oldView.dispatchEvent(navigation);
    const title = new Event('page-title-updated'); title.title = 'Stale page';
    oldView.dispatchEvent(title);
    expect(tabManager.markTabRendererGone(id, {reason: 'clean-exit'})).toBe(false);
    expect(tabManager.getTabById(id)).toMatchObject({title: 'Original', url: 'https://example.com/original', crashed: false});
  });
  test('deferred background entries have no attached page until selected', () => {
    const id = tabManager.createTab('https://example.com/later', {activate: false, deferLoad: true});
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(0);
    expect(tabManager.getTabById(id).webview.getAttribute('src')).toBeNull();
    tabManager.switchToTab(id);
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(1);
    expect(tabManager.getTabById(id).webview.getAttribute('src')).toBe('https://example.com/later');
  });
  test('restoring collapsed groups unloads those pages and retains their group memberships', () => {
    const a = tabManager.createTab('https://example.com/a');
    const b = tabManager.createTab('https://example.com/b');
    tabManager.setTabGroup(a, 'Saved'); tabManager.setTabGroup(b, 'Saved');
    tabManager.restoreCollapsedGroups(['Saved']);
    expect(document.querySelectorAll('.tab-webview')).toHaveLength(0);
    expect(tabManager.getSessionSnapshot().collapsedGroups).toEqual(['Saved']);
    expect(tabManager.getSessionSnapshot().tabs.map(tab => tab.group)).toEqual(['Saved', 'Saved']);
  });

});
