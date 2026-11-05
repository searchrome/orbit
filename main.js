const { app, BrowserWindow, ipcMain, session, webContents, safeStorage, dialog, powerSaveBlocker } = require('electron');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const crypto = require('crypto');
require('./desktop-bootstrap')(app);
const { JSDOM } = require('jsdom'); // Import JSDOM
const os = require('os'); // Import os module
const axios = require('axios'); // Added for DDG search
const cheerio = require('cheerio'); // Added for DDG parsing
const { YoutubeTranscript } = require('youtube-transcript'); // Added for YouTube transcripts
// Import all necessary functions from the AI service
const {
  getGeminiSummary,
  getBookmarkEnrichment,
  searchBookmarksWithAI,
  getCleanedPageContent,
  getRelatedStoryLinks,
  getAssistantNextAction: getAssistantNextActionOpenRouter
} = require('./openrouter-service');
const { getAssistantNextAction: getAssistantNextActionCli, configureBackend, parseCodexModel, CLAUDE_HAIKU_MODEL } = require('./claude-cli-service');
const BrowserRemoteService = require('./browser-remote-service');
const OpenCodeService = require('./opencode-service');
const ArtifactService = require('./artifact-service');
const TransformedViewService = require('./transformed-view-service');
const DlnaCastManager = require('./dlna-cast-manager');
const { extractVideoFromWebContents, extractSubtitlesFromWebContents } = require('./cast-media-extractor');
const { CastStreamRegistry } = require('./cast-stream-registry');
const { CastRelayService } = require('./cast-relay-service');
const { OpenSubtitlesService } = require('./opensubtitles-service');
const { cuesToSrt, parseWebVtt } = require('./subtitle-converter');

// Load .env values
function loadEnvFlag(key) {
    if (typeof process.env[key] === 'string') return process.env[key];
    try {
        const envPath = require('path').join(__dirname, '.env');
        const content = require('fs').readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith('#') || !trimmed.includes('=')) continue;
            const [k, ...rest] = trimmed.split('=');
            if (k.trim() === key) {
                return rest.join('=').trim().replace(/^["']|["']$/g, '');
            }
        }
    } catch { /* .env not found */ }
    return null;
}

// Determine AI backend: LLM=codex|claude|claude-haiku|openrouter (fallback: CLAUDE_CLI=true for backwards compat)
// claude-haiku uses the Claude CLI on the Claude subscription, pinned to Haiku 5.5 unless CLAUDE_HAIKU_MODEL overrides it.
const LLM_BACKEND = (loadEnvFlag('LLM') || '').toLowerCase();
const USE_CLI = LLM_BACKEND === 'claude' || LLM_BACKEND === 'claude-haiku' || LLM_BACKEND === 'codex' || loadEnvFlag('CLAUDE_CLI') === 'true';
const OPEN_CODE_TERMINAL_ENABLED = !/^(0|false|no|off)$/i.test(
  String(process.env.OPENCODE_TERMINAL_ENABLED ?? loadEnvFlag('OPENCODE_TERMINAL_ENABLED') ?? 'true')
);

// Configure CLI backend if active
if (USE_CLI) {
    const backend = LLM_BACKEND === 'codex' ? 'codex' : 'claude';
    if (backend === 'codex') {
        const { model, reasoningEffort } = parseCodexModel(loadEnvFlag('CODEX_MODEL'));
        configureBackend({ backend: 'codex', model, reasoningEffort });
    } else if (LLM_BACKEND === 'claude-haiku') {
        configureBackend({ backend: 'claude', model: loadEnvFlag('CLAUDE_HAIKU_MODEL') || CLAUDE_HAIKU_MODEL });
    } else {
        configureBackend({ backend: 'claude', model: loadEnvFlag('CLAUDE_MODEL') || null });
    }
}

const getAssistantNextAction = USE_CLI ? getAssistantNextActionCli : getAssistantNextActionOpenRouter;
const {
  registerAssistantPlannerRequest,
  clearAssistantPlannerRequest,
  abortAssistantPlannerRequest
} = require('./assistant-planner-requests');

// State variables
let tabNetworkBlockedState = {}; // Stores network blocked state per webContentsId { webContentsId: boolean }
let javascriptDisabled = false; // Global JS disable state (could be made per-tab if needed)
let cacheEnabled = false; // Default cache to OFF
let domainBlockingEnabled = true; // Default blocklist to ON
let blockedDomains = new Set(); // Set to store blocked domains
const monitoredNetworkSessions = new WeakSet();
const monitoredDownloadSessions = new WeakSet();
let nextDownloadId = 1;
const castStreamRegistry = new CastStreamRegistry();
const castRelayService = new CastRelayService();
// Extracted page captions live here between "extract" and "cast" IPC calls.
const castSubtitleStore = new Map();
const CAST_SUBTITLE_STORE_LIMIT = 4;
let castSubtitleTokenCounter = 0;

// Stores a subtitle entry under a one-shot token for the next cast call; the
// store is bounded so stale lookups cannot accumulate.
function storeCastSubtitleEntry(subtitles) {
  if (!subtitles?.found || !(subtitles.cues?.length || /^https?:\/\//i.test(subtitles.trackSrc || ''))) return '';
  castSubtitleTokenCounter += 1;
  const subtitleToken = `sub-${Date.now()}-${castSubtitleTokenCounter}`;
  castSubtitleStore.set(subtitleToken, { ...subtitles, createdAt: Date.now() });
  while (castSubtitleStore.size > CAST_SUBTITLE_STORE_LIMIT) {
    const oldest = [...castSubtitleStore.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    castSubtitleStore.delete(oldest[0]);
  }
  return subtitleToken;
}

let opensubtitlesService = null;
function ensureOpensubtitlesService() {
  if (!opensubtitlesService) {
    opensubtitlesService = new OpenSubtitlesService({ app, secretStorage: safeStorage });
  }
  return opensubtitlesService;
}

async function castSubtitlePayload(token, contents) {
    const entry = castSubtitleStore.get(String(token || ''));
    console.log(`[Cast] subtitle token ${String(token || '(none)')} → ${entry ? `found, cues=${entry.cues?.length || 0}` : 'NOT FOUND'}`);
    if (!entry) return null;
    // Not deleted on read: a picked subtitle stays valid for re-casts until the
    // bounded store evicts it.
    if (entry.cues?.length) {
        return { srt: cuesToSrt(entry.cues), language: entry.language || '' };
    }
    const trackUrl = entry.trackSrc || '';
    if (!/^https?:\/\//i.test(trackUrl) || !contents || contents.isDestroyed()) return null;
    try {
        const response = await contents.session.fetch(trackUrl);
        if (!response.ok) return null;
        const parsed = parseWebVtt(await response.text());
        return parsed.cues.length ? { srt: cuesToSrt(parsed.cues), language: entry.language || '' } : null;
    } catch {
        return null;
    }
}

const browserWindows = new Set();
const windowStartupSessions = new Map();
const windowSessionSnapshots = new Map();
let mainWindow; // Make mainWindow accessible outside createWindow
const assistantRuntimeLogPath = app.isPackaged
  ? path.join(app.getPath('userData'), 'logs', 'assistant-runtime.log')
  : path.join(__dirname, '.tmp', 'assistant-runtime.log');
const browserToolRequests = new Map();
let browserRemoteService = null;
let artifactService = null;
let transformedViewService = null;
let openCodeService = null;

function registerNetworkRequestMonitoring(targetSession) {
  if (!targetSession || monitoredNetworkSessions.has(targetSession)) return;
  monitoredNetworkSessions.add(targetSession);

  const filter = { urls: ['*://*/*'] };
  targetSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    if (domainBlockingEnabled && blockedDomains.size > 0) {
      try {
        const hostname = new URL(details.url).hostname.toLowerCase();
        for (const blockedDomain of blockedDomains) {
          if (hostname === blockedDomain || hostname.endsWith(`.${blockedDomain}`)) {
            console.log(`Blocking request to ${hostname} based on blocklist entry: ${blockedDomain}`);
            callback({ cancel: true });
            return;
          }
        }
      } catch (error) {
        console.warn(`Could not parse URL for blocking check: ${details.url}`, error);
      }
    }

    const isTabNetworkBlocked = tabNetworkBlockedState[details.webContentsId] === true;
    if (isTabNetworkBlocked) {
      console.log(`Blocking network request for tab ${details.webContentsId}: ${details.url}`);
      callback({ cancel: true });
      return;
    }

    callback({ cancel: false });
  });

  targetSession.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    castStreamRegistry.observeRequest(details);
    const requestHeaders = { ...(details.requestHeaders || {}) };
    if (!cacheEnabled) {
      requestHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
      requestHeaders.Pragma = 'no-cache';
      requestHeaders.Expires = '0';
      console.log('Added cache-bypassing headers for:', details.url);
    }
    callback({ requestHeaders });
  });

  targetSession.webRequest.onHeadersReceived(filter, (details, callback) => {
    castStreamRegistry.observeResponse(details, targetSession);
    if (mainWindow && details.responseHeaders) {
      const contentLengthHeader = Object.keys(details.responseHeaders).find(
        (header) => header.toLowerCase() === 'content-length'
      );
      if (contentLengthHeader && details.responseHeaders[contentLengthHeader][0]) {
        const size = parseInt(details.responseHeaders[contentLengthHeader][0], 10);
        if (!isNaN(size)) {
          mainWindow.webContents.send('network-request-data', size);
        }
      }
    }
    const responseHeaders = { ...(details.responseHeaders || {}) };
    if (javascriptDisabled && ['mainFrame', 'subFrame'].includes(details.resourceType)
        && webContents.fromId(details.webContentsId)?.getType() === 'webview') {
      // Append an independent CSP so a site's own policies remain in force.
      const key = Object.keys(responseHeaders).find(key => key.toLowerCase() === 'content-security-policy') || 'Content-Security-Policy';
      responseHeaders[key] = [...(responseHeaders[key] || []), "script-src 'none'; object-src 'none'"];
    }
    callback({ responseHeaders });
  });
}

function sendDownloadStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('download-status', payload);
  }
}

function registerDownloadMonitoring(targetSession) {
  if (!targetSession || monitoredDownloadSessions.has(targetSession)) return;
  monitoredDownloadSessions.add(targetSession);

  targetSession.on('will-download', (_event, item, sourceWebContents) => {
    const downloadId = `download-${nextDownloadId++}`;
    let lastProgressUpdate = 0;

    const buildPayload = (state) => {
      const totalBytes = Number(item.getTotalBytes?.()) || 0;
      const receivedBytes = Number(item.getReceivedBytes?.()) || 0;
      return {
        id: downloadId,
        filename: String(item.getFilename?.() || 'Download'),
        receivedBytes: Math.max(0, receivedBytes),
        totalBytes: Math.max(0, totalBytes),
        state,
        sourceWebContentsId: Number.isInteger(sourceWebContents?.id) ? sourceWebContents.id : null
      };
    };

    const report = (state = 'progressing', force = false) => {
      const now = Date.now();
      if (!force && now - lastProgressUpdate < 100) return;
      lastProgressUpdate = now;
      sendDownloadStatus(buildPayload(state));
    };

    report('progressing', true);
    item.on('updated', (_itemEvent, state) => report(state));
    item.once('done', (_itemEvent, state) => report(state, true));
  });
}

function appendAssistantRuntimeLog(event) {
  try {
    fsSync.mkdirSync(path.dirname(assistantRuntimeLogPath), { recursive: true });
    fsSync.appendFileSync(
      assistantRuntimeLogPath,
      `${JSON.stringify({
        ts: new Date().toISOString(),
        ...event
      })}\n`,
      'utf8'
    );
  } catch (error) {
    console.warn(`[Main] Could not write assistant runtime log: ${error?.message || error}`);
  }
}

function isHostBrowserEvent(event) {
  return !!(
    event &&
    [...browserWindows].some(window => !window.isDestroyed() && event.sender === window.webContents)
  );
}

function sendOpenCodeStatus(payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('opencode-terminal-status', payload);
  }
}

function sendOpenCodeOutput(data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('opencode-terminal-output', data);
  }
}

function isMutatingBrowserTool(tool) {
  return new Set([
    'open_tab', 'focus_tab', 'close_tab', 'navigate_tab',
    'click_element', 'press_and_hold', 'type_into', 'scroll_page', 'search_site',
    'create_transformed_view', 'update_transformed_view',
    'open_transformed_view', 'refresh_transformed_view'
  ]).has(tool);
}

function browserToolCancellationResult(tool, code, message, started = false) {
  const mutation = isMutatingBrowserTool(tool);
  return {
    ok: false,
    error: {
      code,
      message,
      retryable: code === 'browser_timeout' ? !mutation : false
    },
    actionMayHaveCompleted: mutation && started
  };
}

function cancelBrowserToolRequest(requestId, code, message) {
  const pending = browserToolRequests.get(requestId);
  if (!pending) return false;

  browserToolRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.signal?.removeEventListener('abort', pending.abortListener);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('browser-tool-cancel', { requestId, reason: message });
  }
  pending.resolve(browserToolCancellationResult(pending.tool, code, message, pending.started));
  return true;
}

function cancelAllBrowserToolRequests(code = 'browser_cancelled', message = 'Browser action was cancelled.') {
  for (const requestId of [...browserToolRequests.keys()]) {
    cancelBrowserToolRequest(requestId, code, message);
  }
}

function requestBrowserToolFromRenderer({ tool, args, timeoutMs = 30000, signal } = {}) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return Promise.resolve({
      ok: false,
      error: { code: 'browser_unavailable', message: 'The browser window is not available.', retryable: !isMutatingBrowserTool(tool) }
    });
  }
  if (signal?.aborted) {
    return Promise.resolve(browserToolCancellationResult(tool, 'browser_cancelled', String(signal.reason || 'Browser action was cancelled.')));
  }

  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      cancelBrowserToolRequest(requestId, 'browser_timeout', `Browser tool ${tool} timed out.`);
    }, Math.max(500, Math.min(Number(timeoutMs) || 30000, 30000)));

    const abortListener = () => {
      cancelBrowserToolRequest(requestId, 'browser_cancelled', String(signal.reason || 'Browser action was cancelled.'));
    };
    browserToolRequests.set(requestId, { resolve, timeout, signal, abortListener, tool, started: false });
    signal?.addEventListener('abort', abortListener, { once: true });
    mainWindow.webContents.send('browser-tool-request', { requestId, tool, args });
  });
}

function ensureArtifactService() {
  if (!artifactService) {
    artifactService = new ArtifactService({ app, requestBrowserTool: requestBrowserToolFromRenderer, logger: console });
  }
  return artifactService;
}

function ensureTransformedViewService() {
  if (!transformedViewService) {
    transformedViewService = new TransformedViewService({ app, logger: console });
  }
  return transformedViewService;
}

const dlnaCastManager = new DlnaCastManager();

async function getArtifactServiceForHost() {
  const service = ensureArtifactService();
  await service.start();
  return service;
}

function ensureOpenCodeServices() {
  if (!browserRemoteService) {
    browserRemoteService = new BrowserRemoteService({
      requestBrowserTool: requestBrowserToolFromRenderer,
      logger: console
    });
  }

  if (!openCodeService) {
    const artifacts = ensureArtifactService();
    openCodeService = new OpenCodeService({
      app,
      getBrowserRemoteConnection: () => browserRemoteService.start(),
      getArtifactConnection: () => artifacts.start(),
      cancelBrowserActions: () => cancelAllBrowserToolRequests('browser_cancelled', 'OpenCode session stopped; browser actions were cancelled.'),
      emitOutput: sendOpenCodeOutput,
      emitStatus: sendOpenCodeStatus,
      secretStorage: safeStorage,
      logger: console
    });
  }

  return openCodeService;
}

function getOpenRouterModelFromSetting(model) {
  const selectedModel = String(model || '').trim();
  return selectedModel.startsWith('openrouter/')
    ? selectedModel.slice('openrouter/'.length)
    : undefined;
}

async function getBookmarkAiOptions() {
  const service = ensureOpenCodeServices();
  const [settings, credential] = await Promise.all([
    service.getSettings(),
    service.getOpenRouterCredential()
  ]);

  return {
    model: getOpenRouterModelFromSetting(settings?.model),
    // Keep the key in the main process. The renderer receives only generated
    // metadata and never the credential itself.
    openRouterConfig: credential?.value ? { apiKey: credential.value } : undefined
  };
}

function normalizeBookmarkText(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

// Prevent multi-process launch collisions (common with repeated npm start calls).
// If another instance already owns the lock, this process exits immediately.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  console.error('[Main] Another browser instance is already running. Exiting duplicate process.');
  app.quit();
  process.exit(0);
}

// --- History File Path ---
const historyFilePath = path.join(app.getPath('userData'), 'browser-history.json');
const browserSessionFilePath = path.join(app.getPath('userData'), 'browser-session.json');
const BROWSER_SESSION_VERSION = 1;
let startupRecoverySession = null;
let startupCleanSession = null;
let browserSessionWrite = Promise.resolve();
let browserWindowCloseWrite = Promise.resolve();
console.log(`[Main] History file path: ${historyFilePath}`);

function sanitizeSessionTab(tab) {
  if (!tab || typeof tab !== 'object') return null;

  const url = typeof tab.url === 'string' ? tab.url.trim() : '';
  if (!url || url.length > 8192 || /^javascript:/i.test(url)) return null;

  return {
    id: typeof tab.id === 'string' ? tab.id.slice(0, 128) : '',
    url,
    group: typeof tab.group === 'string' ? tab.group.slice(0, 60) : '',
    title: typeof tab.title === 'string' ? tab.title.slice(0, 512) : 'Untitled',
    loadState: ['idle', 'loading', 'failed', 'crashed'].includes(tab.loadState) ? tab.loadState : 'idle',
    crashed: tab.crashed === true
  };
}

function sanitizeBrowserSession(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return { tabs: [], activeTabId: null };

  const tabs = Array.isArray(snapshot.tabs)
    ? snapshot.tabs.map(sanitizeSessionTab).filter(Boolean)
    : [];
  const knownTabIds = new Set(tabs.map((tab) => tab.id));
  const activeTabId = typeof snapshot.activeTabId === 'string' && knownTabIds.has(snapshot.activeTabId)
    ? snapshot.activeTabId
    : null;

  const groups = new Set(tabs.map(tab => tab.group).filter(Boolean));
  const collapsedGroups = Array.isArray(snapshot.collapsedGroups)
    ? [...new Set(snapshot.collapsedGroups.filter(group => groups.has(group)))] : [];
  return { tabs, activeTabId, collapsedGroups };
}

