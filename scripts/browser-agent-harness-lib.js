const { truncateText } = require('./cdp-browser-session.js');

const DEFAULT_MAX_TOOL_CALLS = 50;
const DEFAULT_MAX_NEW_TABS = 5;
const DEFAULT_MAX_DURATION_MS = 120000;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_OBSERVATION_CHARS = 12000;

function parseBudgetMax(prompt) {
    const text = String(prompt || '');
    const patterns = [
        /(?:under|below|max(?:imum)?|budget(?: of)?|up to)\s*€?\s*(\d[\d.,]*)/i,
        /€\s*(\d[\d.,]*)/i,
        /\b(\d[\d.,]*)\s*(?:euro|eur)\b/i
    ];

    for (const pattern of patterns) {
        const match = text.match(pattern);
        if (!match?.[1]) {
            continue;
        }
        const normalized = match[1].replace(/\./g, '').replace(',', '.');
        const value = Number.parseFloat(normalized);
        if (Number.isFinite(value) && value > 0) {
            return value;
        }
    }

    return null;
}

function parsePriceValue(value) {
    const text = String(value || '').toLowerCase();
    if (!text) {
        return null;
    }

    if (/\bbieden\b/.test(text) || /\breserved\b|\bgereserveerd\b/.test(text)) {
        return null;
    }

    const match = text.match(/(?:€|eur)\s*([\d.]+(?:,\d+)?|\d+(?:\.\d+)?)/i);
    if (!match?.[1]) {
        return null;
    }

    const normalized = match[1].replace(/\./g, '').replace(',', '.');
    const parsed = Number.parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function deriveTaskProfile(prompt) {
    const normalized = String(prompt || '').toLowerCase();
    const shoppingSignals = [
        'used',
        'buy',
        'bike',
        'bicycle',
        'marketplace',
        'listing',
        'price',
        'shopping',
        'seller',
        'ecommerce'
    ];
    const localSearchSignals = [
        /\bfind me\b/i,
        /\bnear me\b/i,
        /\bnearby\b/i,
        /\bwhere can i\b/i,
        /\bwhat\s+is\s+near\b/i,
        /\bsports? club\b/i,
        /\bgym\b/i,
        /\brestaurant\b/i,
        /\bcafe\b/i,
        /\bvenue\b/i,
        /\bdentist\b/i,
        /\bdoctor\b/i,
        /\bplumber\b/i,
        /\bschool\b/i
    ];
    const recommendationSignals = [
        /\brecommend/i,
        /\bsuggest/i,
        /\bwhat should i watch\b/i,
        /\bwhat should i read\b/i,
        /\bwhat should i listen to\b/i,
        /\bwatch tonight\b/i,
        /\blike these\b/i,
        /\bsimilar to\b/i,
        /\bmovies?\b/i,
        /\bfilm\b/i,
        /\bmusic\b/i,
        /\bbook\b/i
    ];

    const isShopping = shoppingSignals.some((signal) => normalized.includes(signal));
    const isLocalSearch = !isShopping && localSearchSignals.some((signal) => signal.test(normalized));
    const isRecommendation = !isShopping && !isLocalSearch && recommendationSignals.some((signal) => signal.test(normalized));

    let preferredMarketplace = null;
    if (/\bmarktplaats\b/i.test(normalized)) {
        preferredMarketplace = 'marktplaats.nl';
    } else if (/\bebay\b/i.test(normalized)) {
        preferredMarketplace = 'ebay.nl';
    }

    return {
        kind: isShopping ? 'shopping' : isLocalSearch ? 'local_search' : isRecommendation ? 'recommendation' : 'general',
        preferredMarketplace,
        budgetMax: isShopping ? parseBudgetMax(prompt) : null,
        query: String(prompt || '').trim()
    };
}

function isAffirmativeContinuationReply(value) {
    return /\b(yes|yep|yeah|continue|go on|proceed|more|keep going|carry on|sure|ok|okay)\b/i.test(String(value || ''));
}

function isNegativeContinuationReply(value) {
    return /\b(no|nope|nah|stop|cancel|done|enough|finish|end|quit)\b/i.test(String(value || ''));
}

function createContinuationQuestion(limit = DEFAULT_MAX_TOOL_CALLS) {
    return `I have used ${limit} browser steps. Reply "continue" to allow ${limit} more, or "stop" to finish here.`;
}

function normalizeTouchedTab(tab) {
    if (!tab || typeof tab !== 'object' || !tab.id) {
        return null;
    }

    return {
        id: String(tab.id),
        title: tab.title || tab.url || String(tab.id),
        url: tab.url || '',
        role: tab.role || 'regular',
        assistantOwned: !!tab.assistantOwned,
        internal: !!tab.internal,
        active: !!tab.active,
        closed: !!tab.closed
    };
}

function isPlausibleMarketplaceListingItem(item) {
    if (!item || typeof item !== 'object') {
        return false;
    }
    const title = String(item.title || '').toLowerCase();
    const href = String(item.href || '').toLowerCase();
    const price = String(item.price || '').trim();
    if (!title || title.length < 6 || !href || !price) {
        return false;
    }
    if (!/\/itm\/|\/v\/|\/p\//i.test(href)) {
        return false;
    }
    return !/category|rubriek|shop on ebay|fietsaccessoires|fietsonderdelen/i.test(`${title} ${item.snippet || ''}`);
}

function summarizeMarketplaceCandidates(items = [], taskProfile = {}) {
    if (!Array.isArray(items) || !items.length) {
        return {
            plausibleCount: 0,
            underBudgetCount: 0,
            topCandidates: []
        };
    }

    const budgetMax = Number.isFinite(taskProfile?.budgetMax) ? taskProfile.budgetMax : null;
    const plausible = items
        .filter((item) => isPlausibleMarketplaceListingItem(item))
        .map((item) => {
            const priceValue = parsePriceValue(item.price);
            const underBudget = Number.isFinite(priceValue) && Number.isFinite(budgetMax) ? priceValue <= budgetMax : null;
            return {
                title: item.title || '',
                url: item.href || '',
                price: item.price || null,
                priceValue,
                location: item.location || null,
                reason: item.snippet || null,
                score: Number(item.score) || 0,
                underBudget
            };
        })
        .sort((left, right) => {
            const leftBudget = left.underBudget === true ? 1 : left.underBudget === false ? 0 : -1;
            const rightBudget = right.underBudget === true ? 1 : right.underBudget === false ? 0 : -1;
            if (leftBudget !== rightBudget) {
                return rightBudget - leftBudget;
            }
            if (left.score !== right.score) {
                return right.score - left.score;
            }
            if (Number.isFinite(left.priceValue) && Number.isFinite(right.priceValue)) {
                return left.priceValue - right.priceValue;
            }
            return 0;
        });

    return {
        plausibleCount: plausible.length,
        underBudgetCount: plausible.filter((item) => item.underBudget === true).length,
        topCandidates: plausible.slice(0, 5).map(({ score, priceValue, ...item }) => item)
    };
}

class StandaloneBrowserAgent {
    constructor(options = {}) {
        if (typeof options.planner !== 'function') {
            throw new Error('StandaloneBrowserAgent requires a planner function.');
        }
        if (!options.browser) {
            throw new Error('StandaloneBrowserAgent requires a browser adapter.');
        }

        this.planner = options.planner;
        this.browser = options.browser;
        this.io = options.io || {
            info: async () => {},
            warn: async () => {},
            error: async () => {},
            assistant: async () => {},
            ask: async () => 'no interactive input available — proceed with best judgment'
        };
        this.maxToolCalls = Number(options.maxToolCalls) || DEFAULT_MAX_TOOL_CALLS;
        this.maxNewTabs = Number(options.maxNewTabs) || DEFAULT_MAX_NEW_TABS;
        this.maxDurationMs = Number(options.maxDurationMs) || DEFAULT_MAX_DURATION_MS;
    }

    buildBrowserState() {
        return {
            activeTab: this.browser.getActiveTab(),
            tabs: this.browser.listTabs().filter((tab) => !tab.internal)
        };
    }

    truncateObservation(value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        return truncateText(text, MAX_OBSERVATION_CHARS);
    }

    buildRuntimeState(run) {
        return {
            toolCallsUsed: run.callCount,
            toolCallsRemaining: Math.max(0, run.stepBudget - run.callCount),
            openedTabs: run.openedTabs,
            remainingTabBudget: Math.max(0, this.maxNewTabs - run.openedTabs),
            consecutiveToolFailures: run.consecutiveToolFailures,
            lastToolName: run.lastToolName || null,
            lastToolOk: typeof run.lastToolOk === 'boolean' ? run.lastToolOk : null,
            lastToolError: run.lastToolError || null,
            lastMarketplaceCandidateCount: run.lastMarketplaceCandidateCount || 0,
            lastPlausibleMarketplaceCandidateCount: run.lastPlausibleMarketplaceCandidateCount || 0,
            lastUnderBudgetMarketplaceCandidateCount: run.lastUnderBudgetMarketplaceCandidateCount || 0,
            topMarketplaceCandidates: Array.isArray(run.topMarketplaceCandidates) ? run.topMarketplaceCandidates.slice(0, 5) : [],
            touchedTabs: Array.isArray(run.touchedTabs) ? run.touchedTabs.slice(0, 5) : []
        };
    }

    recordTouchedTabs(run, toolResult) {
        const candidates = [];
        if (toolResult?.tab) {
            candidates.push(toolResult.tab);
        }
        if (Array.isArray(toolResult?.tabs)) {
            candidates.push(...toolResult.tabs);
        }
        if (toolResult?.closedTabId) {
            candidates.push({ id: toolResult.closedTabId, title: String(toolResult.closedTabId), url: '', closed: true });
        }

        const normalized = candidates.map((tab) => normalizeTouchedTab(tab)).filter(Boolean);
        if (!normalized.length) {
            return run.touchedTabs;
        }

        const next = Array.isArray(run.touchedTabs) ? run.touchedTabs.slice() : [];
        for (const tab of normalized) {
            const existingIndex = next.findIndex((entry) => entry.id === tab.id);
            if (existingIndex >= 0) {
                next.splice(existingIndex, 1);
            }
            next.unshift(tab);
        }
        run.touchedTabs = next.slice(0, 8);
        return run.touchedTabs;
    }

    countPlausibleMarketplaceListingItems(items = []) {
        return summarizeMarketplaceCandidates(items, {}).plausibleCount;
    }

    updateRuntimeSignals(run, toolName, toolResult) {
        run.lastToolName = toolName || null;
        run.lastToolOk = !!toolResult?.ok;
        run.lastToolError = toolResult?.ok ? null : (toolResult?.error || 'Unknown error');

        if (!toolResult?.ok) {
            run.consecutiveToolFailures += 1;
            return;
        }

        run.consecutiveToolFailures = 0;
        if (run.taskProfile.kind === 'shopping' && toolName === 'extract_search_results' && Array.isArray(toolResult?.items)) {
            const summary = summarizeMarketplaceCandidates(toolResult.items, run.taskProfile);
            run.lastMarketplaceCandidateCount = toolResult.items.length;
            run.lastPlausibleMarketplaceCandidateCount = summary.plausibleCount;
            run.lastUnderBudgetMarketplaceCandidateCount = summary.underBudgetCount;
            run.topMarketplaceCandidates = summary.topCandidates;
        }
    }

    async executeTool(toolName, toolArgs, run) {
        switch (toolName) {
            case 'list_tabs':
                return { ok: true, tabs: this.browser.listTabs().filter((tab) => !tab.internal) };
            case 'open_tab': {
                const result = await this.browser.openTab(toolArgs || {});
                if (result?.ok) {
                    run.openedTabs += 1;
                }
                return result;
            }
            case 'focus_tab':
                return this.browser.focusTab(toolArgs || {});
            case 'close_tab':
                return this.browser.closeTab(toolArgs || {});
            case 'navigate_tab':
                return this.browser.navigateTab(toolArgs || {});
            case 'get_tab_info':
                return this.browser.getTabInfo(toolArgs || {});
            case 'get_active_tab':
                return this.browser.getActiveTabInfo();
            case 'wait_for_load':
                return this.browser.waitForLoad(toolArgs?.tabId, toolArgs?.timeoutMs);
            case 'read_page_text':
                return this.browser.readPageText(toolArgs || {});
            case 'query_selector_all':
                return this.browser.querySelectorAll(toolArgs || {});
            case 'click_element':
                return this.browser.clickElement(toolArgs || {});
            case 'type_into':
                return this.browser.typeInto(toolArgs || {});
            case 'scroll_page':
                return this.browser.scrollPage(toolArgs || {});
            case 'search_site':
                return this.browser.searchSite(toolArgs || {});
            case 'extract_search_results':
                return this.browser.extractSearchResults(toolArgs || {});
            default:
                return { ok: false, error: `Unsupported tool: ${toolName}` };
        }
    }

    async handleContinuation(run) {
        const question = createContinuationQuestion(this.maxToolCalls);
        const answer = await this.io.ask(question);

        if (isNegativeContinuationReply(answer)) {
            return {
                continued: false,
                final: {
                    type: 'final',
                    message: 'Stopped here. Ask me again when you want to continue.',
                    results: []
                }
            };
        }

        if (!isAffirmativeContinuationReply(answer)) {
            return {
                continued: false,
                final: {
                    type: 'clarify',
                    question
                }
            };
        }

        run.stepBudget += this.maxToolCalls;
        run.messages.push({ role: 'assistant', content: question });
        run.messages.push({ role: 'user', content: answer });
        run.prompt = `${run.rootPrompt}\n\nContinuation approval: ${answer}\nContinue the same task from the current browser state and prior conversation.`;
        return { continued: true };
    }

    async run(initialPrompt) {
        const prompt = String(initialPrompt || '').trim();
        if (!prompt) {
            throw new Error('An initial prompt is required.');
        }

        const run = {
            rootPrompt: prompt,
            prompt,
            messages: [{ role: 'user', content: prompt }],
            startedAt: Date.now(),
            callCount: 0,
            stepBudget: this.maxToolCalls,
            openedTabs: 0,
            consecutiveToolFailures: 0,
            lastToolName: null,
            lastToolOk: null,
            lastToolError: null,
            lastMarketplaceCandidateCount: 0,
            lastPlausibleMarketplaceCandidateCount: 0,
            lastUnderBudgetMarketplaceCandidateCount: 0,
            topMarketplaceCandidates: [],
            touchedTabs: [],
            taskProfile: deriveTaskProfile(prompt)
        };

        await this.io.info('Assistant task started.');

        while (true) {
            if (Date.now() - run.startedAt > this.maxDurationMs) {
                return {
                    type: 'final',
                    message: 'Run time limit reached before the task could be completed.',
                    results: []
                };
            }

            if (run.callCount >= run.stepBudget) {
                const continuation = await this.handleContinuation(run);
                if (!continuation.continued) {
                    return continuation.final;
                }
            }

            await this.browser.refreshTargets();
            const action = await this.planner({
                prompt: run.prompt,
                messages: run.messages.slice(-MAX_CONTEXT_MESSAGES),
                browserState: this.buildBrowserState(),
                taskProfile: run.taskProfile,
                runtimeState: this.buildRuntimeState(run),
                limits: {
                    maxToolCalls: this.maxToolCalls,
                    maxNewTabs: this.maxNewTabs,
                    maxDurationMs: this.maxDurationMs
                },
                timeoutMs: Math.max(1000, this.maxDurationMs - (Date.now() - run.startedAt))
            });

            if (!action || typeof action !== 'object') {
                throw new Error('Planner returned an invalid response.');
            }

            if (action.type === 'final') {
                if (action.message) {
                    await this.io.assistant(action.message, { results: Array.isArray(action.results) ? action.results : [] });
                }
                return action;
            }

            if (action.type === 'clarify') {
                const question = String(action.question || action.message || '').trim();
                if (!question) {
                    throw new Error('Planner returned a clarification without a question.');
                }

                await this.io.assistant(question);
                run.messages.push({ role: 'assistant', content: question });
                const answer = await this.io.ask(question);
                run.messages.push({ role: 'user', content: answer });
                run.prompt = `${run.rootPrompt}\n\nClarification answer: ${answer}`;
                continue;
            }

            if (action.type !== 'tool_call') {
                throw new Error(`Unsupported planner action type: ${action.type}`);
            }

            if (action.message) {
                await this.io.assistant(String(action.message).trim());
            }

            const toolName = action.tool;
            const toolArgs = action.arguments || action.args || {};
            await this.io.info(`Running tool: ${toolName}`);
            const toolResult = await this.executeTool(toolName, toolArgs, run);
            this.recordTouchedTabs(run, toolResult);
            this.updateRuntimeSignals(run, toolName, toolResult);
            run.messages.push({
                role: 'tool',
                name: toolName,
                content: this.truncateObservation(toolResult)
            });

            if (toolResult?.ok) {
                await this.io.info(`Tool ${toolName} finished.`);
            } else {
                await this.io.warn(`Tool ${toolName} failed: ${toolResult?.error || 'Unknown error'}`);
            }

            run.callCount += 1;
        }
    }
}

module.exports = {
    StandaloneBrowserAgent,
    deriveTaskProfile,
    isAffirmativeContinuationReply,
    isNegativeContinuationReply,
    createContinuationQuestion,
    parseBudgetMax,
    parsePriceValue,
    DEFAULT_MAX_TOOL_CALLS,
    DEFAULT_MAX_NEW_TABS,
    DEFAULT_MAX_DURATION_MS
};
