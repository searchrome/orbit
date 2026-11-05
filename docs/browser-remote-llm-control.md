# Remote LLM Browser Control

## Overview

This guide explains how to use the Electron browser through a remote LLM call.

In this app, "remote" means the model runs outside the Electron process, usually through OpenRouter, while the browser itself still executes tab and page actions locally. The model does not browse the web directly. It chooses the next action, and the browser host performs that action inside a real `webview`.

If you want to integrate your own model, the important boundary is:

1. The model returns one planner action at a time.
2. The Electron host executes that action with the browser tool layer.
3. The result is fed back into the next planner call.

There is no public REST API for browser control in this repo. The control surface is the in-app assistant workspace plus Electron IPC.

## OpenCode terminal control

The toolbar Terminal drawer provides a second, local control path. It runs OpenCode in an embedded terminal using the model selected in the drawer and gives it a local `browser` MCP server. The existing assistant workspace remains available while this integration is introduced, but it is prevented from issuing browser actions while an OpenCode session is starting, running, or stopping.

The MCP server is not exposed publicly. Electron starts a loopback-only bridge with a random per-session token. Its adapter process translates MCP calls into host-only IPC, where `BrowserTools` executes them against the real `TabManager` and visible webviews. OpenCode receives application tab IDs, never CDP target IDs. Browser mutations are serialized per tab; reads have bounded concurrency. Stop and timeout messages cancel queued work and mark an already-dispatched mutation as possibly completed rather than retryable.

The initial tool surface is `list_tabs`, `get_active_tab`, `get_tab_info`, `open_tab`, `focus_tab`, `close_tab`, `navigate_tab`, `wait_for_load`, `wait_for_element`, `batch_read_tabs`, `read_page_text`, `find_page_text`, `query_selector_all`, `click_element`, `type_into`, `scroll_page`, `search_site`, `extract_search_results`, `create_artifact`, `list_artifacts`, `open_artifact`, and `download_artifact`.

OpenCode must be installed and authenticated separately. The browser writes ephemeral, app-owned OpenCode configuration under its user-data directory; credentials stay in OpenCode's own credential store. Its generated browser agent denies inherited shell, filesystem, web, and unrelated MCP tools; it allows inspection, navigation, clicks, typing, and app-owned artifact creation by default while requiring OpenCode approval for closing tabs, site search, and downloads. The model setting applies when a session starts. Hiding the terminal keeps that session alive, while Stop or closing the browser window cancels bridge work and ends the owned process group. Set `OPENCODE_TERMINAL_ENABLED=false` to disable this rollout path.

## Runtime Flow

The current loop is:

1. The user opens `browser://assistant`.
2. `assistant-renderer.js` collects the prompt and session state.
3. `assistant-controller.js` builds `browserState`, `taskProfile`, and `runtimeState`.
4. The host browser window calls `assistant-next-action` through IPC.
5. `main.js` forwards the request to the configured LLM backend.
6. The backend returns one of:
   - `tool_call`
   - `clarify`
   - `final`
7. `assistant-controller.js` executes the tool through `browser-tools.js`.
8. The result is added back into the conversation context.
9. The loop continues until the run finishes, pauses for clarification, or is stopped.

The default backend is OpenRouter. If `CLAUDE_CLI=true` is set in `.env`, the host can switch to the Claude CLI backend without changing the planner contract.

## Configuration

Put your OpenRouter key in the repo-root `.env` file:

```env
OPENROUTER_API_KEY=your_key_here
OPENROUTER_MODEL=openai/gpt-4.1-mini
```

Optional settings:

```env
OPENROUTER_BASE_URL=https://openrouter.ai/api/v1
OPENROUTER_HTTP_REFERER=http://localhost
OPENROUTER_APP_TITLE=Simple Electron Browser
CLAUDE_CLI=false
```

Notes:

1. `OPENROUTER_MODEL` defaults to `openai/gpt-4.1-mini`.
2. `CLAUDE_CLI=true` switches the planner backend, but the action schema stays the same.
3. Restart Electron after editing `.env`.

## Planner Request

The host sends a single request per planner turn. The current payload includes:

