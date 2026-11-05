#!/usr/bin/env node
/**
 * cdp-agent.js — Standalone LLM agent that drives the browser via CDP.
 *
 * Usage:
 *   node scripts/cdp-agent.js "find me a ps4 deal in NL"
 *   node scripts/cdp-agent.js --model x-ai/grok-4.3 "find me a ps4 deal in NL"
 *   node scripts/cdp-agent.js --session "find me a ps4 deal in NL"
 *   node scripts/cdp-agent.js                # interactive mode, prompts on stdin
 *
 * Flags:
 *   --model <model>      — override OPENROUTER_MODEL for this run
 *   --session            — interactive multi-turn mode
 *   --output <dir>       — directory for session logs (default: scripts/logs)
 *
 * Env (reads .env at project root):
 *   OPENROUTER_API_KEY   — required
 *   OPENROUTER_MODEL     — default z-ai/glm-5.1
 *   OPENROUTER_BASE_URL  — default https://openrouter.ai/api/v1
 *   CDP_PORT             — default 9222
 */

const path = require('path');
const readline = require('readline');
const WebSocket = require('ws');

let fs;
try { fs = require('fs'); } catch { fs = null; }

// ---------------------------------------------------------------------------
// ENV
// ---------------------------------------------------------------------------

function loadEnv() {
    if (!fs || typeof fs.existsSync !== 'function') return;
    const envPath = path.join(__dirname, '..', '.env');
    if (!fs.existsSync(envPath)) return;
    for (const raw of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*)$/);
        if (!m) continue;
        let val = m[2].trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
}

loadEnv();

const CONFIG = {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'z-ai/glm-5.1',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, ''),
    referer: process.env.OPENROUTER_HTTP_REFERER || 'http://localhost',
    appTitle: process.env.OPENROUTER_APP_TITLE || 'CDP Agent',
    cdpPort: parseInt(process.env.CDP_PORT || '9222', 10),
};

// ---------------------------------------------------------------------------
// LOGGING
// ---------------------------------------------------------------------------

let _sessionLog = null;

function log(level, message, meta) {
    const prefix = { info: '\x1b[36m[info]\x1b[0m', tool: '\x1b[33m[tool]\x1b[0m', llm: '\x1b[35m[llm]\x1b[0m', error: '\x1b[31m[error]\x1b[0m', result: '\x1b[32m[result]\x1b[0m', ask: '\x1b[34m[ask]\x1b[0m' };
    const tag = prefix[level] || `[${level}]`;
    console.error(`${tag} ${message}`);
    if (meta) console.error(`       ${typeof meta === 'string' ? meta : JSON.stringify(meta).slice(0, 300)}`);
    if (_sessionLog) {
        const plain = `[${level}] ${message}${meta ? '\n       ' + (typeof meta === 'string' ? meta : JSON.stringify(meta).slice(0, 300)) : ''}`;
        _sessionLog.lines.push({ ts: new Date().toISOString(), level, text: plain });
    }
}

// ---------------------------------------------------------------------------
// SESSION METRICS & FILE LOGGING
// ---------------------------------------------------------------------------

function createSessionLog(model, prompt, intent, outputDir) {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const slug = model.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const dir = outputDir || path.join(__dirname, 'logs');
    return {
        file: path.join(dir, `session_${slug}_${ts}.json`),
        dir,
        startedAt: new Date().toISOString(),
        model,
        initialPrompt: prompt,
        intent,
        metrics: {
            toolCalls: 0,
            toolCallsByName: {},
            searchesSubmitted: 0,
            pagesRead: 0,
            questionsAskedToUser: 0,
            userAnswers: [],
            earlyFinalBounces: 0,
            llmCalls: 0,
            llmErrors: 0,
            sourcesVisited: [],
            totalSteps: 0,
        },
        turns: [],
        lines: [],
    };
}

function flushSessionLog(sessionLog) {
    if (!sessionLog || !fs || typeof fs.mkdirSync !== 'function') return null;
    try {
        fs.mkdirSync(sessionLog.dir, { recursive: true });
        sessionLog.finishedAt = new Date().toISOString();
        fs.writeFileSync(sessionLog.file, JSON.stringify(sessionLog, null, 2), 'utf8');
        log('info', `Session log written: ${sessionLog.file}`);
        return sessionLog.file;
    } catch (err) {
        log('error', `Failed to write session log: ${err.message}`);
        return null;
    }
}

