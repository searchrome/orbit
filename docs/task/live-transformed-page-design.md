# Live transformed pages: developer design

Status: proposed; documentation only. No implementation is authorized by this document.

## Product contract

A user asks OpenCode to build an alternative view of an existing page: remove distracting sections, create a reader layout, or redesign how its information is presented. OpenCode develops a reusable transformation once. Every subsequent open or refresh loads current source content and applies that saved transformation without an LLM call.

The result has a persistent identity and opens in one normal browser tab. Refresh updates that tab; it does not create a new artifact. The browser reload command and a Refresh button inside the view use the same operation. Switching back to an already open tab does not automatically refresh it. A separately requested OpenCode rebuild changes the transformation itself.

“Live” means fresh on opening and explicit refresh in the first version, not continuous synchronization or guaranteed compatibility with every website. Read-only public articles, lists, and informational pages are the initial target. Interactive forms, payments, source-site application state, and continuous feeds remain in the original page.

## Existing implementation and required extensions

| Existing component | Relevant behavior | Proposed change |
| --- | --- | --- |
| `opencode-service.js` | Browser agent with explicit MCP permissions; ordinary filesystem/shell tools denied | Add developer instructions and scoped transformed-view tools |
| `scripts/browser-mcp-server.js` | Adapts browser and artifact tools | Register transformed-view tool schemas and dispatch |
| `artifact-service.js` | Stores static files; loopback URLs contain runtime port and capability tokens | Keep static artifacts intact; optionally export a transformed snapshot to one |
| `tab-manager.js` | Owns tab identities, webviews, hidden tabs, partitions, recovery snapshots | Add transformed-view role, stable view identity and unified reload routing |
| `renderer.js` / `preload.js` / `main.js` | Host UI and IPC boundaries | Add host-only commands and controlled view lifecycle |
| `browser-action-coordinator.js` | Per-tab mutation queues and agent ownership | Coordinate source acquisition without navigating a user's working tab |
| Artifact library UI | Shows persisted static deliverables | Show a distinct live-view card that opens the saved view |

Static HTML currently cannot refresh its source simply by reloading its local URL. A source loader, saved recipe, trusted view shell, and lifecycle service are new work. Existing artifact ports/tokens are temporary; never use them as persistent view identities.

## Architecture

Proposed components:

- `transformed-view-service.js`: main-process storage, validation, revisions, operation ownership, and IPC/MCP entry points.
- `transformed-source-loader.js`: temporary isolated source webContents, navigation, readiness, extraction and cleanup.
- `transformed-view-runtime.js`: bounded declarative extraction and rendering; no execution of arbitrary generated JavaScript.
- `transformed-view.html` / `.js`: application-owned shell with Refresh, Stop, Open original, last-updated status and an isolated result frame.

Flow: saved view ID → source loader → inert document snapshot → saved recipe → isolated result → atomic replacement of the last successful snapshot.

Use a dedicated source webContents with no application preload or Node integration. Source JavaScript may run to populate dynamic public pages, subject to the user's blocker settings. The generated view never receives the source cookies, source scripts or a general Electron bridge. No public server or S3 is needed for local operation.

The source loader uses a separate nonpersistent partition in the first version. It does not inherit logged-in browsing sessions. Pages requiring authentication show an explanatory state with Open original. Future authenticated support needs an explicit session design; silently sharing the browser's cookies is not part of this proposal.

## OpenCode as developer

OpenCode inspects the selected page with existing browser read tools, identifies stable content selectors, creates the recipe and layout, then previews and revises them. Give it structured authoring tools rather than expanding its general shell/filesystem permissions.

Proposed tools (names are new contracts, not existing capabilities):

| Tool | Purpose |
| --- | --- |
| `create_transformed_view` | Persist source URL, name, recipe and presentation; return stable view ID |
| `update_transformed_view` | Save a validated candidate revision using an expected revision number |
| `preview_transformed_view` | Test a candidate against fresh source content and return extraction diagnostics |
| `open_transformed_view` | Open/focus the view; refresh on a new open |
| `refresh_transformed_view` | Reload source and apply the accepted recipe |
| `list_transformed_views` | Return IDs, source URLs, revisions and refresh status |

