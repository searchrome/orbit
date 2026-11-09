// DOM Elements
const urlInput = document.getElementById('url-input');
const backBtn = document.getElementById('back-btn');
const toggleNetworkBtn = document.getElementById('toggle-network-btn');
const toggleJsBtn = document.getElementById('toggle-js-btn');
const toggleCacheBtn = document.getElementById('toggle-cache-btn');
const toggleBlocklistBtn = document.getElementById('toggle-blocklist-btn');
const summarizeBtn = document.getElementById('summarize-btn');
const bookmarkBtn = document.getElementById('bookmark-btn'); // Add reference for bookmark button
const cleanupBtn = document.getElementById('cleanup-btn'); // Add reference for cleanup button
const terminalBtn = document.getElementById('terminal-btn');
const toolbarMoreMenu = document.getElementById('toolbar-more-menu');
const networkActivityBar = document.getElementById('network-activity-bar');
const networkActivityFill = document.getElementById('network-activity-fill');
const contentContainer = document.getElementById('content');
const summaryPanel = document.getElementById('summary-panel'); // Added
const summaryContent = document.getElementById('summary-content'); // Added
const closeSummaryBtn = document.getElementById('close-summary-btn'); // Added
const downloadStatusBar = document.getElementById('download-status-bar');
const downloadStatusList = document.getElementById('download-status-list');
const clearDownloadsBtn = document.getElementById('clear-downloads-btn');

// State variables
let tabNetworkState = {}; // Tracks network state per tab { tabId: boolean (true=blocked) }
let isJsDisabledRenderer = false; // Local tracker for JS status (remains global for now)
let isCacheEnabled = true; // Track cache state locally in renderer (remains global)

// Constants for visualization
const MAX_VISUAL_SIZE_BYTES = 0.1 * 1024 * 1024; // e.g., 10 MB = 100% width
const RESET_DELAY_MS = 500; // How long the bar stays filled after a request
let resetTimer = null; // Timer for resetting the bar
const downloads = new Map();
const MAX_VISIBLE_DOWNLOADS = 3;

const formatDownloadBytes = (bytes) => {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const unitIndex = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1);
  const divisor = 1024 ** (unitIndex + 1);
  const scaled = value / divisor;
  const formatted = Number.isInteger(scaled) ? String(scaled) : scaled.toFixed(scaled >= 10 ? 0 : 1);
  return `${formatted} ${units[unitIndex]}`;
};

const getDownloadLabel = (download) => {
  if (download.state === 'completed') return `Downloaded · ${formatDownloadBytes(download.receivedBytes || download.totalBytes)}`;
  if (download.state === 'cancelled') return 'Download cancelled';
  if (download.state === 'interrupted') return 'Download interrupted';
  if (download.totalBytes > 0) {
    const percent = Math.min(100, Math.round((download.receivedBytes / download.totalBytes) * 100));
    return `Downloading · ${percent}% · ${formatDownloadBytes(download.receivedBytes)} of ${formatDownloadBytes(download.totalBytes)}`;
  }
  return download.receivedBytes > 0
    ? `Downloading · ${formatDownloadBytes(download.receivedBytes)}`
    : 'Starting download…';
};

const renderDownloadStatus = () => {
  if (!downloadStatusBar || !downloadStatusList) return;

  const visibleDownloads = [...downloads.values()]
    .sort((left, right) => {
      const leftIsActive = left.state === 'progressing';
      const rightIsActive = right.state === 'progressing';
      if (leftIsActive !== rightIsActive) return leftIsActive ? -1 : 1;
      return right.updatedAt - left.updatedAt;
    })
    .slice(0, MAX_VISIBLE_DOWNLOADS);
  downloadStatusBar.hidden = visibleDownloads.length === 0;
  downloadStatusList.replaceChildren();

  visibleDownloads.forEach((download) => {
    const item = document.createElement('div');
    item.className = `download-status__item download-status__item--${download.state || 'progressing'}`;

    const icon = document.createElement('span');
    icon.className = 'download-status__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = download.state === 'completed' ? '✓' : download.state === 'cancelled' || download.state === 'interrupted' ? '!' : '↓';

    const details = document.createElement('div');
    details.className = 'download-status__details';
    const filename = document.createElement('div');
    filename.className = 'download-status__filename';
    filename.textContent = download.filename || 'Download';
    filename.title = filename.textContent;
    const label = document.createElement('div');
    label.className = 'download-status__label';
    label.textContent = getDownloadLabel(download);
    details.append(filename, label);

    const progress = document.createElement('div');
    progress.className = 'download-status__progress';
    progress.setAttribute('role', 'progressbar');
    progress.setAttribute('aria-label', `${download.filename || 'Download'} progress`);
    const fill = document.createElement('div');
    fill.className = 'download-status__progress-fill';
    const hasKnownTotal = download.totalBytes > 0;
    const percent = hasKnownTotal ? Math.min(100, (download.receivedBytes / download.totalBytes) * 100) : 0;
    fill.style.width = `${download.state === 'completed' ? 100 : percent}%`;
    if (hasKnownTotal) {
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', String(download.totalBytes));
      progress.setAttribute('aria-valuenow', String(Math.min(download.receivedBytes, download.totalBytes)));
    } else if (download.state === 'progressing') {
      progress.classList.add('download-status__progress--indeterminate');
    }
    progress.appendChild(fill);

    item.append(icon, details, progress);
    downloadStatusList.appendChild(item);
  });

  if (clearDownloadsBtn) {
    clearDownloadsBtn.disabled = ![...downloads.values()].some((download) => download.state !== 'progressing');
  }
};