// ---------------------------------------------------------------------------
// CDP TRANSPORT
// ---------------------------------------------------------------------------

class CdpConnection {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.ws = null;
        this._id = 0;
        this._pending = new Map();
    }

    connect() {
        return new Promise((resolve, reject) => {
            this.ws = new WebSocket(this.wsUrl);
            this.ws.on('open', () => resolve());
            this.ws.on('error', (err) => reject(err));
            this.ws.on('message', (raw) => {
                const msg = JSON.parse(raw);
                if (msg.id !== undefined && this._pending.has(msg.id)) {
                    this._pending.get(msg.id)(msg);
                    this._pending.delete(msg.id);
                }
            });
        });
    }

    send(method, params = {}) {
        return new Promise((resolve, reject) => {
            const id = ++this._id;
            const timeout = setTimeout(() => {
                this._pending.delete(id);
                reject(new Error(`CDP timeout: ${method}`));
            }, 15000);
            this._pending.set(id, (msg) => {
                clearTimeout(timeout);
                if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                else resolve(msg.result);
            });
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }

    close() {
        if (this.ws) this.ws.close();
    }
}

// ---------------------------------------------------------------------------
// CDP TOOLS — what the LLM can call
// ---------------------------------------------------------------------------

async function discoverAllTargets(cdpPort) {
    const res = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
    return res.json();
}

async function discoverTargets(cdpPort) {
    const all = await discoverAllTargets(cdpPort);
    return all
        .filter(t => t.type === 'webview' && !t.url.includes('assistant.html'))
        .map(t => ({ id: t.id, title: t.title, url: t.url, wsUrl: t.webSocketDebuggerUrl }));
}

async function getMainPageTarget(cdpPort) {
    const all = await discoverAllTargets(cdpPort);
    const main = all.find(t => t.type === 'page' && t.url.includes('index.html'));
    if (!main) return null;
    return { id: main.id, wsUrl: main.webSocketDebuggerUrl };
}

const _connections = new Map();

async function getConnection(target) {
    if (_connections.has(target.id)) return _connections.get(target.id);
    const conn = new CdpConnection(target.wsUrl);
    await conn.connect();
    _connections.set(target.id, conn);
    return conn;
}

function closeAllConnections() {
    for (const conn of _connections.values()) conn.close();
    _connections.clear();
}

const TOOLS = {
    async list_targets({ cdpPort }) {
        const targets = await discoverTargets(cdpPort);
        return { ok: true, targets };
    },

    async open_tab({ cdpPort, url }) {
        if (!url) return { ok: false, error: 'open_tab requires a url' };
        const main = await getMainPageTarget(cdpPort);
        if (!main) return { ok: false, error: 'Cannot find the main browser page to create a tab.' };
        const conn = await getConnection(main);
        // Use the renderer's tabManager via the preload bridge to create a new tab
        const js = `
        (() => {
            const url = ${JSON.stringify(url)};
            // Try the tabManager API exposed in the renderer
            if (window.tabManager && typeof window.tabManager.createTab === 'function') {
                const id = window.tabManager.createTab(url, { activate: true, title: 'New Tab' });
                return JSON.stringify({ ok: true, tabId: id });
            }
            // Fallback: click the new-tab button and then navigate
            const btn = document.querySelector('#new-tab-btn, .new-tab-btn, [data-action="new-tab"], button');
            if (btn) { btn.click(); return JSON.stringify({ ok: true, clicked: true }); }
            return JSON.stringify({ ok: false, error: 'No tab creation method found' });
        })()`;
        let result;
        try {
            result = await conn.send('Runtime.evaluate', { expression: js, returnByValue: true });
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
        const val = result?.result?.value;
        let parsed;
        try { parsed = JSON.parse(val); } catch { parsed = { ok: false, error: 'Unexpected response' }; }
        if (!parsed.ok) return parsed;
        // Wait for the webview to appear and navigate
        await new Promise(r => setTimeout(r, 3000));
        // Find the new webview target
        const targets = await discoverTargets(cdpPort);
        if (!targets.length) return { ok: false, error: 'Tab created but no webview appeared.' };
        const newest = targets[targets.length - 1];
        // If the tab was created at about:blank or a default, navigate it
        if (newest.url === 'about:blank' || !newest.url.startsWith('http')) {
            const tabConn = await getConnection(newest);
            await tabConn.send('Page.navigate', { url });
            await new Promise(r => setTimeout(r, 4000));
        }
        // Re-discover to get updated URL/title
        const updated = await discoverTargets(cdpPort);
        const tab = updated.find(t => t.id === newest.id) || newest;
        return { ok: true, target: tab };
    },

    async navigate({ cdpPort, targetId, url }) {
        const targets = await discoverTargets(cdpPort);
        const target = targets.find(t => t.id === targetId);
        if (!target) return { ok: false, error: `Target ${targetId} not found` };
        const conn = await getConnection(target);
        const result = await conn.send('Page.navigate', { url });
        await new Promise(r => setTimeout(r, 4000));
        const titleResult = await conn.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true });
        return { ok: true, frameId: result.frameId, title: titleResult?.result?.value || '' };
    },

    async evaluate({ cdpPort, targetId, expression }) {
        const targets = await discoverTargets(cdpPort);
        const target = targets.find(t => t.id === targetId);
        if (!target) return { ok: false, error: `Target ${targetId} not found` };
        const conn = await getConnection(target);
        let result;
        try {
            result = await conn.send('Runtime.evaluate', { expression, returnByValue: true });
        } catch (err) {
            return { ok: false, error: err.message || String(err) };
        }
        if (result?.exceptionDetails) {
            return { ok: false, error: result.exceptionDetails.text || 'JS error' };
        }
        const value = result?.result?.value;
        return { ok: true, value: typeof value === 'string' ? value.slice(0, 12000) : value };
    },

    async read_page_text({ cdpPort, targetId, maxChars }) {
        const max = maxChars || 6000;
        return TOOLS.evaluate({ cdpPort, targetId, expression: `(document.body ? document.body.innerText || '' : '').slice(0, ${max})` });
    },

    async search_page({ cdpPort, targetId, query }) {
        const js = `
        (() => {
            const q = ${JSON.stringify(query)};
            const inputs = Array.from(document.querySelectorAll('input[type="search"], input[name="q"], input[name*="search" i], input[name="_nkw"], #gh-ac, input[placeholder*="search" i], input[placeholder*="zoek" i], input:not([type="hidden"])'));
            const visible = inputs.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; });
            if (!visible.length) return JSON.stringify({ok: false, error: 'No search field found'});
            const el = visible[0];
            el.focus();
            el.value = '';
            el.value = q;
            el.dispatchEvent(new Event('input', {bubbles: true}));
            el.dispatchEvent(new Event('change', {bubbles: true}));
            const form = el.form || el.closest('form');
            if (form) { try { form.requestSubmit(); } catch { form.submit(); } }
            else { el.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', code:'Enter', bubbles:true})); }
            return JSON.stringify({ok: true, query: q});
        })()`;
        const result = await TOOLS.evaluate({ cdpPort, targetId, expression: js });
        if (!result.ok) return result;
        try {
            const parsed = JSON.parse(result.value);
            if (!parsed.ok) return parsed;
        } catch { /* value wasn't JSON, that's fine */ }
        await new Promise(r => setTimeout(r, 5000));
        return { ok: true, query, message: 'Search submitted, page should be loading.' };
    },

    async wait({ ms }) {
        const delay = Math.min(ms || 3000, 10000);
        await new Promise(r => setTimeout(r, delay));
        return { ok: true, waited: delay };
    },
};

