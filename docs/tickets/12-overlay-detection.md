# 12 — Overlay detection and explicit dismissal

Status: Ready for implementation
Priority order: 12 of 12
Estimated effort: Medium–large (relative, not a delivery commitment)

## Outcome

Identify blocking overlays while preserving user choices.

## Implementation scope

- Detect likely obstructing dialogs and return bounded descriptions and available actions.
- Provide explicit dismissal targets or honor a deliberately configured user preference.
- Do not automatically accept cookies, choose age/geo settings, enable notifications, or remove DOM overlays.
- Use existing targeting, waiting, permissions, and cancellation mechanisms.
- Keep CAPTCHA detection informational; do not introduce bypass behavior.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Cookie, notification, age/geo, and ordinary modal fixtures are distinguished with uncertainty reported.
- [ ] Detection changes no page state.
- [ ] Dismissal only follows explicit action or the matching stored preference and is not blindly retried.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