async function writeBrowserSession(record) {
  const tempPath = `${browserSessionFilePath}.${process.pid}.tmp`;
  await fs.mkdir(path.dirname(browserSessionFilePath), { recursive: true });
  await fs.writeFile(tempPath, JSON.stringify(record, null, 2), { mode: 0o600 });
  await fs.rename(tempPath, browserSessionFilePath);
}

function queueBrowserSessionWrite(record) {
  browserSessionWrite = browserSessionWrite
    .catch(() => {})
    .then(() => writeBrowserSession(record));
  return browserSessionWrite;
}

async function loadBrowserSession(status) {
  try {
    const record = JSON.parse(await fs.readFile(browserSessionFilePath, 'utf8'));
    if (record?.version !== BROWSER_SESSION_VERSION || record.status !== status) {
      return null;
    }

    return sanitizeBrowserSession(record.session);
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn(`[Main] Could not read browser session recovery data: ${error.message}`);
    }
    return null;
  }
}

async function loadInterruptedBrowserSession() {
  return loadBrowserSession('running');
}

async function loadCleanBrowserSession() {
  return loadBrowserSession('clean');
}

function saveRunningBrowserSession(snapshot) {
  const session = sanitizeBrowserSession(snapshot);
  return queueBrowserSessionWrite({
    version: BROWSER_SESSION_VERSION,
    status: 'running',
    updatedAt: Date.now(),
    session
  }).catch((error) => console.warn(`[Main] Could not save browser session recovery data: ${error.message}`));
}

function markBrowserSessionClean(snapshot) {
  const session = sanitizeBrowserSession(snapshot);
  // Dock activation creates a window in this same process. Refresh the in-memory
  // restore source as well as the disk journal before the closed window is destroyed.
  startupCleanSession = session;
  startupRecoverySession = null;
  return queueBrowserSessionWrite({
    version: BROWSER_SESSION_VERSION,
    status: 'clean',
    updatedAt: Date.now(),
    session
  }).catch((error) => console.warn(`[Main] Could not mark browser session as clean: ${error.message}`));
}

// --- History Loading/Saving Functions ---
async function loadHistoryFromFile() {
  console.log('[Main] Attempting to load history from file...');
  try {
    const data = await fs.readFile(historyFilePath, 'utf8');
    console.log('[Main] History file read successfully.');
    const history = JSON.parse(data);
    // Ensure each loaded entry has a 'bookmarked' property, default to false if missing
    history.forEach(entry => {
        if (typeof entry.bookmarked === 'undefined') {
            entry.bookmarked = false;
        }
    });
    return history;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.log('[Main] History file not found, returning empty history.');
      return []; // Return empty array if file doesn't exist
    }
    console.error('[Main] Failed to load history from file:', error);
    // Depending on desired behavior, you might re-throw or return empty
    return [];
  }
}

async function saveHistoryToFile(historyData) {
  console.log('[Main] Attempting to save history to file...');
  try {
    // Ensure the directory exists
    await fs.mkdir(path.dirname(historyFilePath), { recursive: true });
    // Ensure the bookmarked property is included when stringifying
    await fs.writeFile(historyFilePath, JSON.stringify(historyData, null, 2), 'utf8');
    console.log('[Main] History saved to file successfully.');
  } catch (error) {
    console.error('[Main] Failed to save history to file:', error);
    // Handle error appropriately (e.g., notify user)
  }
}


// --- Blocklist Loading ---
async function loadBlocklist() {
  console.log('Attempting to load blocklist...');
  try {
    const data = await fs.readFile(path.join(__dirname, 'block.list'), 'utf8');
    const domains = data.split(/\r?\n/) // Split by lines
                       .map(line => line.trim().toLowerCase()) // Trim whitespace, convert to lowercase
                       .filter(line => line && !line.startsWith('#')); // Remove empty lines and comments
    blockedDomains = new Set(domains);
    console.log(`Blocklist loaded successfully. ${blockedDomains.size} domains added.`);
  } catch (error) {
    console.error('Failed to load or parse block.list:', error);
    // Keep the set empty or handle the error as appropriate
    blockedDomains.clear();
  }
}

function createWindow(namedSession = null) {
  // Create the browser window.
  const shellWindow = new BrowserWindow({ // Assign to the outer scope variable
    icon: path.join(__dirname, 'icons/orbit.png'),
    width: 1280,
    height: 768,
    webPreferences: {
      // Attach the preload script
      preload: path.join(__dirname, 'preload.js'),
      // Enable the <webview> tag
      webviewTag: true,
      // It's generally safer to disable nodeIntegration in the renderer process
      // and use the preload script to expose specific functionality.
      nodeIntegration: false,
      contextIsolation: true,
      additionalArguments: ['--browser-host-renderer'],
    },
  });

  browserWindows.add(shellWindow);
  if (!mainWindow) mainWindow = shellWindow;
  const shellContentsId = shellWindow.webContents.id;
  if (namedSession) windowStartupSessions.set(shellContentsId, namedSession);

  // Load index.html into the main window.
  shellWindow.loadFile(path.join(__dirname, 'index.html'));

  // Open the DevTools (optional, useful for debugging)
  // shellWindow.webContents.openDevTools();

  // Handle window close event to save open tabs
  shellWindow.on('close', (event) => {
    console.log('[Main] shellWindow close event received. Requesting renderer to save open tabs.');
    // Prevent default close
    event.preventDefault();
    // Send IPC message to renderer to save open tabs
    if (shellWindow && !shellWindow.isDestroyed() && shellWindow.webContents && !shellWindow.webContents.isDestroyed()) {
      shellWindow.webContents.send('save-open-tabs');
    } else {
      console.warn('[Main] shellWindow or webContents destroyed during close event. Cannot send save-open-tabs IPC. Allowing default close.');
      // If window is already destroyed, allow default close (which might be happening anyway)
      // Or, if we prevented default, we might need a different way to force close.
      // For now, let's re-enable default to see if it helps.
      // event.preventDefault() was called, so we need to explicitly close.
      // Let's try destroying the window directly if we can't send the message.
      if (shellWindow && !shellWindow.isDestroyed()) {
         shellWindow.destroy(); // Force destroy if we can't save
      }
    }
  });


  shellWindow.on('closed', () => {
    browserWindows.delete(shellWindow);
    windowStartupSessions.delete(shellContentsId);
    windowSessionSnapshots.delete(shellContentsId);
    if (mainWindow === shellWindow) mainWindow = [...browserWindows][0] || null;
    if (browserWindows.size) return;
    if (quitController.requested) {
      quitController.onWindowsChanged();
      return;
    }
    cancelAllBrowserToolRequests('browser_closed', 'The browser window closed.');
    openCodeService?.stop().catch((error) => console.warn(`[OpenCode] Window-close cleanup failed: ${error?.message || error}`));
    browserRemoteService?.stop().catch(() => {});
    endCastPowerSaveBlocker();

  });

  return shellWindow;
}

  // --- WebContents Lifecycle Listener (for cleanup) ---
  app.on('web-contents-created', (event, contents) => {
    // Listen for when a webContents is destroyed (e.g., tab closed)
    contents.on('destroyed', () => {
      console.log(`WebContents ${contents.id} destroyed, cleaning up network state.`);
      delete tabNetworkBlockedState[contents.id]; // Remove its network state entry
      castStreamRegistry.forgetWebContents(contents.id);
    });

    // Page links that request a new window (including target=_blank) are not
    // allowed to create arbitrary Electron windows. Route safe HTTP(S) links
    // back to the host so it can create one managed browser tab instead.
    if (contents.getType?.() !== 'webview' || typeof contents.setWindowOpenHandler !== 'function') {
      return;
    }
    contents.setWindowOpenHandler(({ url, disposition }) => {
      let safeUrl = null;
      try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
          safeUrl = parsed.href;
        }
      } catch {
        // Invalid and non-web URL schemes are deliberately denied.
      }

      const owner = contents.hostWebContents;
      if (safeUrl && owner && !owner.isDestroyed()) {
        owner.send('guest-open-link', {
          sourceWebContentsId: contents.id,
          url: safeUrl,
          activate: disposition !== 'background-tab'
        });
      }
      return { action: 'deny' };
    });
  });

// --- IPC Handlers ---
// IMPORTANT: Register handlers BEFORE app is ready and window is created
console.log('[Main] Registering IPC handlers...'); // ADDED LOG

ipcMain.on('assistant-runtime-log', (event, payload) => {
  if (event?.sender?.getType?.() !== 'window') {
    return;
  }

  appendAssistantRuntimeLog(payload && typeof payload === 'object' ? payload : { payload });
});

// IPC handler to load history
ipcMain.handle('load-history', async () => {
  console.log('[Main] Received load-history IPC request.');
  return await loadHistoryFromFile();
});

const WorkspaceStore = require('./workspace-store');
const workspaceStore = new WorkspaceStore(path.join(app.getPath('userData'), 'named-sessions.json'), snapshot => {
  const clean = sanitizeBrowserSession(snapshot);
  clean.tabs = Array.isArray(snapshot?.tabs) ? snapshot.tabs.map(sanitizeSessionTab).filter(Boolean) : [];
  clean.tabs = clean.tabs.filter(tab => /^(https?:\/\/|about:blank$|browser:\/\/view\/)/i.test(tab.url));
  return clean;
});
for (const [channel, handler] of Object.entries({
  'workspace-list': () => workspaceStore.list(),
  'workspace-save': payload => workspaceStore.save(payload),
  'workspace-delete': payload => workspaceStore.delete(payload?.id),
  'workspace-open-window': async payload => {
    const saved = (await workspaceStore.list()).find(item => item.id === payload?.id);
    if (!saved) throw new Error('Session no longer exists.');
    createWindow(saved.session);
    return { opened: true };
  }
})) {
  ipcMain.handle(channel, (event, payload) => {
    if (!isHostBrowserEvent(event)) throw new Error('Sessions are restricted to browser windows.');
    return handler(payload);
  });
}

