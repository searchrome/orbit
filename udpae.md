# Browser Project Knowledge (UDPAE)

## 1) What This Project Is

This repository is an Electron-based desktop browser with built-in content controls and AI-assisted reading features.

Main user-facing capabilities:
- Multi-tab browsing with per-tab webviews.
- Per-tab network blocking.
- Global JavaScript, cache, and domain-blocklist toggles.
- AI summarization (web pages and YouTube transcripts).
- AI page cleanup into a three-column reading layout.
- DuckDuckGo search with instant navigation via `word!`.


## 2) Runtime Architecture

### Main process
- File: `main.js`
- Owns app lifecycle, BrowserWindow, session-level request interception, IPC handlers, and external integrations.
- Integrates Gemini, YouTube transcript fetching, and DuckDuckGo result scraping.

### Renderer process
- File: `renderer.js`
- Owns UI controls, tab interactions, button state updates, and event orchestration.
- Sends commands to main via `window.electronAPI`.

### Preload bridge
- File: `preload.js`
- Exposes allowlisted IPC `send`, `on`, and `invoke` methods via `contextBridge`.
- Prevents unrestricted Electron API access from renderer/webview content.

### Feature modules
- `tab-manager.js`: tab lifecycle and per-tab webview wiring.
- `summarizer.js`: summarize button flow, YouTube detection and transcript-first logic.
- `history-manager.js`: history load/save/update behavior.
- `gemini-service.js`: Gemini prompts and response parsing for summary/cleanup/related links.


## 3) Ability Catalog (Current)

### A. Per-tab network control
- UI trigger: `Network` button.
- Renderer channel: `toggle-network`.
- Main handler: toggles `tabNetworkBlockedState[webContentsId]`.
- Effect: request cancellation in `session.defaultSession.webRequest.onBeforeRequest`.

### B. Global JavaScript control
- UI trigger: `JS` button.
- Renderer channel: `toggle-js`.
- Main handler: flips `javascriptDisabled` and reports `js-status`/`set-js-status`.
- Note: state is global, not per-tab.

### C. Global cache control
- UI trigger: `Cache` button.
- Renderer channel: `toggle-cache`.
- Main handler: flips `cacheEnabled`, clears caches/storage when turning off.
- Effect: adds no-cache headers to outbound requests when cache is off.

### D. Global domain blocklist
- UI trigger: `Blocklist` button.
- Renderer channel: `toggle-domain-blocking`.
- Main behavior: block hostname matches from `block.list`.

### E. AI summarization
- UI trigger: `Summarize` button.
- Renderer behavior:
  - If current URL matches YouTube watch URL, fetch transcript via invoke channel.
  - Otherwise extract `document.body.innerText`.
  - Send text through `summarize-content`.
- Main behavior:
  - Calls `getGeminiSummary`.
  - Sends formatted HTML on `summary-result`.
- Output: summary panel in renderer.

### F. AI cleanup + related links
- UI trigger: `Cleanup` button.
- Renderer channel: `request-page-cleanup` with active `webContentsId`.
- Main behavior:
  - Pulls full page HTML.
  - Pre-cleans scripts/styles.
  - Calls Gemini in parallel:
    - `getCleanedPageContent` -> selector
    - `getRelatedStoryLinks` -> links array
  - Extracts text content, image URLs, and related links.
  - Builds a three-column HTML document and returns through `cleanup-result`.
- Output: opens cleaned content in a new tab via `data:` URL.

### G. DuckDuckGo search and instant navigation
- Normal behavior: non-URL input becomes DDG query URL.
- Instant behavior: `word!` sends `get-first-duckduckgo-result`.
- Main fetches DDG HTML endpoint, parses first result via Cheerio, returns URL.

### H. Interaction-based auto-mode switching
- Scroll in webview guest page -> emits `webview-scrolled-down` -> renderer blocks network and disables JS.
- Click in webview guest page -> emits `webview-clicked` -> renderer unblocks network and enables JS.


## 4) IPC Surface (Practical)

Important allowlisted outbound `send` channels in preload:
- `toggle-network`
- `toggle-js`
- `toggle-cache`
- `toggle-domain-blocking`
- `summarize-content`
- `request-page-cleanup`
- `get-first-duckduckgo-result`
- `save-open-tabs`
- `save-history`
- `open-tabs-saved`

Important inbound `on` channels:
- `network-request-data`
- `network-status`
- `js-status`
- `cache-status`
- `domain-blocking-status`
- `summary-result`
- `cleanup-result`
- `navigate-to-first-result`
- `save-open-tabs`

Important `invoke` channels:
- `get-initial-status`
- `get-youtube-transcript`
- `summarize-text` (allowlisted but not central in current flow)
- `load-history`


## 5) Data and Persistence

- History file path:
  - `<app userData>/browser-history.json`
- History is loaded/saved through IPC (`load-history`, `save-history`).
- Open-tab restoration:
  - Renderer recreates tabs from entries marked `state === "open"`.
  - Window close flow asks renderer to persist open tabs, then closes.


## 6) How To Run and Validate

### Run
- `npm install`
- `npm start`

### Tests
- `npm test`
- `npm run test:unit`
- `npm run test:integration`
- `npm run test:e2e`
- `npm run test:all`


## 7) Key Risks / Gaps Observed

1. Hardcoded Gemini API key in source
- `gemini-service.js` stores a literal API key.
- Better: use environment variable and never commit secrets.

2. Preload channel mismatch for initial tab network state
- `tab-manager.js` sends `set-network-status-for-tab`.
- `preload.js` send allowlist does not include `set-network-status-for-tab`.
- Result: initialization call can be rejected at bridge level.

3. Bookmark/history method bug
- `history-manager.js` references `isBookmarked` without defining it in `addOrUpdateEntry`.
- This can throw or produce incorrect bookmark state behavior.

4. Search panel appears partially disconnected
- `search-panel.js` expects DOM elements (`search-results-panel`, `search-panel-close-btn`) not present in `index.html`.
- Unit tests mock these elements, but runtime wiring is incomplete.

5. Documentation drift
- Some docs describe roadmap/current state that no longer matches implemented features (for example plugin/extension wording vs current code reality).


## 8) Recommended Next Hardening Steps

1. Move Gemini key to env config and add startup validation.
2. Fix preload allowlist mismatch for `set-network-status-for-tab`.
3. Fix `HistoryManager.addOrUpdateEntry` bookmark parameter handling.
4. Decide whether to fully wire or remove `search-panel.js`.
5. Add integration tests for summarize and cleanup IPC flows.


## 9) High-Value Files

- `main.js`: central orchestration and side effects.
- `renderer.js`: UI behavior and state synchronization.
- `preload.js`: security boundary and IPC contract.
- `gemini-service.js`: AI prompt/parse logic.
- `tab-manager.js`: tab/webview lifecycle.
- `history-manager.js`: persistence model.
- `index.html`: visible controls and UI composition.
- `README.md`: entry usage documentation.

