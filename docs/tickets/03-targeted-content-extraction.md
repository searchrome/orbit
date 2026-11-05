# 03 — Targeted content extraction

Status: Ready for implementation
Priority order: 3 of 12
Estimated effort: Small–medium (relative, not a delivery commitment)

## Outcome

Read relevant content while retaining full-page access.

## Implementation scope

- Extend reading with optional selector and content mode for main/article extraction.
- Use deterministic DOM extraction with explicit fallback metadata when the requested semantic region is absent; an invalid or unmatched explicit selector must be reported.
- Keep legacy full-page behavior available and unchanged for existing calls.
- Bound output and return source metadata, extraction mode, and truncation details. Extract without modifying the visible DOM.
- Defer specialized price inference, full table normalization, and LLM summarization.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Article, product, and no-main-region fixtures preserve relevant evidence.
- [ ] Legacy read calls remain compatible.
- [ ] Navigation chrome is reduced in targeted mode without deleting page content.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
