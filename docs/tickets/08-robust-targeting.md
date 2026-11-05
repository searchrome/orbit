# 08 — Robust element targeting

Status: Ready for implementation
Priority order: 8 of 12
Estimated effort: Medium–large (relative, not a delivery commitment)

## Outcome

Improve access to modern component trees without ambiguous actions.

## Implementation scope

- Add role/name targeting and explicit open-shadow-root traversal with bounded search.
- Add explicit frame discovery and frame targets; treat cross-origin frame support as a separate implementation milestone.
- Document unsupported closed shadow roots and frame cases honestly.
- Retry discovery or readiness only; do not choose an alternative ambiguous target or repeat a consequential action.
- Keep existing CSS selector behavior and tab IDs compatible.

## Compatibility requirements

- Preserve normal browsing, visible tabs, login partitions, history, user network/JS settings, and the existing assistant.
- Implement reusable behavior in the shared browser-tool layer, then expose it through the dispatcher/MCP adapter. Do not make the feature OpenCode-specific or require another LLM.
- Keep existing tool names, required arguments, response fields, and legacy behavior compatible. Add optional arguments or new tools.
- Enforce argument/output limits, exact target identity, existing permissions, coordination, and cancellation where relevant.
- Use deterministic local fixtures and focused tests; live model calls are not required in the normal test suite.

## Acceptance criteria

- [ ] Fixtures cover duplicate accessible names, open shadow roots, nested frames, and unsupported targets.
- [ ] Ambiguous matches fail clearly without acting.
- [ ] A navigation or detached target cannot redirect an action to another element or tab.
- [ ] Focused regression checks cover existing browser and remote-client behavior.
- [ ] Document new tools/options and limits in the remote-control documentation.

## Starting points

Inspect `browser-tools.js`, `browser-tool-dispatcher.js`, `browser-action-coordinator.js`, `scripts/browser-mcp-server.js`, and relevant main/preload IPC before implementation. Reuse current code rather than assuming features are absent.
