# Orbit

A customizable Electron-based browser with unique features for content control, AI-powered summarization, and distraction-free reading.

## Features

### Content Control
- **Per-Tab Network Control**: Toggle network access independently for each tab
- **JavaScript Control**: Enable/disable JavaScript execution with automatic behavior based on user interactions
- **Domain Blocking**: Block unwanted domains using a customizable blocklist
- **Cache Control**: Toggle browser cache with automatic clearing

### AI-Enhanced Browsing
- **Content Summarization**: Get AI-powered summaries of web page content using OpenRouter or a configured local CLI backend.
- **YouTube Video Summarization**: Automatically fetches and summarizes transcripts for YouTube video pages.
- **Content Cleanup**: Extract and display the main content of a page in a clean, distraction-free format.
- **Related Content Extraction**: Automatically identify and display related links from the current page.

### Smart Interaction
- **Scroll-Triggered Actions**: Automatically disable network and JavaScript when scrolling down a page
- **Click-Triggered Actions**: Automatically enable network and JavaScript when clicking on page elements
- **Network Activity Visualization**: See visual representation of network request sizes

### Search Enhancements
- **DuckDuckGo Integration**: Privacy-focused search directly from the URL bar
- **Instant Search**: Use "word!" syntax to navigate directly to the first search result
- **In-Page Search**: Search for selected text in a side panel

## Installation

### Prerequisites
- Node.js 22.12 or later
- npm (included with Node.js)

### Setup
1. Clone the repository:
   ```
   git clone https://github.com/searchrome/orbit.git
   cd orbit
   ```

2. Install dependencies:
   ```
   npm install
   ```

3. Start the application:
   ```
   npm start
   ```

## Configuration

Basic browsing works without API credentials. For OpenRouter features, copy
`.env.example` to `.env` and set your own API key. Keep `.env` private.
OpenCode requires its own installation and authentication, described below.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development and pull request guidance,
and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

For feature implementation entry points and security regression coverage, see
[Source review evidence](docs/source-review-evidence.md).

## Usage

### Search tabs

Click the magnifying glass beside the tab layout and group buttons to search
all open tabs by title or website address, including unloaded tabs and tabs
inside collapsed groups. Combine words such as `github release` to match a
website and page title together. Filtering does not load pages or close tabs.

With left-side tabs, the field appears below the sidebar header, above the
tabs. With top tabs, it appears just before the action icons and makes room
by compressing the tab strip. Click a result or press Enter to open the first
match. Use the clear button to restore all tabs, or Escape to close search.

### Automatic sessions

Every tab belongs to a session. On first launch, Orbit creates a session with
an automatic name and saves tabs, titles, addresses, tab order, groups, and
collapsed groups as you browse. The last-used session opens at startup.

Open **Sessions** to see your current session and saved workspaces. Edit the
current name and click **Rename** to give it a meaningful name. **New session**
starts a separate workspace with a blank tab and an automatic name. **Switch to
session** saves your current workspace and replaces its tabs with the selected
session; inactive sessions retain their saved tabs until you use them again.

**Delete** removes a session. Deleting the current session starts a new blank
session, so the browser always has one. A session already open in another
window is focused instead of opening a competing copy. The save indicator
reports background saves and any write errors. Existing saved sessions and
legacy open tabs are preserved when upgrading.

### Basic Navigation
- Enter URLs or search terms in the address bar
- Use the back button to navigate to previous pages
- Create new tabs with the "+" button in the tab bar

### Content Controls
- Toggle network access for the current tab with the "Network" button
- Toggle JavaScript with the "JS" button
- Toggle cache with the "Cache" button
- Toggle domain blocking with the "Blocklist" button

### AI Features
- Click "Summarize" to get an AI-generated summary of the current page (or YouTube video transcript).
- Click "Cleanup" to extract and display the main content in a clean format.

### OpenCode Terminal

Click **Terminal** in the toolbar to open the bottom drawer. It starts an OpenCode session using the `provider/model` value in the drawer's Model setting. The selected model is saved locally and takes effect for the next session.

The browser must have OpenCode installed and authenticated before starting a session:

```
opencode auth login
```

The terminal automatically gives OpenCode a local `browser` MCP server. Its tools operate the browser's visible tabs: it can list and focus tabs, navigate, read page text, search a page, and interact with page elements. The generated `browser` agent has enforced permissions: inspection and navigation tools are allowed, while closing tabs, clicks, text entry, and site searches require approval in OpenCode. Shell, file, web-fetch, and inherited MCP tools are denied for this agent. Page text is treated as untrusted content.

Use **New session** after changing models. **Stop** cancels queued browser work, terminates OpenCode and its owned MCP descendants, and reports a possible completed action rather than incorrectly reporting success when an in-flight click/type could not be undone. Hiding the drawer leaves the session running so it can be reopened without losing the conversation. While OpenCode is starting or running, the older Assistant workspace cannot control browser tabs.