const updateDownloadStatus = (payload) => {
  const id = typeof payload?.id === 'string' ? payload.id : '';
  if (!id) return;
  const current = downloads.get(id) || {};
  downloads.set(id, {
    ...current,
    ...payload,
    filename: String(payload.filename || current.filename || 'Download'),
    receivedBytes: Math.max(0, Number(payload.receivedBytes ?? current.receivedBytes) || 0),
    totalBytes: Math.max(0, Number(payload.totalBytes ?? current.totalBytes) || 0),
    state: ['progressing', 'completed', 'cancelled', 'interrupted'].includes(payload.state) ? payload.state : (current.state || 'progressing'),
    updatedAt: Date.now()
  });
  renderDownloadStatus();
};

// Import necessary modules
import TabManager from './tab-manager.js';
import WorkspacePanel from './workspace-panel.js';
import Summarizer from './summarizer.js';
import HistoryManager from './history-manager.js'; // Import HistoryManager
import AssistantController from './assistant-controller.js';
import BrowserActionCoordinator, { browserActionCancellationResult } from './browser-action-coordinator.js';
import BrowserToolDispatcher from './browser-tool-dispatcher.js';
import TerminalPanel from './terminal-panel.js';
import ArtifactPanel from './artifact-panel.js';
import SettingsPanel from './settings-panel.js';
import UpdateNotice from './update-notice.js';
import BookmarksPanel from './bookmarks-panel.js';
import TransformedViewManager from './transformed-view-manager.js';
import SessionFilesPanel from './session-files-panel.js';
import CastPanel from './cast-panel.js';

// Initialize HistoryManager, TabManager, and Summarizer
const historyManager = new HistoryManager(); // Instantiate HistoryManager directly
let tabManager = new TabManager(contentContainer, historyManager, bookmarkBtn); // Pass contentContainer, historyManager, and bookmarkBtn
const workspacePanel = new WorkspacePanel(tabManager);
window.workspacePanel = workspacePanel;
document.getElementById('workspace-bar').inert = true;
document.getElementById('controls').inert = true;
window.tabManager = tabManager; // Make it accessible to other scripts like summarizer.js
let browserSessionSyncTimer = null;
const scheduleBrowserSessionSync = () => {
  if (!workspacePanel.ready || workspacePanel.transitioning) return;
  if (browserSessionSyncTimer) return;
  browserSessionSyncTimer = setTimeout(() => {
    browserSessionSyncTimer = null;
    void workspacePanel.autosave().catch(error => console.warn('[Sessions] Autosave failed:', error));
  }, 100);
};
window.addEventListener('tab-session-changed', scheduleBrowserSessionSync);
window.addEventListener('workspace-session-ready', scheduleBrowserSessionSync);
window.addEventListener('workspace-session-changing', () => {
  clearTimeout(browserSessionSyncTimer);
  browserSessionSyncTimer = null;
});
const browserActionCoordinator = new BrowserActionCoordinator();
const assistantController = new AssistantController(tabManager, browserActionCoordinator);
window.assistantController = assistantController;
const transformedViewManager = new TransformedViewManager({ tabManager });
window.transformedViewManager = transformedViewManager;
const browserToolDispatcher = new BrowserToolDispatcher(tabManager, browserActionCoordinator, transformedViewManager);
window.browserToolDispatcher = browserToolDispatcher;
const terminalPanel = new TerminalPanel({
  onBrowserControlChange: (active) => {
    assistantController.setOpenCodeBrowserControlActive(active);
  }
});
window.terminalPanel = terminalPanel;
const artifactPanel = new ArtifactPanel();
window.artifactPanel = artifactPanel;
new UpdateNotice();
const settingsPanel = new SettingsPanel();
window.settingsPanel = settingsPanel;
const bookmarksPanel = new BookmarksPanel({ historyManager, tabManager });
window.bookmarksPanel = bookmarksPanel;
const sessionFilesPanel = new SessionFilesPanel();
window.sessionFilesPanel = sessionFilesPanel;
const castPanel = new CastPanel(tabManager);
window.castPanel = castPanel;

const activeBrowserToolRequests = new Map();

window.electronAPI.on('tab-renderer-gone', (details) => {
  const webContentsId = details?.webContentsId;
  if (!Number.isInteger(webContentsId)) return;

  const tab = tabManager.tabs.find((candidate) => {
    try {
      return candidate.webview?.getWebContentsId?.() === webContentsId;
    } catch {
      return false;
    }
  });

  if (tab) {
    tabManager.markTabRendererGone(tab.id, details);
  }
});

window.electronAPI.on('browser-tool-request', async (request) => {
  const requestId = String(request?.requestId || '');
  if (!requestId) {
    return;
  }
  const controller = new AbortController();
  const operation = { controller, tool: request.tool, args: request.args || {}, started: false };
  activeBrowserToolRequests.set(requestId, operation);
  try {
    let result = await browserToolDispatcher.execute(request.tool, request.args, {
      owner: 'opencode',
      signal: controller.signal,
      onStart: () => {
        operation.started = true;
        window.electronAPI.send('browser-tool-started', { requestId });
      }
    });
    if (controller.signal.aborted) {
      result = browserActionCancellationResult(
        request.tool,
        operation.started,
        String(controller.signal.reason || 'Browser action was cancelled.')
      );
    }
    window.electronAPI.send('browser-tool-response', { requestId, result });
  } finally {
    activeBrowserToolRequests.delete(requestId);
  }
});

