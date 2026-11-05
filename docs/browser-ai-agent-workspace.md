# Browser AI Agent Workspace

## Overview

This document defines a new feature for the browser: a browser-native AI agent workspace where the user can chat with an assistant that can inspect, open, switch, and operate browser tabs on the user's behalf.

The target experience is similar to a desktop LLM product UI, but with one important difference: the assistant is deeply integrated with the browser itself. It can browse the live web, act on real pages, ask clarifying questions, compare sources, and return results grounded in what it actually observed.

Representative requests:

- "I need a used bike."
- "Find a sports club in Den Haag."
- "I like these movies; what should I watch tonight?"

Expected behavior:

1. The user opens the AI workspace page.
2. The user enters the request in a chat box at the bottom of the page.
3. The assistant decides whether the request is already specific enough to act on.
4. If not, it asks clarifying questions before browsing.
5. It then browses the live web, opens relevant pages, compares options, and returns a grounded answer.

## Product Goals

1. Give the user a single entry page for AI-guided browsing and research.
2. Let the assistant use the browser as a real browsing environment, not a static scraper.
3. Allow the assistant to manage tabs as first-class tools.
4. Make the assistant capable of clarification, planning, research, and comparison.
5. Keep the user in control through visible actions, status, and stop controls.
6. Reuse the current Electron browser architecture where possible.

## Non-Goals

1. Fully autonomous background browsing without user visibility.
2. Arbitrary account logins, purchases, or form submission without explicit approval.
3. General OS automation outside the browser window.
4. Voice input in the first version. The initial version should focus on typed chat. Voice can be added later.
5. A hard-coded single-use assistant that only works for marketplace search.

## User Experience

## Entry Page Layout

The feature should introduce a dedicated assistant page, ideally loaded as an internal page such as `browser://assistant` or a local page such as `assistant.html`.

Recommended layout:

1. **Top area**
   - Conversation history
   - Action timeline
   - Current task status
   - Optional list of tabs touched by the assistant

2. **Center area**
   - Latest answer
   - Cards for findings, sources, prices, and open tabs
   - Optional previews of pages the assistant inspected

3. **Bottom area**
   - Chat input box
   - Send button
   - Stop button
   - Optional quick actions such as "Summarize active tab" and "Search current site"

This matches the user's request: text box at the bottom, history at the top, and a desktop LLM-like UI.

## Example Interaction

User:

- "I need a used bike."

Assistant:

1. Asks whether it is for a man, woman, or child if needed.
2. Asks for budget, size, and intended road type if the request is still ambiguous.
3. Creates a task plan after enough constraints are known.
4. Opens relevant marketplaces or local sources.
5. Compares multiple listings.
6. Returns a concise comparison and keeps the relevant tabs open for review.

Another example:

User:

- "Find a sports club in Den Haag."

Assistant:

1. Asks which sport and whether the user cares about distance, price, or schedule.
2. Searches across club sites, maps, and directories.
3. Compares location, offerings, and membership information.
4. Returns several grounded options with links and reasons.

## Core Capabilities

The assistant workspace should support these browser-native actions:

### Tab Tools

1. List open tabs
2. Open a new tab
3. Focus a tab
4. Close a tab
5. Read the active tab URL and title
6. Read tab load state

### Navigation Tools

1. Navigate a tab to a URL
2. Go back / forward
3. Reload
4. Wait for page load or specific DOM content

### Page Interaction Tools

1. Read page text
2. Query DOM elements
3. Click elements
4. Type into inputs
5. Submit forms
6. Scroll
7. Extract structured results from the page

### Reporting Tools

1. Summarize the current page
2. Compare multiple result tabs
3. Return a structured answer with links and evidence
4. Save useful findings into history or a task result log

### Conversation and Planning Tools

1. Detect when a request is underspecified
2. Ask targeted follow-up questions
3. Track known constraints and open questions
4. Decide when enough information exists to browse
5. Decide when enough evidence exists to answer

## Proposed Architecture

The feature should be built as a thin agent layer on top of the current browser primitives.

### Existing Reusable Pieces

The current application already has useful foundations:

