# Browser Application API and Event Flow

This document details the API interfaces and event flow within the browser application, providing a comprehensive reference for understanding component interactions and communication patterns.

## Table of Contents

1. [IPC Communication Channels](#ipc-communication-channels)
2. [Main Process API](#main-process-api)
3. [Renderer Process API](#renderer-process-api)
4. [Custom Events](#custom-events)
5. [Webview Events](#webview-events)
6. [External API Integrations](#external-api-integrations)

## IPC Communication Channels

The application uses Electron's IPC (Inter-Process Communication) system to enable communication between the main and renderer processes. The following channels are defined:

### From Renderer to Main (one-way)

| Channel | Data | Description |
|---------|------|-------------|
| `toggle-network` | `webContentsId` | Toggle network blocking for a specific tab |
| `toggle-js` | - | Toggle JavaScript globally |
| `toggle-cache` | - | Toggle cache globally |
| `toggle-domain-blocking` | - | Toggle domain blocking globally |
| `summarize-content` | `pageContent` | Send page content for summarization |
| `request-page-cleanup` | `webContentsId` | Request page cleanup for a specific tab |
| `get-first-duckduckgo-result` | `word` | Get the first search result for a word |
| `set-network-status-for-tab` | `webContentsId, isBlocked` | Set network status for a specific tab |

### From Main to Renderer (one-way)

| Channel | Data | Description |
|---------|------|-------------|
| `set-js-status` | `isDisabled` | Update JavaScript status |
| `network-request-data` | `size` | Report network request size |
| `network-status` | `webContentsId, isBlocked` | Report network status for a tab |
| `js-status` | `isDisabled` | Report JavaScript status |
| `cache-status` | `enabled` | Report cache status |
| `domain-blocking-status` | `isEnabled` | Report domain blocking status |
| `summary-result` | `htmlContent` | Return summary result |
| `cleanup-result` | `cleanedHtml` | Return cleaned page HTML |
| `navigate-to-first-result` | `url, errorMsg` | Return first search result URL |

### From Renderer to Main (two-way)

| Channel | Data | Response | Description |
|---------|------|----------|-------------|
| `get-initial-status` | - | `{javascriptDisabled, cacheEnabled, domainBlockingEnabled}` | Get initial application status |
| `get-youtube-transcript` | `videoId` | `{ transcript: string }` or `{ error: string }` | Fetch transcript for a YouTube video |

## Main Process API

The main process exposes the following functionality:

### Network Control

```javascript
// Load blocklist from file
async function loadBlocklist()

// Toggle network blocking for a specific tab
ipcMain.on('toggle-network', (event, webContentsId))

// Set network status for a specific tab
ipcMain.on('set-network-status-for-tab', (event, webContentsId, isBlocked))

// Toggle cache globally
ipcMain.on('toggle-cache', async (event))

// Toggle domain blocking globally
ipcMain.on('toggle-domain-blocking', async (event))
```

### Content Control

```javascript
// Toggle JavaScript globally
ipcMain.on('toggle-js', (event))

// Get initial application status
ipcMain.handle('get-initial-status', async (event))
```

### AI Features

```javascript
// Summarize content using Gemini AI
ipcMain.on('summarize-content', async (event, pageContent))

// Clean up page content using Gemini AI
ipcMain.on('request-page-cleanup', async (event, webContentsId))
```

### Search Features

```javascript
// Get first DuckDuckGo search result
ipcMain.on('get-first-duckduckgo-result', async (event, word))
```

## Renderer Process API

The renderer process exposes the following functionality through the `electronAPI` object:

```javascript
window.electronAPI = {
  // Send messages from renderer to main
  send: (channel, data),
  
  // Send messages from guest page to host renderer
  sendToHost: (channel, data),
  
  // Receive messages from main to renderer
  on: (channel, func),
  
  // Send message from renderer to main and expect a result
  invoke: (channel, data)
}
```

## Custom Events

The application uses custom events for internal communication within the renderer process:

| Event | Data | Description |
|-------|------|-------------|
| `tab-switched` | `{ tabId, tab }` | Fired when switching between tabs |
| `ensure-summarizer-initialized` | `{ tabId, webview }` | Ensure summarizer is initialized for a tab |
| `webview-scrolled-down` | `{ tabId }` | Fired when a webview is scrolled down |
| `webview-clicked` | `{ tabId }` | Fired when a webview is clicked |

## Webview Events

The application listens to the following webview events:

| Event | Description |
|-------|-------------|
| `page-title-updated` | Update tab title when page title changes |
| `did-navigate` | Update tab URL when navigation occurs |
| `page-favicon-updated` | Update tab favicon when available |
| `did-start-loading` | Handle page loading start |
| `did-stop-loading` | Handle page loading completion |
| `did-finish-load` | Ensure summarizer is initialized |
| `did-fail-load` | Handle page loading failure |
| `ipc-message` | Handle IPC messages from webview content |

## External API Integrations

### Google Gemini AI

The application integrates with Google's Generative AI (Gemini) through the `gemini-service.js` module:

```javascript
// Get a summary of page content
async function getGeminiSummary(textContent)

// Get a CSS selector for the main content element
async function getCleanedPageContent(sourceHtml)

// Get related story links from a page
async function getRelatedStoryLinks(sourceHtml)
```

### DuckDuckGo Search

The application integrates with DuckDuckGo for search functionality:

1. **URL Bar Search**: Non-URL inputs are treated as search queries and sent to DuckDuckGo.
2. **Instant Search**: The "word!" syntax performs a search and navigates to the first result.
3. **In-Page Search**: Selected text can be searched using DuckDuckGo in a side panel.

## Event Flow Examples

### Tab Creation and Navigation

1. User clicks the "+" button
2. `TabManager.createTab()` is called
3. A new tab element is created and added to the tab bar
4. A new webview is created and added to the content container
5. `TabManager.switchToTab()` is called to activate the new tab
6. The `tab-switched` event is dispatched
7. The URL input is updated to reflect the active tab's URL
8. The back button state is updated
9. The network button state is updated
10. The summarizer is initialized with the new active webview

### Content Summarization

1. User clicks the "Summarize" button.
2. `Summarizer.handleSummarizeClick()` is called.
3. **If YouTube video:**
    a. Video ID is extracted from the URL.
    b. Renderer invokes `get-youtube-transcript` IPC channel with the video ID.
    c. Main process uses `youtube-transcript` library to fetch the transcript.
    d. Main process returns the transcript text (or an error) to the renderer.
    e. Renderer sends the transcript text to the main process via the `summarize-content` IPC channel.
4. **If standard page:**
    a. Page text content is extracted from the active webview.
    b. Renderer sends the page text to the main process via the `summarize-content` IPC channel.
5. Main process sends the received text (transcript or page content) to Gemini AI.
6. Gemini AI returns a summary.
7. Main process sends the summary HTML to the renderer via the `summary-result` IPC channel.
8. Renderer's `summary-result` listener updates the content of the `#summary-panel` and makes it visible.

### Network Blocking

1. User clicks the "Network" toggle button
2. The `toggle-network` IPC message is sent to the main process with the active tab's webContentsId
3. Main process updates the network blocking state for the tab
4. Main process sends the new state back to the renderer via the `network-status` IPC channel
5. Renderer updates the button state to reflect the new network status
6. Future network requests for the tab are blocked or allowed based on the new state