window.electronAPI.on('browser-tool-cancel', (request) => {
  const requestId = String(request?.requestId || '');
  const operation = activeBrowserToolRequests.get(requestId);
  if (!operation || operation.controller.signal.aborted) return;
  if (operation.started) {
    browserToolDispatcher.cancel(operation.tool, operation.args);
  }
  operation.controller.abort(request?.reason || 'Browser action was cancelled.');
});

let summarizerInstance = null; // Initialize Summarizer instance later

// Function to load URL or perform search in the active tab
const loadURL = (input) => {
  const trimmedInput = input.trim();
  if (!trimmedInput) {
    console.log('Empty input, not loading.');
    return;
  }
  console.log(`[Renderer DEBUG] trimmedInput: "${trimmedInput}"`); // DEBUG LOG

  const loweredInput = trimmedInput.toLowerCase();
  if (loweredInput === 'browser://assistant' || loweredInput === 'assistant.html' || loweredInput === 'assistant://assistant') {
    console.log('[Renderer] Opening assistant workspace from the URL bar.');
    assistantController.openWorkspace();
    return;
  }

  const activeWebview = tabManager.getActiveWebview();
  if (!activeWebview) {
    console.error("No active webview found!");
    return;
  }

  // Check for the "word!" pattern
  const instantSearchMatch = trimmedInput.match(/^(\w+)!$/);
  console.log(`[Renderer DEBUG] instantSearchMatch result:`, instantSearchMatch); // DEBUG LOG
  if (instantSearchMatch) {
    const word = instantSearchMatch[1];
    console.log(`[Renderer DEBUG] Detected instant search pattern for: ${word}`); // DEBUG LOG
    console.log(`[Renderer DEBUG] Sending IPC 'get-first-duckduckgo-result' with word: ${word}`); // DEBUG LOG
    window.electronAPI.send('get-first-duckduckgo-result', word);
    // Don't proceed with normal URL/search loading
    return;
  }

  let targetUrl;

  // Basic check if input looks like a URL/domain or specific keywords
  const looksLikeUrl = trimmedInput.includes('.') ||
                       trimmedInput.includes(':') ||
                       trimmedInput.includes('/') ||
                       trimmedInput.toLowerCase() === 'localhost' ||
                       trimmedInput.toLowerCase() === 'about:blank';

  if (looksLikeUrl) {
    targetUrl = trimmedInput;
    // Add http:// if it doesn't have a protocol and isn't about:blank or localhost
    if (!targetUrl.includes('://') && targetUrl !== 'about:blank' && targetUrl.toLowerCase() !== 'localhost') {
      targetUrl = 'http://' + targetUrl;
    }
  } else {
    // Treat as search query
    const encodedTerm = encodeURIComponent(trimmedInput);
    targetUrl = `https://duckduckgo.com/?q=${encodedTerm}`;
    console.log(`Performing search for: ${trimmedInput}`);
  }

  console.log(`Loading target: ${targetUrl}`);

  // Handle cache settings
  if (!isCacheEnabled) {
    console.log('Cache is OFF, loading with no-cache headers.');
    activeWebview.loadURL(targetUrl, {
      extraHeaders: 'Pragma: no-cache\nCache-Control: no-cache, no-store, must-revalidate\nExpires: 0'
    });
  } else {
    activeWebview.src = targetUrl;
  }
};

// Function to update navigation buttons state
const updateNavButtons = () => {
  const activeWebview = tabManager.getActiveWebview();
  if (!backBtn || !activeWebview) {
    return;
  }

  try {
    backBtn.disabled = !activeWebview.canGoBack();
  } catch (error) {
    console.warn(`Could not read back history for the active tab: ${error?.message || error}`);
    backBtn.disabled = true;
  }
};

const safeGetWebContentsId = (webview) => {
  if (!webview || typeof webview.getWebContentsId !== 'function') {
    return null;
  }

  try {
    return webview.getWebContentsId();
  } catch (error) {
    console.warn(`Could not read webContentsId for the active tab: ${error?.message || error}`);
    return null;
  }
};