1. Tab creation and switching in `tab-manager.js`
2. IPC between renderer and main in `preload.js`, `renderer.js`, and `main.js`
3. Web page execution through `webview.executeJavaScript(...)`
4. History persistence
5. AI integration patterns in `gemini-service.js`

### New Components

Recommended new files:

1. `assistant.html`
   - Internal assistant page UI

2. `assistant-renderer.js`
   - Chat UI state
   - Message rendering
   - Task lifecycle display

3. `assistant-controller.js`
   - Orchestrates agent turns
   - Accepts user prompts
   - Invokes tools
   - Streams progress updates back to the UI

4. `browser-tools.js`
   - Tool layer for tab and page operations
   - Normalizes browser actions into explicit functions

5. `agent-service.js`
   - LLM-facing tool schema and execution loop
   - Prompt construction
   - Tool call validation

6. `task-store.js`
   - Persists chat sessions, task runs, and action logs

## Interaction Model

The assistant should not directly mutate the DOM of the assistant page from the model layer. The recommended control flow is:

1. User submits a chat prompt in the assistant page.
2. `assistant-renderer.js` sends the prompt to `assistant-controller.js`.
3. `assistant-controller.js` creates a task run and asks `agent-service.js` for the next action.
4. `agent-service.js` chooses either:
   - a user-facing response, or
   - a tool call
5. If a tool call is selected, `browser-tools.js` executes it against the existing tab system.
6. The result is sent back into the agent loop.
7. The loop continues until the assistant returns a final answer or the user stops the run.

## Proposed Tool Contract

The first version should keep the tool surface narrow and auditable.

### Minimum Tool Set

1. `list_tabs()`
2. `open_tab({ url })`
3. `focus_tab({ tabId })`
4. `navigate_tab({ tabId, url })`
5. `close_tab({ tabId })`
6. `get_tab_info({ tabId })`
7. `get_active_tab()`
8. `wait_for_load({ tabId, timeoutMs })`
9. `read_page_text({ tabId, maxChars })`
10. `query_selector_all({ tabId, selector, fields })`
11. `click_element({ tabId, selector, index })`
12. `type_into({ tabId, selector, text, submit })`
13. `scroll_page({ tabId, direction, amount })`
14. `search_site({ tabId, query, siteHint, timeoutMs })`
15. `extract_search_results({ tabId, siteHint })`

### Why This Tool Set

This is enough to support an initial narrow workflow without over-designing the first version. It also maps cleanly to existing Electron `webview` capabilities.

However, the product target is broader than the current tool surface. The assistant also needs higher-level policies for:

1. when to clarify
2. when to search
3. when to compare more options
4. when to stop and answer

## IPC Additions

The current IPC layer is not sufficient for an agent workspace. New channels will be needed.

### Renderer to Main

1. `assistant-run-task`
2. `assistant-stop-task`
3. `assistant-tool-call`
4. `assistant-open-workspace`

### Main to Renderer

1. `assistant-task-started`
2. `assistant-task-progress`
3. `assistant-tool-result`
4. `assistant-task-finished`
5. `assistant-task-failed`

### Main Process Responsibilities

The main process should own privileged browser actions, including:

1. Mapping tab IDs to `webContentsId`
2. Safe execution of browser tools
3. Validation of tool parameters
4. Enforcement of task limits and permissions

## Task Limits and Safety Controls

This feature needs stricter controls than the existing summarizer because it can browse actively.

### Hard Limits

1. Max tool calls per run
2. Max tabs opened per run
3. Max concurrent assistant-owned tabs
4. Max characters extracted per page
5. Max run duration

Recommended defaults for v1:

1. 20 tool calls per run
2. 5 newly opened tabs per run
3. 3 result tabs kept open by default
4. 30 seconds wall-clock limit
5. 20,000 extracted characters per page unless explicitly expanded

### Restricted Actions

The assistant must not do these without explicit user approval:

1. Login
2. Checkout / purchase
3. Download files
4. Send messages
5. Fill sensitive payment or identity forms

### Transparency Requirements

Each run should display:

1. Current step
2. Pages opened
3. Tabs inspected
4. Data extracted
5. Whether the final answer is based on one page or multiple pages

## Data Model

The assistant workspace should persist task data separately from ordinary browsing history.

Suggested entities:

### Conversation

