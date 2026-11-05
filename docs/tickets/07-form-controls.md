# 07 — Form inspection and explicit controls

Status: Ready for implementation
Priority order: 7 of 12
Estimated effort: Medium (relative, not a delivery commitment)

## Outcome

Make form operations precise and avoid confusing search, signup, and login fields.

## Implementation scope

- Add bounded form inspection returning labels, control types, options, and safe current-state information.
- Reuse existing search-field heuristics; add explicit select-option and checkbox/radio state operations.
- Require exact targets and enforce applicable confirmation rules before sensitive or consequential actions.
- Avoid returning passwords or hidden secrets by default; never auto-submit as a side effect of inspection or setting a field.
- Defer file uploads and complex custom date-picker automation.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Search, newsletter, login, select, checkbox, and radio fixtures are distinguished.
- [ ] Setting a desired checkbox state is idempotent; no unintended form submission occurs.
- [ ] Permission checks and remote-client compatibility are verified.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
