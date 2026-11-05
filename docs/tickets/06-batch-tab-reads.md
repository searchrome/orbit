# 06 — Batch reads across tabs

Status: Ready for implementation
Priority order: 6 of 12
Estimated effort: Small–medium (relative, not a delivery commitment)

## Outcome

Reduce round trips for multi-tab inspection.

## Implementation scope

- Reuse the existing coordinator and verify its concurrent-read path before adding new machinery.
- Add a bounded batch read interface only for allowlisted read operations, with per-item IDs, independent results, and a total output budget.
- Maintain per-tab mutation coordination and cancellation; prevent results from being attributed to the wrong document after navigation.
- Preserve single-call tools and actual application tab IDs.
- Keep comparison reasoning in the calling LLM; do not add a model-backed compare service.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Several local tabs are read concurrently within the configured cap.
- [ ] One failure does not lose successful items; total output remains bounded.
- [ ] Navigation, cancellation, and mixed client activity do not corrupt source identity.
- [ ] Measure latency improvement separately from token usage.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