const safeGuestLinkUrl = (value) => {
  try {
    const parsed = new URL(String(value || ''));
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
};

window.electronAPI.on('guest-open-link', (payload) => {
  const sourceWebContentsId = Number(payload?.sourceWebContentsId);
  const sourceTab = tabManager.tabs.find((tab) => safeGetWebContentsId(tab.webview) === sourceWebContentsId);
  const url = safeGuestLinkUrl(payload?.url);
  if (!sourceTab || !url) {
    console.warn('Ignored a guest link request without a known tab or safe HTTP(S) URL.');
    return;
  }

  tabManager.createTab(url, {
    activate: payload?.activate !== false,
    title: 'Loading…'
  });
});

// Function to update button appearance
const setToolbarToggleState = (button, stateText) => {
  const stateNode = button?.querySelector?.('.toolbar-btn__state');
  if (stateNode) {
    stateNode.textContent = stateText;
    return;
  }

  button.textContent = stateText;
};

const updateButtonState = (button, isActive) => {
  if (!button) return;
  if (isActive) {
    button.classList.add('active');
  } else {
    button.classList.remove('active');
  }

  button.setAttribute('aria-pressed', String(!!isActive));
  // Update text
  if (button === toggleNetworkBtn) {
    // 'isActive' for network button means network is OFF (blocked)
    setToolbarToggleState(button, isActive ? 'Off' : 'On');
  } else if (button === toggleJsBtn) {
    setToolbarToggleState(button, isActive ? 'Off' : 'On');
  } else if (button === toggleCacheBtn) {
    // Note: .active class means OFF for cache
    setToolbarToggleState(button, isActive ? 'Off' : 'On');
  } else if (button === toggleBlocklistBtn) {
    // Active class means ON for blocklist
    setToolbarToggleState(button, isActive ? 'On' : 'Off');
  }
};

const setBookmarkButtonState = (isBookmarked) => {
  if (!bookmarkBtn) return;
  const bookmarked = !!isBookmarked;
  bookmarkBtn.classList.toggle('bookmarked', bookmarked);
  bookmarkBtn.setAttribute('aria-pressed', String(bookmarked));
  bookmarkBtn.setAttribute('aria-label', bookmarked
    ? 'Current page is bookmarked'
    : 'Add current page to bookmarks');
  bookmarkBtn.title = bookmarked ? 'Bookmarked' : 'Add bookmark';
};

const bookmarkEnrichmentUrls = new Set();

const setBookmarkEnrichmentState = (url, isEnriching) => {
  if (!bookmarkBtn || tabManager.getActiveTab()?.url !== url) return;
  bookmarkBtn.classList.toggle('bookmark-enriching', isEnriching);
  bookmarkBtn.setAttribute('aria-busy', String(isEnriching));
  if (isEnriching) {
    bookmarkBtn.setAttribute('aria-label', 'Bookmark saved; creating AI definition');
    bookmarkBtn.title = 'Bookmark saved — creating AI definition…';
  } else {
    setBookmarkButtonState(true);
  }
};

const enrichBookmark = async (tab) => {
  const url = tab?.url;
  if (!url || bookmarkEnrichmentUrls.has(url)) return;

  bookmarkEnrichmentUrls.add(url);
  setBookmarkEnrichmentState(url, true);
  try {
    const pageText = await tab.webview?.executeJavaScript?.('document.body ? document.body.innerText : ""');
    if (!pageText || !String(pageText).trim()) {
      throw new Error('This page has no readable text to summarize.');
    }

    await historyManager.updateBookmarkEnrichment(url, { state: 'pending' });
    const enrichment = await window.electronAPI.invoke('bookmark-enrich', {
      url,
      title: tab.title || 'Untitled page',
      content: String(pageText).slice(0, 30_000)
    });
    await historyManager.updateBookmarkEnrichment(url, {
      state: 'ready',
      definition: enrichment?.definition,
      summary: enrichment?.summary,
      keywords: enrichment?.keywords
    });
  } catch (error) {
    console.warn(`[Renderer] Could not enrich bookmark ${url}: ${error?.message || error}`);
    await historyManager.updateBookmarkEnrichment(url, {
      state: 'failed',
      error: error?.message || 'AI bookmark enrichment failed.'
    });
  } finally {
    bookmarkEnrichmentUrls.delete(url);
    setBookmarkEnrichmentState(url, false);
    dispatchBrowserEvent('bookmarks-updated');
  }
};

const dispatchBrowserEvent = (name) => {
  const event = document.createEvent('Event');
  event.initEvent(name, false, false);
  window.dispatchEvent(event);
};

// Function to initialize the Summarizer with the current active webview
const initializeSummarizer = () => {
  const activeWebview = tabManager.getActiveWebview();
  if (activeWebview && typeof Summarizer !== 'undefined') {
    if (summarizerInstance) {
      // If we already have an instance, just update the webview reference
      console.log('Updating existing Summarizer instance with new webview reference');
      summarizerInstance.updateWebview(activeWebview);
    } else {
      // Create a new instance if one doesn't exist
      console.log('Creating new Summarizer instance');
      summarizerInstance = new Summarizer(activeWebview, summarizeBtn);
    }
  } else {
    console.error('Cannot initialize Summarizer: webview or Summarizer class not available');
  }
};

const updateWorkspaceAwareControls = (activeTab) => {
  const isAssistantWorkspace = activeTab?.role === 'assistant';
  const unavailable = !activeTab?.webview || isAssistantWorkspace;

  if (summarizeBtn) {
    summarizeBtn.disabled = unavailable;
  }

  if (bookmarkBtn) {
    bookmarkBtn.disabled = unavailable;
  }

  if (cleanupBtn) {
    cleanupBtn.disabled = unavailable;
  }
};

// --- Event Listeners ---

// Back button click
if (backBtn) {
  backBtn.addEventListener('click', () => {
    const activeTab = tabManager.getActiveTab();
    if (activeTab) {
      let canGoBack = false;
      try {
        canGoBack = activeTab.webview.canGoBack();
      } catch (error) {
        console.warn(`Back button ignored because the active tab is not ready yet: ${error?.message || error}`);
      }

      if (canGoBack) {
        activeTab.webview.goBack();

        // Ensure Network is ON for the active tab after going back
        const webContentsId = safeGetWebContentsId(activeTab.webview);
        const isTabBlocked = tabNetworkState[activeTab.id] === true;
        if (isTabBlocked && webContentsId) {
          console.log(`Back button clicked for tab ${activeTab.id}, sending toggle-network to unblock.`);
          window.electronAPI.send('toggle-network', webContentsId);
        }

        // Ensure JS is ON after going back (JS state is still global)
        if (isJsDisabledRenderer) {
          console.log('Back button clicked, sending toggle-js to enable.');
          window.electronAPI.send('toggle-js');
        }
      }
    }
  });
}

// Load URL when Enter is pressed in the input field
console.log('[Renderer DEBUG] Checking if urlInput exists before adding listener:', urlInput); // DEBUG LOG
if (urlInput) {
  urlInput.addEventListener('keydown', (e) => { // Changed from keypress to keydown
    console.log(`[Renderer DEBUG] Keydown detected: ${e.key}`); // DEBUG LOG
    if (e.key === 'Enter') {
      console.log(`[Renderer DEBUG] Enter pressed. Input value: "${urlInput.value}"`); // DEBUG LOG
      // Prevent default form submission if applicable
      e.preventDefault();
      loadURL(urlInput.value);
    }
  });
} else {
  console.error('[Renderer DEBUG] urlInput element not found! Cannot attach listener.'); // DEBUG LOG
}

// Automatically enable network for the *active* tab when user starts typing in URL bar if it's off
urlInput.addEventListener('input', () => {
  const activeTab = tabManager.getActiveTab();
  if (activeTab) {
    const webContentsId = safeGetWebContentsId(activeTab.webview);
    const isTabBlocked = tabNetworkState[activeTab.id] === true;
    if (isTabBlocked && webContentsId) {
      console.log(`User started typing in URL bar for active tab ${activeTab.id}, sending toggle-network to unblock.`);
      window.electronAPI.send('toggle-network', webContentsId);
    }
  }
});

// Bookmark Button Click
if (bookmarkBtn) {
  bookmarkBtn.addEventListener('click', async () => {
    const activeTab = tabManager.getActiveTab();
    if (!activeTab?.url || activeTab.url === 'about:blank' || activeTab.role === 'assistant') {
      return;
    }

    await historyManager.addOrUpdateEntry(activeTab.url, activeTab.title, 'open', null, true);
    setBookmarkButtonState(true);
    dispatchBrowserEvent('bookmarks-updated');
    void enrichBookmark(activeTab);
  });
}


// Toggle Network Button (for the active tab)
toggleNetworkBtn?.addEventListener('click', () => {
  const activeTab = tabManager.getActiveTab();
  if (activeTab) {
    const webContentsId = safeGetWebContentsId(activeTab.webview);
    if (webContentsId) {
      console.log(`Toggle Network button clicked for active tab ${activeTab.id}`);
      window.electronAPI.send('toggle-network', webContentsId);
    } else {
      console.error(`Could not get webContentsId for active tab ${activeTab.id} to toggle network.`);
    }
  } else {
    console.error("Toggle Network button clicked, but no active tab found.");
  }
});

// Toggle JS Button (remains global)
toggleJsBtn?.addEventListener('click', () => {
  console.log('Toggle JS button clicked');
  window.electronAPI.send('toggle-js');

  // Reload after the main process confirms the new JavaScript policy.
});

// Toggle Cache Button
toggleCacheBtn.addEventListener('click', () => {
  console.log('Toggle Cache button clicked');
  window.electronAPI.send('toggle-cache');

  // Reload after the main process confirms the new JavaScript policy.
});

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && String(event.key).toLowerCase() === 'r') {
    const activeTab = tabManager.getActiveTab();
    if (activeTab?.role === 'transformed') {
      event.preventDefault();
      tabManager.reloadTab(activeTab.id);
    }
  }
});