Tools accept ordinary UTF-8 JSON, HTML template and CSS strings. Agent instructions explain selector testing, source attribution, empty-state handling, and that normal refresh never requires OpenCode. Updates use optimistic concurrency and retain the last working revision. A rebuild is user-initiated; a broken selector does not automatically start paid model work.

## Saved contract

Store under `<userData>/transformed-views/<uuid>/`, separate from static artifact bytes. Proposed manifest example:

```json
{
  "schemaVersion": 1,
  "id": "<uuid>",
  "name": "Clean news feed",
  "sourceUrl": "https://example.com/news",
  "revision": 1,
  "recipe": {
    "readySelector": "main article",
    "rootSelector": "main",
    "removeSelectors": [".advertisement", "nav"],
    "fields": {
      "heading": { "selector": "h1", "type": "text", "required": true }
    },
    "collections": {
      "stories": {
        "selector": "article",
        "limit": 50,
        "fields": {
          "title": { "selector": "h2", "type": "text", "required": true },
          "link": { "selector": "a", "type": "url", "attribute": "href" }
        }
      }
    }
  },
  "presentation": {
    "template": "template.html",
    "stylesheet": "styles.css"
  },
  "refreshPolicy": "on-open-and-manual",
  "createdAt": "<ISO timestamp>",
  "updatedAt": "<ISO timestamp>",
  "lastSuccessAt": null
}
```

Template binding must use a small defined grammar: escaped text fields, collection repetition and validated link/image attributes. No expressions, imports, event handlers or arbitrary script evaluation. Add an explicitly sanitized rich-content field type for reader views; never insert raw source HTML. CSS is scoped to the result frame and disallows external imports and URL-based network requests in v1. The runtime owns any optional local interactions, such as expanding sections.

Persist the manifest, template, stylesheet and last successful sanitized snapshot with atomic writes. Revisions refer to a complete bundle, never partially updated files. Preserve the previous working bundle until its replacement passes validation. Use IDs for paths, enforce storage limits, and keep transient loading state out of the durable contract.

## Refresh lifecycle

1. Resolve the stable view ID and capture the accepted revision.
2. Show “Refreshing…” immediately. Keep the last successful content visible, marked with its timestamp.
3. Create a source loader, apply current blocker settings, and navigate to the source URL. A refresh triggers a new navigation; normal HTTP revalidation is allowed. Do not clear user cookies or global cache.
4. Wait for the configured readiness selector within a bounded deadline. Do not wait indefinitely for network idle.
5. Capture URL, title and a bounded document snapshot; parse it inertly and apply the recipe.
6. Validate required fields, sanitize rich content and resolve permitted relative links against the final source URL.
7. Render the template and atomically publish the result only if the operation ID and recipe revision are still current.
8. Record completion time and destroy the temporary source webContents in all success/failure/cancel paths.

State transitions: `idle → loading → ready`; failures become `error` if no snapshot exists, otherwise `stale`. Cancellation retains the prior snapshot. Repeated refreshes supersede earlier work: stop its source navigation, invalidate its operation ID, and discard late results. Closing the view or quitting the app also cancels and cleans up loaders. Sharing one in-flight refresh per view avoids duplicate work across tabs.

Proposed starting limits: two concurrent source loads, 20-second readiness deadline, 30-second overall refresh deadline, 2 MB extracted document, 100 collection items, 100 KB template, 100 KB CSS and 5 MB rendered output per snapshot. Make these explicit service constants and validate before saving or executing recipes.

## Browser behavior and navigation

