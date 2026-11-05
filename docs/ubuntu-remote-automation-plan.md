# Ubuntu Remote Automation Plan

## Purpose

This document describes how to run the current `browser` project on a remote Ubuntu machine from the terminal and automate a real job-search workflow:

1. Open a job listing page.
2. Extract matching job links.
3. Open a selected job link.
4. Read and parse the job detail content.

The intended environment is a remote Ubuntu machine where a visible desktop is not required. A virtual display is acceptable.


## Scope

This plan is for the current Electron application and its real browser behavior. It does not depend on static HTML scraping alone.

The plan supports:
- remote execution through terminal
- virtual display with `xvfb`
- remote debugging through Chrome DevTools Protocol (CDP)
- DOM extraction from the live `webview`
- structured output such as JSON

The plan does not include:
- bypassing captcha
- bypassing anti-bot challenges
- evading site protections

If a target site presents a challenge page, the automation should detect it, pause, and surface the status clearly.


## High-Level Architecture

The automation flow is:

1. Start Electron on Ubuntu under a real or virtual display.
2. Enable remote debugging with `--remote-debugging-port=9222`.
3. Open the target page in the browser.
4. Query `http://127.0.0.1:9222/json/list`.
5. Find the target `webview`.
6. Connect to the `webSocketDebuggerUrl`.
7. Evaluate JavaScript in the live DOM.
8. Extract listing links or detail-page content.
9. Serialize the result to JSON.


## Ubuntu Prerequisites

Install system dependencies required by Electron:

```bash
sudo apt-get update
sudo apt-get install -y \
  xvfb \
  libgtk-3-0 \
  libnss3 \
  libasound2 \
  libxss1 \
  libgbm1 \
  libatk-bridge2.0-0 \
  libdrm2 \
  libxdamage1 \
  libxcomposite1 \
  libxrandr2 \
  libxkbcommon0 \
  libpangocairo-1.0-0 \
  libatk1.0-0 \
  libcups2
```

Install project dependencies:

```bash
npm install
```


## Running Electron Remotely

### Option A: machine with desktop session

```bash
npm start -- --remote-debugging-port=9222
```

### Option B: headless Ubuntu server with virtual display

```bash
xvfb-run -a npm start -- --remote-debugging-port=9222
```

This keeps the browser runnable from terminal even when no visible desktop is attached.

### Preferred wrapper commands

Use the project launcher wrapper for scripted orchestration:

```bash
scripts/electron-launcher.sh start --port 9222 --wait 40
scripts/electron-launcher.sh status --port 9222
scripts/electron-launcher.sh stop
```

Behavior:
- `start` returns only when CDP is reachable.
- The browser stays running after `start`.
- `stop` explicitly terminates the launched process.


## Opening the Initial Page

The simplest reliable way to open a page at startup is to seed the history file with one `open` tab entry.

On Linux, Electron user data is typically stored under:

```text
~/.config/browser/
```

Expected history file:

```text
~/.config/browser/browser-history.json
```

Example payload for a listing page:

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

Example payload for a detail page:

```json
[
  {
    "url": "https://www.kariyer.net/is-ilani/proven-bilisim-teknolojileri-anonim-sirketi-java-yazilim-muhendisi-4417820",
    "title": "Java Yazılım Mühendisi",
    "lastOpened": 1776855000000,
    "state": "open",
    "bookmarked": false
  }
]
```

The automation can write this file before launch, then start the app and wait for the page to load.


## Discovering the Active Webview

After Electron starts with remote debugging enabled:

```bash
curl -s http://127.0.0.1:9222/json/list
```

Target types typically include:
- `page`: the Electron shell window
- `webview`: the actual tab content
- `iframe`: embedded content inside the tab

Automation should select the `webview` target whose `url` matches the page of interest.


## Listing-Page Extraction

Once connected to the `webview`, run JavaScript in the live DOM to collect job links.

Recommended extraction pattern:

```js
Array.from(document.querySelectorAll('a[href*="/is-ilani/"]'))
  .map(a => ({
    text: (a.innerText || a.textContent || '').trim(),
    href: a.href
  }))
  .filter(x => /java|developer|yazılım/i.test(x.text))
```

This should produce a normalized array of job cards:

```json
[
  {
    "text": "Java Yazılım Mühendisi ...",
    "href": "https://www.kariyer.net/is-ilani/..."
  }
]
```

Recommended post-processing:
- deduplicate by `href`
- normalize whitespace
- split visible text into structured fields when possible
- preserve the original raw text for fallback parsing


## Detail-Page Extraction

After selecting one link, open it in the browser and extract the page content from the target `webview`.

Recommended DOM read:

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

This raw structure is enough to parse:
- job title
- company name
- location
- updated time
- work model
- employment type
- application count if visible
- general qualifications
- preferred qualifications
- job description
- company information
- benefits


## Blocker and Challenge Handling

Some target pages may load anti-bot, captcha, or challenge components. The automation must not attempt to bypass them.

Instead, it should:

1. detect challenge-like content
2. stop extraction
3. return a machine-readable status
4. allow manual continuation if a human solves the challenge in the display session

Detection signals can include:
- page title contains `captcha`, `verify`, `challenge`, or `access denied`
- body text contains challenge instructions
- known third-party challenge widgets appear in the DOM

Example status payload:

```json
{
  "status": "challenge_detected",
  "url": "https://www.kariyer.net/...",
  "title": "Verification Required",
  "reason": "Potential anti-bot or captcha page detected"
}
```


## Output Contract

The terminal automation should return JSON rather than plain text whenever possible.

Suggested listing output:

```json
{
  "status": "ok",
  "page_type": "listing",
  "query": "java yazilim uzmani",
  "results": [
    {
      "title": "Java Yazılım Mühendisi",
      "company": "PROVEN BİLİŞİM TEKNOLOJİLERİ ANONİM ŞİRKETİ",
      "location": "Ankara",
      "href": "https://www.kariyer.net/is-ilani/..."
    }
  ]
}
```

Suggested detail output:

```json
{
  "status": "ok",
  "page_type": "detail",
  "job": {
    "title": "Java Yazılım Mühendisi",
    "company": "PROVEN BİLİŞİM TEKNOLOJİLERİ ANONİM ŞİRKETİ",
    "location": "Ankara (Çankaya)",
    "work_model": "İş Yerinde",
    "employment_type": "Tam Zamanlı",
    "requirements": [],
    "preferred_skills": [],
    "description": [],
    "benefits": []
  }
}
```


## Implementation Plan

### Phase 1: launcher
- Write a script to seed the history file with the target URL.
- Start Electron with `xvfb-run -a` and `--remote-debugging-port=9222`.
- Wait until the DevTools endpoint is reachable.

### Phase 2: target discovery
- Query `/json/list`.
- Select the correct `webview` target by URL.
- Retry until the expected page is present or timeout.

### Phase 3: extractor
- Evaluate DOM extraction code in the `webview`.
- Support both listing and detail pages.
- Normalize the extracted content.

### Phase 4: blocker detection
- Detect challenge pages before parsing.
- Return a structured failure state instead of forcing the flow.

### Phase 5: CLI wrapper
- Add commands such as:
  - `search-jobs <url>`
  - `get-job <url>`
  - `extract-json <url>`


## Operational Notes

- Prefer live DOM extraction from the `webview` over static HTTP scraping for client-rendered pages.
- Keep one browser session per run unless session reuse is a deliberate feature.
- Capture logs around page URL, target selection, and extraction timing.
- Persist raw DOM snippets or raw text in debug mode only.
- Do not depend on fragile CSS classes when broad semantic selectors are sufficient.


## Recommended Next Step

Implement a Node script that:

1. writes the history file
2. launches Electron under `xvfb`
3. finds the `webview`
4. extracts listing results or detail content
5. prints JSON to stdout

That script becomes the terminal entry point for Ubuntu remote execution.