ipcMain.handle('get-startup-session', (event) => {
  if (isHostBrowserEvent(event) && windowStartupSessions.has(event.sender.id)) {
    return { namedSession: true, interrupted: false, session: windowStartupSessions.get(event.sender.id) };
  }
  // `event.sender === mainWindow.webContents` is the authoritative host
  // identity. getType() is not stable across Electron's startup lifecycle and
  // caused recovery IPC to be rejected on the browser's own renderer.
  if (!mainWindow || mainWindow.isDestroyed() || event?.sender !== mainWindow.webContents) {
    return { interrupted: false, session: { tabs: [], activeTabId: null } };
  }

  return {
    interrupted: !!startupRecoverySession,
    session: startupRecoverySession || startupCleanSession || { tabs: [], activeTabId: null }
  };
});

ipcMain.on('browser-session-state', (event, snapshot) => {
  if (!isHostBrowserEvent(event)) return;
  const session = sanitizeBrowserSession(snapshot);
  windowSessionSnapshots.set(event.sender.id, session);
  if (event.sender === mainWindow?.webContents) void saveRunningBrowserSession(session);
});

// IPC handler to save history
ipcMain.on('save-history', async (event, historyData) => {
  console.log('[Main] Received save-history IPC request.');
  await saveHistoryToFile(historyData);
  // Optionally send a confirmation back to the renderer if needed,
  // but for now, the renderer will just proceed after sending.
});

ipcMain.on('toggle-network', (event, webContentsId) => {
  if (webContentsId === undefined || webContentsId === null) {
    console.error('toggle-network IPC received without webContentsId');
    return;
  }
  tabNetworkBlockedState[webContentsId] = !(tabNetworkBlockedState[webContentsId] === true);
  const newState = tabNetworkBlockedState[webContentsId];
  console.log(`Network blocking for tab ${webContentsId} toggled: ${newState}`);
  event.sender.send('network-status', webContentsId, newState);
});

ipcMain.on('set-network-status-for-tab', (event, webContentsId, isBlocked) => {
  if (webContentsId === undefined || webContentsId === null) {
    console.error('set-network-status-for-tab IPC received without webContentsId');
    return;
  }
  tabNetworkBlockedState[webContentsId] = !!isBlocked;
  console.log(`Network blocking for tab ${webContentsId} explicitly set to: ${tabNetworkBlockedState[webContentsId]}`);
  event.sender.send('network-status', webContentsId, tabNetworkBlockedState[webContentsId]);
});

ipcMain.on('toggle-cache', async (event) => {
  cacheEnabled = !cacheEnabled;
  console.log(`Cache enabled toggled: ${cacheEnabled}`);
  if (!cacheEnabled) {
    try {
      const browserSessions = [session.defaultSession, session.fromPartition('transformed-view-source')];
      await Promise.all(browserSessions.map(async (targetSession) => {
        await targetSession.clearCache();
        await targetSession.clearStorageData({
          storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
        });
      }));
      console.log('Cleared HTTP cache and storage for browser and transformed source sessions.');
    } catch (error) {
      console.error('Failed to clear cache or storage:', error);
    }
  }
  event.sender.send('cache-status', cacheEnabled);
});

ipcMain.on('toggle-js', (event) => {
  javascriptDisabled = !javascriptDisabled;
  console.log(`JavaScript disabling toggled: ${javascriptDisabled}`);
  for (const window of browserWindows) {
    window.webContents.send('js-status', javascriptDisabled);
    window.webContents.send('set-js-status', javascriptDisabled);
  }
});

ipcMain.on('toggle-domain-blocking', async (event) => {
  domainBlockingEnabled = !domainBlockingEnabled;
  console.log(`Domain blocking toggled: ${domainBlockingEnabled}`);
  event.sender.send('domain-blocking-status', domainBlockingEnabled);
});

ipcMain.handle('get-initial-status', async (event) => {
  return {
    javascriptDisabled,
    cacheEnabled,
    domainBlockingEnabled,
    aiBackend: USE_CLI ? (LLM_BACKEND === 'codex' ? 'codex-cli' : LLM_BACKEND === 'claude-haiku' ? 'claude-haiku-cli' : 'claude-cli') : 'openrouter',
    openCodeTerminalEnabled: OPEN_CODE_TERMINAL_ENABLED
  };
});

ipcMain.handle('transformed-view-list', async (event) => {
  if (!isHostBrowserEvent(event)) throw new Error('Transformed views are restricted to the host browser window.');
  return ensureTransformedViewService().list();
});

ipcMain.handle('transformed-view-get', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Transformed views are restricted to the host browser window.');
  return ensureTransformedViewService().get(payload?.id);
});

ipcMain.handle('transformed-view-create', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Transformed views are restricted to the host browser window.');
  return ensureTransformedViewService().create(payload || {});
});

ipcMain.handle('transformed-view-update', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Transformed views are restricted to the host browser window.');
  return ensureTransformedViewService().update(payload || {});
});

ipcMain.handle('transformed-view-record-success', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Transformed views are restricted to the host browser window.');
  await ensureTransformedViewService().recordSuccess(payload?.id, payload?.sourceUrl);
  return { ok: true };
});

ipcMain.handle('bookmark-enrich', async (event, payload) => {
  if (!isHostBrowserEvent(event)) {
    throw new Error('Bookmark enrichment is restricted to the host browser window.');
  }

  const url = normalizeBookmarkText(payload?.url, 2_000);
  const title = normalizeBookmarkText(payload?.title, 500);
  const content = normalizeBookmarkText(payload?.content, 30_000);
  if (!url || !content) {
    throw new Error('A readable page is required to create a bookmark definition.');
  }

  return getBookmarkEnrichment({ url, title, content }, await getBookmarkAiOptions());
});

ipcMain.handle('bookmark-search', async (event, payload) => {
  if (!isHostBrowserEvent(event)) {
    throw new Error('Bookmark search is restricted to the host browser window.');
  }

  const query = normalizeBookmarkText(payload?.query, 500);
  if (!query) {
    throw new Error('Enter a bookmark search query.');
  }

  const bookmarks = (await loadHistoryFromFile())
    .filter((entry) => entry?.bookmarked && entry.url && entry.url !== 'about:blank');
  const result = await searchBookmarksWithAI(query, bookmarks, await getBookmarkAiOptions());
  const bookmarksByUrl = new Map(bookmarks.map((bookmark) => [bookmark.url, bookmark]));
  const matches = result.matches.map((match) => {
    const record = result.records[match.id];
    const bookmark = bookmarksByUrl.get(record.url);
    return {
      url: record.url,
      title: bookmark?.title || record.title,
      lastOpened: bookmark?.lastOpened || null,
      bookmarkDefinition: bookmark?.bookmarkDefinition || record.definition,
      bookmarkSummary: bookmark?.bookmarkSummary || record.summary,
      bookmarkKeywords: bookmark?.bookmarkKeywords || record.keywords,
      reason: match.reason
    };
  });

  return { matches, searchedCount: result.records.length };
});

ipcMain.handle('opencode-terminal-get-settings', async (event) => {
  if (!isHostBrowserEvent(event)) {
    throw new Error('OpenCode terminal settings are restricted to the host browser window.');
  }
  return ensureOpenCodeServices().getSettings();
});

ipcMain.handle('opencode-terminal-save-settings', async (event, payload) => {
  if (!isHostBrowserEvent(event)) {
    throw new Error('OpenCode terminal settings are restricted to the host browser window.');
  }
  return ensureOpenCodeServices().saveSettings(payload || {});
});

ipcMain.handle('opencode-terminal-start', async (event, payload) => {
  if (!OPEN_CODE_TERMINAL_ENABLED) {
    throw new Error('OpenCode terminal is disabled by OPENCODE_TERMINAL_ENABLED.');
  }
  if (!isHostBrowserEvent(event)) {
    throw new Error('OpenCode terminal is restricted to the host browser window.');
  }
  return ensureOpenCodeServices().start(payload || {});
});

ipcMain.handle('opencode-terminal-stop', async (event) => {
  if (!isHostBrowserEvent(event)) {
    throw new Error('OpenCode terminal is restricted to the host browser window.');
  }
  return ensureOpenCodeServices().stop();
});

ipcMain.handle('opencode-session-files-list', async (event) => {
  if (!OPEN_CODE_TERMINAL_ENABLED || !isHostBrowserEvent(event)) {
    throw new Error('OpenCode session files are restricted to the host browser window.');
  }
  return ensureOpenCodeServices().listUploadedFiles();
});

ipcMain.handle('opencode-session-files-upload', async (event) => {
  if (!OPEN_CODE_TERMINAL_ENABLED || !isHostBrowserEvent(event)) {
    throw new Error('OpenCode session files are restricted to the host browser window.');
  }
  const openCode = ensureOpenCodeServices();
  // Validate before opening the native picker, so an upload cannot be staged
  // against a stopped or non-existent session.
  const activeSession = await openCode.listUploadedFiles();
  const selection = await dialog.showOpenDialog(mainWindow, {
    title: 'Upload task files for this OpenCode session',
    buttonLabel: 'Upload files',
    properties: ['openFile', 'multiSelections']
  });
  if (selection.canceled || selection.filePaths.length === 0) {
    return openCode.listUploadedFiles();
  }
  return openCode.uploadFiles(selection.filePaths, { sessionId: activeSession.sessionId });
});

