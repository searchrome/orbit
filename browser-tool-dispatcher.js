import BrowserTools from './browser-tools.js';
import BrowserActionCoordinator, { MUTATING_BROWSER_TOOLS } from './browser-action-coordinator.js';

const MAX_TEXT_LENGTH = 20_000;
const MAX_SELECTOR_LENGTH = 1_000;
const MAX_URL_LENGTH = 8_192;
const MAX_WAIT_MS = 20_000;
const MAX_SCROLL_AMOUNT = 8_000;
const MAX_QUERY_RESULTS = 200;
const MAX_QUERY_TEXT_CHARS = 20_000;
const MAX_QUERY_TEXT_OFFSET = 1_000_000;
const MAX_QUERY_OUTPUT_CHARS = 64_000;
const MAX_FIND_QUERY_LENGTH = 512;
const MAX_FIND_CONTEXT_CHARS = 512;
const MAX_FIND_MATCHES = 50;
const MAX_WAIT_TEXT_LENGTH = 512;
const MIN_WAIT_POLL_MS = 50;
const MAX_WAIT_POLL_MS = 1_000;
const MAX_BATCH_READ_ITEMS = 8;
const MIN_BATCH_OUTPUT_CHARS = 10_000;
const MAX_BATCH_OUTPUT_CHARS = 64_000;
const DEFAULT_BATCH_OUTPUT_CHARS = 24_000;
const MIN_BATCH_ITEM_CHARS = 900;
const BATCH_READ_TOOLS = new Set([
    'get_tab_info',
    'read_page_text',
    'find_page_text',
    'query_selector_all'
]);
const CONTENT_MODES = new Set(['full', 'main', 'article', 'auto']);
const MAX_VIEW_NAME_LENGTH = 160;
const MAX_VIEW_SELECTORS = 40;

function error(message, code = 'invalid_request') {
    return { ok: false, error: { code, message } };
}

function stringValue(value, field, maxLength, { required = true } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? { error: `${field} is required.` } : { value: '' };
    }

    if (typeof value !== 'string') {
        return { error: `${field} must be a string.` };
    }

    const normalized = value.trim();
    if (required && !normalized) {
        return { error: `${field} is required.` };
    }
    if (normalized.length > maxLength) {
        return { error: `${field} must be at most ${maxLength} characters.` };
    }
    return { value: normalized };
}

function literalStringValue(value, field, maxLength) {
    if (typeof value !== 'string' || value.length === 0) {
        return { error: `${field} must be a non-empty string.` };
    }
    if (value.length > maxLength) {
        return { error: `${field} must be at most ${maxLength} characters.` };
    }
    return { value };
}

function boundedNumber(value, fallback, min, max, field) {
    if (value === undefined || value === null) {
        return { value: fallback };
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max) {
        return { error: `${field} must be a number between ${min} and ${max}.` };
    }
    return { value: Math.floor(number) };
}

function optionalBoundedNumber(value, min, max, field) {
    if (value === undefined || value === null || value === '') {
        return { value: undefined };
    }
    return boundedNumber(value, undefined, min, max, field);
}

function optionalBoolean(value, field) {
    if (value === undefined || value === null) {
        return { value: undefined };
    }
    if (typeof value !== 'boolean') {
        return { error: `${field} must be a boolean.` };
    }
    return { value };
}

function optionalLiteralString(value, field, maxLength, { allowEmpty = false } = {}) {
    if (value === undefined || value === null) {
        return { value: undefined };
    }
    if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
        return { error: `${field} must be ${allowEmpty ? 'a string' : 'a non-empty string'}.` };
    }
    if (value.length > maxLength) {
        return { error: `${field} must be at most ${maxLength} characters.` };
    }
    return { value };
}