const TOOL_DESCRIPTIONS = `
Available tools (return JSON with "tool" and "arguments"):
1. list_targets {} — discover browser webview tabs
2. open_tab { "url": string } — open a new browser tab with the given URL (use when no suitable tab exists)
3. navigate { "targetId": string, "url": string } — navigate an existing tab to a URL
4. evaluate { "targetId": string, "expression": string } — run JS in a tab, returns result
5. read_page_text { "targetId": string, "maxChars"?: number } — get page text content
6. search_page { "targetId": string, "query": string } — find search box, type query, submit
7. wait { "ms": number } — wait N milliseconds before next action

IMPORTANT: If list_targets returns empty, use open_tab to create a new tab first.
`.trim();

// ---------------------------------------------------------------------------
// LLM PLANNER
// ---------------------------------------------------------------------------

async function callLLM(messages, retries = 2) {
    if (!CONFIG.apiKey) throw new Error('OPENROUTER_API_KEY not set');

    for (let attempt = 0; attempt <= retries; attempt++) {
        const res = await fetch(`${CONFIG.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${CONFIG.apiKey}`,
                'Content-Type': 'application/json',
                'HTTP-Referer': CONFIG.referer,
                'X-OpenRouter-Title': CONFIG.appTitle,
            },
            body: JSON.stringify({
                model: CONFIG.model,
                messages,
                temperature: 0,
                max_tokens: 1200,
            }),
        });

        if (!res.ok) {
            const text = await res.text();
            if (attempt < retries) { await new Promise(r => setTimeout(r, 1500)); continue; }
            throw new Error(`OpenRouter ${res.status}: ${text.slice(0, 300)}`);
        }

        const body = await res.json();
        const content = body?.choices?.[0]?.message?.content || '';
        if (!content && attempt < retries) continue;
        return content;
    }
    throw new Error('LLM returned empty content after retries.');
}

