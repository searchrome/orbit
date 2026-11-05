'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

/**
 * CLI backend for the AI workspace (Claude CLI + Codex CLI).
 * Drop-in replacement for openrouter-service.js getAssistantNextAction().
 * Activated when LLM=claude or LLM=codex in .env.
 *
 * Env vars:
 *   LLM=claude|codex|openrouter   — which backend to use
 *   CLAUDE_MODEL=sonnet            — model for claude -p
 *   CODEX_MODEL=gpt-5.4-mini/xhigh — model/effort for codex exec
 */

const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);
const CLAUDE_HAIKU_MODEL = 'claude-haiku-5-5';
const codexSessionsByAssistantSession = new Map();

// Re-use prompt building helpers ------------------------------------------------

function truncateText(value, maxChars) {
    const text = String(value ?? '');
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars)}...[truncated]`;
}

function buildConversationBlock(messages) {
    return messages.map((message) => {
        const role = message.role || 'unknown';
        const name = message.name ? ` (${message.name})` : '';
        const content = truncateText(
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
            1500
        );
        return `[${role}${name}] ${content}`;
    }).join('\n\n');
}

// Build the same prompt text used by the OpenRouter service ---------------------

function buildPromptText(payload, options = {}) {
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const browserState = payload.browserState || {};
    const limits = payload.limits || {};
    const prompt = String(payload.prompt || '').trim();
    const conversationBlock = buildConversationBlock(messages);
    const isCompact = options.compact === true || payload.compactPlannerContext === true;

    if (isCompact) {
        return `
Continue the existing browser workspace task. Return ONLY one valid JSON object.

Use the browser tools when more live evidence is needed. Ask a clarification only when the next useful step depends on the user's answer. Return final only when the result is grounded in observed browser state.

Hard constraints:
- one action only
- no markdown
- no commentary outside JSON
- respect remaining tool calls and tab budget

Allowed JSON shapes:
{"type":"tool_call","message":"brief next-step message","tool":"list_tabs","arguments":{}}
{"type":"clarify","question":"one concise question","reason":"why this is needed"}
{"type":"final","message":"concise answer","results":[{"title":"...","url":"...","price":"...","reason":"..."}]}

User request:
${prompt}

Recent conversation:
${conversationBlock || '[no prior conversation]'}

Compact browser state:
${truncateText(JSON.stringify(browserState, null, 2), 5000)}

Task profile:
${truncateText(JSON.stringify(payload.taskProfile || {}, null, 2), 1600)}

Runtime state:
${truncateText(JSON.stringify(payload.runtimeState || {}, null, 2), 2500)}
`;
    }

    return `
You are a browser-integrated helpful agent working inside a live browser workspace.

Your job is to understand the user's request, decide what information is still needed, browse real web pages with the available tools, and gradually complete the task.

Think in terms of an execution plan, even though you only return one action at a time. Your internal plan should usually follow a structure like:
- understand the request
- collect missing information from the user when needed
- choose useful websites or tabs
- search and inspect live pages
- compare findings
- return grounded results
- ask follow-up questions or request feedback when needed

You may ask the user for more information at any time if it would materially improve the result. You may also return to the user when results are noisy, ambiguous, low-confidence, or when you need feedback before continuing.

This runtime is turn-based:
- you have up to ${limits.maxToolCalls || 50} actions in this turn
- the user may allow another turn later
- do not waste actions

Your tools are limited and explicit. Return ONLY valid JSON, with no markdown, no code fences, and no commentary.

Available tools:
1. list_tabs {}
2. open_tab { "url": string, "activate"?: boolean, "title"?: string, "role"?: string }
3. focus_tab { "tabId": string }
4. close_tab { "tabId": string }
5. navigate_tab { "tabId": string, "url": string }
6. get_tab_info { "tabId": string }
7. get_active_tab {}
8. wait_for_load { "tabId": string, "timeoutMs"?: number }
9. wait_for_element { "tabId": string, "selector": string, "index"?: number, "present"?: boolean, "visible"?: boolean, "enabled"?: boolean, "text"?: string, "textChangedFrom"?: string, "caseSensitive"?: boolean, "timeoutMs"?: number }
10. read_page_text { "tabId": string, "maxChars"?: number, "selector"?: string, "contentMode"?: "full"|"main"|"article"|"auto" }
11. find_page_text { "tabId": string, "query": string, "contextChars"?: number, "maxMatches"?: number, "caseSensitive"?: boolean }
12. query_selector_all { "tabId": string, "selector": string, "fields"?: string[] }
13. click_element { "tabId": string, "selector": string, "index"?: number }
14. type_into { "tabId": string, "selector": string, "text": string, "submit"?: boolean, "clear"?: boolean }
15. scroll_page { "tabId": string, "direction"?: "up"|"down", "amount"?: number }
16. search_site { "tabId": string, "query": string, "siteHint"?: string, "timeoutMs"?: number }
17. extract_search_results { "tabId": string, "siteHint"?: string }