1. `id`
2. `title`
3. `createdAt`
4. `updatedAt`

### Message

1. `id`
2. `conversationId`
3. `role` (`user`, `assistant`, `tool`, `system`)
4. `content`
5. `createdAt`

### TaskRun

1. `id`
2. `conversationId`
3. `status`
4. `prompt`
5. `startedAt`
6. `finishedAt`
7. `finalAnswer`

### TaskAction

1. `id`
2. `taskRunId`
3. `type`
4. `tabId`
5. `input`
6. `output`
7. `createdAt`

## Implementation Phases

## Phase 1: Assistant Page Shell

Deliverables:

1. Internal assistant page
2. Message list UI
3. Composer at bottom
4. Basic local conversation persistence
5. Button to open the assistant page in a new tab

## Current Implementation Gap

The current implementation is best described as:

1. a browser-native assistant prototype
2. with a narrow marketplace-oriented workflow
3. and an initial real-tab tool loop

It is not yet:

1. a strong general-purpose agent
2. good at asking clarifying questions
3. good at deciding how much research is enough
4. good at comparing multiple options across arbitrary domains

The next product-level shift should be:

1. move from fixed workflow behavior to general task behavior
2. add clarify → browse → compare → answer as a first-class loop
3. validate the same agent on shopping, local search, and recommendation tasks

Acceptance:

1. User can open the page
2. User can type prompts
3. Messages render correctly
4. Conversation reloads after restart

## Phase 2: Browser Tool Layer

Deliverables:

1. Stable tab IDs
2. Browser tool abstraction
3. IPC methods for tab and page actions
4. Structured tool results

Acceptance:

1. Code can list tabs
2. Code can open and focus tabs
3. Code can read page text and click selectors

## Phase 3: Agent Loop

Deliverables:

1. Prompt + tool schema
2. Multi-step tool execution loop
3. Progress events to UI
4. Stop / cancel support

Acceptance:

1. Assistant can perform at least one multi-step browsing task
2. User can stop a task safely
3. Tool calls are shown in the UI

## Phase 4: Search Result Workflows

Deliverables:

1. Search workflow prompts
2. Result extraction helpers
3. Comparison answer format
4. Site-specific heuristics for marketplaces such as eBay

Acceptance:

1. "Find a used bike" opens the target site
2. Assistant searches the live page
3. Assistant opens candidate results in separate tabs
4. Assistant returns a short ranked list with links

## Phase 5: Trust, Controls, and Voice

Deliverables:

1. Approval gates for sensitive actions
2. Per-run usage limits
3. Session replay / audit view
4. Optional speech input and speech output

Acceptance:

1. Sensitive actions require explicit user approval
2. Past runs can be inspected
3. Voice remains optional and can be disabled

## UX Requirements

The assistant should feel like a browsing copilot, not a background crawler.

Required UX characteristics:

1. The assistant page stays readable during long tasks.
2. The user always sees what the assistant is doing.
3. Opened tabs remain visible in the normal tab strip.
4. Final answers cite the tabs or pages used.
5. The user can take over manually at any time.

## Open Design Decisions

These decisions should be resolved before implementation starts:

1. Should the assistant page be a normal browser tab or a permanent side panel?
2. Should the LLM operate on generic tools only, or include site-specific helpers for eBay, Marktplaats, Amazon, etc.?
3. Should assistant-opened tabs be visually marked?
4. Should task memory be per conversation, per browser session, or both?
5. Which model should be used for tool planning versus final answer generation?

## Recommended First Slice

The smallest valuable version is:

1. A dedicated assistant page
2. Typed chat only
3. Tools for `list_tabs`, `open_tab`, `focus_tab`, `navigate_tab`, `read_page_text`, `query_selector_all`, `click_element`, and `type_into`
4. One end-to-end workflow for marketplace search
5. Visible action log and stop button

This is enough to prove the concept without taking on voice, account flows, or broad web automation complexity.

## Summary

Yes, the request is clear enough to design.

The correct product shape is an internal AI workspace page that behaves like a desktop LLM chat UI, but with browser-native tools for opening tabs, searching real websites, inspecting live pages, and returning grounded results. The first implementation should prioritize typed chat, tab control, safe tool execution, and a narrow end-to-end shopping workflow.
