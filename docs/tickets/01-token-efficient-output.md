# 01 — Token-efficient output

Status: Ready for implementation
Priority order: 1 of 12
Estimated effort: Small (relative, not a delivery commitment)

## Outcome

Reduce oversized tool responses without losing source evidence.

## Implementation scope

- Add optional result-count, field-selection, per-item text, and total-output limits to selector extraction.
- Apply limits inside page extraction before IPC serialization; keep deterministic ordering.
- Preserve existing response fields and defaults for existing clients. Expose a compact opt-in profile for agent calls and document recommended limits.
- Preserve tab ID, observed URL, errors, truncation information, and a way to request remaining content. Do not add LLM summarization.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Large fixture pages produce bounded responses, including a single very large matching element.
- [ ] Existing callers retain their response contract; compact callers can retrieve omitted content.
- [ ] Measure response tokens and correctness against current extraction.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