General rules:
- Prefer the active browsable tab in browserState.activeTab when it is present.
- browserState.tabs excludes the assistant workspace UI; do not try to navigate or inspect the workspace itself.
- Use live page inspection tools before making claims about a page.
- Keep open tabs to a minimum. Do not open more than ${limits.maxNewTabs || 5} new tabs.
- Do not exceed ${limits.maxToolCalls || 50} tool calls.
- Each planner turn may include a short natural-language message for the user in the "message" field. Use it to say what you are about to do or why you need something. Keep it brief and concrete.
- On the first action of a run, prefer including a short execution-plan message before browsing.
- Do not invent prices, titles, or links. Ground answers in observed browser state.
- If the request is underspecified, return a clarification action instead of browsing immediately.
- Ask one concise clarifying question at a time.
- If the conversation already includes a clarification answer, use that answer and continue browsing.
- If the task is complete, return a final answer with concise evidence.
- If the current approach is failing, return a clarification action.
- If you need more information from a page, return a tool call instead of guessing.
- If a sensitive action is required, stop and return a final message explaining that approval is needed.
- After navigation, submitting a search, or clicking a result link, call wait_for_load before reading the page.
- For a dynamic page control or text update, call wait_for_element with the exact tab and selector rather than repeating the preceding action or waiting for global network idle.

Behavior guidance:
- If taskProfile.kind is "shopping", treat the request as a real shopping/research task. Clarify important missing constraints, search live sites, inspect product pages, compare plausible options, and then answer.
- If taskProfile.preferredMarketplace is set and no site was named by the user, start there.
- For marketplace searches, use search_site instead of guessing selectors.
- After search results load, use extract_search_results with a site hint when appropriate.
- Do not treat category pages, taxonomy links, filter groups, or accessory-only results as candidate products.
- If results are mostly noisy, ask the user to narrow the request.
- If the first query is noisy, refine the query once before giving up.
- If multiple plausible candidates are available, inspect and compare them before finalizing.
- If runtimeState.topMarketplaceCandidates already contains plausible items, inspect those before narrowing the query further.
- Treat runtimeState.lastUnderBudgetMarketplaceCandidateCount as a signal that viable options may exist.
- Prefer returning a short ranked set of real options with title, URL, price, and concise reasons.
- If taskProfile.kind is "local_search", treat the request as a location-based research task.
- If taskProfile.kind is "recommendation", treat the request as a preference-matching research task.
- Treat runtimeState as real feedback. If consecutiveToolFailures is 2+, stop and ask a clarification.
- Keep the assistant workspace tab untouched.

User request:
${prompt}

Conversation context:
${conversationBlock || '[no prior conversation]'}

Current browser state:
${truncateText(JSON.stringify(browserState, null, 2), 12000)}

Task profile:
${truncateText(JSON.stringify(payload.taskProfile || {}, null, 2), 4000)}

Runtime state:
${truncateText(JSON.stringify(payload.runtimeState || {}, null, 2), 4000)}

