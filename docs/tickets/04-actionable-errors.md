# 04 — Honest and actionable errors

Status: Ready for implementation
Priority order: 4 of 12
Estimated effort: Small–medium (relative, not a delivery commitment)

## Outcome

Prevent wasted retries by reporting observed failure states accurately.

## Implementation scope

- Standardize additive error codes for known network/JS blocks, missing elements, navigation failures, and deadlines.
- Distinguish directly observed states from suspected login/geo restrictions; report uncertainty rather than inventing a cause.
- Preserve explicit user blocks and cancellation boundaries, including whether an action may have completed.
- Allow bounded backoff only for safe reads and proven transient failures; never automatically retry submissions, clicks, or other mutations.
- Keep existing error-envelope compatibility for remote clients.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Fixtures or mocks distinguish blocked, missing, timeout, and unknown states.
- [ ] Mutation failures do not trigger retries; cancellation prevents queued work.
- [ ] Clients receive actionable errors with bounded response size.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
