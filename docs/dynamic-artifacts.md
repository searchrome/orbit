# Dynamic web artifacts — framework v1

The browser starts the artifact HTTP server on an automatically selected loopback port. Static files and dynamic apps share that server. No generated app starts a process or chooses a port.

Dynamic app definitions, settings, source snapshots and namespaced JSON records live in `userData/dynamic-artifacts/dynamic-artifacts.sqlite` using the SQLite implementation bundled with Electron's Node runtime. This requires Node 22.13 or newer with `node:sqlite` available. There is no separately installed database service. The browser closes the scheduler and database on shutdown.

## OpenCode workflow

1. Read `get_dynamic_artifact_guide` for the full contract and starter HTML.
2. Inspect the user's source tabs and their actual extraction result shapes.
3. Call `create_dynamic_artifact` with `{name, html, sources}`. Each source is `{id, url, kind: "text" | "elements", selector?}`.
4. Use `open_artifact` to open the result. Static and dynamic items share the Artifacts library.
5. For edits, read `get_dynamic_artifact`, then send the complete package to `update_dynamic_artifact` with `id` and `expectedRevision`. Settings and local records survive updates; source snapshots reset. Reopen to load changed HTML.

`dynamic-artifact-prompt.js` is injected into every newly started OpenCode browser session. `dynamic-artifact-starter.html` is the reusable template returned by the guide tool. Generated code uses HTML, inline CSS and browser JavaScript.

## Runtime SDK

The runtime installs `window.artifact` before generated code executes:

```js
const state = await artifact.data();
// state.sources[sourceId] = {url, fetchedAt, result}; result is a browser tool response.
const unsubscribe = artifact.subscribe(render);
render(state);
await artifact.storage.set('preferences', { sort: 'newest' });
const preferences = await artifact.storage.get('preferences');
await artifact.refresh();
```

State includes settings, lastSuccess, lastAttempt, nextRefresh, error, refreshing and storageBytes. Missing storage keys return null. Errors reject promises. Treat source data as untrusted text; use textContent rather than assigning source HTML.

## Common frame and scheduling

The trusted outer page provides the title, Refresh now, source-opening buttons and settings. Generated HTML runs in a sandboxed opaque iframe and receives only data, refresh and scoped storage methods through a checked message bridge.

Refresh defaults to each opening. Users can choose daily, manual or an interval of 15–1440 minutes. Daily means at least 24 hours after the last attempt/success; failed background jobs retry at the selected interval. On opening, an overdue daily app tries again. Background refresh is opt-in and runs only while the browser is running. Open app frames heartbeat every 15 seconds; a 45-second lease determines whether scheduled source refresh remains active. Background browser timer throttling can delay lease renewal and scheduled work. Closed apps execute no generated JavaScript; optional background jobs only update source snapshots.

The scheduler checks every 30 seconds, limits active/queued app refreshes to four and serializes browser source work. Concurrent identical source reads share one promise. User-triggered refreshes have a 15-second cooldown. Each app persists its own latest source snapshot; failed sources preserve old data with an error. This version does not implement a persistent global cache across apps.

## Limits and current boundaries

- Up to 100 saved dynamic apps, six sources per app, 500,000 HTML characters. Multiple app tabs can be opened; there is no hard renderer memory quota or automatic tab suspension yet.
- App storage: 100 records, 100 KB per record, 1 MB serialized JSON per app. No generated SQL or arbitrary database access.
- Sources are exact HTTP(S) URLs matched to currently open browser tabs. Tabs must remain open for source refresh. Refresh reads current DOM content; it does not reload/navigate sites or fetch closed sources.
- Text reads are bounded to 20,000 characters; element extraction to 100 results / 20,000 output characters. A post-read URL check rejects results after source navigation.
- Generated code has no Electron bridge, cookies, raw network access, remote images, CDN dependencies, server execution or direct access to other apps. Host APIs require the per-app route capability plus same-origin POST with a custom header. The main MCP tool endpoint retains its separate secret token.
- Generated app navigation stays inside the app. Hash links and client-side list/detail state work; external links, `target="_blank"` and `window.open()` are blocked with an explanation. Declared sources can still be opened through the trusted **Open source** buttons.
- Website actions are limited to trusted frame buttons opening declared source URLs on user click. General click/type/search/write operations, media proxying and video playback are future work.
- No background model calls. New content does not automatically receive AI summaries. App code can deterministically combine data or display explicitly timestamped precomputed summaries.
- Dynamic app URLs use a new random port/capability after browser restart. Reopen saved apps through the Artifacts library; old restored URLs may be unavailable. Stable restoration is future work.
- PDF generation is not added by this framework; static artifact creation still accepts UTF-8 content only.

## Verification

Run `node --test scripts/tests/dynamic-artifacts.test.cjs` for HTTP authorization, SQLite persistence/isolation, refresh behavior and revision checks. Existing artifact/OpenCode Jest suites exercise the integration. `scripts/dynamic-artifact-preview.cjs` runs the real frame with explicitly synthetic source data in a temporary profile for manual UI QA.