ipcMain.handle('opencode-artifacts-list', async (event) => {
  if (!OPEN_CODE_TERMINAL_ENABLED || !isHostBrowserEvent(event)) {
    throw new Error('Artifacts are restricted to the host browser window.');
  }
  return (await getArtifactServiceForHost()).tool({ tool: 'list_artifacts' });
});

ipcMain.handle('opencode-artifacts-open', async (event, payload) => {
  if (!OPEN_CODE_TERMINAL_ENABLED || !isHostBrowserEvent(event)) {
    throw new Error('Artifacts are restricted to the host browser window.');
  }
  return (await getArtifactServiceForHost()).open(payload?.id);
});

ipcMain.handle('opencode-artifacts-download', async (event, payload) => {
  if (!OPEN_CODE_TERMINAL_ENABLED || !isHostBrowserEvent(event)) {
    throw new Error('Artifacts are restricted to the host browser window.');
  }
  // This handler is called by a direct click in the host UI, which is the
  // explicit approval required before a download reaches the user's system.
  return (await getArtifactServiceForHost()).download(payload?.id);
});

ipcMain.handle('opencode-artifacts-delete', async (event, payload) => {
  if (!OPEN_CODE_TERMINAL_ENABLED || !isHostBrowserEvent(event)) {
    throw new Error('Artifacts are restricted to the host browser window.');
  }
  // The host renderer shows a confirmation dialog before this IPC request.
  return (await getArtifactServiceForHost()).remove(payload?.id);
});

ipcMain.handle('cast-discover-devices', async (event) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  return dlnaCastManager.discoverDevices();
});

ipcMain.handle('cast-extract-video', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  const webContentsId = Number(payload?.webContentsId);
  const contents = Number.isInteger(webContentsId) ? webContents.fromId(webContentsId) : null;
  if (!contents || contents.isDestroyed() || contents.getType?.() !== 'webview') {
    throw new Error('The active browser tab is no longer available for casting.');
  }
  const [extraction, subtitles] = await Promise.all([
    extractVideoFromWebContents(contents),
    extractSubtitlesFromWebContents(contents).catch(() => ({ found: false, trackSrc: '', label: '', language: '', cues: [] }))
  ]);
  const subtitleToken = storeCastSubtitleEntry(subtitles);
  return {
    ...extraction,
    relayStream: castStreamRegistry.publicInfo(webContentsId),
    subtitles: {
      available: !!subtitleToken,
      token: subtitleToken,
      language: subtitles.language || '',
      label: subtitles.label || '',
      cueCount: subtitles.cues?.length || 0
    }
  };
});

ipcMain.handle('cast-get-settings', async (event) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  return ensureOpensubtitlesService().getSettings();
});

ipcMain.handle('cast-save-settings', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  return ensureOpensubtitlesService().saveSettings(payload || {});
});

// OpenSubtitles: the search is user-editable and the user picks a result; the
// chosen file is downloaded, parsed, and staged under a one-shot token so the
// next cast serves it beside the video like a page caption.
ipcMain.handle('cast-subtitle-search', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  return ensureOpensubtitlesService().search(payload || {});
});

ipcMain.handle('cast-subtitle-download', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  const service = ensureOpensubtitlesService();
  const fileId = Number(payload?.fileId);
  if (!Number.isInteger(fileId)) throw new Error('Pick a subtitle result first.');
  const srtText = await service.downloadSrt(fileId);
  const { cues } = parseWebVtt(srtText);
  if (!cues.length) throw new Error('That subtitle had no usable cues — pick another one.');
  const label = String(payload?.label || '');
  const token = storeCastSubtitleEntry({ found: true, cues, language: String(payload?.language || ''), label });
  if (!token) throw new Error('That subtitle had no usable cues — pick another one.');
  return { available: true, token, label, language: String(payload?.language || ''), cueCount: cues.length };
});

let castStartInFlight = false;

// While a cast is running the machine must not fall asleep — the relay is
// serving media to the TV. 'prevent-app-suspension' keeps the system awake but
// still lets the display turn off on its own schedule, so the screen sleeping
// does not interrupt playback.
let castPowerSaveBlockerId = null;

function beginCastPowerSaveBlocker() {
  if (castPowerSaveBlockerId === null || !powerSaveBlocker.isStarted(castPowerSaveBlockerId)) {
    castPowerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
    console.log('[Cast] power save blocker started: system stays awake, display may sleep.');
  }
}

function endCastPowerSaveBlocker() {
  if (castPowerSaveBlockerId !== null && powerSaveBlocker.isStarted(castPowerSaveBlockerId)) {
    powerSaveBlocker.stop(castPowerSaveBlockerId);
    console.log('[Cast] power save blocker stopped.');
  }
  castPowerSaveBlockerId = null;
}

ipcMain.handle('cast-relay-video', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  if (castStartInFlight) throw new Error('A cast is already starting. Wait a few seconds, or stop it before casting again.');
  castStartInFlight = true;
  try {
    return await startRelayCast(payload, event.sender);
  } finally {
    castStartInFlight = false;
  }
});

async function startRelayCast(payload, sender = null) {
  const webContentsId = Number(payload?.webContentsId);
  const contents = Number.isInteger(webContentsId) ? webContents.fromId(webContentsId) : null;
  if (!contents || contents.isDestroyed() || contents.getType?.() !== 'webview') {
    throw new Error('The active browser tab is no longer available for casting.');
  }
  const stream = castStreamRegistry.bestForWebContents(webContentsId);
  if (!stream) throw new Error('No recent compatible stream was found. Start the video, wait a moment, then try again.');
  beginCastPowerSaveBlocker();
  // Stable identity for the capture cache: signed URLs and query strings
  // rotate on every fetch, so they are stripped; the page, the path and the
  // subtitle choice identify the content.
  const stableUrl = (() => {
    try {
      const parsed = new URL(stream.url);
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch {
      return String(stream.url || '');
    }
  })();
  const pageUrl = contents.getURL?.() || '';
  const cacheKeyBase = crypto.createHash('sha1').update(
    `${pageUrl}|${stableUrl}|${stream.kind || ''}|subs:${payload?.subtitleToken ? 'custom' : 'none'}`
  ).digest('hex');
  // The subtitle payload is fetched before the relay starts: it stages the SRT
  // for embedding into the remux AND for the DLNA sidecar.
  const subtitlePayload = await castSubtitlePayload(payload?.subtitleToken, contents).catch(() => null);
  const relay = await castRelayService.start(stream, { cacheKeyBase });
  let subtitleUrl = '';
  let subtitleFile = '';
  try {
    if (subtitlePayload?.srt) {
      try {
        subtitleUrl = await castRelayService.serveSubtitle(subtitlePayload.srt);
      } catch {
        subtitleUrl = '';
      }
      try {
        subtitleFile = path.join(os.tmpdir(), `cast-sub-${Date.now()}.srt`);
        // main.js aliases fs to require('fs').promises — no nested .promises.
        await fs.writeFile(subtitleFile, subtitlePayload.srt, 'utf8');
      } catch (error) {
        console.log(`[Cast] subtitle temp file write failed: ${error?.message || error}`);
        subtitleFile = '';
      }
    }
    castRelayService.prewarmCapture(subtitleFile);
    console.log(`[Cast] subtitle payload: srt=${subtitlePayload?.srt?.length || 0} bytes, temp file=${subtitleFile || '(none)'}`);
    // Hold the ENTIRE handoff back — SetAVTransportURI included — until the
    // local capture finishes. Renderers like AirScreen probe the media URL the
    // moment the Set lands, and a still-growing MP4 has no moov atom yet (the
    // faststart seek table is written when ffmpeg finalizes the file), so an
    // early Set makes them report "unsupported media format". Once the capture
    // is complete the TV fetches a finite, seekable file.
    // The TV must only receive a FINISHED, seekable MP4: a partial faststart
    // file has no moov atom and no renderer can play it (the Samsung spins and
    // then reports a connection error). Long VODs take minutes to capture, so
    // wait for real completion with a stall watchdog, and stream progress to
    // the panel so the wait is visible.
    const PREPARE_DEADLINE_MS = 20 * 60 * 1000;
    const PREPARE_STALL_MS = 60000;
    const prepareStarted = Date.now();
    let lastSize = -1;
    let lastGrowthAt = Date.now();
    let lastReportAt = 0;
    while (true) {
      if (!castRelayService.hasActiveRoute()) {
        throw new Error('The cast was stopped while the video was being prepared.');
      }
      const status = castRelayService.captureStatus();
      if (status.ended) break;
      if (Date.now() - prepareStarted > PREPARE_DEADLINE_MS) {
        throw new Error('Preparing this video took too long. Try again, or pick a shorter video.');
      }
      if (status.size > lastSize) {
        lastSize = status.size;
        lastGrowthAt = Date.now();
      } else if (Date.now() - lastGrowthAt > PREPARE_STALL_MS) {
        throw new Error('The video source stopped responding while the video was being prepared.');
      }
      if (sender && !sender.isDestroyed() && Date.now() - lastReportAt > 2000) {
        lastReportAt = Date.now();
        const progress = castRelayService.castProgress();
        if (progress) sender.send('cast-progress', progress);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    // A capture that died (or produced no real output) must not be handed to
    // the TV: renderers just show a generic "An error occurred". Fail here so
    // the panel reports the actual remuxer problem instead.
    const capture = castRelayService.captureStatus();
    if (capture.hasCapture && capture.ended && (capture.error || capture.size < 4096)) {
      const detail = String(capture.error || 'the remuxer produced no output.').split('\n').slice(-1)[0].slice(0, 200);
      console.log(`[Cast] capture failed: size=${capture.size} err=${detail}`);
      throw new Error(`The video could not be prepared for the TV — ${detail}`);
    }
    await dlnaCastManager.setVideo(payload?.device, relay.url, {
      title: String(payload?.title || 'Video from Entrim Browser'),
      mimeType: relay.mimeType,
      protocolInfo: relay.protocolInfo,
      duration: relay.duration,
      subtitleUrl
    });
    const playResult = await dlnaCastManager.play(payload?.device);
    return { ...playResult, reused: !!relay.cached };
  } catch (error) {
    await castRelayService.stop();
    endCastPowerSaveBlocker();
    throw error;
  }
}

ipcMain.handle('cast-video', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  if (castStartInFlight) throw new Error('A cast is already starting. Wait a few seconds, or stop it before casting again.');
  castStartInFlight = true;
  beginCastPowerSaveBlocker();
  try {
    const subtitlePayload = await castSubtitlePayload(payload?.subtitleToken, null);
    await castRelayService.stop();
    let subtitleUrl = '';
    if (subtitlePayload?.srt) {
      try {
        subtitleUrl = await castRelayService.serveSubtitle(subtitlePayload.srt);
      } catch {
        subtitleUrl = '';
      }
    }
    return await dlnaCastManager.castVideo(payload?.device, payload?.videoUrl, { ...(payload?.metadata || {}), subtitleUrl });
  } catch (error) {
    endCastPowerSaveBlocker();
    throw error;
  } finally {
    castStartInFlight = false;
  }
});

ipcMain.handle('cast-stop', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  try {
    if (payload?.device) return await dlnaCastManager.stop(payload.device);
    return { ok: true };
  } finally {
    await castRelayService.stop();
    endCastPowerSaveBlocker();
  }
});

ipcMain.handle('cast-play', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  return dlnaCastManager.play(payload?.device);
});