- Address bar displays `browser://view/<uuid>` with visible source attribution in the view header. It must not pretend to be the source domain. Public domain sharing remains a separate future feature.
- All reload entry points, including Ctrl/Cmd+R, route through `reloadTab(tabId)` and dispatch transformed tabs to refresh their source. Reloading only the local shell is insufficient. Shell initialization also triggers refresh once, with deduplication to prevent double loads.
- In-page Refresh and Stop are trusted shell controls, outside the generated result frame. They remain visible while content scrolls. Optional generated buttons cannot call general IPC.
- Open original opens the current source URL in a normal tab. Source-content links open normal browser tabs in v1; following them does not silently retarget the recipe.
- Save `viewId` and tab role in both clean-exit restoration and crash recovery. Resolve runtime URLs on reopen. Existing recovery pauses still win: a crash-paused view requires explicit refresh.
- Reopening a saved view refreshes it. Merely focusing an already open tab preserves its current content and scroll position. Refresh preserves position when practical and displays a clear timestamp.
- Export snapshot produces an ordinary static artifact labeled with source URL and snapshot time. It does not retain live refresh behavior outside this browser.

## Isolation and failures

Keep the result in a sandboxed frame within the app-owned shell, with scripts/forms/top navigation blocked. Only the trusted shell can request refresh; main validates the exact host/frame identity and view binding. Generated markup and source content must not gain access to preload APIs, loopback capability tokens or filesystem paths. Application links are handled by the shell with validated HTTP(S) destinations.

Do not load remote assets directly from generated HTML in v1. An optional bounded image fetcher can supply sanitized images through the app, with explicit source-origin and redirect rules. Initial source targets and redirects should be HTTP(S), with local/private network targets disallowed for this public-page feature. Recipe CSS cannot create an alternative network channel.

| Condition | Visible behavior |
| --- | --- |
| Source offline or timeout | Keep previous snapshot, show “Could not refresh” and Retry |
| Required selector missing | Keep previous snapshot; show “Source layout changed” and offer Rebuild with OpenCode |
| User blocker active | Explain refresh is blocked; do not bypass the setting |
| Login required | Show Open original; do not report the login screen as a successful transformation |
| Source renderer crash | Stop that refresh, retain the view and offer Retry |
| Native Electron main-process crash | Existing recovery on restart; this architecture cannot promise containment of a native main-process failure |
| Deleted or unknown view ID | Show missing-view screen; do not navigate an obsolete local URL |

## Implementation sequence

1. Add versioned view storage, recipe/schema validation and deterministic fixture-based extraction/rendering.
2. Add bounded source loading, operation cancellation and cleanup. Verify public dynamic pages and blocker behavior.
3. Add trusted shell, result isolation and stable view tabs. Unify reload handling and support clean/crash restoration.
4. Add scoped OpenCode authoring tools, prompt instructions, candidate preview and revision promotion.
5. Add live-view library cards and static snapshot export. Document unsupported source types.

Each step should be independently reviewable. Keep public hosting, automatic publication, general executable transformation scripts and continuous background refresh out of this implementation.

## Acceptance checks

- An OpenCode-authored view shows content from a controlled source fixture; changing that source changes the view on reopen and on both browser/in-page refresh.
- Ordinary refresh makes zero LLM calls, preserves view identity and creates no extra tabs/artifacts.
- Dynamic fixture content waits for its readiness selector; absent content produces a bounded, explicit failure.
- Repeated refresh, Stop, tab close, rebuild during refresh and app shutdown never publish stale results or leak source loaders.
- Offline/selector failures preserve the last good snapshot and mark it stale; an empty extraction is not reported as success.
- Generated HTML/CSS cannot execute scripts, invoke IPC, read browser credentials, navigate the host or issue arbitrary network requests.
- Relative links resolve correctly and open original destinations; forms stay noninteractive.
- Clean restart restores the same view ID; crash recovery does not auto-reload a paused source.
- Existing static artifacts, ordinary tabs and active OpenCode browser operations retain their behavior.

References: [future features](../future-features.md), [OpenCode integration plan](opencode-terminal-integration-plan.md).