Set `OPENCODE_TERMINAL_ENABLED=false` to hide the terminal and reject terminal startup during a staged rollout.

OpenCode tracks temporary research tabs per task. Its browser agent starts with
`begin_task` and calls `complete_task` after verifying the result, before its
final answer. Cleanup closes only tabs opened through that task's `open_tab`
tool. Existing tabs, artifact previews, explicitly retained results, and source
tabs needed by live artifacts stay open. Cleanup reports retained tabs and
failures; hiding or stopping the terminal does not trigger tab deletion.

### Special URL Bar Features
- Type a search term to search with DuckDuckGo
- Type "word!" to navigate directly to the first search result for "word"

## Browser Automation Workflow

This project can be automated as a real browser, not just as a static HTTP scraper. A practical workflow is:

1. Start the Electron app with remote debugging enabled.
2. Open or restore the page you want to inspect in a tab.
3. Discover the active `webview` target through the DevTools endpoint.
4. Read the live DOM from that `webview`.
5. Extract job cards and links from the listing page.
6. Open a selected job link in a new tab or as the startup page.
7. Read the job detail page and parse requirements, location, company info, and benefits.

For the planner request/response contract and the browser tool loop used by the AI workspace, see [Remote LLM Browser Control](docs/browser-remote-llm-control.md).

### Why this approach
- It uses the application's real browser behavior, including JavaScript-rendered content.
- It works on pages that are harder to scrape reliably with plain HTTP requests.
- It lets you automate tab-level browsing, search result discovery, link extraction, and detail-page parsing.

### Launch the browser for automation

Start the app normally:

```bash
npm start
```

Start the app with Chrome DevTools remote debugging enabled:

```bash
npm start -- --remote-debugging-port=9222
```

Once started, Electron exposes targets at:

```text
http://127.0.0.1:9222/json/list
```

### Use the launcher wrapper for scripted runs

For automation workflows, prefer the launcher wrapper instead of calling Electron directly:

```bash
scripts/electron-launcher.sh start --port 9222
scripts/electron-launcher.sh status --port 9222
scripts/electron-launcher.sh stop
```

What the wrapper adds:
- launches Electron in background and waits for CDP readiness
- checks `http://127.0.0.1:9222/json/list` before returning success
- writes a PID file and log file under `.tmp/`
- supports `start`, `status`, and `stop` commands for script orchestration
- keeps the browser process running after `start` until `stop` is called

Default paths:

```text
.tmp/electron-launcher.pid
.tmp/electron-launcher.log
```

Optional flags:

```bash
scripts/electron-launcher.sh start --port 9222 --wait 45
scripts/electron-launcher.sh start --pid-file /tmp/browser.pid --log-file /tmp/browser.log
```

On macOS, the wrapper checks for an active GUI user session (Dock process) before launch.
This avoids common scripted-start crashes where Electron aborts before CDP is available.
Use `--force` only if you intentionally want to skip that guard:

```bash
scripts/electron-launcher.sh start --force
```

Quick smoke test:

```bash
scripts/electron-launcher.sh start --port 9222 --wait 40
scripts/electron-launcher.sh status --port 9222
curl -fsS http://127.0.0.1:9222/json/list | head
scripts/electron-launcher.sh stop
```

### Run the standalone agent harness

Use the standalone CDP harness when you want to test planner behavior with different models before wiring the flow into the browser UI.

Start the browser with CDP first:

```bash
scripts/electron-launcher.sh start --port 9222 --wait 40
```

Then run the harness:

```bash
npm run agent:harness -- --prompt "find me a used bicycle under 150 euro"
```

Useful options:

```bash
npm run agent:harness -- --model openai/gpt-4.1-mini
npm run agent:harness -- --cdp http://127.0.0.1:9222
npm run agent:harness -- --max-tool-calls 50
```

What it does:
- connects directly to the live browser through CDP
- sends the same planner prompt shape used by the in-browser agent
- prints the agent's own step messages before tool execution
- asks follow-up questions when the model returns `clarify`
- pauses after the tool budget and asks whether to continue

### Open a page programmatically

One simple way to drive startup navigation is to seed the browser history file so the app restores the target URL as an open tab on launch.

History file location on macOS:

```text
/Users/<your-user>/Library/Application Support/browser/browser-history.json
```

Example history payload:

```json
[
  {
    "url": "https://www.kariyer.net/is-ilanlari/java%2Byazilim%2Buzmani",
    "title": "Java Yazılım Uzmanı İş İlanları",
    "lastOpened": 1776855000000,
    "state": "open",
    "bookmarked": false
  }
]
```

With this file in place, launching the app restores that page in the browser automatically.

### Discover the active tab or webview

After the app starts with `--remote-debugging-port=9222`, query the target list:

```bash
node -e '(async()=>{const r=await fetch("http://127.0.0.1:9222/json/list"); console.log(JSON.stringify(await r.json(), null, 2));})()'
```

