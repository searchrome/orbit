const { contextBridge, ipcRenderer } = require('electron');

// The assistant planner is only callable from the host browser window.
// The host shell is loaded from index.html; assistant and site webviews are not.
const isHostBrowserRenderer = (() => {
  const args = Array.isArray(process.argv) ? process.argv : [];
  const expected = args.find(arg => arg.startsWith('--browser-host-url='))?.slice('--browser-host-url='.length);
  return process.isMainFrame === true
    && args.includes('--browser-host-renderer')
    && typeof expected === 'string'
    && expected.startsWith('file:')
    && window.location.href === expected;
})();

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
if (isHostBrowserRenderer) {
contextBridge.exposeInMainWorld('electronAPI', {
  // Send messages from renderer to main (one-way)
  send: (channel, data) => {
    // Whitelist channels
    let validChannels = ['toggle-network', 'set-network-status-for-tab', 'toggle-js', 'toggle-cache', 'toggle-domain-blocking', 'summarize-content', 'request-page-cleanup', 'get-first-duckduckgo-result', 'save-open-tabs', 'save-history', 'open-tabs-saved', 'assistant-abort-next-action', 'assistant-runtime-log', 'opencode-terminal-input', 'opencode-terminal-resize', 'browser-tool-started', 'browser-tool-response', 'browser-session-state']; // Added DDG channel and save-open-tabs, save-history, open-tabs-saved, planner abort, assistant runtime logging, OpenCode terminal bridge, and crash recovery journal
    const hostOnlyChannels = new Set(['assistant-runtime-log', 'opencode-terminal-input', 'opencode-terminal-resize', 'browser-tool-started', 'browser-tool-response', 'browser-session-state']);
    if (hostOnlyChannels.has(channel) && !isHostBrowserRenderer) {
      console.error(`[Preload] Attempted to send ${channel} from a non-host renderer.`);
      return;
    }
    if (validChannels.includes(channel)) {
      console.log(`[Preload] Sending IPC message on valid channel: ${channel}`); // Add log for confirmation
      ipcRenderer.send(channel, data);
    } else {
      console.error(`[Preload] Attempted to send IPC message on invalid channel: ${channel}`); // Log if channel is invalid
    }
  },
  // Send messages from guest page back to host renderer (one-way)
  sendToHost: (channel, data) => {
    // No specific channel validation here, as it's guest->host
    ipcRenderer.sendToHost(channel, data);
  },
  // Receive messages from main to renderer (one-way)
  on: (channel, func) => {
    // Whitelist channels for receiving messages
    let validChannels = [
        'set-js-status',         // From main to update webview JS setting
        'network-request-data',  // From main with content size
        'network-status',        // From main with current network block status
        'js-status',             // From main with current JS disabled status
        'cache-status',          // From main with current cache enabled status
        'domain-blocking-status', // From main with current domain blocking status
        'summary-result',        // From main with Gemini summary result
        'cleanup-result',        // From main with Gemini cleanup result
        'navigate-to-first-result', // From main with DDG result URL
        'open-tabs-saved',        // From main confirming open tabs saved
        'save-open-tabs',        // From main requesting to save open tabs
        'assistant-response',     // From host renderer back to assistant workspace
        'assistant-progress',     // From host renderer with assistant progress updates
        'assistant-status',       // From host renderer with assistant run state
        'assistant-log',          // From host renderer with log entries
        'assistant-task-started', // From host renderer when a task begins
        'assistant-task-finished',// From host renderer when a task ends
        'assistant-task-failed',  // From host renderer when a task fails
        'opencode-terminal-output',
        'opencode-terminal-status',
        'browser-tool-request',
        'browser-tool-cancel',
        'guest-open-link',
        'tab-renderer-gone',
        'cast-progress',         // From main with cast preparation progress
        'updates-status',
        'download-status'
    ];
    if (validChannels.includes(channel)) {
      console.log(`[Preload] Registering IPC listener for valid channel: ${channel}`);
      // Deliberately strip event as it includes `sender`
      ipcRenderer.on(channel, (event, ...args) => {
        console.log(`[Preload] IPC event received on channel: ${channel}`); // ADDED LOG HERE
        func(...args);
      });
    } else {
      console.error(`[Preload] Attempted to register IPC listener for invalid channel: ${channel}`);
    }
  },
  // Add function to get YouTube transcript
  handleGetTranscript: (videoId) => {
    console.log(`[Preload] Invoking get-youtube-transcript for videoId: ${videoId}`);
    return ipcRenderer.invoke('get-youtube-transcript', videoId);
  },
  // Send message from renderer to main and expect a result back (two-way)
  invoke: (channel, data) => {
    const hostOnlyChannels = new Set(['updates-get-state', 'updates-dismiss', 'updates-open-download', 'workspace-list', 'workspace-autosave', 'workspace-switch', 'workspace-rename', 'workspace-delete', 'workspace-open-window', 'assistant-next-action', 'bookmark-enrich', 'bookmark-search', 'transformed-view-list', 'transformed-view-get', 'transformed-view-create', 'transformed-view-update', 'transformed-view-record-success', 'opencode-terminal-get-settings', 'opencode-terminal-save-settings', 'opencode-terminal-start', 'opencode-terminal-stop', 'opencode-session-files-list', 'opencode-session-files-upload', 'opencode-artifacts-list', 'opencode-artifacts-open', 'opencode-artifacts-download', 'opencode-artifacts-delete', 'get-startup-session', 'cast-discover-devices', 'cast-extract-video', 'cast-relay-video', 'cast-video', 'cast-stop', 'cast-play', 'cast-pause', 'cast-seek', 'cast-status', 'cast-get-settings', 'cast-save-settings', 'cast-subtitle-search', 'cast-subtitle-download']);
    if (hostOnlyChannels.has(channel) && !isHostBrowserRenderer) {
      console.error(`[Preload] Attempted to invoke ${channel} from a non-host renderer.`);
      return Promise.reject(new Error(`${channel} is restricted to the host browser window.`));
    }
    // Whitelist channels for invoke
    let validChannels = ['updates-get-state', 'updates-dismiss', 'updates-open-download', 'workspace-list', 'workspace-autosave', 'workspace-switch', 'workspace-rename', 'workspace-delete', 'workspace-open-window', 'get-initial-status', 'get-youtube-transcript', 'summarize-text', 'load-history', 'assistant-next-action', 'bookmark-enrich', 'bookmark-search', 'transformed-view-list', 'transformed-view-get', 'transformed-view-create', 'transformed-view-update', 'transformed-view-record-success', 'opencode-terminal-get-settings', 'opencode-terminal-save-settings', 'opencode-terminal-start', 'opencode-terminal-stop', 'opencode-session-files-list', 'opencode-session-files-upload', 'opencode-artifacts-list', 'opencode-artifacts-open', 'opencode-artifacts-download', 'opencode-artifacts-delete', 'get-startup-session', 'cast-discover-devices', 'cast-extract-video', 'cast-relay-video', 'cast-video', 'cast-stop', 'cast-play', 'cast-pause', 'cast-seek', 'cast-status', 'cast-get-settings', 'cast-save-settings', 'cast-subtitle-search', 'cast-subtitle-download']; // Added browser-owned transformed views, bookmark intelligence, terminal controls, and DLNA cast
    if (validChannels.includes(channel)) {
        console.log(`[Preload] Invoking IPC on valid channel: ${channel}`); // Add log
        return ipcRenderer.invoke(channel, data);
    } else {
      console.error(`[Preload] Attempted to invoke IPC on invalid channel: ${channel}`); // Log if channel is invalid
      // Optionally return a rejected promise or throw an error
      return Promise.reject(new Error(`Invalid invoke channel: ${channel}`));
    }
  }
});

}