Return one of these JSON shapes:
{"type":"tool_call","message":"First I will inspect the open tabs.","tool":"list_tabs","arguments":{}}
{"type":"tool_call","message":"Opening a marketplace tab.","tool":"open_tab","arguments":{"url":"https://example.com","activate":true}}
{"type":"clarify","question":"What budget should I use?","reason":"The request is missing a budget."}
{"type":"final","message":"concise answer","results":[{"title":"...","url":"...","price":"...","reason":"..."}]}
`;
}

// Claude CLI call (async, non-blocking) -----------------------------------------

// Parse CODEX_MODEL format: "model/effort" e.g. "gpt-5.4-mini/xhigh"
function parseCodexModel(value) {
    const raw = String(value || '').trim();
    if (!raw) return { model: null, reasoningEffort: null };

    const slashIdx = raw.lastIndexOf('/');
    if (slashIdx > 0) {
        const possibleEffort = raw.slice(slashIdx + 1).toLowerCase();
        if (CODEX_REASONING_EFFORTS.has(possibleEffort)) {
            return { model: raw.slice(0, slashIdx), reasoningEffort: possibleEffort };
        }
    }
    return { model: raw, reasoningEffort: null };
}

// Shared helper: spawn a CLI command with stdin, timeout, abort support
function spawnCli(command, args, input, { signal, timeoutMs = 120000, label = command, cleanupFiles = [] } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        const cleanup = () => {
            for (const f of cleanupFiles) {
                try { fs.unlinkSync(f); } catch { /* ignore */ }
            }
        };

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            cleanup();
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        if (signal) {
            if (signal.aborted) {
                child.kill('SIGTERM');
                clearTimeout(timer);
                cleanup();
                reject(new Error('Aborted'));
                return;
            }
            signal.addEventListener('abort', () => {
                child.kill('SIGTERM');
                clearTimeout(timer);
                cleanup();
                reject(new Error('Aborted'));
            }, { once: true });
        }

        child.on('close', (code) => {
            clearTimeout(timer);
            cleanup();
            if (code !== 0) {
                reject(new Error(`${label} exited with code ${code}: ${stderr.slice(0, 500)}`));
                return;
            }
            resolve(stdout.trim());
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            cleanup();
            reject(new Error(`${label} spawn error: ${err.message}`));
        });

        child.stdin.write(input);
        child.stdin.end();
    });
}

function callClaudeCli(promptText, { signal, timeoutMs = 120000, model } = {}) {
    const sysFile = path.join(os.tmpdir(), `browser-claude-sys-${Date.now()}.txt`);
    const systemPrompt = 'You are a browser automation agent. Return ONLY a single valid JSON object. No markdown, no code fences, no commentary before or after the JSON.';
    fs.writeFileSync(sysFile, systemPrompt, 'utf8');

    const args = [
        '-p',
        '--no-session-persistence',
        '--output-format', 'text',
        '--system-prompt-file', sysFile,
        '--max-turns', '1',
    ];
    if (model) args.push('--model', model);

    return spawnCli('claude', args, promptText, {
        signal, timeoutMs, label: `Claude CLI${model ? ' (' + model + ')' : ''}`, cleanupFiles: [sysFile]
    });
}

function normalizeCodexReasoningEffort(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

function buildCodexCliArgs({ model, reasoningEffort, outputFile, codexSessionId } = {}) {
    const args = codexSessionId
        ? ['exec', 'resume']
        : ['exec'];

    args.push('--dangerously-bypass-approvals-and-sandbox');
    if (model) args.push('--model', model);

    const normalizedEffort = normalizeCodexReasoningEffort(reasoningEffort);
    if (normalizedEffort) {
        args.push('-c', `model_reasoning_effort="${normalizedEffort}"`);
    }

    args.push('--json');

    if (outputFile) {
        args.push('-o', outputFile);
    }

    if (codexSessionId) {
        args.push(codexSessionId);
    }

    args.push('-');
    return args;
}

function extractCodexSessionIdFromJsonLines(value) {
    const text = String(value || '');
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
        let event;
        try {
            event = JSON.parse(line);
        } catch {
            continue;
        }

        const candidates = [
            event?.session_id,
            event?.sessionId,
            event?.payload?.session_id,
            event?.payload?.sessionId,
            event?.payload?.id,
            event?.payload?.session?.id
        ];

        for (const candidate of candidates) {
            const sessionId = String(candidate || '').trim();
            if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(sessionId)) {
                return sessionId;
            }
        }
    }

    return null;
}

function callCodexCli(promptText, { signal, timeoutMs = 120000, model, reasoningEffort, assistantSessionId } = {}) {
    const tmpFile = path.join(os.tmpdir(), `browser-codex-${Date.now()}.txt`);
    const codexSessionId = assistantSessionId
        ? codexSessionsByAssistantSession.get(assistantSessionId) || null
        : null;

    const args = buildCodexCliArgs({
        model,
        reasoningEffort,
        outputFile: tmpFile,
        codexSessionId
    });

    const label = `Codex CLI${model ? ' (' + model + ')' : ''}${reasoningEffort ? ' effort=' + reasoningEffort : ''}${codexSessionId ? ' resume=' + codexSessionId : ''}`;

    return new Promise((resolve, reject) => {
        const child = spawn('codex', args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

        const timer = setTimeout(() => {
            child.kill('SIGTERM');
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        if (signal) {
            if (signal.aborted) {
                child.kill('SIGTERM');
                clearTimeout(timer);
                reject(new Error('Aborted'));
                return;
            }
            signal.addEventListener('abort', () => {
                child.kill('SIGTERM');
                clearTimeout(timer);
                reject(new Error('Aborted'));
            }, { once: true });
        }

        child.on('close', (code) => {
            clearTimeout(timer);
            try {
                if (fs.existsSync(tmpFile)) {
                    const result = fs.readFileSync(tmpFile, 'utf8').trim();
                    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
                    const discoveredSessionId = extractCodexSessionIdFromJsonLines(stdout);
                    if (assistantSessionId && discoveredSessionId) {
                        codexSessionsByAssistantSession.set(assistantSessionId, discoveredSessionId);
                    }
                    resolve(result);
                    return;
                }
            } catch { /* fall through */ }

            if (code !== 0) {
                reject(new Error(`${label} exited with code ${code}: ${stderr.slice(0, 500)}`));
            } else {
                reject(new Error(`${label} produced no output file`));
            }
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            reject(new Error(`${label} spawn error: ${err.message}`));
        });

        // Codex takes the full prompt (system + user) on stdin
        const systemPrompt = 'You are a browser automation agent. Return ONLY a single valid JSON object. No markdown, no code fences, no commentary before or after the JSON.';
        child.stdin.write(`${systemPrompt}\n\n${promptText}`);
        child.stdin.end();
    });
}

// Extract JSON from Claude response (may include markdown fences) ---------------

function extractJson(text) {
    // Try direct parse first
    const trimmed = text.trim();
    try { return JSON.parse(trimmed); } catch { /* fallback */ }

    // Try stripping markdown code fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (fenceMatch) {
        try { return JSON.parse(fenceMatch[1].trim()); } catch { /* fallback */ }
    }

    // Try finding first { ... } block
    const braceStart = trimmed.indexOf('{');
    const braceEnd = trimmed.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
        try { return JSON.parse(trimmed.slice(braceStart, braceEnd + 1)); } catch { /* give up */ }
    }

    throw new Error('CLI response did not contain valid JSON.');
}

// Public API — matches openrouter-service.js getAssistantNextAction() -----------

// Backend config is set once at startup via createCliBackend()
let _backendConfig = { backend: 'claude', model: null, reasoningEffort: null };

function configureBackend(config) {
    _backendConfig = { ..._backendConfig, ...config };
}

async function getAssistantNextAction(payload = {}) {
    const { backend, model, reasoningEffort } = _backendConfig;
    const assistantSessionId = String(payload?.sessionId || '').trim();
    const hasCodexSession = backend === 'codex' && assistantSessionId && codexSessionsByAssistantSession.has(assistantSessionId);
    const promptText = buildPromptText(payload, { compact: hasCodexSession });

    const timeoutMs = Number.isFinite(payload?.timeoutMs) && payload.timeoutMs > 0
        ? Math.floor(payload.timeoutMs)
        : 120000;

    const label = backend === 'codex' ? 'Codex CLI' : 'Claude CLI';
    console.log(`[CliService] Calling ${label}${model ? ' (' + model + ')' : ''}${reasoningEffort ? ' effort=' + reasoningEffort : ''}...`);

    try {
        let raw;
        if (backend === 'codex') {
            raw = await callCodexCli(promptText, { signal: payload.signal, timeoutMs, model, reasoningEffort, assistantSessionId });
        } else {
            raw = await callClaudeCli(promptText, { signal: payload.signal, timeoutMs, model });
        }

        const parsed = extractJson(raw);

        if (!parsed || typeof parsed !== 'object') {
            throw new Error(`${label} response did not contain a JSON object.`);
        }

        if (parsed.type === 'tool_call') {
            if (!parsed.tool || typeof parsed.tool !== 'string') {
                throw new Error(`${label} returned a tool call without a tool name.`);
            }
            if (parsed.arguments === undefined && parsed.args === undefined) {
                parsed.arguments = {};
            }
            return parsed;
        }

        if (parsed.type === 'clarify') {
            if (typeof parsed.question !== 'string' || !parsed.question.trim()) {
                throw new Error(`${label} returned a clarification without a question.`);
            }
            return parsed;
        }

        if (parsed.type === 'final') {
            if (typeof parsed.message !== 'string') {
                throw new Error(`${label} returned a final response without a message.`);
            }
            return parsed;
        }

        throw new Error(`${label} returned unsupported action type: ${parsed.type}`);
    } catch (error) {
        console.error(`[CliService] Failed to get assistant action:`, error);
        throw new Error(`Failed to get assistant action from ${label}: ${error.message}`);
    }
}

module.exports = {
    getAssistantNextAction,
    configureBackend,
    parseCodexModel,
    CLAUDE_HAIKU_MODEL,
    // Exported for testing
    buildPromptText,
    extractJson,
    extractCodexSessionIdFromJsonLines,
    buildCodexCliArgs,
    codexSessionsByAssistantSession,
    callClaudeCli,
    callCodexCli,
};