```json
{
  "requestId": "session-1:...",
  "sessionId": "session-1",
  "prompt": "find me a used bike under 300 euro",
  "messages": [
    { "role": "user", "content": "..." }
  ],
  "browserState": {
    "activeTab": { "id": "tab-1", "url": "https://..." },
    "tabs": [ ... ]
  },
  "taskProfile": {
    "kind": "shopping"
  },
  "runtimeState": {
    "toolCallsUsed": 3,
    "toolCallsRemaining": 17,
    "openedTabs": 2,
    "remainingTabBudget": 3,
    "consecutiveToolFailures": 0
  },
  "limits": {
    "maxToolCalls": 20,
    "maxNewTabs": 5,
    "maxDurationMs": 30000
  },
  "timeoutMs": 29850
}
```

Important fields:

1. `requestId` is required and unique per planner call.
2. `sessionId` ties the turn to the assistant chat session.
3. `browserState.tabs` excludes the assistant workspace tab.
4. `taskProfile.kind` is one of `shopping`, `local_search`, `recommendation`, or `general`.
5. `runtimeState` carries live feedback so the model can stop pushing blindly.

## Planner Response

The model must return exactly one JSON object that matches one of these shapes:

### Tool call

```json
{
  "type": "tool_call",
  "message": "I will inspect the current tabs first.",
  "tool": "list_tabs",
  "arguments": {}
}
```

### Clarification

```json
{
  "type": "clarify",
  "question": "What budget should I use?",
  "reason": "The request is missing a budget.",
  "missingInfo": ["budget"]
}
```

### Final answer

```json
{
  "type": "final",
  "message": "Here are the best matches.",
  "results": [
    {
      "title": "Example result",
      "url": "https://example.com/item",
      "price": "EUR 199",
      "reason": "Good fit for the budget."
    }
  ]
}
```

The host rejects malformed responses. The model should keep the output compact and avoid any extra prose outside the JSON object.

## Tool Surface

The browser host currently exposes these actions to the planner:

1. `list_tabs`
2. `open_tab`
3. `focus_tab`
4. `navigate_tab`
5. `close_tab`
6. `get_tab_info`
7. `get_active_tab`
8. `wait_for_load`
9. `wait_for_element`
10. `batch_read_tabs`
11. `read_page_text`
12. `find_page_text`
13. `query_selector_all`
14. `click_element`
15. `type_into`
16. `scroll_page`
17. `search_site`
18. `extract_search_results`
19. `create_artifact`
20. `list_artifacts`
21. `open_artifact`
22. `download_artifact`

Practical notes:

1. These tools run against real Electron `webview` tabs.
2. The browser should open real tabs for real pages. Do not route runtime browsing through Playwright.
3. `search_site` is the preferred way to search on live pages when the site has a visible search box.
4. `extract_search_results` is useful for marketplace-style result pages.
5. `find_page_text`, `read_page_text`, and `query_selector_all` are the main inspection tools for grounded answers.

### Find page text with context

Use `find_page_text` to inspect matching rendered-text passages without sending the whole page or changing the browser’s selection, scroll position, or native Find UI. It requires `tabId` and a literal `query`; matching is case-insensitive by default and becomes case-sensitive only with `caseSensitive: true`. Leading and trailing query whitespace is literal rather than trimmed.

`contextChars` defaults to 240 and is limited to 0–512. `maxMatches` defaults to 20 and is limited to 1–50. The tool searches at most the first 1,000,000 rendered-text characters in the main frame. Results are source-ordered, include offsets, a matching substring, surrounding `snippet`, observed page URL/title, and `scope: { frame: "main_frame", subframes: "not_searched" }`. Matching subframes is intentionally unsupported and is reported in `scope`.

`matchCountExact: false` together with `truncated.scan: true` means the page text exceeded the scan bound, so the count is only for the scanned prefix. `truncated.matches: true` means more matches were counted than returned. A successful no-match result has `noMatches: true`, `matchCount: 0`, and an empty `matches` array.

### Targeted page text extraction

`read_page_text` remains backward compatible: `{ tabId, maxChars }` reads the full visible page body as before. To reduce navigation chrome for a targeted read, add a literal `selector` or `contentMode`: `main`, `article`, or `auto`. `auto` prefers `article`, then `main`, including their matching ARIA roles. An explicit selector takes precedence over `contentMode`.

Targeted reads are limited to 20,000 characters and return the normal `text`, `length`, and `truncated` fields plus `extraction`. That metadata identifies the requested semantic mode, selected element/selector, main-frame scope, and any fallback. A missing `main` or `article` region falls back to `body` with `fallback: true` and a specific `fallbackReason`; an invalid or unmatched explicit selector instead returns an error with `extraction.status` of `invalid_selector` or `selector_not_found`. No DOM is changed during extraction.

