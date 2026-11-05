# Browser-agent improvement tickets

Implement in the numbered order below, ranked by expected value relative to effort. Each ticket is independently reviewable; this order is not a claim that all later work depends on earlier tickets.

These tickets capture the improvement review, not a production-readiness certification. No 70–90% token-saving claim is assumed. Preserve normal browsing and all existing remote LLM clients.

| Order | Ticket | Effort |
| --- | --- | --- |
| 1 | [Token-efficient output](01-token-efficient-output.md) | Small |
| 2 | [Find page text with context](02-find-page-text.md) | Small |
| 3 | [Targeted content extraction](03-targeted-content-extraction.md) | Small–medium |
| 4 | [Honest and actionable errors](04-actionable-errors.md) | Small–medium |
| 5 | [Wait for a specific condition](05-condition-waiting.md) | Medium |
| 6 | [Batch reads across tabs](06-batch-tab-reads.md) | Small–medium |
| 7 | [Form inspection and explicit controls](07-form-controls.md) | Medium |
| 8 | [Robust element targeting](08-robust-targeting.md) | Medium–large |
| 9 | [Explicit navigation helpers](09-navigation-helpers.md) | Mixed |
| 10 | [On-demand screenshots](10-on-demand-screenshots.md) | Medium |
| 11 | [Session notes and cached findings](11-session-notes.md) | Medium–large |
| 12 | [Overlay detection and explicit dismissal](12-overlay-detection.md) | Medium–large |
| 13 | [DLNA video cast to TVs](13-dlna-video-cast.md) | Medium |

Start with tickets 01–04. Compare response token counts, tool-call counts, elapsed time, and task correctness on the same representative fixtures and workflows. Record the tokenizer/model used for token measurements; character counts are not token counts. Keep task correctness and evidence completeness as release gates.

Existing infrastructure includes bounded page reads, selector extraction, structured search results, search-field heuristics, and bounded concurrent-read coordination. Verify these paths before extending them.

References: [integration plan](../task/opencode-terminal-integration-plan.md), [remote-control documentation](../browser-remote-llm-control.md).

