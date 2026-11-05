# 02 — Find page text with context

Status: Ready for implementation
Priority order: 2 of 12
Estimated effort: Small (relative, not a delivery commitment)

## Outcome

Find relevant passages without sending the entire page.

## Implementation scope

- Add find_page_text with explicit tabId, literal query, bounded contextChars and maxMatches, and documented case sensitivity.
- Return matching snippets, stable ordering, observed URL/title, match counts or explicit count limitations, and truncation metadata.
- Search rendered text without changing the user's selection, scroll position, or native find state; do not treat native findInPage match metadata as snippets.
- Bound extraction work and output; return explicit no-match and unsupported-frame scope information.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Fixtures cover repeated terms, Unicode, no matches, long text, and limits.
- [ ] No page or browser UI state changes occur.
- [ ] New tool works through MCP and the shared remote dispatcher.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
