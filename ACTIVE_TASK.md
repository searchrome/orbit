# Active Task: Browser-Native AI Agent

## Status

Current state after review:

1. Assistant workspace foundation exists
2. Browser tool layer exists
3. Agent loop exists
4. Boundary hardening is in place
5. Marketplace workflow support exists in initial form
6. Browser load failures are now surfaced to the agent and UI
7. Workflow-specific regression tests now exist for browser tool failure paths
8. End-to-end browsing workflow still needs runtime verification and stabilization
9. The broader product target is now clarified as a general browser-native agent, not a single shopping flow

Recent review outcome:

1. The planner IPC is now restricted to the host browser window
2. The assistant workspace tab is excluded from browsable agent targets
3. Agent tools cannot navigate or inspect the workspace UI itself
4. Internal workspace tabs are protected against navigation away from `assistant.html`
5. Marketplace search helpers were added for real-site search flows
6. Tool-level page-load failures now propagate as top-level failures instead of hidden nested metadata
7. “Navigation did not start” is now treated as a failure for actions that require real page transitions
8. Unit tests now cover the main browser-tool failure paths and marketplace extraction basics
9. Assistant workspace run-state/session-state handling is now authoritative
10. Renderer tests now cover persisted waiting state and active-run session switching
11. The assistant backend now runs through OpenRouter instead of Gemini
12. Planner requests now use structured JSON output, timeout budgeting, and request-scoped aborts
13. Marketplace comparison now dedupes listing candidates by normalized URL
14. Auto-opened marketplace comparison cards preserve extracted prices
15. Clarification-first browsing now exists as an initial planner behavior
16. Clarification replies are persisted per session and can resume the same task

This means the feature has moved past initial scaffolding and into workflow completion and stabilization.

## Objective

Add a browser-native AI agent to the application: a chat-first workspace where the assistant can understand the user’s goal, ask clarifying questions when needed, plan a browsing strategy, use the browser as a tool, and return grounded recommendations.

This is not just a chat UI and not just a fixed shopping workflow. The assistant must be able to:

1. Clarify ambiguous requests before acting
2. Open new tabs
3. Inspect existing open tabs
4. Focus or switch between tabs
5. Navigate to real websites
6. Interact with live pages
7. Compare multiple sources or options
8. Return results based on what it actually found

## User Intent

The user wants a desktop LLM-style page inside the browser with:

1. Conversation history shown toward the top
2. A text input box at the bottom
3. An assistant that can browse, research, compare, and discuss tradeoffs with the user

Representative requests:

- "I need a used bike."
- "Find me a sports club in Den Haag."
- "I like these movies, what should I watch tonight?"

Expected behavior:

1. The assistant determines whether the request is underspecified
2. If needed, it asks follow-up questions such as budget, size, location, gender, skill level, or preferences
3. It then searches the live web, opens and compares multiple relevant sources, and returns a grounded recommendation
4. It should not rely on a single hard-coded prompt or a single marketplace-specific pattern

## Scope

The feature should introduce a dedicated assistant workspace page, likely as:

- `assistant.html`, or
- an internal route such as `browser://assistant`

The page should behave like a modern desktop LLM UI, but with browser-native tools and multi-turn task reasoning.

## Current Baseline

The following pieces are already present in the codebase:

1. Assistant workspace UI
2. Session persistence for assistant conversations
3. Assistant controller loop
4. Browser tool abstraction
5. Planner integration through OpenRouter
6. Workspace boundary protections

What is not complete yet:

1. A real clarification loop for ambiguous requests
2. General-purpose task planning beyond narrow shopping patterns
3. Reliable multi-source research and comparison behavior
4. Strong result extraction quality across real sites
5. End-to-end validation against representative real tasks
6. Clear UX for approval/waiting states beyond the current basic handling
7. Production-grade safety and observability
8. Broader regression coverage beyond the current browser tool failure-path suite
9. Better confidence from runtime/manual verification on real pages
10. Real production confidence for the OpenRouter-backed runtime under live browsing load
11. A clear “ask → clarify → browse → compare → answer” policy in the planner
12. Generalization of clarification behavior beyond the first shopping use case

## Core Requirements

### UI

1. Assistant page with message history
2. Composer/input at the bottom
3. Send button
4. Stop button
5. Visible progress/action log during browsing tasks

### Browser Capabilities

1. List open tabs
2. Open a new tab
3. Focus a tab
4. Close a tab
5. Navigate a tab to a URL
6. Read page text
7. Query DOM elements
8. Click elements
9. Type into search fields and forms
10. Open and inspect multiple result pages

### Output

The assistant should return answers grounded in tabs it actually visited.

For research and recommendation tasks, answers should include some combination of:

1. Clarified assumptions or unanswered questions
2. Title / name
3. Link
4. Price, location, schedule, genre, or other task-specific fields when relevant
5. Short reason why the option is relevant
6. Comparison notes across multiple options

## Constraints

### First Version

Keep v1 pragmatic:

1. Typed chat only
2. No voice input/output yet
3. No login automation
4. No checkout/purchase flows
5. No arbitrary web-page downloads; OpenCode-created artifacts may be downloaded only after explicit user approval
6. Focus on ask → clarify → browse → compare → answer

### Safety

Sensitive actions must require explicit user approval:

1. Logging in
2. Purchasing
3. Sending messages
4. Downloading files, including generated artifacts
5. Filling sensitive identity or payment forms

Additional boundary rules already adopted and should remain enforced:

1. Only the host browser renderer may call the assistant planner IPC
2. The assistant workspace page is not a browsable target for agent tools
3. Agent tools must not navigate the workspace tab away from the internal assistant page
4. Internal assistant pages must remain protected from accidental tool-driven takeover

### Technical Limits

Recommended defaults for v1:

1. Max 20 tool calls per run
2. Max 5 newly opened tabs per run
3. Max 30 seconds run time
4. Max 20,000 characters extracted per page unless explicitly expanded

## Suggested Architecture

Reuse the current Electron browser structure where possible.

### Existing Code To Reuse

1. `main.js`
2. `renderer.js`
3. `preload.js`
4. `tab-manager.js`
5. `history-manager.js`
6. `openrouter-service.js`

### New Modules Suggested

1. `assistant.html`
2. `assistant-renderer.js`
3. `assistant-controller.js`
4. `browser-tools.js`
5. `assistant-store.js`
6. `assistant-planner-requests.js`

Note:

- The current implementation uses `openrouter-service.js` for summaries, cleanup, related-link extraction, and planner decisions
- Request-scoped planner cancellation is handled through `assistant-planner-requests.js`
- If the feature grows further, the planner/runtime split should likely move into a more explicit agent service boundary

## Proposed Implementation Phases

### Phase 1

Build the assistant page shell only:

1. Message history UI
2. Bottom composer
3. Local conversation persistence
4. Way to open the assistant page in a tab

Status: complete in initial form

### Phase 2

Build the browser tool layer:

1. List tabs
2. Open/focus/navigate tabs
3. Read page text
4. Click and type on live pages

Status: complete in initial form

### Phase 3

Build the agent loop:

1. Prompt handling
2. Tool calling
3. Progress updates
4. Stop/cancel support

Status: complete in initial form

### Phase 4

Build the first end-to-end workflow:

1. Marketplace search
2. Multi-tab result inspection
3. Ranked response with links and reasoning

Status: complete in initial narrow form

### Phase 5

Stabilize and harden the narrow workflow:

1. Improve result extraction for target sites such as `ebay.nl`
2. Add better waiting logic around page load and DOM readiness
3. Improve action logs and failure reporting
4. Validate tool behavior against real browsing sessions
5. Add regression coverage where practical

Status: active as validation harness

### Phase 6

Expand from narrow workflow to general agent behavior:

1. Add clarification-question behavior before browsing when the request is ambiguous
2. Add higher-level planning for arbitrary user goals
3. Support research and recommendation tasks beyond shopping
4. Improve comparison and synthesis across multiple pages
5. Define domain-specific stopping conditions and answer quality rules

Status: active in initial form

### Phase 7

Generalize the agent beyond the first clarification flow:

1. Extend clarification to non-shopping tasks
2. Add reusable research planning across domains
3. Improve comparison quality for local search and recommendation tasks
4. Define answer-quality checks before final response
5. Validate the agent on multiple representative task types

Status: next target

### Phase 4/5 Progress Notes

Completed recently:

1. Added marketplace-oriented task profiling
2. Added `search_site` tool for real on-page search interactions
3. Improved marketplace result extraction heuristics
4. Strengthened load/wait handling for navigation and search submission
5. Surfaced browser load failures clearly to both the agent loop and the workspace log
6. Added unit tests for failed navigation, failed search submission, and marketplace extraction basics
7. Migrated the assistant backend from Gemini to OpenRouter
8. Added structured JSON response enforcement for planner and extraction calls
9. Added planner timeout budgeting and abort propagation
10. Fixed stop/retry races by scoping aborts to planner request ids
11. Added unit coverage for planner timeout handling and request-scoped aborts
12. Improved used-bike search result ranking to prefer real bicycle listings over noisy accessories
13. Hardened renderer and tab-management event handling around unready controls and webviews
14. Stabilized marketplace comparison behavior so duplicate listing URLs do not count as distinct options
15. Preserved extracted price metadata for auto-opened comparison candidates
16. Added a first clarification-first loop for underspecified shopping prompts
17. Added session-scoped clarification persistence and reply handling in the workspace UI