function transformedViewRecipe(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return { error: 'recipe must be an object.' };
    }
    const rootSelector = stringValue(value.rootSelector, 'recipe.rootSelector', MAX_SELECTOR_LENGTH);
    const titleSelector = optionalLiteralString(value.titleSelector, 'recipe.titleSelector', MAX_SELECTOR_LENGTH, { allowEmpty: true });
    const readySelector = optionalLiteralString(value.readySelector, 'recipe.readySelector', MAX_SELECTOR_LENGTH, { allowEmpty: true });
    const removeSelectors = value.removeSelectors === undefined ? [] : value.removeSelectors;
    if (rootSelector.error || titleSelector.error || readySelector.error) {
        return { error: rootSelector.error || titleSelector.error || readySelector.error };
    }
    if (!Array.isArray(removeSelectors) || removeSelectors.length > MAX_VIEW_SELECTORS) {
        return { error: `recipe.removeSelectors must contain at most ${MAX_VIEW_SELECTORS} selectors.` };
    }
    const cleanedRemoveSelectors = [];
    for (let index = 0; index < removeSelectors.length; index += 1) {
        const item = stringValue(removeSelectors[index], `recipe.removeSelectors[${index}]`, MAX_SELECTOR_LENGTH);
        if (item.error) return item;
        cleanedRemoveSelectors.push(item.value);
    }
    if (value.theme !== undefined && value.theme !== 'light' && value.theme !== 'dark') {
        return { error: 'recipe.theme must be light or dark.' };
    }
    return {
        value: {
            rootSelector: rootSelector.value,
            titleSelector: titleSelector.value || 'h1',
            readySelector: readySelector.value || '',
            removeSelectors: cleanedRemoveSelectors,
            theme: value.theme === 'dark' ? 'dark' : 'light'
        }
    };
}