function classifyIntent(prompt) {
    const normalized = String(prompt || '').toLowerCase();

    const lookupSignals = [
        /\bwebsite\s+(of|for|van)\b/i,
        /\bwhat is the (url|link|address|site)\b/i,
        /\bgo to\b/i,
        /\bopen\b.*\b(site|page|url)\b/i,
        /\bhow (do i|to|can i)\b/i,
        /\bwhat does .+ mean\b/i,
        /\bdefine\b/i,
        /\bweather\b/i,
        /\bwhat time\b/i,
    ];

    const exploreSignals = [
        /\bfind\b/i,
        /\bsearch\b/i,
        /\blooking for\b/i,
        /\bbest\b/i,
        /\bcheapest\b/i,
        /\bdeal\b/i,
        /\bcompare\b/i,
        /\boptions?\b/i,
        /\brecommend/i,
        /\bsuggest/i,
        /\bwhere can i\b/i,
        /\bnear\b/i,
        /\btraining\b/i,
        /\bclub\b/i,
        /\bschool\b/i,
        /\bshop\b/i,
        /\bbuy\b/i,
        /\bused\b/i,
        /\brent\b/i,
        /\bprice/i,
        /\bbudget\b/i,
        /\balternatives?\b/i,
        /\breviews?\b/i,
    ];

    const isLookup = lookupSignals.some(r => r.test(normalized));
    const isExplore = exploreSignals.some(r => r.test(normalized));

    if (isLookup && !isExplore) return 'lookup';
    if (isExplore) return 'explore';
    return 'auto';
}

function buildSystemPrompt(targets, intentHint) {
    const intent = intentHint || 'auto';

    const depthGuidance = intent === 'lookup'
        ? `This looks like a LOOKUP request — the user wants one specific answer, URL, or fact.
- Find the answer efficiently. One source is enough.
- Return a final answer as soon as you have what they asked for.`
        : intent === 'explore'
        ? `This looks like an EXPLORE request — the user wants to compare options.
- Visit AT LEAST 3 different real websites before returning a final answer.
- For each option, extract real data: name, price, schedule, location, URL.
- Do NOT return a final answer after reading just one source or one search results page.
- After reading search results, pick the top 3-5 candidates and visit each site individually.
- Compare what you found across sites before answering.
- If a site returns 404 or no useful data, move on to the next one — do not count it.
- Only return final when you have inspected at least 3 real source pages with useful data.`
        : `Decide based on the request:
- If the user wants a specific fact, URL, or single answer → find it and return quickly.
- If the user is exploring options, comparing, or asking "find me X" → visit AT LEAST 3 real sites, extract data from each, and compare before answering.
- When in doubt, explore more rather than less.`;

    return `You are a browser automation agent. You control a live Electron browser via CDP tools.

${TOOL_DESCRIPTIONS}

Current browser targets:
${JSON.stringify(targets, null, 2)}

Search depth guidance:
${depthGuidance}

## CHECKPOINT — Before you start browsing

CRITICAL: Your VERY FIRST action on a new request MUST be to evaluate whether you have enough information to do a good search. Think about what details are missing that would dramatically improve the results.

For product searches, consider: size, gender, type/style, location/city, brand preference, new vs used condition expectations, pickup vs delivery.
For service searches, consider: age/level, location/city, schedule preferences, gender, budget details.
For any search: consider what a knowledgeable human would ask before searching.

If ANY important detail is missing, your first action MUST be {"type":"ask_user","question":"..."} to collect the missing info. You can ask multiple things in one question.

Examples of GOOD first actions:
- User says "find me a bicycle under 150 euro" → ask_user: "Before I search, I need a few details: 1) Men's, women's, or unisex? 2) What frame size or your height? 3) Which city/region for pickup? 4) Any brand preference?"
- User says "find football training for my daughter" → ask_user: "To find the best options: 1) How old is she / birth year? 2) Which city? 3) Beginner or experienced? 4) Any budget limit?"

Examples of BAD first actions:
- Immediately opening Google or Marktplaats without knowing size/gender/location
- Guessing details the user didn't provide

Only skip the checkpoint if the user's request already contains ALL key details (location, size/age, gender, specific requirements).

## Rules
- Return ONLY valid JSON, no markdown, no code fences, no commentary.
- One action per response.
- Return one of these shapes:
  {"type":"tool_call","message":"what you are doing","tool":"<name>","arguments":{...}}
  {"type":"ask_user","question":"your question"}
  {"type":"final","message":"your answer with findings","sourcesVisited":N}
- Use evaluate to extract structured data from pages (run JS that returns JSON.stringify(...)).
- After navigate or search_page, use read_page_text or evaluate to see what loaded.
- Do not invent data. Only report what you actually read from pages.
- Keep tool calls efficient but thorough.
- In your final answer, include "sourcesVisited" with how many distinct real pages you read data from.
- For explore requests: if you have visited fewer than 3 real sources, do NOT return final yet — visit more sites first.`;
}

