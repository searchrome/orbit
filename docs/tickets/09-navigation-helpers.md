# 09 — Explicit navigation helpers

Status: Ready for implementation
Priority order: 9 of 12
Estimated effort: Mixed (relative, not a delivery commitment)

## Outcome

Support deliberate history and pagination operations.

## Implementation scope

- Expose back/forward with explicit tabId and history availability, bounded readiness, and observed destination metadata.
- Add explicit bounded pagination/load-more operations only with known targets and page/item budgets.
- Return 404 or navigation failure clearly; make site-search, breadcrumb, or sitemap fallbacks caller-selected.
- Preserve current tab history and the user's actual browsing session.
- Apply mutation coordination, permission rules, and cancellation to navigation helpers.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Back/forward respect the selected application tab and real history.
- [ ] Unavailable history returns a clear result.
- [ ] Pagination terminates at limits and detects no progress.
- [ ] A 404 does not silently navigate elsewhere.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
