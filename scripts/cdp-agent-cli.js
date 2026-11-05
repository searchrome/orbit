#!/usr/bin/env node
/**
 * cdp-agent-cli.js — CDP browser agent using Claude CLI or Codex CLI as backend.
 *
 * Reuses all CDP tools, parsing, and agent loop from cdp-agent.js but replaces
 * the OpenRouter API call with a CLI invocation (claude -p or codex exec).
 *
 * Usage:
 *   node scripts/cdp-agent-cli.js --backend claude "find a used bike under 150 euro"
 *   node scripts/cdp-agent-cli.js --backend codex "find a used bike under 150 euro"
 *   node scripts/cdp-agent-cli.js --backend codex-evrim "find a used bike under 150 euro"
 *   node scripts/cdp-agent-cli.js --backend claude --model opus --session "search query"
 *   node scripts/cdp-agent-cli.js --backend codex --model gpt-5.4-mini --reasoning-effort xhigh "search query"
 *
 * Flags:
 *   --backend <claude|codex|codex-evrim>  — which CLI to use (required)
 *   --model <model>           — model override (claude: sonnet/opus/haiku; codex: gpt-5.4-mini/o3/etc)
 *   --reasoning-effort <lvl>  — codex reasoning effort: low, medium, high, xhigh
 *   --session                 — interactive multi-turn mode
 *   --output <dir>            — directory for session logs (default: scripts/logs)
 *   --full-context            — always send full conversation (default: true)
 *   --last-n <N>              — only send last N messages instead of full context
 */

const { execSync } = require('child_process');
const path = require('path');

// Reuse everything from cdp-agent except callLLM and CLI parsing
const agent = require('./cdp-agent');
const {
    CONFIG,
    TOOLS,
    parseAction,
    buildSystemPrompt,
    classifyIntent,
    discoverTargets,
    executeAgentLoop,
    closeAllConnections,
    createSessionLog,
    flushSessionLog,
    _connections,
} = agent;

let fs;
try { fs = require('fs'); } catch { fs = null; }

const readline = require('readline');

const CODEX_REASONING_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh']);

// ---------------------------------------------------------------------------
// CLI BACKENDS
// ---------------------------------------------------------------------------

const BACKENDS = {
    claude: {
        command: 'claude',
        buildArgs(model, systemPrompt, userMessage) {
            const args = ['-p', '--no-session-persistence', '--output-format', 'text'];
            if (model) args.push('--model', model);
            if (systemPrompt) args.push('--system-prompt', systemPrompt);
            return args;
        },
    },
    codex: {
        command: 'codex',
        buildArgs(model, systemPrompt, userMessage) {
            const args = ['exec', '--dangerously-bypass-approvals-and-sandbox'];
            if (model) args.push('--model', model);
            return args;
        },
    },
    'codex-evrim': {
        command: 'codex-evrim',
        buildArgs(model, systemPrompt, userMessage) {
            const args = ['exec', '--dangerously-bypass-approvals-and-sandbox'];
            if (model) args.push('--model', model);
            return args;
        },
    },
};

// ---------------------------------------------------------------------------
// LOGGING (mirrors cdp-agent but separate instance)
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
// LLM CALL VIA CLI
// ---------------------------------------------------------------------------

function normalizeCodexReasoningEffort(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const normalized = String(value).trim().toLowerCase();
    if (!CODEX_REASONING_EFFORTS.has(normalized)) {
        throw new Error(`Unknown Codex reasoning effort "${value}". Use low, medium, high, or xhigh.`);
    }
    return normalized;
}

function buildCodexExecArgs({ model, reasoningEffort, outputFile }) {
    const args = ['exec', '--dangerously-bypass-approvals-and-sandbox'];
    if (model) {
        args.push('--model', model);
    }
    const normalizedEffort = normalizeCodexReasoningEffort(reasoningEffort);
    if (normalizedEffort) {
        args.push('-c', `model_reasoning_effort="${normalizedEffort}"`);
    }
    if (outputFile) {
        args.push('-o', outputFile);
    }
    args.push('-');
    return args;
}