function parseAction(raw) {
    const text = raw.trim();
    // strip code fences if present
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const objMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!objMatch) throw new Error(`No JSON object in LLM response: ${text.slice(0, 200)}`);
    return JSON.parse(objMatch[0]);
}

// ---------------------------------------------------------------------------
// AGENT LOOP
// ---------------------------------------------------------------------------

async function askUser(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
        rl.question(`\x1b[34m[ask]\x1b[0m ${question}\n> `, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

const MIN_EXPLORE_SOURCES = 3;
const MAX_EARLY_FINAL_BOUNCES = 2;

function isReadTool(toolName) {
    return toolName === 'read_page_text' || toolName === 'evaluate';
}

async function executeAgentLoop(conversation, { maxSteps = 40, intent = 'auto' } = {}) {
    let step = 0;
    let lastFinal = null;
    const sourcesRead = new Set();
    let earlyFinalBounces = 0;
    const m = _sessionLog?.metrics;

    while (step < maxSteps) {
        step++;
        if (m) m.totalSteps = step;
        log('llm', `Step ${step}/${maxSteps} — asking planner...`);

        let raw;
        try {
            if (m) m.llmCalls++;
            raw = await callLLM(conversation);
        } catch (err) {
            if (m) m.llmErrors++;
            log('error', `LLM call failed: ${err.message}`);
            break;
        }

        let action;
        try {
            action = parseAction(raw);
        } catch (err) {
            log('error', `Bad LLM response: ${err.message}`, raw.slice(0, 300));
            conversation.push({ role: 'assistant', content: raw });
            conversation.push({ role: 'user', content: 'Your response was not valid JSON. Return only a valid JSON action object.' });
            continue;
        }

        conversation.push({ role: 'assistant', content: JSON.stringify(action) });

        // --- FINAL ---
        if (action.type === 'final') {
            // Bounce back if explore intent and not enough sources visited
            if (intent === 'explore' && sourcesRead.size < MIN_EXPLORE_SOURCES && earlyFinalBounces < MAX_EARLY_FINAL_BOUNCES) {
                earlyFinalBounces++;
                if (m) m.earlyFinalBounces = earlyFinalBounces;
                log('info', `Only ${sourcesRead.size}/${MIN_EXPLORE_SOURCES} sources visited — pushing agent to explore more (bounce ${earlyFinalBounces}/${MAX_EARLY_FINAL_BOUNCES})`);
                conversation.push({
                    role: 'user',
                    content: `You have only visited ${sourcesRead.size} real source pages so far. This is an exploration request — please visit at least ${MIN_EXPLORE_SOURCES} distinct sites and extract real data (prices, schedules, etc.) from each before returning your final answer. Navigate to more candidate sites now.`
                });
                continue;
            }

            log('result', action.message || 'Done.');
            if (m) m.sourcesVisited = Array.from(sourcesRead);
            log('info', `Sources visited: ${sourcesRead.size} (${Array.from(sourcesRead).join(', ')})`);
            if (Array.isArray(action.results)) {
                for (const r of action.results) {
                    console.error(`  • ${r.title || ''} — ${r.price || ''} ${r.url || r.href || ''}`);
                }
            }
            lastFinal = action;
            break;
        }

        // --- ASK USER ---
        if (action.type === 'ask_user') {
            if (m) m.questionsAskedToUser++;
            const answer = await askUser(action.question);
            if (m) m.userAnswers.push({ question: action.question, answer });
            log('info', `User answered: ${answer}`);
            conversation.push({ role: 'user', content: answer });
            continue;
        }

        // --- TOOL CALL ---
        if (action.type === 'tool_call') {
            const toolName = action.tool;
            const toolArgs = action.arguments || {};
            if (m) {
                m.toolCalls++;
                m.toolCallsByName[toolName] = (m.toolCallsByName[toolName] || 0) + 1;
            }
            log('tool', `${toolName}(${JSON.stringify(toolArgs).slice(0, 200)})`, action.message);

            const toolFn = TOOLS[toolName];
            if (!toolFn) {
                const errResult = { ok: false, error: `Unknown tool: ${toolName}` };
                conversation.push({ role: 'user', content: `Tool result: ${JSON.stringify(errResult)}` });
                continue;
            }

            let result;
            try {
                result = await toolFn({ cdpPort: CONFIG.cdpPort, ...toolArgs });
            } catch (err) {
                result = { ok: false, error: err.message };
            }

            // Track distinct source pages read
            if (result?.ok && isReadTool(toolName) && toolArgs.targetId) {
                if (m) m.pagesRead++;
                try {
                    const currentTargets = await discoverTargets(CONFIG.cdpPort);
                    const readTarget = currentTargets.find(t => t.id === toolArgs.targetId);
                    if (readTarget?.url && readTarget.url.startsWith('http')) {
                        const host = new URL(readTarget.url).hostname.replace(/^www\./, '');
                        sourcesRead.add(host);
                        log('info', `Sources read so far: ${sourcesRead.size} [${Array.from(sourcesRead).join(', ')}]`);
                    }
                } catch { /* ignore tracking errors */ }
            }

            // Track search submissions
            if (toolName === 'search_page' && result?.ok) {
                if (m) m.searchesSubmitted++;
            }

            const resultStr = JSON.stringify(result).slice(0, 12000);
            log('tool', `${toolName} → ${result?.ok ? 'ok' : 'FAILED'}`, resultStr.slice(0, 200));
            conversation.push({ role: 'user', content: `Tool result: ${resultStr}` });

            // Refresh targets after navigation or tab changes
            if (toolName === 'navigate' || toolName === 'list_targets' || toolName === 'open_tab') {
                try {
                    const targets = await discoverTargets(CONFIG.cdpPort);
                    conversation[0].content = buildSystemPrompt(targets, intent);
                } catch { /* keep old targets */ }
            }

            continue;
        }

        log('error', `Unknown action type: ${action.type}`);
        conversation.push({ role: 'user', content: `Unknown action type "${action.type}". Use tool_call, ask_user, or final.` });
    }

    if (step >= maxSteps) {
        log('error', `Reached max steps (${maxSteps}). Stopping.`);
    }

    return lastFinal;
}

async function createSession({ outputDir, maxSteps } = {}) {
    if (!CONFIG.apiKey) {
        log('error', 'OPENROUTER_API_KEY is not set in .env');
        process.exit(1);
    }

    log('info', `Model: ${CONFIG.model}`);
    log('info', `CDP: 127.0.0.1:${CONFIG.cdpPort}`);

    let targets;
    try {
        targets = await discoverTargets(CONFIG.cdpPort);
    } catch (err) {
        log('error', `Cannot reach browser CDP at port ${CONFIG.cdpPort}. Is the browser running?`, err.message);
        process.exit(1);
    }
    log('info', `Found ${targets.length} browser tab(s)`);

    return {
        conversation: [
            { role: 'system', content: buildSystemPrompt(targets) },
        ],
        turnCount: 0,
        intent: 'auto',
        outputDir: outputDir || null,
        maxSteps: maxSteps || 40,
    };
}

async function runTurn(session, prompt) {
    session.turnCount++;

    // Classify intent on first turn or re-classify if it was auto
    if (session.turnCount === 1 || session.intent === 'auto') {
        session.intent = classifyIntent(prompt);
        log('info', `Intent: ${session.intent} (from: "${prompt.slice(0, 60)}")`);
    }

    // Init session log on first turn
    if (session.turnCount === 1) {
        _sessionLog = createSessionLog(CONFIG.model, prompt, session.intent, session.outputDir);
    }
    if (_sessionLog) {
        _sessionLog.turns.push({ turn: session.turnCount, prompt, intent: session.intent, startedAt: new Date().toISOString() });
    }

    log('info', `Turn ${session.turnCount}: ${prompt}`);
    session.conversation.push({ role: 'user', content: prompt });

    // Refresh targets at the start of each turn
    try {
        const targets = await discoverTargets(CONFIG.cdpPort);
        session.conversation[0].content = buildSystemPrompt(targets, session.intent);
    } catch { /* keep old system prompt */ }

    const result = await executeAgentLoop(session.conversation, { intent: session.intent, maxSteps: session.maxSteps });

    if (_sessionLog) {
        const turn = _sessionLog.turns[_sessionLog.turns.length - 1];
        turn.finishedAt = new Date().toISOString();
        turn.result = result;
    }

    return result;
}

async function runAgent(initialPrompt, { outputDir, maxSteps } = {}) {
    const session = await createSession({ outputDir, maxSteps });
    const result = await runTurn(session, initialPrompt);
    closeAllConnections();
    flushSessionLog(_sessionLog);
    return { session, result, logFile: _sessionLog?.file };
}

async function runInteractiveSession(initialPrompt, { outputDir, maxSteps } = {}) {
    const session = await createSession({ outputDir, maxSteps });

    if (initialPrompt) {
        await runTurn(session, initialPrompt);
    }

    // Keep asking for follow-up prompts
    while (true) {
        const followUp = await askUser('Follow-up question (or "quit" to exit):');
        if (!followUp || /^(quit|exit|bye|stop|q)$/i.test(followUp)) {
            log('info', 'Session ended.');
            break;
        }
        await runTurn(session, followUp);
    }

    closeAllConnections();
    flushSessionLog(_sessionLog);
    return session;
}

// ---------------------------------------------------------------------------
// MAIN / EXPORTS
// ---------------------------------------------------------------------------

function parseCliArgs(argv) {
    const raw = argv.slice(2);
    const flags = { session: false, model: null, output: null, maxSteps: null };
    const rest = [];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '--session') { flags.session = true; }
        else if (raw[i] === '--model' && i + 1 < raw.length) { flags.model = raw[++i]; }
        else if (raw[i].startsWith('--model=')) { flags.model = raw[i].split('=').slice(1).join('='); }
        else if (raw[i] === '--output' && i + 1 < raw.length) { flags.output = raw[++i]; }
        else if (raw[i].startsWith('--output=')) { flags.output = raw[i].split('=').slice(1).join('='); }
        else if (raw[i] === '--max-steps' && i + 1 < raw.length) { flags.maxSteps = parseInt(raw[++i], 10); }
        else if (raw[i].startsWith('--max-steps=')) { flags.maxSteps = parseInt(raw[i].split('=').slice(1).join('='), 10); }
        else { rest.push(raw[i]); }
    }
    flags.prompt = rest.join(' ').trim();
    return flags;
}

if (require.main === module) {
    const flags = parseCliArgs(process.argv);

    // Override model from CLI arg
    if (flags.model) {
        CONFIG.model = flags.model;
    }

    const opts = { outputDir: flags.output || undefined, maxSteps: flags.maxSteps || undefined };

    if (flags.session) {
        runInteractiveSession(flags.prompt || null, opts).catch(err => { log('error', err.message); process.exit(1); });
    } else if (flags.prompt) {
        runAgent(flags.prompt, opts).catch(err => { log('error', err.message); process.exit(1); });
    } else {
        runInteractiveSession(null, opts).catch(err => { log('error', err.message); process.exit(1); });
    }
}

module.exports = {
    loadEnv,
    CONFIG,
    TOOLS,
    CdpConnection,
    discoverTargets,
    callLLM,
    parseAction,
    buildSystemPrompt,
    classifyIntent,
    runAgent,
    runTurn,
    createSession,
    runInteractiveSession,
    executeAgentLoop,
    closeAllConnections,
    createSessionLog,
    flushSessionLog,
    parseCliArgs,
    _connections,
    get _sessionLog() { return _sessionLog; },
    set _sessionLog(v) { _sessionLog = v; },
};