ipcMain.handle('cast-pause', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  return dlnaCastManager.pause(payload?.device);
});

ipcMain.handle('cast-seek', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  return dlnaCastManager.seek(payload?.device, payload?.seconds);
});

ipcMain.handle('cast-status', async (event, payload) => {
  if (!isHostBrowserEvent(event)) throw new Error('Casting is restricted to the host browser window.');
  const status = await dlnaCastManager.getStatus(payload?.device);
  // The renderer treats these states as "the TV stopped playback" and tears
  // its session down; release the wake lock here so the machine can sleep
  // again even when the user never pressed Stop.
  if (status?.state === 'STOPPED' || status?.state === 'NO_MEDIA_PRESENT') {
    endCastPowerSaveBlocker();
  }
  return status;
});

ipcMain.on('opencode-terminal-input', (event, data) => {
  if (!isHostBrowserEvent(event)) {
    return;
  }
  try {
    ensureOpenCodeServices().write(data);
  } catch (error) {
    sendOpenCodeStatus({ state: 'error', message: error?.message || String(error) });
  }
});

ipcMain.on('opencode-terminal-resize', (event, payload) => {
  if (!isHostBrowserEvent(event)) {
    return;
  }
  ensureOpenCodeServices().resize(payload?.cols, payload?.rows);
});

ipcMain.on('browser-tool-response', (event, payload) => {
  if (!isHostBrowserEvent(event)) {
    return;
  }
  const requestId = String(payload?.requestId || '');
  const pending = browserToolRequests.get(requestId);
  if (!pending) {
    return;
  }
  browserToolRequests.delete(requestId);
  clearTimeout(pending.timeout);
  pending.signal?.removeEventListener('abort', pending.abortListener);
  pending.resolve(payload?.result && typeof payload.result === 'object'
    ? payload.result
    : { ok: false, error: { code: 'invalid_browser_response', message: 'Browser returned an invalid tool response.' } });
});

ipcMain.on('browser-tool-started', (event, payload) => {
  if (!isHostBrowserEvent(event)) {
    return;
  }
  const requestId = String(payload?.requestId || '');
  const pending = browserToolRequests.get(requestId);
  if (pending) {
    pending.started = true;
  }
});