### Actionable browser errors

Remote failures retain the existing `{ ok: false, error, data }` envelope. `error` now preserves specific codes when the browser directly observes a condition: `browser_network_blocked`, `browser_javascript_blocked`, `browser_element_not_found`, `browser_navigation_failed`, `browser_navigation_not_started`, `browser_timeout`, `browser_tab_not_ready`, `browser_network_unavailable`, `browser_tab_not_found`, `browser_tab_closed`, and `browser_protected_tab`. Other failures use `browser_operation_failed` with `certainty: "unknown"`. Messages are capped at 500 characters. The original browser result remains in `data`, including additive `errorInfo` with `certainty` (`observed` or `unknown`).

`retryable: true` is reserved for safe read operations with a known transient timeout, readiness, or connection state. The browser retries only DOM-readiness failures for safe reads, with at most three attempts. It never automatically retries click, text-entry, scrolling, search, navigation, or submission actions. If such an action could already have reached the page, the result has `actionMayHaveCompleted: true`; callers must inspect the tab rather than retry blindly. The bridge does not infer a login or geographic restriction from a generic failure.

### Condition-based waits

Use `wait_for_element` when a particular page condition must become true after a prior action. It is a non-mutating read: it never clicks, types, submits, changes focus, or retries the preceding action. It checks only the requested DOM condition, so pages with polling, analytics, live scores, ads, or other continuous background traffic can still become ready.

`tabId` and `selector` are required. `index` selects one matching element and defaults to `0`; it is limited to `0`–`100`. The default condition is that the selected element is present. Optional boolean conditions are `visible` and `enabled`; each waits for that exact state. Set `present: false` to wait for the selected element to disappear. `present: false` cannot be combined with visibility, enabled, or text conditions because there is no target element to inspect.

For text-driven updates, `text` waits for a literal normalized-text substring, and `textChangedFrom` waits until the element’s normalized text differs from the supplied value. Text comparisons ignore repeated whitespace; `text` is case-insensitive unless `caseSensitive: true`. Both strings are limited to 512 characters. `timeoutMs` defaults to 10,000 and is bounded to 500–20,000; `pollIntervalMs` defaults to 100 and is bounded to 50–1,000 milliseconds.

The successful result includes the exact condition, observed state, elapsed time, and whether the same application tab navigated while waiting. A navigation does not cancel the wait: the condition follows the same `tabId` and resumes after its new document is ready. Closing that tab returns observed `browser_tab_closed`; stopping OpenCode or a remote call cancels the wait promptly without stopping page loading. A deadline returns `browser_timeout` and no browser action is retried or duplicated.

### Batch tab reads

Use `batch_read_tabs` when several already-known tabs need independent inspection. It accepts `requests` (1–8) and an optional `maxOutputChars` (10,000–64,000; default 24,000). Each request has a unique `id`, an allowlisted `tool`, and its normal tool arguments including an explicit `tabId`. The allowed tools are `get_tab_info`, `read_page_text`, `find_page_text`, and `query_selector_all`; the batch tool cannot navigate, wait, focus, or mutate a tab.

Items run through the existing bounded read coordinator rather than a separate queue, so they share the normal concurrent-read cap with other browser clients and remain cancellable. A failed, closed, or blocked tab produces only that item's result; it does not discard successful siblings. The caller retains the order and `id` supplied in `requests`.

Each item includes `document.initial`, `document.source`, and `document.current`. Page-content reads capture `document.source` inside the page evaluation, including URL, title, and a document identifier; callers must use that source identity for citations instead of assuming the tab's current page. `sourceIsCurrent` is intentionally only true when it can be proven; a navigation after the read leaves the result attributed to the captured source, never relabeled as the new page. If the combined response would exceed `maxOutputChars`, individual results retain their id, tool, success/failure state, and source identity while bulky text, matches, or selector items are clipped; `output.truncated` and per-item `truncated.output` make that explicit.

### OpenCode artifacts

OpenCode can create persistent text artifacts without receiving general filesystem access. `create_artifact` requires a safe filename and direct UTF-8 `content`; OpenCode must not base64-encode HTML, CSV, Markdown, JSON, or other text. The direct-content field is capped at 2,000,000 characters, each stored file at 10 MiB, and the whole artifact library at 1 GB. Files and a private manifest are stored in the app-owned artifact workspace and remain available after browser restarts until the user deletes them. `list_artifacts` returns opaque IDs, safe local URLs, and storage status; the Artifacts panel warns the user when opened at the 1 GB limit.

