import BrowserTools from './browser-tools.js';

const MAX_TOOL_CALLS = 50;
const MAX_NEW_TABS = 5;
const MAX_DURATION_MS = 600000;
const MAX_CONTEXT_MESSAGES = 16;
const MAX_PLANNER_CONTEXT_MESSAGES = 8;
const MAX_OBSERVATION_CHARS = 6000;
const MAX_PLANNER_TABS = 8;
const MAX_PLANNER_CANDIDATES = 5;
const MAX_REPEATED_TOOL_CALLS = 2;
const AGENT_BROWSER_PARTITION = 'persist:assistant-agent';
const TRACKING_RESEARCH_QUERY_PARAMS = new Set([
    'gclid',
    'dclid',
    'fbclid',
    'msclkid',
    'wbraid',
    'gbraid',
    'igshid',
    'mc_cid',
    'mc_eid'
]);

function createPlannerRequestId(sessionId) {
    const suffix = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

    return `${sessionId || 'assistant-session'}:${suffix}`;
}

function isAffirmativeContinuationReply(value) {
    return /\b(yes|yep|yeah|continue|go on|proceed|more|keep going|carry on|sure|ok|okay)\b/i.test(String(value || ''));
}

function isNegativeContinuationReply(value) {
    return /\b(no|nope|nah|stop|cancel|done|enough|finish|end|quit)\b/i.test(String(value || ''));
}

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

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map((item) => stableStringify(item)).join(',')}]`;
    }

    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

class AssistantController {
    constructor(tabManager, browserActionCoordinator = null) {
        this.tabManager = tabManager;
        this.browserTools = new BrowserTools(tabManager);
        this.browserActionCoordinator = browserActionCoordinator;
        this.openCodeHasBrowserControl = false;
        this.runs = new Map();

        this.handleWebviewMessage = this.handleWebviewMessage.bind(this);
        this.handleTabClosed = this.handleTabClosed.bind(this);

        window.addEventListener('webview-ipc-message', this.handleWebviewMessage);
        window.addEventListener('tab-closed', this.handleTabClosed);
    }

    setOpenCodeBrowserControlActive(active) {
        this.openCodeHasBrowserControl = !!active;
        if (active) {
            this.browserActionCoordinator?.setExclusiveOwner('opencode');
            for (const tabId of [...this.runs.keys()]) {
                this.stopRun(tabId);
            }
        } else {
            this.browserActionCoordinator?.clearExclusiveOwner('opencode');
        }
    }

    openWorkspace() {
        const existing = this.tabManager.tabs.find((tab) => tab.role === 'assistant');
        if (existing) {
            this.tabManager.switchToTab(existing.id);
            return existing.id;
        }

        return this.tabManager.createTab('browser://assistant', {
            title: 'AI Workspace',
            role: 'assistant',
            assistantOwned: false
        });
    }

    handleTabClosed(event) {
        const tabId = event?.detail?.tabId;
        if (!tabId) {
            return;
        }

        const run = this.runs.get(tabId);
        if (run) {
            run.aborted = true;
            this.runs.delete(tabId);
        }
    }

    handleWebviewMessage(event) {
        const detail = event?.detail || {};
        const { tabId, channel, args } = detail;
        if (!tabId || !channel) {
            return;
        }

        const tab = this.tabManager.getTabById(tabId);
        if (!tab || tab.role !== 'assistant') {
            return;
        }

        const payload = Array.isArray(args) && args.length > 0 ? args[0] : null;

        if (channel === 'assistant-user-message') {
            this.startRun(tab, payload).catch((error) => {
                this.sendToWorkspace(tab, 'assistant-task-failed', {
                    sessionId: payload?.sessionId,
                    status: 'failed',
                    message: error.message || String(error)
                });
            });
        } else if (channel === 'assistant-stop-task') {
            this.stopRun(tab.id);
        }
    }

    stopRun(tabId) {
        const run = this.runs.get(tabId);
        if (!run) {
            return;
        }

        const requestId = run.activePlannerRequestId;
        run.aborted = true;

        if (requestId && window.electronAPI && typeof window.electronAPI.send === 'function') {
            window.electronAPI.send('assistant-abort-next-action', {
                requestId,
                sessionId: run.sessionId
            });
        }

        this.runs.delete(tabId);

        const tab = this.tabManager.getTabById(tabId);
        if (tab) {
            this.sendToWorkspace(tab, 'assistant-status', {
                sessionId: run.sessionId,
                status: 'idle',
                message: 'Task stopped.'
            });
            this.sendToWorkspace(tab, 'assistant-task-finished', {
                sessionId: run.sessionId,
                message: 'Task stopped.'
            });
        }
    }

    sendToWorkspace(tab, channel, payload) {
        this.writeRuntimeLog(channel, payload);

        if (!tab?.webview || typeof tab.webview.send !== 'function') {
            console.warn(`[AssistantController] Could not send ${channel}; workspace webview is unavailable.`);
            return;
        }

        try {
            tab.webview.send(channel, payload);
        } catch (error) {
            const message = error?.message || String(error);
            console.warn(`[AssistantController] Could not send ${channel}; workspace webview is not ready yet: ${message}`);
        }
    }

    writeRuntimeLog(channel, payload) {
        if (!channel || !channel.startsWith('assistant-')) {
            return;
        }

        if (!window.electronAPI || typeof window.electronAPI.send !== 'function') {
            return;
        }

        try {
            window.electronAPI.send('assistant-runtime-log', {
                channel,
                payload
            });
        } catch (error) {
            console.warn(`[AssistantController] Could not mirror runtime event ${channel}: ${error?.message || error}`);
        }
    }

    log(tab, sessionId, message, level = 'info', meta = {}) {
        this.sendToWorkspace(tab, 'assistant-log', {
            sessionId,
            message,
            level,
            meta
        });
    }

    progress(tab, sessionId, message, level = 'info', meta = {}) {
        this.sendToWorkspace(tab, 'assistant-progress', {
            sessionId,
            message,
            level,
            meta
        });
    }

    buildBrowserState() {
        return {
            activeTab: this.browserTools.getActiveTab(),
            tabs: this.browserTools.listTabs()
        };
    }

    compactPlannerTab(tab) {
        if (!tab || typeof tab !== 'object') {
            return null;
        }

        return {
            id: tab.id,
            title: tab.title || '',
            url: tab.url || tab.loadUrl || '',
            role: tab.role || 'regular',
            active: !!tab.active,
            assistantOwned: !!tab.assistantOwned,
            hidden: !!tab.hidden,
            loading: !!tab.loading
        };
    }

    buildPlannerBrowserState(run) {
        const fullState = this.buildBrowserState();
        const relevantTabs = [];
        const seenIds = new Set();
        const addTab = (tab) => {
            const compact = this.compactPlannerTab(tab);
            if (!compact?.id || seenIds.has(compact.id)) {
                return;
            }
            seenIds.add(compact.id);
            relevantTabs.push(compact);
        };

        addTab(fullState.activeTab);

        if (Array.isArray(run?.touchedTabs)) {
            for (const touchedTab of run.touchedTabs) {
                const liveTab = touchedTab?.id ? this.browserTools.getTabInfo(touchedTab.id) : null;
                addTab(liveTab?.ok === false ? touchedTab : liveTab || touchedTab);
            }
        }

        for (const tab of fullState.tabs || []) {
            if (tab?.assistantOwned || tab?.active) {
                addTab(tab);
            }
        }

        for (const tab of fullState.tabs || []) {
            if (relevantTabs.length >= MAX_PLANNER_TABS) {
                break;
            }
            addTab(tab);
        }

        return {
            activeTab: this.compactPlannerTab(fullState.activeTab),
            tabs: relevantTabs.slice(0, MAX_PLANNER_TABS),
            totalTabCount: Array.isArray(fullState.tabs) ? fullState.tabs.length : 0,
            omittedTabCount: Math.max(0, (Array.isArray(fullState.tabs) ? fullState.tabs.length : 0) - relevantTabs.length)
        };
    }

    deriveTaskProfile(prompt) {
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

    isLikelyMarketplaceListingUrl(url) {
        if (typeof url !== 'string' || !url.trim()) {
            return false;
        }

        try {
            const parsed = new URL(url);
            const pathname = (parsed.pathname || '').toLowerCase();
            if (/\/itm\/|\/p\//i.test(pathname)) {
                return true;
            }

            if (/\/dp\/|\/gp\/aw\/d\//i.test(pathname)) {
                return true;
            }

            return false;
        } catch {
            const normalized = url.toLowerCase();
            return /\/itm\/|\/p\//i.test(normalized) || /\/dp\/|\/gp\/aw\/d\//i.test(normalized);
        }
    }

    normalizeMarketplaceListingUrl(url) {
        if (typeof url !== 'string' || !url.trim()) {
            return null;
        }

        try {
            const parsed = new URL(url);
            const hostname = (parsed.hostname || '').toLowerCase().replace(/^www\./, '');
            const pathname = (parsed.pathname || '').replace(/\/+$/, '').toLowerCase();
            if (!pathname) {
                return null;
            }

            return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ''}${pathname}`;
        } catch {
            const normalized = url.trim().toLowerCase();
            if (!normalized) {
                return null;
            }

            return normalized.split('#')[0].split('?')[0].replace(/\/+$/, '');
        }
    }

    normalizeResearchSourcePathname(pathname) {
        const normalized = String(pathname || '').trim().toLowerCase().replace(/\/+$/, '');
        return normalized || '/';
    }

    isTrackingResearchQueryParam(paramName) {
        if (typeof paramName !== 'string' || !paramName.trim()) {
            return false;
        }

        const normalized = paramName.trim().toLowerCase();
        if (normalized.startsWith('utm_')) {
            return true;
        }

        return TRACKING_RESEARCH_QUERY_PARAMS.has(normalized);
    }

    normalizeResearchSourceQueryParams(searchParams) {
        if (!searchParams) {
            return '';
        }

        const entries = [];
        for (const [key, value] of searchParams.entries()) {
            if (this.isTrackingResearchQueryParam(key)) {
                continue;
            }

            entries.push([key, value]);
        }

        if (!entries.length) {
            return '';
        }

        entries.sort(([aKey, aValue], [bKey, bValue]) => {
            const keyCompare = aKey.toLowerCase().localeCompare(bKey.toLowerCase());
            if (keyCompare !== 0) {
                return keyCompare;
            }

            return String(aValue).localeCompare(String(bValue));
        });

        return new URLSearchParams(entries).toString();
    }

    normalizeResearchSourceQueryString(queryString) {
        if (typeof queryString !== 'string' || !queryString.trim()) {
            return '';
        }

        return this.normalizeResearchSourceQueryParams(new URLSearchParams(queryString));
    }

    normalizeResearchSourcePageUrl(url) {
        if (typeof url !== 'string' || !url.trim()) {
            return null;
        }

        try {
            const parsed = new URL(url);
            const hostname = (parsed.hostname || '').toLowerCase().replace(/^www\./, '');
            const pathname = this.normalizeResearchSourcePathname(parsed.pathname);
            const search = this.normalizeResearchSourceQueryParams(parsed.searchParams);
            return `${parsed.protocol}//${hostname}${parsed.port ? `:${parsed.port}` : ''}${pathname}${search ? `?${search}` : ''}`;
        } catch {
            const normalized = url.trim().toLowerCase();
            if (!normalized) {
                return null;
            }

            const [withoutHash] = normalized.split('#');
            const [rawPath = '', rawQuery = ''] = withoutHash.split('?');
            const pathname = this.normalizeResearchSourcePathname(rawPath);
            const search = this.normalizeResearchSourceQueryString(rawQuery);
            return `${pathname}${search ? `?${search}` : ''}`;
        }
    }

    isLikelySearchResultsPage(url) {
        if (typeof url !== 'string' || !url.trim()) {
            return false;
        }

        const normalized = url.trim().toLowerCase();
        const host = (() => {
            try {
                return new URL(normalized).hostname.toLowerCase();
            } catch {
                return '';
            }
        })();

        const searchHosts = [
            'google.',
            'bing.com',
            'duckduckgo.com',
            'yahoo.com',
            'startpage.com',
            'ecosia.org',
            'search.brave.com',
            'baidu.com',
            'yandex.',
            'kagi.com'
        ];

        if (searchHosts.some((fragment) => host.includes(fragment))) {
            return true;
        }

        if (/\/search\b|\/results\b|\/sch\/i\.html\b|\/maps\b/.test(normalized)) {
            return true;
        }

        if (/[?&](q|query|search|keyword|keywords|_nkw)=/.test(normalized)) {
            return true;
        }

        return false;
    }

    getMarketplaceListingTabKey(tab) {
        if (!tab || typeof tab !== 'object') {
            return null;
        }

        return this.normalizeMarketplaceListingUrl(tab.url || tab.loadUrl || '');
    }

    isMarketplaceListingTab(tab) {
        if (!tab || typeof tab !== 'object') {
            return false;
        }

        return this.isLikelyMarketplaceListingUrl(tab.url || tab.loadUrl);
    }

    markMarketplaceListingTabsOpened(run, tabs = []) {
        if (!run || !Array.isArray(tabs) || !tabs.length) {
            return [];
        }

        const current = Array.isArray(run.touchedTabs) ? run.touchedTabs.slice() : [];
        const openedTabs = [];

        for (const tab of tabs) {
            if (!this.isMarketplaceListingTab(tab)) {
                continue;
            }

            const key = this.getMarketplaceListingTabKey(tab);
            if (!key) {
                continue;
            }

            if (!run.marketplaceListingKeysOpened) {
                run.marketplaceListingKeysOpened = new Set();
            }

            if (run.marketplaceListingKeysOpened.has(key)) {
                continue;
            }

            run.marketplaceListingKeysOpened.add(key);
            run.marketplaceListingTabsOpened = run.marketplaceListingKeysOpened.size;
            openedTabs.push(tab);

            const normalized = this.normalizeTouchedTab(tab);
            if (normalized) {
                const index = current.findIndex((entry) => entry.id === normalized.id);
                if (index >= 0) {
                    current.splice(index, 1);
                }
                current.unshift(normalized);
            }
        }

        run.touchedTabs = current.slice(0, 8);
        return openedTabs;
    }

    markMarketplaceListingTabInspected(run, tab) {
        if (!run || !this.isMarketplaceListingTab(tab)) {
            return false;
        }

        const key = this.getMarketplaceListingTabKey(tab);
        if (!key) {
            return false;
        }

        if (!run.marketplaceListingKeysInspected) {
            run.marketplaceListingKeysInspected = new Set();
        }

        const wasNew = !run.marketplaceListingKeysInspected.has(key);
        if (wasNew) {
            run.marketplaceListingKeysInspected.add(key);
        }

        return wasNew;
    }

    markResearchSourcePageInspected(run, tab) {
        if (!run || !tab || !run.taskProfile || (run.taskProfile.kind !== 'local_search' && run.taskProfile.kind !== 'recommendation')) {
            return false;
        }

        const pageUrl = tab.url || tab.loadUrl || '';
        if (!pageUrl) {
            return false;
        }

        if (this.isLikelySearchResultsPage(pageUrl)) {
            return false;
        }

        const key = this.normalizeResearchSourcePageUrl(pageUrl);
        if (!key) {
            return false;
        }

        if (!run.researchSourcePageKeysInspected) {
            run.researchSourcePageKeysInspected = new Set();
        }

        const wasNew = !run.researchSourcePageKeysInspected.has(key);
        if (wasNew) {
            run.researchSourcePageKeysInspected.add(key);
        }

        return wasNew;
    }

    isLikelyMarketplaceCategoryText(value) {
        const normalized = String(value || '').trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        return /\b(rubriek|categorie|category|shop by category|filters?|objectstaat|sport en vrije tijd|fietsen en wielersport|fietsaccessoires|fietsonderdelen)\b/.test(normalized);
    }

    isPlausibleMarketplaceListingItem(item) {
        if (!item || typeof item !== 'object') {
            return false;
        }

        if (!this.isLikelyMarketplaceListingUrl(item.href)) {
            return false;
        }

        if (!item.price || typeof item.price !== 'string') {
            return false;
        }

        const title = String(item.title || '').trim();
        if (!title || title.length < 6) {
            return false;
        }

        if (this.isLikelyMarketplaceCategoryText(title) || this.isLikelyMarketplaceCategoryText(item.snippet)) {
            return false;
        }

        return true;
    }

    countPlausibleMarketplaceListingItems(items = []) {
        if (!Array.isArray(items)) {
            return 0;
        }

        return items.filter((item) => this.isPlausibleMarketplaceListingItem(item)).length;
    }

    summarizeMarketplaceCandidates(items = [], taskProfile = {}) {
        if (!Array.isArray(items) || !items.length) {
            return {
                plausibleCount: 0,
                underBudgetCount: 0,
                topCandidates: []
            };
        }

        const budgetMax = Number.isFinite(taskProfile?.budgetMax) ? taskProfile.budgetMax : null;
        const plausible = items
            .filter((item) => this.isPlausibleMarketplaceListingItem(item))
            .map((item) => {
                const priceValue = parsePriceValue(item.price);
                const underBudget = Number.isFinite(priceValue) && Number.isFinite(budgetMax)
                    ? priceValue <= budgetMax
                    : null;

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

    updateRuntimeSignals(run, toolName, toolResult) {
        if (!run) {
            return;
        }

        run.lastToolName = toolName || null;
        run.lastToolOk = !!toolResult?.ok;
        run.lastToolError = toolResult?.ok ? null : (toolResult?.error || 'Unknown error');

        if (!toolResult?.ok) {
            const failures = (run.consecutiveToolFailures || 0) + 1;
            run.consecutiveToolFailures = failures;
            return;
        }

        run.consecutiveToolFailures = 0;

        if (
            run.taskProfile?.kind === 'shopping' &&
            ((toolName === 'extract_search_results' && Array.isArray(toolResult?.items)) ||
                (toolName === 'search_site' && Array.isArray(toolResult?.extractedResults?.items)))
        ) {
            const items = Array.isArray(toolResult?.items)
                ? toolResult.items
                : toolResult.extractedResults.items;
            run.lastMarketplaceCandidateCount = items.length;
            const summary = this.summarizeMarketplaceCandidates(items, run.taskProfile);
            run.lastPlausibleMarketplaceCandidateCount = summary.plausibleCount;
            run.lastUnderBudgetMarketplaceCandidateCount = summary.underBudgetCount;
            run.topMarketplaceCandidates = summary.topCandidates;
        }
    }

    buildRuntimeState(run) {
        if (!run) {
            return {};
        }

        return {
            toolCallsUsed: run.callCount || 0,
            toolCallsRemaining: Math.max(0, MAX_TOOL_CALLS - (run.callCount || 0)),
            openedTabs: run.openedTabs || 0,
            remainingTabBudget: Math.max(0, MAX_NEW_TABS - (run.openedTabs || 0)),
            consecutiveToolFailures: run.consecutiveToolFailures || 0,
            lastToolName: run.lastToolName || null,
            lastToolOk: typeof run.lastToolOk === 'boolean' ? run.lastToolOk : null,
            lastToolError: run.lastToolError || null,
            lastMarketplaceCandidateCount: run.lastMarketplaceCandidateCount || 0,
            lastPlausibleMarketplaceCandidateCount: run.lastPlausibleMarketplaceCandidateCount || 0,
            lastUnderBudgetMarketplaceCandidateCount: run.lastUnderBudgetMarketplaceCandidateCount || 0,
            topMarketplaceCandidates: Array.isArray(run.topMarketplaceCandidates) ? run.topMarketplaceCandidates.slice(0, MAX_PLANNER_CANDIDATES) : [],
            marketplaceListingPagesOpened: run.marketplaceListingKeysOpened?.size || 0,
            marketplaceListingPagesInspected: run.marketplaceListingKeysInspected?.size || 0,
            inspectedSourcePages: run.researchSourcePageKeysInspected?.size || 0,
            touchedTabs: Array.isArray(run.touchedTabs) ? run.touchedTabs.slice(0, 5) : []
        };
    }

    getToolCallSignature(toolName, toolArgs = {}) {
        return `${toolName || 'unknown'}:${stableStringify(toolArgs || {})}`;
    }

    recordToolCallSignature(run, toolName, toolArgs = {}) {
        if (!run) {
            return 1;
        }

        const signature = this.getToolCallSignature(toolName, toolArgs);
        if (run.lastToolCallSignature === signature) {
            run.repeatedToolCallCount = (run.repeatedToolCallCount || 1) + 1;
        } else {
            run.lastToolCallSignature = signature;
            run.repeatedToolCallCount = 1;
        }

        return run.repeatedToolCallCount;
    }

    findMostRelevantReadableTab(run) {
        const touchedTabs = Array.isArray(run?.touchedTabs) ? run.touchedTabs : [];
        for (const touchedTab of touchedTabs) {
            if (!touchedTab?.id || touchedTab.closed || touchedTab.internal) {
                continue;
            }

            const liveTab = this.browserTools.getTabInfo(touchedTab.id);
            const candidate = liveTab?.ok === false ? touchedTab : liveTab || touchedTab;
            if (candidate?.id && !candidate.closed && !candidate.internal) {
                return candidate;
            }
        }

        const plannerState = this.buildPlannerBrowserState(run);
        return (plannerState.tabs || []).find((candidate) => candidate?.id && !candidate.closed && !candidate.internal) || null;
    }

    async maybeBreakRepeatedToolLoop(tab, run, toolName, toolArgs) {
        const repeatCount = this.recordToolCallSignature(run, toolName, toolArgs);
        if (repeatCount <= MAX_REPEATED_TOOL_CALLS) {
            return null;
        }

        if (toolName === 'list_tabs') {
            const targetTab = this.findMostRelevantReadableTab(run);
            if (targetTab?.id) {
                const message = `Repeated list_tabs detected. Reading ${targetTab.id} instead so the agent can continue from observed page content.`;
                this.log(tab, run.sessionId, message, 'warn', { repeatedToolCallCount: repeatCount, targetTab });
                this.progress(tab, run.sessionId, message, 'warn', { targetTab });
                return {
                    toolName: 'read_page_text',
                    toolArgs: {
                        tabId: targetTab.id,
                        maxChars: 6000
                    },
                    forced: true,
                    reason: 'repeated_list_tabs'
                };
            }
        }

        const message = `Repeated ${toolName} call detected. Planner should choose a different tool, ask a question, or finalize with evidence.`;
        this.log(tab, run.sessionId, message, 'warn', { toolArgs, repeatedToolCallCount: repeatCount });
        run.messages.push({
            role: 'tool',
            name: 'loop_guard',
            content: JSON.stringify({
                ok: false,
                error: message,
                repeatedToolCallCount: repeatCount,
                previousTool: toolName,
                previousArguments: toolArgs
            })
        });
        return { skipExecution: true };
    }

    async maybeAutoOpenMarketplaceListings(run, result) {
        if (!run || run.taskProfile.kind !== 'shopping' || !Array.isArray(result?.items)) {
            return [];
        }

        const remainingNeeded = Math.max(0, 2 - (run.marketplaceListingTabsOpened || 0));
        if (remainingNeeded === 0) {
            return [];
        }

        const candidateItems = [];
        const seenKeys = new Set();
        const openedKeys = run.marketplaceListingKeysOpened || new Set();

        for (const item of result.items) {
            if (!this.isPlausibleMarketplaceListingItem(item)) {
                continue;
            }

            const key = this.normalizeMarketplaceListingUrl(item.href);
            if (!key || seenKeys.has(key) || openedKeys.has(key)) {
                continue;
            }

            seenKeys.add(key);
            candidateItems.push({ item, key, price: item.price || null });
            if (candidateItems.length >= remainingNeeded) {
                break;
            }
        }

        if (!candidateItems.length) {
            return [];
        }

        const openedTabs = [];
        const openedCandidates = [];
        for (let index = 0; index < candidateItems.length; index += 1) {
            if (run.openedTabs >= MAX_NEW_TABS) {
                break;
            }

            const { item, key } = candidateItems[index];
            const openResult = this.browserTools.openTab({
                url: item.href,
                activate: false,
                title: item.title || 'Listing',
                assistantOwned: true,
                role: 'browser',
                hidden: true,
                partition: AGENT_BROWSER_PARTITION,
                trackHistory: false
            });

            if (openResult?.ok === false) {
                continue;
            }

            if (openResult?.id) {
                run.openedTabs += 1;
            }

            const openedTab = openResult?.tab || this.browserTools.getTab(openResult?.id);
            if (openedTab) {
                openedTabs.push(openedTab);
                this.markMarketplaceListingTabsOpened(run, [openedTab]);

                await this.browserTools.waitForLoad({
                    tabId: openedTab.id,
                    timeoutMs: 12000,
                    settleMs: 250,
                    requireNavigation: false
                });

                const inspection = await this.browserTools.readPageText({
                    tabId: openedTab.id,
                    maxChars: 3000
                });
                if (inspection?.ok) {
                    this.markMarketplaceListingTabInspected(run, inspection.tab || openedTab);
                    openedCandidates.push({
                        id: openedTab.id,
                        title: openedTab.title || openedTab.url || openedTab.id,
                        url: openedTab.url || openedTab.loadUrl || '',
                        price: candidateItems[index]?.price || null,
                        summary: this.truncateObservation(inspection.text || '').slice(0, 400)
                    });
                }
            }
        }

        if (openedTabs.length) {
            this.recordTouchedTabs(run, { tabs: openedTabs });
            if (openedCandidates.length) {
                result.openedCandidateTabs = openedCandidates;
            }
            const workspaceTab = this.tabManager.getTabById(run.tabId);
            this.progress(
                workspaceTab,
                run.sessionId,
                'Opened and inspected candidate listing tabs. Compare them before finalizing.',
                'info',
                { touchedTabs: openedTabs }
            );
        }

        return openedTabs;
    }

    truncateObservation(value) {
        const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
        if (text.length <= MAX_OBSERVATION_CHARS) {
            return text;
        }
        return `${text.slice(0, MAX_OBSERVATION_CHARS)}\n[truncated]`;
    }

    normalizeTouchedTab(tab) {
        if (typeof tab === 'string') {
            const id = tab.trim();
            return id ? { id, title: id, url: '', closed: false } : null;
        }

        if (!tab || typeof tab !== 'object' || !tab.id) {
            return null;
        }

        return {
            id: String(tab.id),
            title: tab.title || tab.url || tab.loadUrl || String(tab.id),
            url: tab.url || tab.loadUrl || '',
            role: tab.role || 'regular',
            active: !!tab.active,
            assistantOwned: !!tab.assistantOwned,
            internal: !!tab.internal,
            closed: !!tab.closed
        };
    }

    recordTouchedTabs(run, toolResult) {
        if (!run || !toolResult || typeof toolResult !== 'object') {
            return [];
        }

        const candidateTabs = [];
        if (toolResult.tab) {
            candidateTabs.push(toolResult.tab);
        }
        if (Array.isArray(toolResult.tabs)) {
            candidateTabs.push(...toolResult.tabs);
        }
        if (toolResult.closedTabId) {
            candidateTabs.push({ id: toolResult.closedTabId, title: `${toolResult.closedTabId}`, url: '', closed: true });
        }

        const normalizedTabs = candidateTabs.map((tab) => this.normalizeTouchedTab(tab)).filter(Boolean);
        if (!normalizedTabs.length) {
            return Array.isArray(run.touchedTabs) ? run.touchedTabs : [];
        }

        const current = Array.isArray(run.touchedTabs) ? run.touchedTabs.slice() : [];
        for (const tab of normalizedTabs) {
            const index = current.findIndex((entry) => entry.id === tab.id);
            if (index >= 0) {
                current.splice(index, 1);
            }
            current.unshift(tab);
        }

        run.touchedTabs = current.slice(0, 8);
        return run.touchedTabs;
    }

    countDistinctTouchedTabs(run) {
        if (!run || !Array.isArray(run.touchedTabs)) {
            return 0;
        }

        const uniqueIds = new Set();
        for (const tab of run.touchedTabs) {
            if (!tab || tab.internal || !tab.id) {
                continue;
            }
            uniqueIds.add(tab.id);
        }

        return uniqueIds.size;
    }

    countDistinctInspectedSourcePages(run) {
        if (!run || !run.researchSourcePageKeysInspected) {
            return 0;
        }

        return run.researchSourcePageKeysInspected.size;
    }

    getComparisonHint(run) {
        if (!run || !run.taskProfile) {
            return null;
        }

        if (run.taskProfile.kind === 'shopping') {
            if (
                run.lastMarketplaceCandidateCount >= 2 &&
                (run.marketplaceListingKeysOpened.size < 2 || run.marketplaceListingKeysInspected.size < 2)
            ) {
                return 'Open and inspect at least 2 candidate listing pages before finalizing this shopping task.';
            }
            return null;
        }

        if (run.taskProfile.kind === 'local_search' || run.taskProfile.kind === 'recommendation') {
            if (this.countDistinctInspectedSourcePages(run) < 2) {
                return 'Open and inspect at least 2 distinct source pages before finalizing this research task.';
            }
        }

        return null;
    }

    looksSensitive(toolName, args = {}) {
        if (toolName !== 'type_into') {
            return false;
        }

        const haystack = [
            args.selector,
            args.text
        ].filter(Boolean).join(' ').toLowerCase();

        return /password|passcode|otp|one-time|verification|cvv|card|credit|debit|iban|ssn|social security|pin|secret|token|bank/.test(haystack);
    }

    createContinuationClarification(run, questionOverride = null) {
        return {
            question: questionOverride || `I have used ${MAX_TOOL_CALLS} browser steps. Reply "continue" to allow ${MAX_TOOL_CALLS} more, or "stop" to finish here.`,
            reason: 'continue_run',
            missingInfo: ['continue_confirmation'],
            originalPrompt: run?.rootPrompt || run?.prompt || '',
            createdAt: Date.now(),
            toolCallsUsed: run?.callCount || 0
        };
    }

    async startRun(tab, payload) {
        const sessionId = payload?.sessionId || `assistant-session-${Date.now()}`;
        const prompt = String(payload?.prompt || '').trim();
        const session = payload?.session || {};
        const clarificationContext = payload?.clarificationContext || session.pendingClarification || null;
        const rootPrompt = clarificationContext?.originalPrompt
            ? String(clarificationContext.originalPrompt).trim()
            : prompt;
        let planningPrompt = clarificationContext?.originalPrompt && rootPrompt
            ? `${rootPrompt}\n\nClarification answer: ${prompt}`
            : prompt;

        if (this.openCodeHasBrowserControl) {
            this.sendToWorkspace(tab, 'assistant-task-failed', {
                sessionId,
                status: 'failed',
                message: 'OpenCode currently has exclusive browser control. Stop the terminal session before running the legacy assistant.'
            });
            this.sendToWorkspace(tab, 'assistant-status', {
                sessionId,
                status: 'failed',
                message: 'OpenCode controls the browser'
            });
            return;
        }

        if (!prompt) {
            this.sendToWorkspace(tab, 'assistant-task-failed', {
                sessionId,
                status: 'failed',
                message: 'Empty prompt.'
            });
            return;
        }

        if (clarificationContext?.reason === 'continue_run') {
            if (isNegativeContinuationReply(prompt)) {
                this.sendToWorkspace(tab, 'assistant-response', {
                    sessionId,
                    message: 'Stopped here. Send another prompt when you want to continue.',
                    status: 'idle',
                    isFinal: true
                });
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId,
                    status: 'idle',
                    message: 'Finished'
                });
                this.sendToWorkspace(tab, 'assistant-task-finished', {
                    sessionId,
                    message: 'Task finished.'
                });
                return;
            }

            if (!isAffirmativeContinuationReply(prompt)) {
                const continuation = this.createContinuationClarification({
                    rootPrompt,
                    prompt: rootPrompt,
                    callCount: clarificationContext?.toolCallsUsed || MAX_TOOL_CALLS
                }, `Reply "continue" to allow ${MAX_TOOL_CALLS} more browser steps, or "stop" to finish here.`);

                this.sendToWorkspace(tab, 'assistant-response', {
                    sessionId,
                    message: continuation.question,
                    status: 'clarifying',
                    isFinal: false,
                    meta: {
                        clarification: continuation
                    }
                });
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId,
                    status: 'clarifying',
                    message: 'Need your reply.'
                });
                return;
            }

            planningPrompt = `${rootPrompt}\n\nContinuation approval: ${prompt}\nContinue the same task from the current browser state and prior conversation.`;
        }

        if (this.runs.has(tab.id)) {
            this.progress(tab, sessionId, 'Assistant is already working on a task.', 'warn');
            return;
        }

        const run = {
            tabId: tab.id,
            sessionId,
            prompt: planningPrompt,
            rootPrompt,
            startedAt: Date.now(),
            callCount: 0,
            openedTabs: 0,
            aborted: false,
            taskProfile: this.deriveTaskProfile(planningPrompt),
            touchedTabs: [],
            messages: Array.isArray(session.messages) ? session.messages.slice(-MAX_CONTEXT_MESSAGES) : [],
            activePlannerRequestId: null,
            consecutiveToolFailures: 0,
            lastToolName: null,
            lastToolOk: null,
            lastToolError: null,
            lastMarketplaceCandidateCount: 0,
            lastPlausibleMarketplaceCandidateCount: 0,
            lastUnderBudgetMarketplaceCandidateCount: 0,
            topMarketplaceCandidates: [],
            researchSourcePageKeysInspected: new Set(),
            marketplaceListingTabsOpened: 0,
            marketplaceListingKeysOpened: new Set(),
            marketplaceListingKeysInspected: new Set(),
            pendingClarification: clarificationContext ? { ...clarificationContext } : null
        };

        const lastMessage = run.messages[run.messages.length - 1];
        if (!lastMessage || lastMessage.role !== 'user' || lastMessage.content !== prompt) {
            run.messages.push({ role: 'user', content: prompt });
        }
        this.runs.set(tab.id, run);

        this.sendToWorkspace(tab, 'assistant-task-started', {
            sessionId,
            message: 'Assistant task started.'
        });
        this.sendToWorkspace(tab, 'assistant-status', {
            sessionId,
            status: 'running',
            message: 'Working'
        });
        this.progress(tab, sessionId, 'Thinking about the next step...');

        try {
            await this.runAgentLoop(tab, run);
        } catch (error) {
            if (!run.aborted) {
                this.log(tab, sessionId, `Assistant failed: ${error.message || error}`, 'error');
                this.sendToWorkspace(tab, 'assistant-task-failed', {
                    sessionId,
                    status: 'failed',
                    message: error.message || String(error)
                });
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId,
                    status: 'failed',
                    message: error.message || String(error)
                });
            }
        } finally {
            this.runs.delete(tab.id);
        }
    }

    async runAgentLoop(tab, run) {
        let finished = false;
        let waiting = false;
        let clarifying = false;

        while (!run.aborted) {
            if (Date.now() - run.startedAt > MAX_DURATION_MS) {
                this.log(tab, run.sessionId, 'Run time limit reached.', 'warn');
                break;
            }

            if (run.callCount >= MAX_TOOL_CALLS) {
                clarifying = true;
                const clarification = this.createContinuationClarification(run);
                run.pendingClarification = clarification;
                this.sendToWorkspace(tab, 'assistant-response', {
                    sessionId: run.sessionId,
                    message: clarification.question,
                    status: 'clarifying',
                    isFinal: false,
                    meta: {
                        clarification
                    }
                });
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId: run.sessionId,
                    status: 'clarifying',
                    message: 'Need your reply.'
                });
                this.log(tab, run.sessionId, 'Awaiting continuation approval from the user.', 'info', {
                    clarification
                });
                break;
            }

            const plannerPayload = {
                prompt: run.prompt,
                messages: run.messages.slice(-MAX_PLANNER_CONTEXT_MESSAGES),
                browserState: this.buildPlannerBrowserState(run),
                taskProfile: run.taskProfile,
                runtimeState: this.buildRuntimeState(run),
                limits: {
                    maxToolCalls: MAX_TOOL_CALLS,
                    maxNewTabs: MAX_NEW_TABS,
                    maxDurationMs: MAX_DURATION_MS
                },
                compactPlannerContext: run.callCount > 0,
                requestId: createPlannerRequestId(run.sessionId),
                sessionId: run.sessionId,
                timeoutMs: Math.max(1000, MAX_DURATION_MS - (Date.now() - run.startedAt))
            };

            run.activePlannerRequestId = plannerPayload.requestId;
            this.progress(tab, run.sessionId, 'Requesting the next action from the planner...');
            let action;
            try {
                action = await window.electronAPI.invoke('assistant-next-action', plannerPayload);
            } catch (error) {
                const message = error?.message || String(error);
                if (run.aborted || /aborted|timed out/i.test(message)) {
                    if (/timed out/i.test(message)) {
                        this.log(tab, run.sessionId, 'Planner request timed out.', 'warn');
                        run.aborted = true;
                        this.sendToWorkspace(tab, 'assistant-task-failed', {
                            sessionId: run.sessionId,
                            status: 'failed',
                            message: 'Planner request timed out.'
                        });
                        this.sendToWorkspace(tab, 'assistant-status', {
                            sessionId: run.sessionId,
                            status: 'failed',
                            message: 'Planner request timed out.'
                        });
                    }
                    break;
                }
                throw error;
            } finally {
                if (run.activePlannerRequestId === plannerPayload.requestId) {
                    run.activePlannerRequestId = null;
                }
            }

            if (run.aborted) {
                break;
            }

            if (!action || typeof action !== 'object') {
                throw new Error('Planner returned an invalid response.');
            }

            if (action.type === 'final') {
                const comparisonHint = this.getComparisonHint(run);
                if (comparisonHint) {
                    this.log(tab, run.sessionId, comparisonHint, 'warn');
                    this.progress(tab, run.sessionId, comparisonHint, 'warn');
                    run.messages.push({
                        role: 'assistant',
                        content: comparisonHint
                    });
                    continue;
                }

                finished = true;
                this.sendToWorkspace(tab, 'assistant-response', {
                    sessionId: run.sessionId,
                    message: action.message || 'Done.',
                    results: Array.isArray(action.results) ? action.results : undefined,
                    status: 'idle',
                    isFinal: true
                });
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId: run.sessionId,
                    status: 'idle',
                    message: 'Finished'
                });
                this.sendToWorkspace(tab, 'assistant-task-finished', {
                    sessionId: run.sessionId,
                    message: 'Task finished.'
                });
                break;
            }

            if (action.type === 'clarify') {
                const question = String(action.question || action.message || '').trim();
                if (!question) {
                    throw new Error('Planner returned a clarification without a question.');
                }

                clarifying = true;
                const clarification = {
                    question,
                    reason: typeof action.reason === 'string' ? action.reason : '',
                    missingInfo: Array.isArray(action.missingInfo)
                        ? action.missingInfo.filter((item) => typeof item === 'string' && item.trim())
                        : [],
                    originalPrompt: run.rootPrompt || run.prompt,
                    createdAt: Date.now()
                };

                run.pendingClarification = clarification;

                this.sendToWorkspace(tab, 'assistant-response', {
                    sessionId: run.sessionId,
                    message: question,
                    status: 'clarifying',
                    isFinal: false,
                    meta: {
                        clarification
                    }
                });
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId: run.sessionId,
                    status: 'clarifying',
                    message: 'Need your reply.'
                });
                this.log(tab, run.sessionId, 'Awaiting clarification from the user.', 'info', {
                    clarification
                });
                break;
            }

            if (action.type !== 'tool_call') {
                throw new Error(`Unsupported planner action type: ${action.type}`);
            }

            if (typeof action.message === 'string' && action.message.trim()) {
                this.sendToWorkspace(tab, 'assistant-response', {
                    sessionId: run.sessionId,
                    message: action.message.trim(),
                    status: 'running',
                    isFinal: false,
                    source: 'planner'
                });
            }

            let toolName = action.tool;
            let toolArgs = action.arguments || action.args || {};
            const loopBreaker = await this.maybeBreakRepeatedToolLoop(tab, run, toolName, toolArgs);
            if (loopBreaker?.skipExecution) {
                run.callCount += 1;
                continue;
            }

            if (loopBreaker?.toolName) {
                toolName = loopBreaker.toolName;
                toolArgs = loopBreaker.toolArgs || {};
            }

            if (this.looksSensitive(toolName, toolArgs)) {
                waiting = true;
                this.sendToWorkspace(tab, 'assistant-response', {
                    sessionId: run.sessionId,
                    message: 'Approval required before entering sensitive information. Please handle this step manually if you want to continue.',
                    status: 'waiting',
                    isFinal: true
                });
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId: run.sessionId,
                    status: 'waiting',
                    message: 'Waiting for approval'
                });
                this.log(tab, run.sessionId, `Blocked sensitive tool call: ${toolName}`, 'warn');
                break;
            }

            this.log(tab, run.sessionId, `Running tool: ${toolName}`, 'info', {
                toolArgs,
                forcedByLoopBreaker: loopBreaker?.forced === true,
                loopBreakerReason: loopBreaker?.reason || null
            });
            const toolResult = await this.executeTool(toolName, toolArgs, run);
            const summarizedResult = this.truncateObservation(toolResult);
            const touchedTabs = this.recordTouchedTabs(run, toolResult);

            run.messages.push({
                role: 'tool',
                content: summarizedResult,
                name: toolName
            });
            this.updateRuntimeSignals(run, toolName, toolResult);

            if (!toolResult?.ok) {
                this.progress(tab, run.sessionId, `Tool ${toolName} failed: ${toolResult?.error || 'Unknown error'}`, 'error', {
                    tool: toolName,
                    touchedTabs
                });
                this.log(tab, run.sessionId, `Tool failed: ${summarizedResult}`, 'error');
            } else {
                this.progress(tab, run.sessionId, `Tool ${toolName} finished.`, 'info', {
                    tool: toolName,
                    touchedTabs
                });
                this.log(tab, run.sessionId, `Tool result: ${summarizedResult}`, 'info');
            }

            if (!toolResult?.ok && toolResult?.requiresApproval) {
                waiting = true;
                this.sendToWorkspace(tab, 'assistant-status', {
                    sessionId: run.sessionId,
                    status: 'waiting',
                    message: toolResult.error || 'Approval required'
                });
                break;
            }

            run.callCount += 1;
        }

        if (!run.aborted && !finished && !waiting && !clarifying) {
            this.sendToWorkspace(tab, 'assistant-status', {
                sessionId: run.sessionId,
                status: 'idle',
                message: 'Task finished.'
            });
            this.sendToWorkspace(tab, 'assistant-task-finished', {
                sessionId: run.sessionId,
                message: 'Task finished.'
            });
        }
    }

    async executeTool(toolName, toolArgs, run) {
        if (this.openCodeHasBrowserControl) {
            return {
                ok: false,
                error: 'OpenCode currently has exclusive browser control.'
            };
        }

        if (!this.browserActionCoordinator) {
            return this.executeToolDirect(toolName, toolArgs, run);
        }

        return this.browserActionCoordinator.execute({
            owner: 'assistant',
            toolName,
            tabId: toolArgs?.tabId,
            onStart: () => {
                if (run) run.browserActionStarted = true;
            }
        }, () => this.executeToolDirect(toolName, toolArgs, run));
    }

    async executeToolDirect(toolName, toolArgs, run) {
            switch (toolName) {
            case 'list_tabs':
                return {
                    ok: true,
                    tabs: this.browserTools.listTabs()
                };
            case 'open_tab': {
                if (run.openedTabs >= MAX_NEW_TABS) {
                    return { ok: false, error: 'Maximum number of new tabs reached.' };
                }
                const result = this.browserTools.openTab({
                    url: toolArgs.url,
                    activate: toolArgs.activate === true,
                    title: toolArgs.title || 'New Tab',
                    assistantOwned: true,
                    role: toolArgs.role || 'browser',
                    hidden: toolArgs.hidden !== false,
                    partition: toolArgs.partition || AGENT_BROWSER_PARTITION,
                    trackHistory: toolArgs.trackHistory === true ? true : false
                });
                if (result?.id) {
                    run.openedTabs += 1;
                }
                if (run.taskProfile.kind === 'shopping' && this.isLikelyMarketplaceListingUrl(result?.tab?.url)) {
                    this.markMarketplaceListingTabsOpened(run, [result.tab]);
                }
                if (result?.id) {
                    const waitResult = await this.browserTools.waitForLoad({
                        tabId: result.id,
                        timeoutMs: 12000,
                        settleMs: 250,
                        requireNavigation: false
                    });
                    result.waitResult = waitResult;
                    if (waitResult?.tab) {
                        result.tab = waitResult.tab;
                    }
                }
                return result;
            }
            case 'focus_tab':
                {
                    const result = this.browserTools.focusTab({ tabId: toolArgs.tabId });
                    if (result?.tab) {
                        this.markMarketplaceListingTabInspected(run, result.tab);
                    }
                    return result;
                }
            case 'close_tab':
                return this.browserTools.closeTab({ tabId: toolArgs.tabId });
            case 'navigate_tab':
                return this.browserTools.navigateTab({ tabId: toolArgs.tabId, url: toolArgs.url });
            case 'get_tab_info':
                {
                    const result = this.browserTools.getTabInfo(toolArgs.tabId);
                    this.markMarketplaceListingTabInspected(run, result);
                    return result;
                }
            case 'get_active_tab':
                {
                    const result = this.browserTools.getActiveTab();
                    this.markMarketplaceListingTabInspected(run, result);
                    return result;
                }
            case 'wait_for_load':
                return this.browserTools.waitForLoad({ tabId: toolArgs.tabId, timeoutMs: toolArgs.timeoutMs });
            case 'wait_for_element':
                return this.browserTools.waitForElement({
                    tabId: toolArgs.tabId,
                    selector: toolArgs.selector,
                    index: toolArgs.index,
                    present: toolArgs.present,
                    visible: toolArgs.visible,
                    enabled: toolArgs.enabled,
                    text: toolArgs.text,
                    textChangedFrom: toolArgs.textChangedFrom,
                    caseSensitive: toolArgs.caseSensitive,
                    timeoutMs: toolArgs.timeoutMs,
                    pollIntervalMs: toolArgs.pollIntervalMs
                });
            case 'read_page_text':
                {
                    const result = await this.browserTools.readPageText({
                        tabId: toolArgs.tabId,
                        maxChars: toolArgs.maxChars,
                        selector: toolArgs.selector,
                        contentMode: toolArgs.contentMode
                    });
                    this.markMarketplaceListingTabInspected(run, result?.tab || null);
                    this.markResearchSourcePageInspected(run, result?.tab || null);
                    return result;
                }
            case 'find_page_text':
                {
                    const result = await this.browserTools.findPageText({
                        tabId: toolArgs.tabId,
                        query: toolArgs.query,
                        contextChars: toolArgs.contextChars,
                        maxMatches: toolArgs.maxMatches,
                        caseSensitive: toolArgs.caseSensitive
                    });
                    this.markMarketplaceListingTabInspected(run, result?.tab || null);
                    this.markResearchSourcePageInspected(run, result?.tab || null);
                    return result;
                }
            case 'query_selector_all':
                {
                    const result = await this.browserTools.querySelectorAll({
                        tabId: toolArgs.tabId,
                        selector: toolArgs.selector,
                        fields: toolArgs.fields
                    });
                    this.markMarketplaceListingTabInspected(run, result?.tab || null);
                    this.markResearchSourcePageInspected(run, result?.tab || null);
                    return result;
                }
            case 'click_element':
                {
                    const result = await this.browserTools.clickElement({
                        tabId: toolArgs.tabId,
                        selector: toolArgs.selector,
                        index: toolArgs.index
                    });
                    this.markMarketplaceListingTabInspected(run, result?.tab || null);
                    return result;
                }
            case 'press_and_hold':
                {
                    const result = await this.browserTools.pressAndHold({
                        tabId: toolArgs.tabId,
                        selector: toolArgs.selector,
                        index: toolArgs.index,
                        holdMs: toolArgs.holdMs,
                        jitter: toolArgs.jitter
                    });
                    this.markMarketplaceListingTabInspected(run, result?.tab || null);
                    return result;
                }
            case 'type_into':
                {
                    const result = await this.browserTools.typeInto({
                        tabId: toolArgs.tabId,
                        selector: toolArgs.selector,
                        text: toolArgs.text,
                        submit: toolArgs.submit,
                        clear: toolArgs.clear
                    });
                    this.markMarketplaceListingTabInspected(run, result?.tab || null);
                    return result;
                }
            case 'scroll_page':
                {
                    const result = await this.browserTools.scrollPage({
                        tabId: toolArgs.tabId,
                        direction: toolArgs.direction,
                        amount: toolArgs.amount
                    });
                    this.markMarketplaceListingTabInspected(run, result?.tab || null);
                    return result;
                }
            case 'search_site':
                {
                    const result = await this.browserTools.searchSite({
                        tabId: toolArgs.tabId,
                        query: toolArgs.query,
                        siteHint: toolArgs.siteHint,
                        timeoutMs: toolArgs.timeoutMs
                    });

                    if (result?.ok && run.taskProfile.kind === 'shopping') {
                        const targetTabId = result?.tab?.id || toolArgs.tabId;
                        const extraction = await this.browserTools.extractSearchResults({
                            tabId: targetTabId,
                            siteHint: toolArgs.siteHint
                        });

                        result.extractedResults = extraction;

                        if (Array.isArray(extraction?.items)) {
                            run.lastMarketplaceCandidateCount = extraction.items.length;
                            await this.maybeAutoOpenMarketplaceListings(run, extraction);
                            if (Array.isArray(extraction.openedCandidateTabs)) {
                                result.openedCandidateTabs = extraction.openedCandidateTabs;
                            }
                        }
                    }

                    return result;
                }
            case 'extract_search_results':
                {
                    const result = await this.browserTools.extractSearchResults({
                        tabId: toolArgs.tabId,
                        siteHint: toolArgs.siteHint
                    });
                    if (run.taskProfile.kind === 'shopping' && Array.isArray(result?.items)) {
                        run.lastMarketplaceCandidateCount = result.items.length;
                        await this.maybeAutoOpenMarketplaceListings(run, result);
                    }
                    return result;
                }
            default:
                return {
                    ok: false,
                    error: `Unsupported tool: ${toolName}`
                };
        }
    }
}

export default AssistantController;
