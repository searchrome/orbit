# 05 — Wait for a specific condition

Status: Ready for implementation
Priority order: 5 of 12
Estimated effort: Medium (relative, not a delivery commitment)

## Outcome

Reduce premature reads and interactions on dynamic pages.

## Implementation scope

- Add wait_for_element with explicit tabId, selector, visible/enabled states, and bounded timeout; support text-change waits where useful.
- Check conditions before interaction without blindly repeating the action.
- Integrate cancellation and document behavior when the target tab closes or navigates.
- Use condition-based waiting rather than global network idle; do not wait for every image or background request.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Delayed element, disabled-to-enabled, disappearing element, timeout, cancellation, and tab-close fixtures pass.
- [ ] A page with continuous background traffic can still become ready.
- [ ] No click or submission is duplicated by waiting.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