function callLLMViaCli(messages, backendName, model, lastN, backendOptions = {}) {
    const backend = BACKENDS[backendName];
    if (!backend) throw new Error(`Unknown backend: ${backendName}. Use "claude", "codex", or "codex-evrim".`);

    const systemMsg = messages.find(m => m.role === 'system');
    const systemPrompt = systemMsg?.content || '';

    const nonSystem = messages.filter(m => m.role !== 'system');
    let selected = nonSystem;
    if (lastN && lastN > 0) {
        selected = nonSystem.slice(Math.max(0, nonSystem.length - lastN));
    }

    const conversationText = selected.map(m => {
        if (m.role === 'assistant') return `[ASSISTANT]\n${m.content}`;
        return `[USER]\n${m.content}`;
    }).join('\n\n');

    if (backendName === 'claude') {
        return callClaude(conversationText, systemPrompt, model);
    }
    return callCodexCli(conversationText, systemPrompt, model, backendName, backendOptions);
}

function callClaude(input, systemPrompt, model) {
    // Write system prompt to a temp file to avoid shell escaping issues with large prompts
    const tmpDir = require('os').tmpdir();
    const sysFile = path.join(tmpDir, `cdp-claude-sys-${Date.now()}.txt`);
    if (fs) fs.writeFileSync(sysFile, systemPrompt, 'utf8');

    const args = ['-p', '--no-session-persistence', '--output-format', 'text',
                  '--system-prompt-file', sysFile];
    if (model) args.push('--model', model);

    const fullCmd = ['claude', ...args.map(a => `'${a.replace(/'/g, "'\\''")}'`)].join(' ');
    log('llm', `Calling claude${model ? ' (' + model + ')' : ''}...`);

    try {
        const result = execSync(fullCmd, {
            input,
            encoding: 'utf8',
            timeout: 300000,
            maxBuffer: 1024 * 1024 * 10,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        return result.trim();
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString().slice(0, 500) : '';
        throw new Error(`claude failed: ${err.message}${stderr ? '\n' + stderr : ''}`);
    } finally {
        try { if (fs) fs.unlinkSync(sysFile); } catch { /* ignore */ }
    }
}

function callCodexCli(input, systemPrompt, model, backendName = 'codex', options = {}) {
    // codex exec reads prompt from stdin when using '-'
    // Use --output-last-message to capture the response to a temp file
    const tmpFile = path.join(require('os').tmpdir(), `cdp-codex-${Date.now()}.txt`);
    const fullPrompt = `${systemPrompt}\n\n${input}`;
    const args = buildCodexExecArgs({
        model,
        reasoningEffort: options.reasoningEffort,
        outputFile: tmpFile
    });

    const backend = BACKENDS[backendName] || BACKENDS.codex;
    const command = backend.command;
    const fullCmd = [command, ...args.map(a => `'${a.replace(/'/g, "'\\''")}'`)].join(' ');
    const effortSuffix = options.reasoningEffort ? `, effort=${options.reasoningEffort}` : '';
    log('llm', `Calling ${command}${model ? ' (' + model : ''}${effortSuffix}${model ? ')' : effortSuffix ? '' : ''}...`);

    try {
        execSync(fullCmd, {
            input: fullPrompt,
            encoding: 'utf8',
            timeout: 300000,
            maxBuffer: 1024 * 1024 * 10,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Read the output file
        if (fs && fs.existsSync(tmpFile)) {
            const result = fs.readFileSync(tmpFile, 'utf8').trim();
            try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
            return result;
        }
        throw new Error(`${command} produced no output file`);
    } catch (err) {
        // Clean up temp file on error
        try { if (fs) fs.unlinkSync(tmpFile); } catch { /* ignore */ }
        if (err.message.includes('produced no output')) throw err;
        const stderr = err.stderr ? err.stderr.toString().slice(0, 500) : '';
        throw new Error(`${command} failed: ${err.message}${stderr ? '\n' + stderr : ''}`);
    }
}

// ---------------------------------------------------------------------------
// AGENT LOOP (patched to use CLI backend)
// ---------------------------------------------------------------------------

function isReadTool(toolName) {
    return toolName === 'read_page_text' || toolName === 'evaluate';
}

const MIN_EXPLORE_SOURCES = 3;
const MAX_EARLY_FINAL_BOUNCES = 2;

async function askUser(question) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
    return new Promise((resolve) => {
        rl.question(`\x1b[34m[ask]\x1b[0m ${question}\n> `, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

async function executeCliAgentLoop(conversation, { maxSteps = 40, intent = 'auto', backend = 'claude', model = null, lastN = null, reasoningEffort = null } = {}) {
    let step = 0;
    let lastFinal = null;
    const sourcesRead = new Set();
    let earlyFinalBounces = 0;
    const m = _sessionLog?.metrics;

    while (step < maxSteps) {
        step++;
        if (m) m.totalSteps = step;
        log('llm', `Step ${step}/${maxSteps} — asking ${backend}...`);

        let raw;
        try {
            if (m) m.llmCalls++;
            raw = callLLMViaCli(conversation, backend, model, lastN, { reasoningEffort });
        } catch (err) {
            if (m) m.llmErrors++;
            log('error', `CLI call failed: ${err.message}`);
            break;
        }

        let action;
        try {
            action = parseAction(raw);
        } catch (err) {
            log('error', `Bad response: ${err.message}`, raw.slice(0, 300));
            conversation.push({ role: 'assistant', content: raw });
            conversation.push({ role: 'user', content: 'Your response was not valid JSON. Return ONLY a valid JSON action object, nothing else.' });
            continue;
        }

        conversation.push({ role: 'assistant', content: JSON.stringify(action) });

        // --- FINAL ---
        if (action.type === 'final') {
            if (intent === 'explore' && sourcesRead.size < MIN_EXPLORE_SOURCES && earlyFinalBounces < MAX_EARLY_FINAL_BOUNCES) {
                earlyFinalBounces++;
                if (m) m.earlyFinalBounces = earlyFinalBounces;
                log('info', `Only ${sourcesRead.size}/${MIN_EXPLORE_SOURCES} sources — bounce ${earlyFinalBounces}/${MAX_EARLY_FINAL_BOUNCES}`);
                conversation.push({
                    role: 'user',
                    content: `You have only visited ${sourcesRead.size} real source pages. This is an exploration request — visit at least ${MIN_EXPLORE_SOURCES} distinct sites and extract real data from each before returning final.`
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
                conversation.push({ role: 'user', content: `Tool result: ${JSON.stringify({ ok: false, error: `Unknown tool: ${toolName}` })}` });
                continue;
            }

            let result;
            try {
                result = await toolFn({ cdpPort: CONFIG.cdpPort, ...toolArgs });
            } catch (err) {
                result = { ok: false, error: err.message };
            }

            // Track sources
            if (result?.ok && isReadTool(toolName) && toolArgs.targetId) {
                if (m) m.pagesRead++;
                try {
                    const currentTargets = await discoverTargets(CONFIG.cdpPort);
                    const readTarget = currentTargets.find(t => t.id === toolArgs.targetId);
                    if (readTarget?.url && readTarget.url.startsWith('http')) {
                        const host = new URL(readTarget.url).hostname.replace(/^www\./, '');
                        sourcesRead.add(host);
                        log('info', `Sources: ${sourcesRead.size} [${Array.from(sourcesRead).join(', ')}]`);
                    }
                } catch { /* ignore */ }
            }

            if (toolName === 'search_page' && result?.ok) {
                if (m) m.searchesSubmitted++;
            }

            const resultStr = JSON.stringify(result).slice(0, 12000);
            log('tool', `${toolName} → ${result?.ok ? 'ok' : 'FAILED'}`, resultStr.slice(0, 200));
            conversation.push({ role: 'user', content: `Tool result: ${resultStr}` });

            // Refresh targets
            if (toolName === 'navigate' || toolName === 'list_targets' || toolName === 'open_tab') {
                try {
                    const targets = await discoverTargets(CONFIG.cdpPort);
                    conversation[0].content = buildSystemPrompt(targets, intent);
                } catch { /* keep old */ }
            }

            continue;
        }

        log('error', `Unknown action type: ${action.type}`);
        conversation.push({ role: 'user', content: `Unknown action type "${action.type}". Use tool_call, ask_user, or final.` });
    }

    if (step >= maxSteps) {
        log('error', `Reached max steps (${maxSteps}).`);
    }

    return lastFinal;
}

// ---------------------------------------------------------------------------
// SESSION MANAGEMENT
// ---------------------------------------------------------------------------

async function createCliSession({ outputDir } = {}) {
    log('info', `CDP: 127.0.0.1:${CONFIG.cdpPort}`);

    let targets;
    try {
        targets = await discoverTargets(CONFIG.cdpPort);
    } catch (err) {
        log('error', `Cannot reach browser CDP at port ${CONFIG.cdpPort}.`, err.message);
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
    };
}

async function runCliTurn(session, prompt, opts) {
    const { backend, model, lastN, reasoningEffort } = opts;
    session.turnCount++;

    if (session.turnCount === 1 || session.intent === 'auto') {
        session.intent = classifyIntent(prompt);
        log('info', `Intent: ${session.intent}`);
    }

    if (session.turnCount === 1) {
        const label = `${backend}${model ? '/' + model : ''}`;
        _sessionLog = createSessionLog(label, prompt, session.intent, session.outputDir);
    }
    if (_sessionLog) {
        _sessionLog.turns.push({ turn: session.turnCount, prompt, intent: session.intent, startedAt: new Date().toISOString() });
    }

    log('info', `Turn ${session.turnCount}: ${prompt}`);
    session.conversation.push({ role: 'user', content: prompt });

    // Refresh targets
    try {
        const targets = await discoverTargets(CONFIG.cdpPort);
        session.conversation[0].content = buildSystemPrompt(targets, session.intent);
    } catch { /* keep old */ }

    const result = await executeCliAgentLoop(session.conversation, {
        intent: session.intent,
        backend,
        model,
        reasoningEffort,
        lastN,
        maxSteps: opts.maxSteps || 40,
    });

    if (_sessionLog) {
        const turn = _sessionLog.turns[_sessionLog.turns.length - 1];
        turn.finishedAt = new Date().toISOString();
        turn.result = result;
    }

    return result;
}

async function runCliAgent(initialPrompt, opts) {
    const session = await createCliSession({ outputDir: opts.outputDir });
    const result = await runCliTurn(session, initialPrompt, opts);
    closeAllConnections();
    flushSessionLog(_sessionLog);
    return { session, result, logFile: _sessionLog?.file };
}

async function runCliInteractiveSession(initialPrompt, opts) {
    const session = await createCliSession({ outputDir: opts.outputDir });

    if (initialPrompt) {
        await runCliTurn(session, initialPrompt, opts);
    }

    while (true) {
        const followUp = await askUser('Follow-up question (or "quit" to exit):');
        if (!followUp || /^(quit|exit|bye|stop|q)$/i.test(followUp)) {
            log('info', 'Session ended.');
            break;
        }
        await runCliTurn(session, followUp, opts);
    }

    closeAllConnections();
    flushSessionLog(_sessionLog);
    return session;
}

// ---------------------------------------------------------------------------
// CLI PARSING & MAIN
// ---------------------------------------------------------------------------

function parseArgs(argv) {
    const raw = argv.slice(2);
    const flags = { backend: null, model: null, reasoningEffort: null, session: false, output: null, lastN: null, maxSteps: 40 };
    const rest = [];
    for (let i = 0; i < raw.length; i++) {
        if (raw[i] === '--backend' && i + 1 < raw.length) { flags.backend = raw[++i]; }
        else if (raw[i].startsWith('--backend=')) { flags.backend = raw[i].split('=').slice(1).join('='); }
        else if (raw[i] === '--model' && i + 1 < raw.length) { flags.model = raw[++i]; }
        else if (raw[i].startsWith('--model=')) { flags.model = raw[i].split('=').slice(1).join('='); }
        else if (raw[i] === '--reasoning-effort' && i + 1 < raw.length) { flags.reasoningEffort = raw[++i]; }
        else if (raw[i].startsWith('--reasoning-effort=')) { flags.reasoningEffort = raw[i].split('=').slice(1).join('='); }
        else if (raw[i] === '--effort' && i + 1 < raw.length) { flags.reasoningEffort = raw[++i]; }
        else if (raw[i].startsWith('--effort=')) { flags.reasoningEffort = raw[i].split('=').slice(1).join('='); }
        else if (raw[i] === '--session') { flags.session = true; }
        else if (raw[i] === '--output' && i + 1 < raw.length) { flags.output = raw[++i]; }
        else if (raw[i].startsWith('--output=')) { flags.output = raw[i].split('=').slice(1).join('='); }
        else if (raw[i] === '--last-n' && i + 1 < raw.length) { flags.lastN = parseInt(raw[++i], 10); }
        else if (raw[i].startsWith('--last-n=')) { flags.lastN = parseInt(raw[i].split('=')[1], 10); }
        else if (raw[i] === '--max-steps' && i + 1 < raw.length) { flags.maxSteps = parseInt(raw[++i], 10); }
        else if (raw[i].startsWith('--max-steps=')) { flags.maxSteps = parseInt(raw[i].split('=')[1], 10); }
        else if (raw[i] === '--full-context') { flags.lastN = null; }
        else { rest.push(raw[i]); }
    }
    flags.prompt = rest.join(' ').trim();
    return flags;
}

if (require.main === module) {
    const flags = parseArgs(process.argv);

    if (!flags.backend) {
        console.error('Usage: cdp-agent-cli.js --backend <claude|codex|codex-evrim> [--model <model>] [--session] [--output <dir>] [--last-n <N>] "prompt"');
        console.error('\nExamples:');
        console.error('  node scripts/cdp-agent-cli.js --backend claude "find a bike under 150 euro"');
        console.error('  node scripts/cdp-agent-cli.js --backend codex --model o3 "find a bike under 150 euro"');
        console.error('  node scripts/cdp-agent-cli.js --backend codex-evrim --model gpt-5.4-mini "find a bike under 150 euro"');
        console.error('  node scripts/cdp-agent-cli.js --backend claude --model opus --session');
        process.exit(1);
    }

    if (!BACKENDS[flags.backend]) {
        console.error(`Unknown backend: ${flags.backend}. Use "claude", "codex", or "codex-evrim".`);
        process.exit(1);
    }

    if (flags.reasoningEffort && !['codex', 'codex-evrim'].includes(flags.backend)) {
        console.error('--reasoning-effort is only supported with --backend codex or --backend codex-evrim.');
        process.exit(1);
    }

    let normalizedReasoningEffort = null;
    try {
        normalizedReasoningEffort = normalizeCodexReasoningEffort(flags.reasoningEffort);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }

    const effortLabel = normalizedReasoningEffort ? `, effort=${normalizedReasoningEffort}` : '';
    log('info', `Backend: ${flags.backend}${flags.model ? ' (' + flags.model : ''}${effortLabel}${flags.model ? ')' : effortLabel ? '' : ''}`);

    const opts = {
        backend: flags.backend,
        model: flags.model,
        reasoningEffort: normalizedReasoningEffort,
        outputDir: flags.output || undefined,
        lastN: flags.lastN,
        maxSteps: flags.maxSteps,
    };

    if (flags.session) {
        runCliInteractiveSession(flags.prompt || null, opts).catch(err => { log('error', err.message); process.exit(1); });
    } else if (flags.prompt) {
        runCliAgent(flags.prompt, opts).catch(err => { log('error', err.message); process.exit(1); });
    } else {
        runCliInteractiveSession(null, opts).catch(err => { log('error', err.message); process.exit(1); });
    }
}

module.exports = {
    callLLMViaCli,
    executeCliAgentLoop,
    runCliAgent,
    runCliTurn,
    createCliSession,
    runCliInteractiveSession,
    parseArgs,
    normalizeCodexReasoningEffort,
    buildCodexExecArgs,
    BACKENDS,
};