ipcMain.handle('assistant-next-action', async (event, payload) => {
  console.log('[Main] Received assistant-next-action request.');
  if (event?.sender?.getType?.() !== 'window') {
    throw new Error('assistant-next-action is restricted to the host browser window.');
  }
  const requestId = String(payload?.requestId || '');
  if (!requestId) {
    throw new Error('assistant-next-action requires a requestId.');
  }
  const sessionId = String(payload?.sessionId || 'default');

  const controller = new AbortController();
  const defaultTimeout = USE_CLI ? 120000 : 30000;
  const timeoutMs = Number.isFinite(payload?.timeoutMs) && payload.timeoutMs > 0
    ? Math.floor(payload.timeoutMs)
    : defaultTimeout;

  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Planner request timed out after ${timeoutMs}ms.`));
  }, timeoutMs);

  registerAssistantPlannerRequest({
    requestId,
    sessionId,
    controller,
    timeoutId
  });

  try {
    return await getAssistantNextAction({
      ...payload,
      signal: controller.signal
    });
  } finally {
    clearAssistantPlannerRequest(requestId, controller);
  }
});

ipcMain.on('assistant-abort-next-action', (event, payload) => {
  if (event?.sender?.getType?.() !== 'window') {
    throw new Error('assistant-abort-next-action is restricted to the host browser window.');
  }

  const requestId = String(payload?.requestId || '');
  if (!requestId) {
    return;
  }

  abortAssistantPlannerRequest(requestId, new Error('Assistant task stopped by the user.'));
});

ipcMain.on('summarize-content', async (event, pageContent) => {
  if (!pageContent) {
    console.error('Received summarize-content request with no content.');
    event.sender.send('summary-result', '<p>Error: No content provided for summarization.</p>');
    return;
  }
  console.log('Received summarize-content request, calling OpenRouter API...');
  try {
    const summary = await getGeminiSummary(pageContent);
    const formattedSummary = summary.replace(/\n/g, '<br>');
    console.log('Successfully received summary from OpenRouter.');
    event.sender.send('summary-result', `<p><b>AI Summary:</b></p><p>${formattedSummary}</p>`);
  } catch (error) {
    console.error('Error getting summary from OpenRouter:', error);
    event.sender.send('summary-result', `<p>Error getting summary: ${error.message}</p>`);
  }
});

// --- AI Page Cleanup Handler (Corrected Version) ---
ipcMain.on('request-page-cleanup', async (event, webContentsId) => {
  console.log(`[Main] request-page-cleanup HANDLER INVOKED for webContentsId: ${webContentsId}`);
  if (webContentsId === undefined || webContentsId === null) {
    console.error('[Main] Invalid webContentsId received.');
    event.sender.send('cleanup-result', null);
    return;
  }

  const contents = webContents.fromId(webContentsId);
  if (!contents) {
    console.error(`[Main] Could not find webContents for ID: ${webContentsId}`);
    event.sender.send('cleanup-result', null);
    return;
  }

  console.log(`[Main] Found webContents for ID: ${webContentsId}. Getting source HTML...`);
  try {
    const pageHtml = await contents.executeJavaScript('document.documentElement.outerHTML');
    console.log(`[Main] Got original page HTML (length: ${pageHtml?.length}).`);

    if (!pageHtml) {
      console.error('[Main] Failed to get page HTML content (result was empty).');
      event.sender.send('cleanup-result', null);
      return;
    }

    // Pre-clean HTML (remove scripts/styles before sending to the AI service)
    let preCleanedHtml = pageHtml.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
    preCleanedHtml = preCleanedHtml.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
    console.log(`[Main] Pre-cleaned HTML length: ${preCleanedHtml.length}`);

    // --- Make parallel calls to the AI service ---
    console.log('[Main] Requesting main content selector and related links from OpenRouter...');
    let selectorString, relatedLinks;
    try {
      const [selectorResult, linksResult] = await Promise.all([
        getCleanedPageContent(preCleanedHtml),
        getRelatedStoryLinks(preCleanedHtml) // Call the new function
      ]);

      selectorString = selectorResult;
      relatedLinks = linksResult; // Should be an array of {title, href} or empty array

      console.log(`[Main] Received selector string: "${selectorString}"`);
      console.log(`[Main] Received ${relatedLinks.length} related links.`);

      if (!selectorString || typeof selectorString !== 'string') {
        throw new Error('Invalid selector received from OpenRouter service.');
      }
      if (!Array.isArray(relatedLinks)) {
        console.warn('[Main] Received non-array for related links, treating as empty.');
        relatedLinks = [];
      }

    } catch (aiError) {
      console.error('[Main] Error calling AI service(s):', aiError);
      throw new Error(`Failed to get required data from OpenRouter: ${aiError.message}`);
    }
    // --- End parallel calls ---


    // Parse original HTML with JSDOM
    const dom = new JSDOM(pageHtml);
    const document = dom.window.document;
    const pageUrl = new URL(contents.getURL()); // Get base URL for resolving relative links
    const mainElement = document.querySelector(selectorString);

    if (mainElement) {
      console.log('[Main] Found main content element.');

      // --- CORRECT ORDER: Extract Image URLs *before* removing elements ---
      let imageUrls = [];
      try {
        console.log('[Main] Extracting image URLs...');
        const imagesForPanel = mainElement.querySelectorAll('img');
        imagesForPanel.forEach(img => {
          let absoluteSrc = img.src;
          const srcAttr = img.getAttribute('src');
          if (srcAttr) {
              try {
                const pageUrl = new URL(contents.getURL());
                absoluteSrc = new URL(srcAttr, pageUrl.href).href;
              } catch (urlError) {
                 console.warn(`[Main] Could not resolve image URL: ${srcAttr}. Using original src. Error: ${urlError.message}`);
                 absoluteSrc = srcAttr;
              }
          } else if (!absoluteSrc) {
              console.warn('[Main] Skipping image with no src property or attribute.');
              return;
          }
          if (absoluteSrc) {
            imageUrls.push(absoluteSrc);
          }
        });
        console.log(`[Main] Found ${imageUrls.length} image URL(s) for the panel.`);
      } catch (extractError) {
         console.error('[Main] Error while extracting image URLs:', extractError);
      }
      // --- End Image URL Extraction ---

      // --- Remove unwanted elements (fullscreen buttons) ---
      try {
        console.log('[Main] Searching for and removing fullscreen buttons...');
        const fullscreenButtons = mainElement.querySelectorAll('button[aria-label*="fullscreen" i]');
        if (fullscreenButtons.length > 0) {
          fullscreenButtons.forEach(button => button.remove());
          console.log(`[Main] Removed ${fullscreenButtons.length} fullscreen button(s).`);
        } else {
          console.log('[Main] No fullscreen buttons found.');
        }
      } catch (removeError) {
        console.error('[Main] Error removing fullscreen buttons:', removeError);
      }
      // --- End fullscreen button removal ---

      // --- Remove all images (from mainElement for text content) ---
      try {
        console.log('[Main] Removing all images from text content...');
        const images = mainElement.querySelectorAll('img');
        if (images.length > 0) {
          images.forEach(img => img.remove());
          console.log(`[Main] Removed ${images.length} image(s) from text content.`);
        } else {
          console.log('[Main] No images found in text content.');
        }
      } catch (removeError) {
        console.error('[Main] Error removing images:', removeError);
      }
      // --- End image removal ---

      // --- Remove links but keep text ---
      try {
        console.log('[Main] Replacing links with their text...');
        const links = mainElement.querySelectorAll('a');
        if (links.length > 0) {
          links.forEach(link => {
            const linkText = document.createTextNode(link.textContent || '');
            link.parentNode.replaceChild(linkText, link);
          });
          console.log(`[Main] Replaced ${links.length} link(s) with text.`);
        } else {
          console.log('[Main] No links found to replace.');
        }
      } catch (removeError) {
        console.error('[Main] Error replacing links:', removeError);
      }
      // --- End link removal ---

      // Get the final text-only HTML
      const textOnlyHtml = mainElement.innerHTML;
      console.log(`[Main] Extracted text-only HTML length: ${textOnlyHtml?.length}.`);

      // Read the sample CSS file
      let sampleCssContent = '';
      try {
        console.log('[Main] Reading style_sample.css...');
        sampleCssContent = await fs.readFile(path.join(__dirname, 'style_sample.css'), 'utf8');
        console.log(`[Main] Read style_sample.css (length: ${sampleCssContent.length}).`);
      } catch (cssError) {
        console.error('[Main] Failed to read style_sample.css:', cssError);
      }

      // Construct the image list HTML
      const imageListHtml = imageUrls.map(url => `<li><img src="${url}" alt="Extracted Image"></li>`).join('');

      // Construct the related links list HTML
      const relatedLinksHtml = relatedLinks.map(link => {
        let absoluteHref;
        try {
          // Resolve relative URLs against the original page's URL
          absoluteHref = new URL(link.href, pageUrl.href).href;
        } catch (urlError) {
          console.warn(`[Main] Could not resolve related link URL: ${link.href}. Using original href. Error: ${urlError.message}`);
          absoluteHref = link.href; // Use original if resolution fails
        }
        // Use target="_blank" to open links in the system's default browser, not within Electron
        return `<li><a href="${absoluteHref}" title="${link.title}" target="_blank">${link.title}</a></li>`;
      }).join('');


      // Construct the full HTML document with THREE columns and injected styles
      const threeColumnHtmlDocument = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Cleaned Content</title>
  <style>
    /* Base styles from style_sample.css (applied mainly to .text-content) */
    ${sampleCssContent}

    /* Three-column layout */
    body {
      margin: 0; /* Remove default body margin */
      padding: 0;
      display: flex;
      min-height: 100vh;
      background-color: #f0f0f0; /* Light grey background for the page */
    }
    .image-panel {
      width: 15%; /* Use percentage */
      max-width: 250px; /* Max width */
      flex-shrink: 0; /* Prevent panel from shrinking */
      background-color: #e8e8e8; /* Slightly darker grey for panel */
      padding: 15px;
      box-sizing: border-box;
      overflow-y: auto; /* Allow scrolling if many images */
      height: 100vh; /* Make panel full height */
      position: sticky; /* Make the panel sticky */
      top: 0; /* Stick to the top */
      border-right: 1px solid #ccc; /* Add separator */
    }
    .panel-heading { /* Common style for panel headings */
      margin-top: 0;
      font-size: 1.1em; /* Slightly smaller */
      color: #333;
      border-bottom: 1px solid #ccc;
      padding-bottom: 5px;
      margin-bottom: 10px; /* Space below heading */
    }
    .image-panel ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .image-panel li {
      margin-bottom: 10px; /* Smaller margin */
    }
    .image-panel img {
      max-width: 100%; /* Ensure images fit panel */
      height: auto;
      display: block;
      border: 1px solid #ccc; /* Add a light border */
      background-color: #fff; /* White background in case of transparency */
      box-shadow: 0 1px 2px rgba(0,0,0,0.08); /* Softer shadow */
      margin: 0 auto; /* Center image within li */
    }

    .text-content {
      width: 60%; /* Target width */
      max-width: 900px; /* Increased max-width */
      flex-grow: 1; /* Allow to grow if side panels hit max-width */
      flex-shrink: 1; /* Allow shrinking */
      padding: 25px 40px; /* Adjust padding */
      box-sizing: border-box;
      background-color: #fdfdfd; /* Use background from sample style */
      /* margin: 0 auto; /* Remove auto margin to allow flex positioning */
      /* Main content area will scroll with the body */
    }

    .related-links-panel {
      width: 25%; /* Use percentage */
      max-width: 350px; /* Max width */
      flex-shrink: 0;
      background-color: #fafafa; /* Slightly different background */
      padding: 15px;
      box-sizing: border-box;
      overflow-y: auto;
      height: 100vh;
      position: sticky;
      top: 0;
      border-left: 1px solid #ccc; /* Add separator */
    }
    .related-links-panel ul {
      list-style: none;
      padding: 0;
      margin: 0;
    }
    .related-links-panel li {
      margin-bottom: 8px; /* Space between links */
    }
    .related-links-panel a {
      text-decoration: none;
      color: #0056b3; /* Link color */
      font-size: 0.95em;
      display: block; /* Make entire area clickable */
      padding: 3px 0; /* Add some padding */
      transition: background-color 0.2s ease;
    }
    .related-links-panel a:hover {
      background-color: #eee; /* Highlight on hover */
      text-decoration: underline;
    }


    /* Override body styles from sample CSS as they are now applied to .text-content */
    .text-content {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol";
      line-height: 1.7;
      color: #333;
    }
    /* Ensure other sample styles target elements within .text-content */
    .text-content h1, .text-content h2, .text-content h3, .text-content h4, .text-content h5, .text-content h6 { color: #111; margin-top: 1.8em; margin-bottom: 0.8em; line-height: 1.3; }
    .text-content h1 { font-size: 2.2em; }
    .text-content h2 { font-size: 1.8em; }
    .text-content h3 { font-size: 1.5em; }
    .text-content p { margin-bottom: 1.2em; }
    .text-content figcaption { text-align: center; font-size: 0.9em; color: #555; margin-top: -1.5em; margin-bottom: 2em; }
    /* Links are removed, so 'a' styles are less relevant here */
    .text-content pre, .text-content code { font-family: "SFMono-Regular", Consolas, "Liberation Mono", Menlo, Courier, monospace; background-color: #f0f0f0; border-radius: 3px; }
    .text-content code { padding: 0.2em 0.4em; }
    .text-content pre { padding: 1em; overflow-x: auto; margin-bottom: 1.5em; box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
    .text-content blockquote { border-left: 4px solid #ccc; padding-left: 1.5em; margin-left: 0; margin-right: 0; margin-bottom: 1.5em; font-style: italic; color: #555; }
    .text-content blockquote p { margin-bottom: 0.5em; }
    .text-content ul, .text-content ol { margin-bottom: 1.5em; padding-left: 2em; }
    .text-content li { margin-bottom: 0.6em; }

  </style>
</head>
<body>
  <div class="image-panel">
    <h2 class="panel-heading">Images</h2>
    <ul>${imageListHtml}</ul>
  </div>
  <div class="text-content">
    ${textOnlyHtml} <!-- Inject the modified text-only innerHTML -->
  </div>
  <div class="related-links-panel">
    <h2 class="panel-heading">Related Stories</h2>
    <ul>${relatedLinksHtml}</ul>
  </div>
</body>
</html>`;

      console.log('[Main] Sending three-column HTML document back to renderer...');
      event.sender.send('cleanup-result', threeColumnHtmlDocument);
      console.log('[Main] cleanup-result (three-column HTML) sent.');

    } else {
      console.error(`[Main] Selector "${selectorString}" did not match any element in the original HTML.`);
      const errorHtml = `<html><body><h2>Cleanup Error</h2><p>Could not find the main content element using the selector provided by the AI:</p><pre>${selectorString}</pre></body></html>`;
      event.sender.send('cleanup-result', errorHtml);
      console.log('[Main] Sent cleanup-result with "element not found" error.');
    }

  } catch (error) {
    console.error('[Main] Error during page cleanup process:', error);
    const errorHtml = `<html><body><h2>Cleanup Error</h2><p>An error occurred during the cleanup process:</p><pre>${error.message || 'Unknown error'}</pre></body></html>`;
    event.sender.send('cleanup-result', errorHtml);
    console.log('[Main] Sent cleanup-result with error message due to exception.');
  }
});