function clippedString(value, maxChars) {
    const text = String(value ?? '');
    return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function serializedChars(value) {
    try {
        return JSON.stringify(value).length;
    } catch {
        return Infinity;
    }
}

function compactDocument(document) {
    if (!document || typeof document !== 'object') return null;
    return {
        tabId: clippedString(document.tabId, 200) || null,
        url: clippedString(document.url, 256) || null,
        title: clippedString(document.title, 120),
        documentId: clippedString(document.documentId, 80) || null
    };
}

function compactBatchData(data) {
    if (!data || typeof data !== 'object') return data;
    const compact = {};
    for (const field of ['tab', 'observed', 'selector', 'query', 'caseSensitive', 'contextChars', 'maxMatches', 'totalMatches', 'matchCount', 'noMatches', 'truncated', 'extraction']) {
        if (data[field] !== undefined) compact[field] = data[field];
    }
    if (typeof data.text === 'string') compact.text = clippedString(data.text, 1_000);
    if (Array.isArray(data.matches)) compact.matches = data.matches.slice(0, 2).map((match) => ({
        ...match,
        ...(typeof match?.snippet === 'string' ? { snippet: clippedString(match.snippet, 300) } : {}),
        ...(typeof match?.match === 'string' ? { match: clippedString(match.match, 160) } : {})
    }));
    if (Array.isArray(data.items)) compact.items = data.items.slice(0, 2).map((item) => {
        if (!item || typeof item !== 'object') return item;
        const copy = { ...item };
        for (const field of ['text', 'html', 'href', 'src', 'title', 'ariaLabel']) {
            if (typeof copy[field] === 'string') copy[field] = clippedString(copy[field], 300);
        }
        return copy;
    });
    return compact;
}

function batchItemForBudget(item, budget) {
    if (serializedChars(item) <= budget) return item;

    const result = item.result && typeof item.result === 'object' ? item.result : { ok: false };
    const compact = {
        id: item.id,
        tool: item.tool,
        tabId: item.tabId,
        result: {
            ok: result.ok === true,
            ...(result.ok === false && result.error ? {
                error: {
                    code: clippedString(result.error.code || 'browser_action_failed', 80),
                    message: clippedString(result.error.message || 'Browser read failed.', 240),
                    retryable: result.error.retryable === true
                }
            } : {}),
            ...(result.ok === true ? { data: compactBatchData(result.data) } : {})
        },
        document: {
            source: compactDocument(item.document?.source),
            current: compactDocument(item.document?.current),
            identityVerified: item.document?.identityVerified === true,
            sourceIsCurrent: item.document?.sourceIsCurrent === true
        },
        truncated: { output: true, originalChars: serializedChars(item) }
    };
    if (serializedChars(compact) <= budget) return compact;

    const minimal = {
        id: item.id,
        tool: item.tool,
        tabId: item.tabId,
        result: result.ok === true
            ? { ok: true }
            : {
                ok: false,
                error: {
                    code: clippedString(result.error?.code || 'browser_action_failed', 80),
                    message: clippedString(result.error?.message || 'Browser read failed.', 120),
                    retryable: result.error?.retryable === true
                }
            },
        document: {
            source: compactDocument(item.document?.source),
            identityVerified: item.document?.identityVerified === true,
            sourceIsCurrent: item.document?.sourceIsCurrent === true
        },
        truncated: { output: true, originalChars: serializedChars(item) }
    };
    return minimal;
}

function normalizeResult(result) {
    if (!result || typeof result !== 'object') {
        return { ok: true, data: result };
    }

    if (result.ok === false) {
        const details = result.errorInfo && typeof result.errorInfo === 'object' ? result.errorInfo : null;
        const message = details?.message || (typeof result.error === 'object' ? result.error.message : result.error) || 'Browser action failed.';
        return {
            ok: false,
            error: {
                code: details?.code || 'browser_action_failed',
                message: String(message).slice(0, 500),
                retryable: details?.retryable === true,
                ...(details?.certainty ? { certainty: details.certainty } : {})
            },
            data: result,
            ...(result.actionMayHaveCompleted === true ? { actionMayHaveCompleted: true } : {})
        };
    }

    return { ok: true, data: result };
}

export default class BrowserToolDispatcher {
    constructor(tabManager, coordinator = new BrowserActionCoordinator(), transformedViews = null) {
        this.browserTools = new BrowserTools(tabManager);
        this.coordinator = coordinator;
        this.transformedViews = transformedViews;
    }

    async executeBatchRead(rawArgs, execution = {}) {
        const rawRequests = rawArgs?.requests;
        if (!Array.isArray(rawRequests) || rawRequests.length === 0 || rawRequests.length > MAX_BATCH_READ_ITEMS) {
            return error(`requests must contain between 1 and ${MAX_BATCH_READ_ITEMS} items.`);
        }
        const outputLimit = boundedNumber(rawArgs?.maxOutputChars, DEFAULT_BATCH_OUTPUT_CHARS, MIN_BATCH_OUTPUT_CHARS, MAX_BATCH_OUTPUT_CHARS, 'maxOutputChars');
        if (outputLimit.error) return error(outputLimit.error);

        const ids = new Set();
        const requests = [];
        for (let requestIndex = 0; requestIndex < rawRequests.length; requestIndex += 1) {
            const rawRequest = rawRequests[requestIndex];
            if (!rawRequest || typeof rawRequest !== 'object' || Array.isArray(rawRequest)) {
                return error(`requests[${requestIndex}] must be an object.`);
            }
            const id = stringValue(rawRequest.id, `requests[${requestIndex}].id`, 80);
            if (id.error) return error(id.error);
            if (ids.has(id.value)) return error(`requests[${requestIndex}].id must be unique.`);
            ids.add(id.value);
            if (!BATCH_READ_TOOLS.has(rawRequest.tool)) {
                return error(`requests[${requestIndex}].tool must be one of ${[...BATCH_READ_TOOLS].join(', ')}.`);
            }
            if (!rawRequest.args || typeof rawRequest.args !== 'object' || Array.isArray(rawRequest.args)) {
                return error(`requests[${requestIndex}].args must be an object.`);
            }
            const tabId = stringValue(rawRequest.args.tabId, `requests[${requestIndex}].args.tabId`, 200);
            if (tabId.error) return error(tabId.error);
            requests.push({
                id: id.value,
                tool: rawRequest.tool,
                tabId: tabId.value,
                args: { ...rawRequest.args, tabId: tabId.value }
            });
        }

        let started = false;
        const markStarted = () => {
            if (started) return;
            started = true;
            execution.onStart?.();
        };
        const rawItems = await this.browserTools.batchRead({
            requests,
            executeRead: (request) => this.execute(request.tool, request.args, {
                owner: execution.owner || 'opencode',
                signal: execution.signal,
                onStart: markStarted,
                includeDocumentIdentity: true
            })
        });

        // Reserve a small fixed envelope so the serialized response, not just
        // the read payloads, stays under the caller's total budget.
        let remainingChars = outputLimit.value - 256;
        let usedChars = 0;
        const items = rawItems.map((item, index) => {
            const remainingItems = rawItems.length - index - 1;
            const budget = Math.max(
                MIN_BATCH_ITEM_CHARS,
                remainingChars - (remainingItems * MIN_BATCH_ITEM_CHARS)
            );
            const bounded = batchItemForBudget(item, budget);
            const size = serializedChars(bounded);
            remainingChars -= size;
            usedChars += size;
            return bounded;
        });

        return {
            ok: true,
            data: {
                items,
                output: {
                    maxChars: outputLimit.value,
                    itemChars: usedChars,
                    truncated: items.some((item) => item.truncated?.output === true)
                }
            }
        };
    }

    async execute(toolName, rawArgs = {}, execution = {}) {
        const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
        if (toolName === 'batch_read_tabs') {
            return this.executeBatchRead(args, execution);
        }
        const run = async ({ signal } = {}) => {
            if (signal?.aborted) {
                return {
                    ok: false,
                    error: { code: 'browser_action_cancelled', message: 'Browser action was cancelled.', retryable: !MUTATING_BROWSER_TOOLS.has(toolName) },
                    actionMayHaveCompleted: false
                };
            }

            try {
            switch (toolName) {
            case 'list_tabs':
                return { ok: true, data: { tabs: this.browserTools.listTabs() } };
            case 'get_active_tab':
                return { ok: true, data: { tab: this.browserTools.getActiveTab() } };
            case 'get_tab_info':
                return normalizeResult(this.browserTools.getTabInfo(args.tabId));
            case 'open_tab': {
                const url = stringValue(args.url, 'url', MAX_URL_LENGTH);
                if (url.error) return error(url.error);
                return normalizeResult(this.browserTools.openTab({
                    url: url.value,
                    activate: args.activate !== false,
                    title: typeof args.title === 'string' ? args.title.slice(0, 250) : 'New Tab',
                    assistantOwned: true,
                    role: 'browser',
                    hidden: false,
                    trackHistory: true
                }));
            }
            case 'focus_tab':
                return normalizeResult(this.browserTools.focusTab({ tabId: args.tabId }));
            case 'close_tab':
                return normalizeResult(this.browserTools.closeTab({ tabId: args.tabId }));
            case 'navigate_tab': {
                const url = stringValue(args.url, 'url', MAX_URL_LENGTH);
                if (url.error) return error(url.error);
                const timeout = boundedNumber(args.timeoutMs, 12_000, 500, MAX_WAIT_MS, 'timeoutMs');
                if (timeout.error) return error(timeout.error);
                return normalizeResult(await this.browserTools.navigateTab({
                    tabId: args.tabId,
                    url: url.value,
                    timeoutMs: timeout.value
                }));
            }
            case 'wait_for_load': {
                const timeout = boundedNumber(args.timeoutMs, 10_000, 500, MAX_WAIT_MS, 'timeoutMs');
                if (timeout.error) return error(timeout.error);
                return normalizeResult(await this.browserTools.waitForLoad({
                    tabId: args.tabId,
                    timeoutMs: timeout.value
                }));
            }
            case 'wait_for_element': {
                const selector = stringValue(args.selector, 'selector', MAX_SELECTOR_LENGTH);
                const index = boundedNumber(args.index, 0, 0, 100, 'index');
                const present = optionalBoolean(args.present, 'present');
                const visible = optionalBoolean(args.visible, 'visible');
                const enabled = optionalBoolean(args.enabled, 'enabled');
                const text = optionalLiteralString(args.text, 'text', MAX_WAIT_TEXT_LENGTH);
                const textChangedFrom = optionalLiteralString(args.textChangedFrom, 'textChangedFrom', MAX_WAIT_TEXT_LENGTH, { allowEmpty: true });
                const caseSensitive = optionalBoolean(args.caseSensitive, 'caseSensitive');
                const timeout = boundedNumber(args.timeoutMs, 10_000, 500, MAX_WAIT_MS, 'timeoutMs');
                const pollInterval = boundedNumber(args.pollIntervalMs, 100, MIN_WAIT_POLL_MS, MAX_WAIT_POLL_MS, 'pollIntervalMs');
                if (selector.error || index.error || present.error || visible.error || enabled.error || text.error || textChangedFrom.error || caseSensitive.error || timeout.error || pollInterval.error) {
                    return error(selector.error || index.error || present.error || visible.error || enabled.error || text.error || textChangedFrom.error || caseSensitive.error || timeout.error || pollInterval.error);
                }
                const requestedPresent = present.value === undefined ? true : present.value;
                if (!requestedPresent && (visible.value !== undefined || enabled.value !== undefined || text.value !== undefined || textChangedFrom.value !== undefined)) {
                    return error('present: false cannot be combined with visible, enabled, text, or textChangedFrom.');
                }
                return normalizeResult(await this.browserTools.waitForElement({
                    tabId: args.tabId,
                    selector: selector.value,
                    index: index.value,
                    present: requestedPresent,
                    ...(visible.value === undefined ? {} : { visible: visible.value }),
                    ...(enabled.value === undefined ? {} : { enabled: enabled.value }),
                    ...(text.value === undefined ? {} : { text: text.value }),
                    ...(textChangedFrom.value === undefined ? {} : { textChangedFrom: textChangedFrom.value }),
                    ...(caseSensitive.value === undefined ? {} : { caseSensitive: caseSensitive.value }),
                    timeoutMs: timeout.value,
                    pollIntervalMs: pollInterval.value,
                    signal
                }));
            }
            case 'read_page_text': {
                const maxChars = boundedNumber(args.maxChars, 12_000, 1, MAX_TEXT_LENGTH, 'maxChars');
                if (maxChars.error) return error(maxChars.error);
                const selector = args.selector === undefined || args.selector === null
                    ? undefined
                    : stringValue(args.selector, 'selector', MAX_SELECTOR_LENGTH);
                const contentMode = args.contentMode === undefined || args.contentMode === null
                    ? 'full'
                    : args.contentMode;
                if (selector?.error) return error(selector.error);
                if (typeof contentMode !== 'string' || !CONTENT_MODES.has(contentMode)) {
                    return error('contentMode must be one of full, main, article, or auto.');
                }
                return normalizeResult(await this.browserTools.readPageText({
                    tabId: args.tabId,
                    maxChars: maxChars.value,
                    ...(selector?.value ? { selector: selector.value } : {}),
                    contentMode,
                    ...(execution.includeDocumentIdentity === true ? { includeDocumentIdentity: true } : {})
                }));
            }
            case 'find_page_text': {
                const query = literalStringValue(args.query, 'query', MAX_FIND_QUERY_LENGTH);
                const contextChars = boundedNumber(args.contextChars, 240, 0, MAX_FIND_CONTEXT_CHARS, 'contextChars');
                const maxMatches = boundedNumber(args.maxMatches, 20, 1, MAX_FIND_MATCHES, 'maxMatches');
                if (query.error || contextChars.error || maxMatches.error) {
                    return error(query.error || contextChars.error || maxMatches.error);
                }
                return normalizeResult(await this.browserTools.findPageText({
                    tabId: args.tabId,
                    query: query.value,
                    contextChars: contextChars.value,
                    maxMatches: maxMatches.value,
                    caseSensitive: args.caseSensitive === true
                }));
            }
            case 'query_selector_all': {
                const selector = stringValue(args.selector, 'selector', MAX_SELECTOR_LENGTH);
                if (selector.error) return error(selector.error);
                const compact = args.compact === true;
                const fields = Array.isArray(args.fields)
                    ? args.fields.filter((field) => ['text', 'href', 'title', 'ariaLabel'].includes(field)).slice(0, 4)
                    : ['text'];
                const offset = boundedNumber(args.offset, 0, 0, MAX_QUERY_TEXT_OFFSET, 'offset');
                const maxResults = boundedNumber(args.maxResults, compact ? 20 : MAX_QUERY_RESULTS, 1, MAX_QUERY_RESULTS, 'maxResults');
                const maxTextChars = optionalBoundedNumber(args.maxTextChars, 1, MAX_QUERY_TEXT_CHARS, 'maxTextChars');
                const textOffset = boundedNumber(args.textOffset, 0, 0, MAX_QUERY_TEXT_OFFSET, 'textOffset');
                const maxOutputChars = optionalBoundedNumber(args.maxOutputChars, 256, MAX_QUERY_OUTPUT_CHARS, 'maxOutputChars');
                if (offset.error || maxResults.error || maxTextChars.error || textOffset.error || maxOutputChars.error) {
                    return error(offset.error || maxResults.error || maxTextChars.error || textOffset.error || maxOutputChars.error);
                }
                return normalizeResult(await this.browserTools.querySelectorAll({
                    tabId: args.tabId,
                    selector: selector.value,
                    fields: fields.length ? fields : ['text'],
                    offset: offset.value,
                    maxResults: maxResults.value,
                    maxTextChars: maxTextChars.value,
                    textOffset: textOffset.value,
                    maxOutputChars: maxOutputChars.value,
                    compact,
                    ...(execution.includeDocumentIdentity === true ? { includeDocumentIdentity: true } : {})
                }));
            }
            case 'click_element': {
                const selector = stringValue(args.selector, 'selector', MAX_SELECTOR_LENGTH);
                const index = boundedNumber(args.index, 0, 0, 100, 'index');
                if (selector.error || index.error) return error(selector.error || index.error);
                return normalizeResult(await this.browserTools.clickElement({
                    tabId: args.tabId,
                    selector: selector.value,
                    index: index.value
                }));
            }
            case 'type_into': {
                const selector = stringValue(args.selector, 'selector', MAX_SELECTOR_LENGTH);
                const text = stringValue(args.text, 'text', 10_000, { required: false });
                if (selector.error || text.error) return error(selector.error || text.error);
                return normalizeResult(await this.browserTools.typeInto({
                    tabId: args.tabId,
                    selector: selector.value,
                    text: text.value,
                    submit: args.submit === true,
                    clear: args.clear !== false
                }));
            }
            case 'scroll_page': {
                const amount = boundedNumber(args.amount, 800, 1, MAX_SCROLL_AMOUNT, 'amount');
                if (amount.error) return error(amount.error);
                const direction = args.direction === 'up' ? 'up' : 'down';
                return normalizeResult(await this.browserTools.scrollPage({
                    tabId: args.tabId,
                    direction,
                    amount: amount.value
                }));
            }
            case 'search_site': {
                const query = stringValue(args.query, 'query', 2_000);
                const timeout = boundedNumber(args.timeoutMs, 12_000, 500, MAX_WAIT_MS, 'timeoutMs');
                if (query.error || timeout.error) return error(query.error || timeout.error);
                return normalizeResult(await this.browserTools.searchSite({
                    tabId: args.tabId,
                    query: query.value,
                    siteHint: typeof args.siteHint === 'string' ? args.siteHint.slice(0, 250) : '',
                    timeoutMs: timeout.value
                }));
            }
            case 'extract_search_results':
                return normalizeResult(await this.browserTools.extractSearchResults({
                    tabId: args.tabId,
                    siteHint: typeof args.siteHint === 'string' ? args.siteHint.slice(0, 250) : ''
                }));
            case 'create_transformed_view': {
                if (!this.transformedViews) return error('Transformed views are unavailable.', 'feature_unavailable');
                const name = stringValue(args.name, 'name', MAX_VIEW_NAME_LENGTH);
                const sourceUrl = stringValue(args.sourceUrl, 'sourceUrl', MAX_URL_LENGTH);
                const recipe = transformedViewRecipe(args.recipe);
                if (name.error || sourceUrl.error || recipe.error) return error(name.error || sourceUrl.error || recipe.error);
                const created = await this.transformedViews.create({ name: name.value, sourceUrl: sourceUrl.value, recipe: recipe.value });
                return { ok: true, data: created };
            }
            case 'update_transformed_view': {
                if (!this.transformedViews) return error('Transformed views are unavailable.', 'feature_unavailable');
                const id = stringValue(args.id, 'id', 80);
                const expectedRevision = boundedNumber(args.expectedRevision, undefined, 1, Number.MAX_SAFE_INTEGER, 'expectedRevision');
                const recipe = args.recipe === undefined ? { value: undefined } : transformedViewRecipe(args.recipe);
                const name = args.name === undefined ? { value: undefined } : stringValue(args.name, 'name', MAX_VIEW_NAME_LENGTH);
                const sourceUrl = args.sourceUrl === undefined ? { value: undefined } : stringValue(args.sourceUrl, 'sourceUrl', MAX_URL_LENGTH);
                if (id.error || expectedRevision.error || recipe.error || name.error || sourceUrl.error) return error(id.error || expectedRevision.error || recipe.error || name.error || sourceUrl.error);
                const view = await this.transformedViews.update({ id: id.value, expectedRevision: expectedRevision.value, recipe: recipe.value, name: name.value, sourceUrl: sourceUrl.value });
                return { ok: true, data: view };
            }
            case 'list_transformed_views':
                if (!this.transformedViews) return error('Transformed views are unavailable.', 'feature_unavailable');
                return { ok: true, data: { views: await this.transformedViews.list() } };
            case 'open_transformed_view': {
                if (!this.transformedViews) return error('Transformed views are unavailable.', 'feature_unavailable');
                const id = stringValue(args.id, 'id', 80);
                if (id.error) return error(id.error);
                return { ok: true, data: { tabId: await this.transformedViews.open(id.value) } };
            }
            case 'refresh_transformed_view': {
                if (!this.transformedViews) return error('Transformed views are unavailable.', 'feature_unavailable');
                const tabId = stringValue(args.tabId, 'tabId', 200);
                if (tabId.error) return error(tabId.error);
                await this.transformedViews.refresh(tabId.value, { signal });
                return { ok: true, data: { tabId: tabId.value, refreshing: true } };
            }
            default:
                return error(`Unknown browser tool: ${toolName}.`, 'unknown_tool');
            }
            } catch (caught) {
                if (signal?.aborted) {
                    return {
                        ok: false,
                        error: {
                            code: 'browser_action_cancelled',
                            message: String(signal.reason || 'Browser action was cancelled.'),
                            retryable: !MUTATING_BROWSER_TOOLS.has(toolName)
                        },
                        actionMayHaveCompleted: false
                    };
                }
                return {
                    ok: false,
                    error: {
                        code: 'browser_dispatch_error',
                        message: caught?.message || String(caught),
                        retryable: false
                    }
                };
            }
        };

        return this.coordinator.execute({
            owner: execution.owner || 'opencode',
            toolName,
            tabId: args.tabId,
            signal: execution.signal,
            onStart: execution.onStart
        }, run);
    }

    cancel(toolName, args = {}) {
        if (toolName === 'refresh_transformed_view') {
            this.transformedViews?.cancelRefresh?.(args.tabId, 'Browser action was cancelled.');
            return;
        }
        // Page-side interaction cannot always be undone once dispatched, but
        // stopping the owning webview prevents any remaining navigation or
        // asynchronous page work from continuing after a timeout or stop.
        if (!['navigate_tab', 'wait_for_load', 'search_site', 'type_into', 'click_element', 'press_and_hold', 'scroll_page'].includes(toolName)) {
            return;
        }
        const tab = this.browserTools.getTab(args.tabId);
        try {
            tab?.webview?.stop?.();
        } catch {
            // The tab may have closed while the cancellation was in flight.
        }
    }
}