Useful target types:
- `page`: the Electron shell window that loads `index.html`
- `webview`: the actual browser tab content
- `iframe`: embedded third-party frames inside the webview

For automation, the `webview` target is the important one because it contains the live job listing or job detail page.

### Extract job links from a listing page

Once you have the `webSocketDebuggerUrl` of the `webview`, evaluate JavaScript in that target and collect job cards.

Typical extraction pattern:

```js
Array.from(document.querySelectorAll('a[href*="/is-ilani/"]'))
  .map(a => ({
    text: (a.innerText || a.textContent || '').trim(),
    href: a.href
  }))
  .filter(x => /java|developer|yazılım/i.test(x.text))
```

This is enough to:
- search a job listing page
- identify matching jobs
- collect the detail-page links

### Open a job link and get content

After selecting a listing URL, launch the app with that job URL as the restored open tab, or navigate a tab to that URL.

Then inspect the job detail `webview` and read the page DOM:

```js
({
  title: document.title,
  url: location.href,
  headings: Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    .map(h => h.innerText.trim())
    .filter(Boolean),
  body: document.body.innerText
})
```

This provides enough raw content to parse:
- job title
- company name
- location
- work model
- employment type
- candidate requirements
- preferred qualifications
- job description
- company information
- benefits

### Example end-to-end use case

The workflow used successfully against Kariyer.net was:

1. Seed history with a job search page such as `java+yazilim+uzmani`.
2. Launch the app with `npm start -- --remote-debugging-port=9222`.
3. Read `http://127.0.0.1:9222/json/list`.
4. Find the `webview` target for the listing page.
5. Extract matching job links from the live DOM.
6. Seed history with a chosen job URL.
7. Relaunch the app.
8. Read the job detail page from the `webview` DOM and parse the content.

### Notes for production automation
- Prefer DOM extraction from the `webview` over static HTML scraping when the site is client-rendered.
- Expect third-party anti-bot or captcha assets on some sites.
- The browser can still load and render useful content even when analytics or ad domains are blocked by `block.list`.
- If you need repeatable automation, consider wrapping the DevTools flow in a script that:
  - launches Electron
  - waits for the target `webview`
  - evaluates extraction code
  - serializes results as JSON

## Documentation

For detailed documentation about the browser application, see the following resources:

- [Documentation Index](browser-documentation-index.md) - Overview and links to all documentation
- [Functionality Document](browser-functionality-document.md) - Comprehensive overview of features and architecture
- [Architecture Diagram](browser-architecture-diagram.md) - Visual representation of the application structure
- [API and Event Flow](browser-api-and-events.md) - Details of the application's APIs and event handling
- [Unique Features](browser-unique-features.md) - Explanation of differentiating features
- [Development Roadmap](browser-development-roadmap.md) - Future development plans

## Development

### Project Structure
- `main.js` - Main process entry point
- `renderer.js` - Renderer process logic
- `preload.js` - Preload script for secure IPC
- `tab-manager.js` - Tab management functionality
- `summarizer.js` - Content summarization functionality
- `search-panel.js` - Search panel functionality
- `gemini-service.js` - Google Gemini AI integration
- `index.html` - Main application HTML
- `styles.css` - Application styling
- `style_sample.css` - Styling for cleaned content
- `block.list` - List of domains to block

### Building
```
npm run build:mac
```

### Testing
The application includes a comprehensive test suite to ensure functionality works as expected. Tests are organized into three categories:

- **Unit Tests**: Test individual components in isolation
- **Integration Tests**: Test how components work together
- **End-to-End Tests**: Test complete user workflows

To run the tests:

```bash
# Run all tests
npm test

# Run only unit tests
npm run test:unit

# Run only integration tests
npm run test:integration

# Run only end-to-end tests
npm run test:e2e

# Run all tests in sequence
npm run test:all
```

For more details about the testing setup, see the [Testing Documentation](__tests__/README.md).

## License

Orbit is licensed under the [MIT License](LICENSE). Third-party dependencies retain their respective licenses.

## Acknowledgments

- [Electron](https://www.electronjs.org/) - Framework for building cross-platform desktop applications
- [Google Generative AI](https://ai.google.dev/) - AI capabilities for content summarization and cleanup
- [DuckDuckGo](https://duckduckgo.com/) - Privacy-focused search integration

## Build Orbit for macOS

Run `npm run build:mac` on the target Mac. This creates a locally signed,
standalone `dist/Orbit-darwin-arm64/Orbit.app` on Apple Silicon (or the x64
variant on Intel). Copy Orbit.app to Applications and open that app directly;
it does not require a project-path argument. Pin Orbit, rather than the
Electron development executable, in the Dock.

The packaged app uses the existing `browser` profile in Application Support.
Optional local environment settings belong in `runtime.env` in that profile;
`.env` files and credentials are excluded from the application bundle. This
build is signed for local use; public distribution requires developer signing
and notarization.