Still required:

1. Validate the full “used bike” flow on a live target site
2. Tune selectors and extraction quality based on real pages
3. Confirm failure handling is understandable from the workspace UI
4. Add follow-up tests only after real runtime failures expose missing cases
5. Verify the assistant workspace stays coherent during real long-running flows
6. Confirm the OpenRouter-backed runtime behaves reliably under real end-to-end use
7. Redefine planner behavior around clarification, research depth, and comparison quality
8. Implement the first clarification-first general-agent slice
9. Generalize the clarification-first loop to non-shopping tasks

## Immediate Next Task

The next development target is:

1. Generalize clarification-first behavior beyond the bike workflow
2. Keep the “used bike” flow as the regression harness while broadening behavior
3. Add the next two representative task types:
   - local search, e.g. "find a sports club in Den Haag"
   - recommendation, e.g. "I like these movies, what should I watch tonight?"
4. Ensure the planner can decide:
   - whether clarification is needed
   - which single follow-up question is most useful
   - when browsing should start
   - when enough evidence exists to answer
5. Ensure the agent can reuse the same loop:
   - ask
   - clarify
   - browse
   - compare
   - answer
6. Verify that workspace protections remain intact during that broader loop
7. Verify that planner timeouts, retries, and user-initiated Stop still behave correctly

Recommended implementation order:

1. Keep one narrow real-site shopping scenario as the regression harness
2. Add one local-search scenario with explicit clarification behavior
3. Add one recommendation scenario that may need clarification but not live form interaction
4. Teach the planner to track known constraints and open questions across domains
5. Patch any regression in the current bike flow caused by the broader loop
6. Add regression coverage for clarification decisions and resumed browsing across at least two task types

## Immediate Next Slice

Shift from shopping-only clarification to multi-domain clarification:

1. Validate the current bike clarification flow on a live run
2. Add the next ambiguity detector for local search prompts
3. If a local-search prompt is underspecified, return a user-facing clarifying question instead of browsing immediately
4. Persist the user’s follow-up answer in session state
5. Resume browsing with the clarified constraints
6. Re-run the bike scenario with prompts like:
   - "I need a used bike"
   - "for a woman, city use, around 300 euro"
7. Add a second scenario such as:
   - "find a sports club in Den Haag"
   - ask follow-up about sport, distance, or budget before browsing

## Acceptance Criteria

The long-term feature is successful when the assistant can:

1. Understand broad user goals
2. Ask follow-up questions when the request is underspecified
3. Browse the live web to gather enough evidence
4. Compare multiple options or sources
5. Return grounded recommendations with links and reasons

The current milestone is successful when the following narrow scenario works reliably:

1. User opens the assistant page
2. User types: "I need a used bike"
3. Assistant opens `https://www.ebay.nl/`
4. Assistant searches on the real page
5. Assistant opens several candidate listings in separate tabs
6. Assistant reads those tabs
7. Assistant returns a short list of relevant results with links

Additional acceptance criteria for the current stage:

1. The assistant workspace remains visible throughout the run
2. The agent cannot target the internal workspace tab with browsing tools
3. Only the host browser window can invoke the planner IPC
4. Failure states are surfaced in the assistant action log
5. Navigation failures are not treated as successful tool calls
6. Failed search submissions are visible to the planner and UI as failures
7. The browser tool failure-path unit tests remain green
8. Persisted session status and Send/Stop controls agree on initial render
9. Switching sessions cannot hide or misrepresent an active assistant run
10. Enter, quick actions, and new-chat are blocked when a persisted session is already waiting or running
11. Planner requests use request-scoped aborts, so stopping one run cannot cancel a newer retry in the same session
12. The first returned eBay candidates are biased toward actual bicycle listings rather than accessories or unrelated “bike” matches
13. Duplicate marketplace listing URLs do not count as separate comparison options
14. Auto-opened comparison candidates retain extracted price metadata

Acceptance criteria for the next broader slice:

1. For an underspecified request such as "I need a used bike", the assistant asks a useful clarifying question before browsing
2. The assistant can resume the same task after the user answers the clarification
3. The assistant uses the clarified constraints during browsing and comparison
4. The narrow bike workflow remains intact as a regression harness while the planner broadens
5. The same clarification-first loop works for at least one non-shopping task

## Important Product Decision

This feature should be implemented as a browser-integrated agent workspace, not just a text chatbot.

The differentiator is that the assistant can use real tabs and real pages as tools.

## Related Documents

For detailed design, see:

1. `browser-ai-agent-workspace.md:1`
2. `browser-documentation-index.md:1`
3. `browser-development-roadmap.md:1`
