# Source review evidence

This index points to the implementation behind the functional specification.
A reviewer that samples only some of these files cannot establish that the
unsampled portions are missing. This document describes the v1.0.2 source. The task-cleanup and
source-security changes are not present in v1.0.1; installed applications and
earlier source uploads need updating to include them.

## Feature implementation index

| Feature | Main implementation and entry points |
| --- | --- |
| Tabs, switching, closing, and back navigation | `tab-manager.js`: `createTab`, `switchToTab`, `closeTab`, `updateBackButtonState`; `renderer.js`: back-button handler |
| Automatic named sessions | `automatic-sessions.js`: `start`, `save`, `change`, `rename`, `delete`; `workspace-store.js`: persistence; `workspace-panel.js`: session controls |
| Groups, unloaded pages, and tab layouts | `tab-manager.js`: `setTabGroup`, `setTabGroupCollapsed`, `suspendTab`; `workspace-panel.js`: layout-button binding and `bindSidebarResize`; `styles.css`: `body.vertical-tabs` rules |
| Tab title and website search | `tab-manager.js`: `setTabSearchQuery`, `_matchesTabSearch`, `_renderGroupHeaders`; `workspace-panel.js`: `bindTabSearch`; `index.html`: `tab-search-input` |
| OpenCode browser integration | `opencode-service.js`: runtime configuration and terminal lifecycle; `terminal-panel.js`: terminal controls; `browser-tool-dispatcher.js`: browser actions |
| Task file uploads | `session-files-panel.js`: upload/list UI; `opencode-session-workspace.js`: session-scoped file storage; `opencode-service.js`: `uploadFiles` |
| Task tab cleanup | `browser-task-lifecycle.js`: ownership tokens and completion ordering; `scripts/browser-mcp-server.js`: `begin_task` / `complete_task`; `browser-tool-dispatcher.js`: tracked tab cleanup; `main.js`: live-artifact source protection |
| Page and YouTube summaries | `summarizer.js`: summary requests; `openrouter-service.js`: summarization; `main.js`: transcript retrieval and summary IPC |
| Cleaned and transformed reading views | `transformed-view-manager.js`: creation and refresh; `transformed-view-service.js`: saved definitions; `transformed-view.html`: reading UI; `main.js`: page cleanup |
| Generated files and reports | `artifact-service.js`: creation, preview, download, and deletion; `artifact-panel.js`: library actions; `scripts/browser-mcp-server.js`: output tools |
| Persistent interactive dashboards | `dynamic-artifact-service.js`: source refresh, settings, and storage; `dynamic-artifact-frame.js`: controls and sandboxed application frame |
| Bookmarks and natural-language search | `bookmarks-panel.js`: search UI; `history-manager.js`: saved bookmarks; `main.js`: `bookmark-search`; `openrouter-service.js`: model-backed bookmark search |
| DuckDuckGo and instant search | `renderer.js`: address-bar handling; `main.js`: `get-first-duckduckgo-result` |
| Per-tab network control and activity display | `renderer.js`: toggle handler, network status, and activity rendering; `main.js`: `toggle-network`, `set-network-status-for-tab`, and request monitoring |
| Global JavaScript control | `renderer.js`: toggle and `js-status` listener; `main.js`: `toggle-js` |
| Cache and domain blocking | `renderer.js`: toolbar bindings; `main.js`: `toggle-cache`, `toggle-domain-blocking`, and `loadBlocklist`; `block.list`: domain data |
| Download progress and clearing finished items | `renderer.js`: `renderDownloadStatus` and `clearDownloadsBtn` handler, which deletes only entries whose state is not `progressing`; `main.js`: download events; `index.html`: download display |
| Compatible video casting | `cast-panel.js`: discovery and playback UI; `dlna-cast-manager.js`: device controls; `cast-relay-service.js`: compatible media relay |

## Security boundaries

### AI navigation schemes

`browser-url-policy.js` permits HTTP, HTTPS, and the exact blank-page URL only.
Both `browser-tool-dispatcher.js` and `browser-tools.js` apply that policy
before opening or navigating a page. Local files, script URLs, embedded data,
and application-internal schemes are rejected. Trusted reader and artifact
entry points remain separate from arbitrary AI URL navigation.

### Generated HTML

Static HTML responses in `artifact-service.js` use an HTTP CSP sandbox with
scripts permitted for interactive reports, but without `allow-same-origin`.
Network connections, forms, child frames, objects, and workers are prohibited.
The result is an opaque document origin, rather than access to the server's
origin or tool API. Artifact webviews receive no preload bridge.

Dynamic applications run inside the `sandbox="allow-scripts"` iframe generated
by `dynamic-artifact-frame.js`, also without same-origin permission. Their
trusted outer frame exposes only the documented scoped operations. The tool
endpoint requires its separate authorization token.

### Remote page preload

The full `electronAPI` exists only in the exact bundled host document with a
browser-process-provided launch marker. A remote page named `index.html` does
not qualify. The browser process removes the host preload and host markers
from guest webviews.

`guest-preload.js` exposes no application API to websites. It handles link and
reading-mode notifications in its isolated context. Bundled transformed and
recovery pages use separate narrow preloads that verify their exact trusted
local document; those APIs disappear after navigation to a remote page.

## Regression coverage

- `__tests__/unit/preload.test.js`: host identity, remote index pages, restricted guest messages, and narrow bridges.
- `__tests__/unit/browser-tools.test.js` and `browser-tool-dispatcher.test.js`: unsafe URL rejection before browser changes.
- `__tests__/unit/artifact-service.test.js`: restrictive response headers.
- `__tests__/e2e/browser-navigation.test.cjs`: isolated desktop checks for remote API absence, rejected AI navigation, opaque-origin interactive artifacts, and recovery behavior.
- `scripts/tests/dynamic-artifacts.test.cjs`: dynamic frame isolation and API authorization.
- `__tests__/unit/browser-task-lifecycle.test.js`, `browser-task-source-protection.test.js`, and `scripts/tests/browser-task-cleanup.test.cjs`: task cleanup ownership and source retention.

These checks are scoped regression evidence, not a claim that a source scan
or test suite can guarantee application safety.