Use `download_artifact` for any file type. OpenCode asks for the user's approval before it invokes this action; the approved request opens a visible local download URL that always responds as an attachment, so a document, archive, image, or binary is not interpreted as application content. `open_artifact` opens every artifact: HTML runs in a sandboxed interactive tab, text files get an escaped read-only preview, and other file types get a safe page with a user-initiated download link. The viewer has no Electron or Node privileges and a CSP sandbox that blocks connections, forms, framing, top-level navigation, and external resource loading. Artifact routes are loopback-only and require a random per-session capability token; they are stopped and removed when the browser shuts down.

The browser toolbar also has an **Artifacts** library. Every artifact card has **Open**, **Download**, and a confirmed **Delete** action. This keeps report delivery visible even when OpenCode's terminal output has scrolled away.

The **Terminal** button opens OpenCode at the bottom by default. Use the **Bottom** and **Left** controls in its toolbar to dock it below the browser or alongside it; the selected location and its size are remembered for the next session.

### Bounded selector extraction

`query_selector_all` keeps its legacy defaults: it returns up to 200 matching elements, without clipping the selected text or item payload. Agent callers can opt into a bounded response without changing the tool name:

```json
{
  "tabId": "tab-42",
  "selector": "article h2 a",
  "fields": ["text", "href"],
  "compact": true
}
```

`compact: true` defaults to 20 results, 280 text characters per selected element, and a 6,000-character serialized-item budget. The explicit controls are `offset` (0–1,000,000), `maxResults` (1–200), `maxTextChars` (1–20,000), `textOffset` (0–1,000,000), and `maxOutputChars` (256–64,000). Limits are applied inside the page before the result crosses Electron IPC.

The result keeps `tab`, `selector`, and `items`, and adds `totalMatches`, `offset`, `nextOffset`, `nextTextOffset`, `truncated`, `truncatedItemIndexes`, and `itemOutputChars`. To read omitted elements, call again with `offset: nextOffset`. To continue a clipped single element, repeat the same selector with `textOffset: nextTextOffset`; preserve the same field selection and per-item limit. If `truncated.output` is true before an item can fit, narrow `fields` or lower `maxTextChars` and repeat at `nextOffset`; the tool does not silently discard part of an item to meet the output budget. A `null` continuation field means that type of content was not omitted.

`maxOutputChars` and `itemOutputChars` are character counts for the selected-item payload, not token counts. To reproduce the local large-element measurement, run `npm run measure:selector-output`. It reports `o200k_base` tokens using `js-tiktoken` 1.0.21 for the current default OpenCode target model, `openrouter/z-ai/glm-5.3-flash`; treat that as an estimate until the provider's exact tokenizer is confirmed.

## Suggested Agent Policy

The existing planner prompt already biases the model toward the following behavior:

1. Clarify underspecified requests before browsing.
2. Use real browser tabs, not hidden automation.
3. Compare multiple sources before finalizing shopping, local search, and recommendation tasks.
4. Keep the assistant workspace tab visible and untouched.
5. Stop for sensitive actions such as logins, purchases, or payment forms.

The current runtime enforces additional guardrails:

1. The assistant workspace tab is not a valid browsing target.
2. The browser host applies request-scoped aborts.
3. Runs are limited by tool calls, tab count, and time budget.
4. Shopping and research tasks require comparison before a final answer.
5. If you need a clean browser state for a new task, restart the Electron browser and reconnect to the fresh CDP session.

## Minimal Host Loop

If you are wiring your own host around the same planner contract, the loop looks like this:

```js
const action = await window.electronAPI.invoke('assistant-next-action', {
  requestId,
  sessionId,
  prompt,
  messages,
  browserState,
  taskProfile,
  runtimeState,
  limits,
  timeoutMs
});

switch (action.type) {
  case 'tool_call':
    // Execute the browser tool, append the result to messages, then ask again.
    break;
  case 'clarify':
    // Show the question to the user and pause the run.
    break;
  case 'final':
    // Display the answer and end the run.
    break;
}
```

## Direct CDP Control (Scripted, Out-of-Process)

The planner loop above is the in-app path: an LLM running behind `assistant-next-action` picks one tool at a time and the host executes it. There is a second, lower-level way to drive the same browser that does **not** go through the assistant workspace, the planner contract, or `browser-tools.js` at all.

