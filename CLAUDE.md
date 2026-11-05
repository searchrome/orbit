# CLAUDE.md - Browser Project Guide

## What This Project Is

An Electron-based desktop browser with a built-in AI agent workspace. The agent can autonomously browse the web: open tabs, read pages, click elements, fill search forms, compare results, and return grounded recommendations to the user through a chat interface.

## Quick Start

```bash
npm install
npm start                                    # normal launch
npm start -- --remote-debugging-port=9222    # launch with CDP for scripted automation
```

Set `OPENROUTER_API_KEY` in a `.env` file at project root to enable AI features. Default model: `openai/gpt-4.1-mini` via OpenRouter.

## Project Structure

```
main.js                        # Electron main process: window, IPC, history, blocklist, AI service dispatch
renderer.js                    # Renderer process: browser chrome UI, tab bar, controls, webview management
preload.js                     # Secure IPC bridge between renderer and main process
index.html / styles.css        # Main browser window UI

tab-manager.js                 # Tab CRUD, switching, state tracking
history-manager.js             # Browsing history persistence
bookmark-manager.js            # Bookmark management
search-panel.js                # In-page search panel
summarizer.js                  # Content extraction for summarization

openrouter-service.js          # OpenRouter API client: summaries, page cleanup, related links, planner calls
                               # Also defines structured JSON schemas for planner responses
gemini-service.js              # Legacy Gemini AI integration (replaced by OpenRouter for agent features)

assistant.html / assistant.css # AI workspace chat UI
assistant-renderer.js          # Workspace UI logic: message rendering, session management, send/stop controls
assistant-store.js             # Session persistence for assistant conversations
assistant-controller.js        # Agent loop: receives prompts, calls planner, executes browser tools, manages runs
browser-tools.js               # 15 browser tools the AI agent can invoke
assistant-planner-requests.js  # Request-scoped abort/timeout management for planner API calls

block.list                     # Domain blocklist file
scripts/electron-launcher.sh   # Wrapper for scripted Electron launches with CDP readiness checks
```

## Architecture Overview

### Process Model (Electron)

- **Main process** (`main.js`): Application lifecycle, IPC handlers, network monitoring, AI service calls, history/blocklist I/O
- **Renderer process** (`renderer.js`): Browser chrome, tab bar, URL bar, control buttons, webview instances
- **Preload script** (`preload.js`): Exposes safe IPC methods to the renderer via `window.electronAPI`

### AI Agent System

The agent runs in the renderer process via `AssistantController`, which orchestrates an agentic loop:

1. **User prompt** arrives from the assistant workspace UI (`assistant.html`)
2. **Task profiling** (`deriveTaskProfile`): classifies the request as `shopping`, `local_search`, `recommendation`, or `general`
3. **Planner call** (`openrouter-service.js` -> `getAssistantNextAction`): sends browser state + conversation context to the LLM, which returns one of:
   - `tool_call` - execute a browser tool
   - `clarify` - ask the user a follow-up question
   - `final` - return the answer with optional result cards
4. **Tool execution** (`executeTool` -> `BrowserTools`): runs the requested tool against real browser tabs
5. **Loop continues** until the planner returns `final`, the user stops, or limits are hit

### Available Browser Tools

| Tool | Purpose |
|------|---------|
| `list_tabs` | List all non-workspace tabs |
| `open_tab` | Open a new tab with a URL |
| `focus_tab` | Switch to a specific tab |
| `close_tab` | Close a tab |
| `navigate_tab` | Navigate a tab to a URL |
| `get_tab_info` | Get metadata about a tab |
| `get_active_tab` | Get the currently active tab |
| `wait_for_load` | Wait for a tab to finish loading |
| `read_page_text` | Extract `innerText` from a tab's page |
| `query_selector_all` | Run CSS selectors and extract fields from matched elements |
| `click_element` | Click a DOM element by selector + index |
| `type_into` | Type text into a form field, optionally submit |
| `scroll_page` | Scroll up or down |
| `search_site` | Find and fill the search field on the current page, then submit |
| `extract_search_results` | Extract structured search results (title, href, price, etc.) |

### Agent Safety Boundaries

- The assistant workspace tab (`browser://assistant`) is **protected** - agent tools cannot navigate, inspect, or close it
- Only the host browser renderer can call the planner IPC
- Sensitive actions (passwords, payments, PII) are detected and blocked, requiring manual user handling
- Limits: max 50 tool calls per run, max 5 new tabs, max 120s duration

## Key IPC Channels

- `assistant-user-message` - User sends a prompt to the agent
- `assistant-stop-task` - User requests the agent to stop
- `assistant-next-action` - Renderer invokes the planner via main process
- `assistant-abort-next-action` - Cancel a specific planner request
- `assistant-task-started/finished/failed` - Lifecycle events sent to the workspace UI
- `assistant-response` - Agent messages back to the workspace (intermediate or final)
- `assistant-status` - Status updates (running/idle/clarifying/waiting/failed)
- `assistant-progress` / `assistant-log` - Progress and debug log messages

## Testing

```bash
npm test              # all tests
npm run test:unit     # unit tests only
npm run test:integration
npm run test:e2e
npm run test:all      # sequential: unit -> integration -> e2e
```

Tests use Jest with jsdom. Test files are in `__tests__/unit/`, `__tests__/integration/`, `__tests__/e2e/`.

## Browser Automation (CDP)

The app can be automated via Chrome DevTools Protocol:

```bash
scripts/electron-launcher.sh start --port 9222
curl -fsS http://127.0.0.1:9222/json/list | head
scripts/electron-launcher.sh stop
```

Target types: `page` (Electron shell), `webview` (actual tab content), `iframe` (embedded frames). For automation, target the `webview`.

## Development Status

Currently on branch `feature/ai_groups`, in Phase 6-7 of the roadmap:
- Phases 1-5 (workspace UI, browser tools, agent loop, shopping workflow, hardening) are complete
- Phase 6-7: Generalizing the agent from narrow shopping to multi-domain (local search, recommendations)
- See `ACTIVE_TASK.md` for detailed current status and next steps

## Common Patterns

### Adding a new browser tool

1. Add the method to `BrowserTools` class in `browser-tools.js`
2. Add the `case` to `executeTool()` in `assistant-controller.js`
3. Document the tool in the planner prompt in `openrouter-service.js` (`getAssistantNextAction`)
4. Add unit tests in `__tests__/unit/browser-tools.test.js`

### Modifying planner behavior

The planner prompt and response schema live in `openrouter-service.js`:
- `getAssistantNextAction()` builds the full prompt with browser state, conversation, and tool descriptions
- `ASSISTANT_ACTION_RESPONSE_FORMAT` defines the structured JSON schema the LLM must follow
- Task-specific behavior hints are driven by `taskProfile.kind` in `assistant-controller.js`

### Session/conversation persistence

`assistant-store.js` handles localStorage-based session persistence. Sessions include messages, status, and pending clarifications. The workspace UI in `assistant-renderer.js` manages session switching and state display.
