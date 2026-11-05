# 10 — On-demand screenshots

Status: Ready for implementation
Priority order: 10 of 12
Estimated effort: Medium (relative, not a delivery commitment)

## Outcome

Provide visual evidence when text is insufficient.

## Implementation scope

- Add an explicit screenshot tool for a specified tab with viewport/crop support and bounded dimensions and encoded size.
- Return image data through an appropriate MCP image result and preserve existing text tools for text-only clients.
- Capture the actual visible browser page and include tab/URL provenance; do not create another login session.
- Define crop coordinates and unsupported cases; avoid automatic captures on every read or error.
- Respect existing access rules and do not persist images unless requested.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Viewport and crop fixtures produce correctly attributed images within size limits.
- [ ] Text-only remote workflows continue unchanged.
- [ ] Closed tabs and invalid crops fail clearly; screenshots do not change focus or page content.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