In this mode an external process (a Node script, or an agent such as Claude Code) connects straight to the Electron Chrome DevTools Protocol endpoint and issues `Target.*`, `Page.*`, and `Runtime.*` commands against the real `webview` targets. The caller *is* the planner: it decides navigate -> wait -> extract itself instead of asking the in-app model.

Use this path for scripted automation, scraping, and reproducible batch runs. Use the assistant path when you want the product's own LLM agent to plan.

### How it differs from the planner path

| | Planner path (assistant) | Direct CDP path |
|---|---|---|
| Entry point | `assistant-next-action` IPC | CDP WebSocket on `127.0.0.1:9222` |
| Who plans | OpenRouter / Claude CLI backend | the calling script / agent |
| Tool layer | `browser-tools.js` (15 tools) | `scripts/cdp-browser-session.js` |
| Guardrails | tool/tab/time budgets, sensitive-action blocks, assistant-tab protection | none enforced — the caller is responsible |
| Target | real `webview` tabs | same real `webview` tabs |

Both surfaces ultimately act on the same live tabs. `cdp-browser-session.js` is the CDP-side twin of the tool surface: it exposes the same verbs the planner uses (`navigate`, `readPageText`, `querySelectorAll`, `clickElement`, `typeInto`, `scrollPage`, `searchSite`, `extractSearchResults`).

### Launch with CDP enabled

```bash
scripts/electron-launcher.sh start --port 9222
scripts/electron-launcher.sh status        # confirm "CDP: ready"
curl -fsS http://127.0.0.1:9222/json/list  # inspect targets
```

Target types you will see: `page` (the Electron shell / index.html), `webview` (actual tab content — target this), and `iframe`. `CdpBrowserSession` already filters out the shell and the assistant page so `listTabs()` only returns browsable tabs.

### Minimal scripted loop

```js
const { CdpBrowserSession } = require('./scripts/cdp-browser-session.js');

const browser = new CdpBrowserSession({ baseUrl: 'http://127.0.0.1:9222' });
await browser.initialize();

const { tab } = await browser.openTab({ url: 'about:blank', activate: true });
await browser.navigate(tab.id, 'https://example.com/search');

// The caller plans each step itself:
const text = await browser.readPageText({ tabId: tab.id });
const items = await browser.evaluate(tab.id, `(() => {
  return Array.from(document.querySelectorAll('a[href]')).map((a) => a.href);
})()`);

await browser.close();
```

`evaluate(tabId, expression)` runs arbitrary page JavaScript via `Runtime.evaluate` and returns the value by default. `navigate` waits for `document.readyState`; dynamic, JS-rendered result pages may still need an extra `await sleep(...)` before extraction.

### Worked example

`scripts/job-search.js` is a complete example of this pattern: it navigates `yenibiris.com` and `kariyer.net` results pages, detects anti-bot interstitials, extracts structured listings, and writes JSON to `scripts/logs/`. Run it against a browser already started on port 9222:

```bash
scripts/electron-launcher.sh start --port 9222
node scripts/job-search.js
```

### Practical notes

1. Some sites serve anti-bot walls (Akamai "press-and-hold", Cloudflare "verify you are human") to the automated session. Detect the interstitial from page text and report it rather than assuming an empty result set. A human can clear the challenge directly in the visible Electron window, after which the now-trusted session can be re-scraped.
2. Prefer path-based result URLs over query-param search forms where a site supports both — some sites gate the query-param endpoint behind bot verification while the path form loads cleanly.
3. There are no runtime budgets on this path. Add your own delays, retry, and visit limits (see `scripts/collect-sellers-v2.js` for a paginated, resumable example).
4. To reset state, stop and restart the browser (`scripts/electron-launcher.sh stop|start`) so the next run gets a clean CDP session.

## Troubleshooting

1. If you see `assistant-next-action is restricted to the host browser window`, the call came from the wrong context.
2. If you see `WebView must be attached to the DOM and the dom-ready event emitted`, wait for the target tab to finish attaching before executing page JavaScript.
3. If the model fails with a missing key error, check `OPENROUTER_API_KEY` in the repo-root `.env`.
4. If the workspace appears stuck, use Stop. The current implementation aborts the active planner request by request id.
5. If you need to reset a partially completed flow, restart the browser before reconnecting so the next run does not inherit the previous tab state.
