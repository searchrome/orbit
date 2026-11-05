# 11 — Session notes and cached findings

Status: Ready for implementation
Priority order: 11 of 12
Estimated effort: Medium–large (relative, not a delivery commitment)

## Outcome

Avoid unnecessary repeated reads without presenting stale evidence.

## Implementation scope

- Keep conversation summarization in the calling LLM; add explicit bounded browser notes only where clients need shared source records.
- Record source URL, tab/document identity, capture timestamp, and client/session ownership.
- If caching is added, define invalidation for navigation and DOM changes and expose freshness explicitly; URL equality alone is insufficient.
- Keep memory isolated between clients/sessions and provide explicit deletion and retention behavior.
- Do not automatically persist sensitive page contents or introduce model calls.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Notes retain provenance and remain isolated between sessions.
- [ ] Navigation and dynamic content cannot yield an unmarked stale cache hit.
- [ ] Deletion/retention behavior is tested; browser bookmarks and history remain unchanged.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
