#!/usr/bin/env node

const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const { getAssistantNextAction } = require('../openrouter-service.js');
const { CdpBrowserSession, DEFAULT_CDP_BASE_URL } = require('./cdp-browser-session.js');
const {
    StandaloneBrowserAgent,
    DEFAULT_MAX_DURATION_MS,
    DEFAULT_MAX_NEW_TABS,
    DEFAULT_MAX_TOOL_CALLS
} = require('./browser-agent-harness-lib.js');

function parseArgs(argv) {
    const options = {
        baseUrl: process.env.CDP_BASE_URL || DEFAULT_CDP_BASE_URL,
        prompt: '',
        model: process.env.OPENROUTER_MODEL || '',
        maxToolCalls: DEFAULT_MAX_TOOL_CALLS,
        maxNewTabs: DEFAULT_MAX_NEW_TABS,
        maxDurationMs: DEFAULT_MAX_DURATION_MS
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const next = argv[index + 1];
        if (arg === '--prompt' && next) {
            options.prompt = next;
            index += 1;
        } else if (arg === '--cdp' && next) {
            options.baseUrl = next;
            index += 1;
        } else if (arg === '--model' && next) {
            options.model = next;
            index += 1;
        } else if (arg === '--max-tool-calls' && next) {
            options.maxToolCalls = Number(next) || DEFAULT_MAX_TOOL_CALLS;
            index += 1;
        } else if (arg === '--max-new-tabs' && next) {
            options.maxNewTabs = Number(next) || DEFAULT_MAX_NEW_TABS;
            index += 1;
        } else if (arg === '--max-duration-ms' && next) {
            options.maxDurationMs = Number(next) || DEFAULT_MAX_DURATION_MS;
            index += 1;
        }
    }

    return options;
}

function createConsoleIo(rl) {
    return {
        async info(message) {
            console.log(message);
        },
        async warn(message) {
            console.warn(message);
        },
        async error(message) {
            console.error(message);
        },
        async assistant(message, meta = {}) {
            if (message) {
                console.log(`Agent: ${message}`);
            }
            if (Array.isArray(meta.results) && meta.results.length) {
                for (const [index, result] of meta.results.entries()) {
                    console.log(`  ${index + 1}. ${result.title || 'Untitled'}${result.price ? ` — ${result.price}` : ''}`);
                    if (result.url) {
                        console.log(`     ${result.url}`);
                    }
                    if (result.reason) {
                        console.log(`     ${result.reason}`);
                    }
                }
            }
        },
        async ask(question) {
            if (!stdin.isTTY) {
                throw new Error(`Interactive input required but no TTY is available: ${question}`);
            }
            return rl.question(`${question}\n> `);
        }
    };
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.model) {
        process.env.OPENROUTER_MODEL = options.model;
    }

    const rl = readline.createInterface({ input: stdin, output: stdout });
    const io = createConsoleIo(rl);

    try {
        const prompt = options.prompt || await rl.question('Initial request:\n> ');
        const browser = await new CdpBrowserSession({ baseUrl: options.baseUrl }).initialize();
        const agent = new StandaloneBrowserAgent({
            planner: getAssistantNextAction,
            browser,
            io,
            maxToolCalls: options.maxToolCalls,
            maxNewTabs: options.maxNewTabs,
            maxDurationMs: options.maxDurationMs
        });

        const result = await agent.run(prompt);
        if (result?.type === 'final' && !result.message) {
            console.log('Agent finished.');
        }
    } catch (error) {
        await io.error(error.message || String(error));
        process.exitCode = 1;
    } finally {
        rl.close();
    }
}

main();