// Toggle Blocklist Button
toggleBlocklistBtn.addEventListener('click', () => {
  console.log('Toggle Blocklist button clicked');
  window.electronAPI.send('toggle-domain-blocking');
});

if (terminalBtn) {
  terminalBtn.addEventListener('click', () => {
    terminalPanel.show();
  });
}

if (toolbarMoreMenu) {
  document.addEventListener('click', (event) => {
    if (!toolbarMoreMenu.contains(event.target)) {
      toolbarMoreMenu.removeAttribute('open');
      return;
    }
    if (event.target.closest?.('.toolbar-more__menu button')) {
      toolbarMoreMenu.removeAttribute('open');
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') toolbarMoreMenu.removeAttribute('open');
  });
}

// Cleanup Button Click
console.log('[Renderer] Attempting to attach cleanupBtn listener...'); // Log before attaching
if (cleanupBtn) {
  cleanupBtn.addEventListener('click', () => {
    console.log('[Renderer] cleanupBtn clicked!'); // Log inside listener
    const activeWebview = tabManager.getActiveWebview();
    if (!activeWebview) {
      console.error("Cleanup button clicked, but no active webview found.");
      // Optionally show an error message to the user
      return;
    }
    const webContentsId = safeGetWebContentsId(activeWebview);
    if (!webContentsId) {
      console.error("Cleanup button clicked, but could not get webContentsId.");
      // Optionally show an error message
      return;
    }

    console.log(`[Renderer] Cleanup button clicked for active tab ${tabManager.activeTabId}, sending request-page-cleanup for webContentsId ${webContentsId}`);
    // Optionally disable the button while processing
    cleanupBtn.disabled = true;
    cleanupBtn.textContent = 'Cleaning...';
    window.electronAPI.send('request-page-cleanup', webContentsId);
  });
  console.log('[Renderer] cleanupBtn listener attached successfully.'); // Log after attaching
} else {
  console.error('[Renderer] cleanupBtn element not found! Listener not attached.');
}


// Listen for tab switch events
window.addEventListener('tab-switched', (event) => {
  console.log(`Switched to tab: ${event.detail.tabId}`);

  // Update the URL input to reflect the active tab's URL
  const activeTab = tabManager.getActiveTab();
  if (activeTab && activeTab.url !== 'about:blank') {
    urlInput.value = activeTab.url;
  }

  // Update back button state
  updateNavButtons();
  updateWorkspaceAwareControls(activeTab);

  // Update network button state based on the new active tab's state
  const activeTabId = event.detail.tabId;
  const isNewTabBlocked = tabNetworkState[activeTabId] === true; // Default to false (ON) if undefined
  console.log(`Tab switched to ${activeTabId}. Network blocked state: ${isNewTabBlocked}`);
  updateButtonState(toggleNetworkBtn, isNewTabBlocked);

  if (activeTab?.role !== 'assistant') {
    // Re-initialize the summarizer with the new active webview
    initializeSummarizer();
  }

  // Update bookmark button state based on the new active tab's URL
  const activeTabUrl = activeTab ? activeTab.url : null;
  const isBookmarked = activeTabUrl ? historyManager.isBookmarked(activeTabUrl) : false;
  setBookmarkButtonState(isBookmarked);
});

// Listen for ensure-summarizer-initialized events
window.addEventListener('ensure-summarizer-initialized', (event) => {
  console.log(`Ensuring summarizer is initialized for tab: ${event.detail.tabId}`);

  // Check if this is the active tab
  if (tabManager.activeTabId === event.detail.tabId) {
    console.log('This is the active tab - initializing summarizer');
    initializeSummarizer();
  } else {
    console.log('Not the active tab - summarizer will be initialized when tab is activated');
  }
});

// Custom event handlers for webview events (now include tabId)
window.addEventListener('webview-scrolled-down', (event) => {
  // Protection is deliberately controlled only by the visible Blocker button.
  return;
  const tabId = event.detail?.tabId;
  if (!tabId) {
    console.error('webview-scrolled-down event received without tabId.');
    return;
  }

  const tab = tabManager.getTabById(tabId);
  if (!tab) {
    console.error(`webview-scrolled-down event for unknown tabId: ${tabId}`);
    return;
  }

  const webContentsId = safeGetWebContentsId(tab.webview);
  const isTabBlocked = tabNetworkState[tabId] === true;

  // Block network for this tab if enabled
  if (!isTabBlocked && webContentsId) {
    console.log(`Scroll down detected in tab ${tabId}, sending toggle-network to block.`);
    window.electronAPI.send('toggle-network', webContentsId);
  } else {
    console.log(`Scroll down detected in tab ${tabId}, but network already blocked or webContentsId missing.`);
  }

  // Disable JS if enabled (JS state is still global)
  if (!isJsDisabledRenderer) {
    console.log('Scroll down detected, sending toggle-js to disable.');
    window.electronAPI.send('toggle-js');
  } else {
    console.log('Scroll down detected, but JS already disabled.');
  }
});

window.addEventListener('webview-clicked', (event) => {
  // Protection is deliberately controlled only by the visible Blocker button.
  return;
  const tabId = event.detail?.tabId;
   if (!tabId) {
    console.error('webview-clicked event received without tabId.');
    return;
  }

  const tab = tabManager.getTabById(tabId);
  if (!tab) {
    console.error(`webview-clicked event for unknown tabId: ${tabId}`);
    return;
  }

  const webContentsId = safeGetWebContentsId(tab.webview);
  const isTabBlocked = tabNetworkState[tabId] === true;

  // Unblock network for this tab if blocked
  if (isTabBlocked && webContentsId) {
    console.log(`Click detected in tab ${tabId}, sending toggle-network to unblock.`);
    window.electronAPI.send('toggle-network', webContentsId);
  } else {
    console.log(`Click detected in tab ${tabId}, but network already unblocked or webContentsId missing.`);
  }

  // Enable JS if disabled (JS state is still global)
  if (isJsDisabledRenderer) {
    console.log('Click detected, sending toggle-js to enable.');
    window.electronAPI.send('toggle-js');
  } else {
    console.log('Click detected, but JS already enabled.');
  }
});

// --- IPC Listeners ---
// Register listeners that receive data from main process early.
// The callback will execute later, after the DOM is likely ready.

// Listen for summary result from main process (Registered early)
window.electronAPI.on('summary-result', async (summaryHtml) => {
  console.log('>>> summary-result CALLBACK FIRED <<<'); // ADDED EXTRA LOG
  console.log('Renderer received summary-result'); // Log added for confirmation

  // Get element references *inside* the callback to ensure they exist when needed
  const panel = document.getElementById('summary-panel');
  const content = document.getElementById('summary-content');
  console.log(`Panel found: ${!!panel}, Content found: ${!!content}`); // Log element status

  if (panel && content) {
    content.innerHTML = summaryHtml; // Update panel content
    delete panel.dataset.state;
    panel.classList.remove('hidden'); // Show panel
    console.log('Summary panel updated and shown.');
  } else {
    console.error('Summary panel elements not found when trying to display summary.');
  }

  // --- Add logic to save summary to history ---
  const activeTab = tabManager.getActiveTab();
  if (activeTab && activeTab.url && activeTab.url !== 'about:blank') {
    console.log(`Saving summary for URL: ${activeTab.url}`);
    // Use the historyManager instance to add or update the history entry with the summary
    // Also mark it as bookmarked
    await historyManager.addOrUpdateEntry(activeTab.url, activeTab.title, 'closed', summaryHtml, true); // Mark as closed and bookmarked
    console.log('Summary saved to history and marked as bookmarked.');

    setBookmarkButtonState(true);
    dispatchBrowserEvent('bookmarks-updated');

  } else {
    console.warn('Could not save summary to history: No active tab or invalid URL.');
  }
});

// Listeners that DON'T depend heavily on the DOM initially can be here
// Listen for network data size from main process
window.electronAPI.on('network-request-data', (sizeInBytes) => {
  const percentage = Math.min(100, (sizeInBytes / MAX_VISUAL_SIZE_BYTES) * 100);
  networkActivityFill.style.width = `${percentage}%`;

  // Clear any existing reset timer
  if (resetTimer) {
    clearTimeout(resetTimer);
  }

  // Set a timer to reset the bar width
  resetTimer = setTimeout(() => {
    networkActivityFill.style.width = '0%';
    resetTimer = null;
  }, RESET_DELAY_MS);
});

window.electronAPI.on('download-status', updateDownloadStatus);

if (clearDownloadsBtn) {
  clearDownloadsBtn.addEventListener('click', () => {
    [...downloads.entries()].forEach(([id, download]) => {
      if (download.state !== 'progressing') downloads.delete(id);
    });
    renderDownloadStatus();
  });
}

// Listen for network status updates from main process (now includes webContentsId)
window.electronAPI.on('network-status', (webContentsId, isBlocked) => {
  console.log(`Received network-status for webContentsId ${webContentsId}: ${isBlocked}`);

  // Find the tabId associated with this webContentsId
  const tab = tabManager.tabs.find(t => safeGetWebContentsId(t.webview) === webContentsId);
  if (tab) {
    const tabId = tab.id;
    tabNetworkState[tabId] = isBlocked; // Update local state tracker for the specific tab
    console.log(`Updated tabNetworkState for ${tabId}: ${isBlocked}`);

    // Update the button only if the affected tab is the currently active one
    if (tabManager.activeTabId === tabId) {
      updateButtonState(toggleNetworkBtn, isBlocked); // Update button based on blocked status
    }
  } else {
    console.warn(`Received network-status for unknown webContentsId: ${webContentsId}`);
  }
});


// Listen for JS status updates from main process (remains global)
window.electronAPI.on('js-status', (isDisabled) => {
  console.log(`Received js-status: ${isDisabled}`);
  const changed = isJsDisabledRenderer !== isDisabled;
  isJsDisabledRenderer = isDisabled; // Update local JS state tracker
  if (changed) {
    for (const tab of tabManager.tabs) {
      if (!tab.internal && !tab.deferredUrl) tabManager.reloadTab(tab.id);
    }
  }
  updateButtonState(toggleJsBtn, isDisabled); // Update button based on disabled status
});

// Listen for cache status updates from main process
window.electronAPI.on('cache-status', (enabled) => {
  console.log(`Received cache-status: ${enabled}`);
  isCacheEnabled = enabled; // Update local cache state tracker
  // Update button state - active class means OFF
  updateButtonState(toggleCacheBtn, !enabled);
});

// Listen for domain blocking status updates from main process
window.electronAPI.on('domain-blocking-status', (isEnabled) => {
  console.log(`Received domain-blocking-status: ${isEnabled}`);
  updateButtonState(toggleBlocklistBtn, isEnabled); // Update button based on enabled status
});

// Listen for cleanup result from main process
window.electronAPI.on('cleanup-result', (cleanedHtml) => {
  console.log('[Renderer] Received cleanup-result IPC message.'); // Log entry
  // Re-enable the button
  cleanupBtn.disabled = false;
  cleanupBtn.textContent = 'Cleanup';

  if (cleanedHtml && typeof cleanedHtml === 'string') {
    // Create a data URI for the cleaned HTML
    console.log(`[Renderer] Received valid cleaned HTML (length: ${cleanedHtml.length}). Creating data URI...`);
    const dataUri = 'data:text/html;charset=UTF-8,' + encodeURIComponent(cleanedHtml);
    // Open the data URI in a new tab
    console.log('[Renderer] Opening cleaned content in new tab...');
    tabManager.createTab(dataUri);
    console.log('[Renderer] New tab created for cleaned content.');
  } else {
    console.error('[Renderer] Received invalid or null cleanup result:', cleanedHtml);
    // Optionally show an error message to the user
    // Example: Display error in the error overlay
    const errorOverlay = document.getElementById('error-message-overlay');
    if (errorOverlay) {
        errorOverlay.textContent = 'Failed to clean up page. Invalid result received.';
        errorOverlay.classList.add('visible');
        // Optionally hide after a delay
        setTimeout(() => errorOverlay.classList.remove('visible'), 5000);
    }
  }
});

// Listen for JS status updates from the main process (for webview)
window.electronAPI.on('set-js-status', (isDisabled) => {
  console.log(`Received set-js-status for webview: ${isDisabled}`);
  // The main process handles the actual JS toggle
});

// Listen for the first result URL from the main process
window.electronAPI.on('navigate-to-first-result', (url, errorMsg) => {
  if (errorMsg) {
    console.error(`Error getting first result: ${errorMsg}`);
    // Optionally display the error to the user (e.g., in the URL bar or a notification)
    urlInput.value = `Error: ${errorMsg}`;
    return;
  }

  if (url) {
    console.log(`Received first result URL: ${url}. Loading...`);
    // Use the existing loadURL logic, but force it to treat the input as a URL
    // We need to ensure loadURL doesn't re-interpret this as a search
    const activeWebview = tabManager.getActiveWebview();
    if (activeWebview) {
      // Directly set the src or use loadURL with cache handling
      if (!isCacheEnabled) {
        console.log('Cache is OFF, loading first result with no-cache headers.');
        activeWebview.loadURL(url, {
          extraHeaders: 'Pragma: no-cache\nCache-Control: no-cache, no-store, must-revalidate\nExpires: 0'
        });
      } else {
        activeWebview.src = url;
      }
      // Update the URL bar to show the loaded URL
      urlInput.value = url;
    } else {
      console.error("Cannot load first result: No active webview found!");
    }
  } else {
    // Handle case where no URL was returned (e.g., no results found)
    console.warn("Received navigate-to-first-result without a URL.");
    // Optionally inform the user
    urlInput.value = 'No result found for instant search.';
  }
});

// --- IPC Listener for Saving Open Tabs on Close ---
// Make the handler async to await historyManager.saveHistory()
window.electronAPI.on('save-open-tabs', async () => {
  console.log('[Renderer] Received save-open-tabs IPC. Initiating save process.'); // Added log

  // Get currently open tabs from tabManager
  const openTabs = tabManager.tabs;
  console.log(`[Renderer] Found ${openTabs.length} open tabs to save.`); // Added log

  // Mark all history entries as closed first
  const history = historyManager.getHistory();
  history.forEach(entry => {
    if (entry.state === 'open') { // Only mark as closed if currently open
        entry.state = 'closed';
        console.log(`[Renderer] Marking history entry as closed: ${entry.url}`); // Added log
    }
  });

  // Update or add entries for currently open tabs and mark them as 'open'
  // Use a loop with await if addOrUpdateEntry was truly async and needed to complete sequentially
  // Since addOrUpdateEntry calls saveHistory internally which is async,
  // we need to ensure all updates are reflected before the final save.
  // A simple loop is fine if saveHistory is quick, but for robustness,
  // we might collect updates and save once at the end.
  // Let's collect updates and save once after the loop.

  // Collect updates without saving immediately in the loop
  openTabs.forEach(tab => {
    if (tab.trackHistory !== false && tab.url && tab.url !== 'about:blank') { // Ensure valid URL before saving
        const existingEntryIndex = historyManager.history.findIndex(entry => entry.url === tab.url);
        const timestamp = Date.now();

        if (existingEntryIndex > -1) {
            historyManager.history[existingEntryIndex].title = tab.title || historyManager.history[existingEntryIndex].title;
            historyManager.history[existingEntryIndex].lastOpened = timestamp;
            historyManager.history[existingEntryIndex].state = 'open';
        } else {
            historyManager.history.push({
                url: tab.url,
                title: tab.title || 'Untitled',
                lastOpened: timestamp,
                state: 'open'
            });
        }
        console.log(`[Renderer] Prepared history entry for open tab: ${tab.url}`); // Added log
    }
  });

  // Now, save the entire updated history
  await historyManager.saveHistory(); // Await the asynchronous save operation
  console.log('[Renderer] History saved via IPC. Sending open-tabs-saved IPC.'); // Added log

  // Send confirmation back to main process *after* saving is initiated
  window.electronAPI.send('open-tabs-saved', workspacePanel.getCurrentSnapshot());
});


// --- Initial Setup ---

// Get initial status from main process and set button states (Network state is handled per-tab now)
// Make the initial setup block async to await history loading
window.electronAPI.invoke('get-initial-status').then(async (status) => { // Added async here
  console.log('Received initial status (excluding network):', status);
  isCacheEnabled = status.cacheEnabled; // Set initial local cache state
  isJsDisabledRenderer = status.javascriptDisabled; // Set initial local JS state
  terminalPanel.setEnabled(status.openCodeTerminalEnabled !== false);
  if (terminalBtn) terminalBtn.hidden = status.openCodeTerminalEnabled === false;
  artifactPanel.setEnabled(status.openCodeTerminalEnabled !== false);
  settingsPanel.setEnabled(status.openCodeTerminalEnabled !== false);

  // Don't set network button initially here, wait for tab creation/switch
  // updateButtonState(toggleNetworkBtn, status.networkBlocked); // Removed
  updateButtonState(toggleJsBtn, status.javascriptDisabled);
  updateButtonState(toggleCacheBtn, !status.cacheEnabled); // Active class means OFF for cache
  updateButtonState(toggleBlocklistBtn, status.domainBlockingEnabled); // Active class means ON for blocklist

  // Await history loading before proceeding
  await historyManager.loadHistory(); // Await the asynchronous load operation
  console.log('[Renderer] History loaded during initial setup.'); // Added log

  // Prefer the tab journal after an unexpected exit. Tabs that were actively
  // loading are restored as paused crash tabs, so a problematic page is never
  // reopened automatically.
  let startupSession = null;
  try {
    startupSession = await window.electronAPI.invoke('get-startup-session');
  } catch (error) {
    console.warn(`[Renderer] Could not load crash recovery session: ${error?.message || error}`);
  }

  if (!startupSession?.workspace?.id) throw new Error('Could not open your session.');
  tabManager.replaceSession(startupSession.session, {interrupted: startupSession.interrupted});
  workspacePanel.initialize(startupSession.workspace);
  document.getElementById('workspace-bar').inert = false;
  document.getElementById('controls').inert = false;
  scheduleBrowserSessionSync();
  const initialActiveTab = tabManager.getActiveTab();
  updateWorkspaceAwareControls(initialActiveTab);
  setBookmarkButtonState(initialActiveTab?.url ? historyManager.isBookmarked(initialActiveTab.url) : false);

  // Initialize the summarizer with the active webview (will be called after first tab is created and switched to)
  // initializeSummarizer(); // Moved initialization to be triggered by tab-switched event for the first tab

  // --- Other setup within .then() ---

  // Note: The close button listener is now attached in the separate DOMContentLoaded listener below.
  // The redundant nested listener block has been removed.

}).catch(err => {
  console.error('Error during initial setup:', err);
  workspacePanel.saveState = `Could not open session: ${err.message || err}`;
  workspacePanel.updateSessionStatus();
  const message = document.createElement('div');
  message.className = 'session-startup-error';
  message.setAttribute('role', 'alert');
  const text = document.createElement('p'); text.textContent = 'Could not open your saved session. Your saved tabs have not been replaced.';
  const retry = document.createElement('button'); retry.className = 'toolbar-btn'; retry.textContent = 'Retry';
  retry.addEventListener('click', () => window.location.reload());
  message.append(text, retry); contentContainer.append(message);
});


if (closeSummaryBtn && summaryPanel) {
  closeSummaryBtn.addEventListener('click', () => {
    summaryPanel.classList.add('hidden');
  });
}