// --- IPC Handler for YouTube Transcript ---
ipcMain.handle('get-youtube-transcript', async (event, videoId) => {
  if (!videoId || typeof videoId !== 'string') {
    console.error('[Main] Invalid videoId received for transcript request:', videoId);
    return { error: 'Invalid video ID provided.' }; // Return an error object
  }
  console.log(`[Main] Received request for YouTube transcript for video ID: ${videoId}`);
  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    if (!transcript || transcript.length === 0) {
      console.warn(`[Main] No transcript found or transcript is empty for video ID: ${videoId}`);
      return { error: 'No transcript available for this video.' }; // Return specific error
    }
    // Join the text parts of the transcript
    const transcriptText = transcript.map(item => item.text).join(' ');
    console.log(`[Main] Successfully fetched and processed transcript for video ID: ${videoId} (Length: ${transcriptText.length})`);
    return { transcript: transcriptText }; // Return transcript object
  } catch (error) {
    console.error(`[Main] Error fetching YouTube transcript for video ID ${videoId}:`, error);
    // Provide a more user-friendly error message based on common issues
    let errorMessage = 'Could not fetch transcript.';
    if (error.message && error.message.includes('disabled transcript')) {
        errorMessage = 'Transcripts are disabled for this video.';
    } else if (error.message && error.message.includes('No transcript found')) {
        errorMessage = 'No transcript could be found for this video.';
    }
    return { error: errorMessage }; // Return error object
  }
});

// --- IPC Handler for DuckDuckGo First Result Search ---
ipcMain.on('get-first-duckduckgo-result', async (event, word) => {
  if (!word || typeof word !== 'string') {
    console.error('Received invalid word for DDG search:', word);
    // Optionally send an error back to renderer
    // event.sender.send('navigate-to-first-result', null, 'Invalid word provided');
    return;
  }

  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(word)}`;
  console.log(`[Main] Fetching DDG search results for "${word}" from ${searchUrl}`);

  try {
    // Use axios to fetch the HTML content
    const response = await axios.get(searchUrl, {
      headers: {
        // Mimic a browser user agent to avoid potential blocks
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
      }
    });

    // Load the HTML into cheerio
    const $ = cheerio.load(response.data);

    // Find the first search result link
    // DuckDuckGo HTML version uses '.result__a' for result links
    const firstResultLink = $('.result__a').first();

    if (firstResultLink.length > 0) {
      const firstUrl = firstResultLink.attr('href');
      console.log(`[Main] Found first DDG result URL: ${firstUrl}`);
      // Send the URL back to the renderer
      event.sender.send('navigate-to-first-result', firstUrl);
    } else {
      console.warn(`[Main] No search results found on DDG for "${word}".`);
      // Optionally inform the renderer
      event.sender.send('navigate-to-first-result', null, `No results found for "${word}"`);
    }
  } catch (error) {
    console.error(`[Main] Error fetching or parsing DDG results for "${word}":`, error.message);
    // Optionally inform the renderer
    event.sender.send('navigate-to-first-result', null, `Error searching for "${word}": ${error.message}`);
  }
});
console.log('[Main] IPC handlers registered.'); // ADDED LOG

// --- App Lifecycle ---

// Listen for confirmation from renderer that open tabs are saved
ipcMain.on('open-tabs-saved', (event, snapshot) => {
  if (!isHostBrowserEvent(event)) return;
  const closingWindow = BrowserWindow.fromWebContents(event.sender);
  // Quit can receive acknowledgements from several windows at once. Serialize
  // final writes and destruction so the actual last window marks the journal clean.
  browserWindowCloseWrite = browserWindowCloseWrite.catch(error => {
    console.warn('[Orbit] Previous window-close save failed:', error?.message || error);
  }).then(async () => {
    if (!closingWindow || closingWindow.isDestroyed()) return;
    windowSessionSnapshots.set(event.sender.id, sanitizeBrowserSession(snapshot));
    if (browserWindows.size === 1) {
      await markBrowserSessionClean(snapshot);
    } else if (closingWindow === mainWindow) {
      const remaining = [...browserWindows].find(window => window !== closingWindow);
      const remainingSnapshot = windowSessionSnapshots.get(remaining?.webContents.id);
      if (remainingSnapshot) await saveRunningBrowserSession(remainingSnapshot);
    }
    if (!closingWindow.isDestroyed()) closingWindow.destroy();
  });
  return browserWindowCloseWrite;
});

app.on('render-process-gone', (event, contents, details) => {
  const reason = details?.reason || 'unknown';
  const tabFailureReasons = new Set(['abnormal-exit', 'crashed', 'oom', 'launch-failed', 'integrity-failure', 'killed']);

  if (!tabFailureReasons.has(reason) || !mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  // A page is a guest webContents. The host renderer is deliberately not sent a
  // message about its own termination; it cannot receive it and is not a tab.
  if (contents?.id === mainWindow.webContents.id || contents?.getType?.() !== 'webview') {
    return;
  }

  console.warn(`[Main] Page renderer ${contents.id} exited (${reason}). Keeping the browser window open.`);
  const owner = contents.hostWebContents;
  if (!owner || owner.isDestroyed()) return;
  owner.send('tab-renderer-gone', {
    webContentsId: contents.id,
    reason,
    exitCode: Number.isInteger(details?.exitCode) ? details.exitCode : null
  });
});

app.whenReady().then(async () => {
  if (!gotSingleInstanceLock) return;
  // Safe because the single-instance lock guarantees no other app instance is
  // using them: anything left in the temp dir is from a dead run.
  castRelayService.sweepAbandonedTempFiles();
  // Keep finished captures in userData so re-casting a video skips the
  // download+remux entirely, across app restarts.
  try {
    castRelayService.configureCache(path.join(app.getPath('userData'), 'cast-cache'));
  } catch (error) {
    console.warn(`[Cast] capture cache disabled: ${error?.message || error}`);
  }
  if (!gotSingleInstanceLock) return;
  const backendLabel = USE_CLI ? (LLM_BACKEND === 'codex' ? 'Codex CLI' : LLM_BACKEND === 'claude-haiku' ? 'Claude Haiku CLI' : 'Claude CLI') : 'OpenRouter';
  console.log(`[Main] AI backend: ${backendLabel}`);
  startupRecoverySession = await loadInterruptedBrowserSession();
  startupCleanSession = startupRecoverySession ? null : await loadCleanBrowserSession();
  if (startupRecoverySession?.tabs.length) {
    console.warn(`[Main] Recovering ${startupRecoverySession.tabs.length} tab(s) after an unexpected exit.`);
  }
  // Mark this run as in progress before showing a window. If Electron exits
  // natively, the most recently journaled tab snapshot remains available.
  await saveRunningBrowserSession(startupRecoverySession || startupCleanSession || { tabs: [], activeTabId: null });
  await loadBlocklist();
  registerNetworkRequestMonitoring(session.defaultSession);
  registerNetworkRequestMonitoring(session.fromPartition('transformed-view-source'));
  registerDownloadMonitoring(session.defaultSession);
  registerDownloadMonitoring(session.fromPartition('transformed-view-source'));
  if (process.platform === 'darwin') app.dock?.setIcon(path.join(__dirname, 'icons/orbit.png'));
  createWindow();
  await getArtifactServiceForHost();
  app.on('activate', function () {
    if (quitController.requested) return;
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

async function shutdownOpenCodeRuntime() {
  cancelAllBrowserToolRequests('browser_closed', 'The browser is closing.');
  endCastPowerSaveBlocker();
  const results = await Promise.allSettled([
    Promise.resolve().then(() => openCodeService?.dispose()),
    Promise.resolve().then(() => browserRemoteService?.stop()),
    Promise.resolve().then(() => artifactService?.stop()),
    Promise.resolve().then(() => castRelayService.stop())
  ]);
  for (const result of results) {
    if (result.status === 'rejected') console.warn('[Orbit] Cleanup failed:', result.reason?.message || result.reason);
  }
}

const DesktopQuitController = require('./desktop-quit-controller');
const quitController = new DesktopQuitController({
  app,
  getWindows: () => [...browserWindows].filter(window => !window.isDestroyed()),
  shutdown: shutdownOpenCodeRuntime
});

if (gotSingleInstanceLock) {
  app.on('second-instance', () => {
    if (quitController.requested) return;
    // Focus existing window instead of allowing another full app boot.
    if (!mainWindow || mainWindow.isDestroyed()) {
      createWindow();
      return;
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.on('window-all-closed', function () {
  if (process.platform !== 'darwin') app.quit();
});
