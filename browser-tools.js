import { normalizeBrowserToolUrl } from './browser-url-policy.js';

const MAX_BROWSER_ERROR_MESSAGE_CHARS = 500;
const SAFE_READ_BROWSER_TOOLS = new Set([
    'get_tab_info',
    'get_active_tab',
    'list_tabs',
    'wait_for_load',
    'wait_for_element',
    'read_page_text',
    'find_page_text',
    'query_selector_all',
    'extract_search_results'
]);

function boundedErrorMessage(value) {
    const message = String(value?.message || value || 'Browser operation failed.')
        .replace(/\s+/g, ' ')
        .trim();
    return message.slice(0, MAX_BROWSER_ERROR_MESSAGE_CHARS) || 'Browser operation failed.';
}

function browserErrorInfo(value, {
    tool = '',
    fallbackCode = 'browser_operation_failed',
    fallbackObserved = false,
    actionMayHaveCompleted = false
} = {}) {
    const message = boundedErrorMessage(value);
    const normalized = message.toLowerCase();
    let code = null;

    if (/err_blocked_by_client|blocked by (the )?(user|client)|network (is )?disabled/.test(normalized)) {
        code = 'browser_network_blocked';
    } else if (/javascript (is )?disabled|script execution (is )?disabled/.test(normalized)) {
        code = 'browser_javascript_blocked';
    } else if (/element not found|no element matched|selector_not_found|selector not found|no usable search field/.test(normalized)) {
        code = 'browser_element_not_found';
    } else if (/timed out|timeout/.test(normalized)) {
        code = 'browser_timeout';
    } else if (/attached to the dom|dom-ready|before this method can be called|tab is not ready/.test(normalized)) {
        code = 'browser_tab_not_ready';
    } else if (/err_connection_reset|err_connection_refused|err_internet_disconnected|err_network_changed|network unavailable/.test(normalized)) {
        code = 'browser_network_unavailable';
    } else if (/navigation did not start/.test(normalized)) {
        code = 'browser_navigation_not_started';
    } else if (/target tab (was )?closed|tab (was )?closed/.test(normalized)) {
        code = 'browser_tab_closed';
    }

    const resolvedCode = code || fallbackCode;
    const retryable = SAFE_READ_BROWSER_TOOLS.has(tool) && (
        resolvedCode === 'browser_timeout' ||
        resolvedCode === 'browser_tab_not_ready' ||
        resolvedCode === 'browser_network_unavailable'
    );
    return {
        code: resolvedCode,
        message,
        retryable,
        // This records only the state directly observed by the browser. It
        // deliberately does not claim a login or geographic restriction.
        certainty: code || fallbackObserved ? 'observed' : 'unknown',
        actionMayHaveCompleted: actionMayHaveCompleted === true
    };
}

class BrowserTools {
    constructor(tabManager) {
        this.tabManager = tabManager;
    }

    _isDomReadyError(error) {
        const message = String(error?.message || '');
        return /attached to the DOM|dom-ready|before this method can be called/i.test(message);
    }

    _delay(ms = 0) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async _prepareTabForInteraction(tab, { timeoutMs = 5000, settleMs = 250 } = {}) {
        const waitResult = await this.waitForLoad({
            tabId: tab.id,
            timeoutMs,
            settleMs,
            requireNavigation: false
        });

        if (waitResult?.ok === false && !waitResult?.alreadyLoaded) {
            return waitResult;
        }

        await this._delay(Math.min(150, Math.max(25, Math.floor(settleMs / 2))));
        return waitResult;
    }

    _failure(tab, value, options = {}) {
        const errorInfo = browserErrorInfo(value, options);
        return {
            ok: false,
            error: errorInfo.message,
            errorInfo,
            ...(tab ? { tab: this._describeTab(tab) } : {}),
            ...(errorInfo.actionMayHaveCompleted ? { actionMayHaveCompleted: true } : {})
        };
    }

    async _executeJavaScriptWhenReady(tab, script, { timeoutMs = 5000, settleMs = 250, retryOnDomReady = true } = {}) {
        let lastError = null;
        const attempts = retryOnDomReady ? 3 : 1;

        for (let attempt = 0; attempt < attempts; attempt += 1) {
            if (attempt > 0) {
                const waitResult = await this._prepareTabForInteraction(tab, { timeoutMs, settleMs });
                if (waitResult?.ok === false && !waitResult?.alreadyLoaded) {
                    throw lastError || new Error(waitResult.error || 'Tab is not ready for interaction.');
                }
            }

            try {
                return await tab.webview.executeJavaScript(script, true);
            } catch (error) {
                if (!this._isDomReadyError(error)) {
                    throw error;
                }
                lastError = error;
            }
        }

        throw lastError || new Error('The tab was not ready for interaction.');
    }

    getTab(tabId) {
        return this.tabManager.getTabById(tabId);
    }

    _isAssistantWorkspaceUrl(url) {
        if (typeof url !== 'string') {
            return false;
        }

        const normalized = url.trim().toLowerCase();
        if (!normalized) {
            return false;
        }

        if (
            normalized === 'browser://assistant' ||
            normalized === 'assistant.html' ||
            normalized === 'assistant://assistant' ||
            normalized === 'assistant'
        ) {
            return true;
        }

        try {
            const parsed = new URL(url, 'file:///');
            const pathname = decodeURIComponent(parsed.pathname || '').replace(/\\/g, '/').toLowerCase();
            return pathname.endsWith('/assistant.html');
        } catch {
            return normalized.includes('/assistant.html') || normalized.includes('\\assistant.html');
        }
    }

    _isProtectedTab(tab) {
        if (!tab) {
            return false;
        }

        return !!tab.internal || this._isAssistantWorkspaceUrl(tab.url) || this._isAssistantWorkspaceUrl(tab.loadUrl);
    }

    _rejectProtectedTab(tab, actionName) {
        if (!tab) {
            const errorInfo = browserErrorInfo('Unknown tab.', { fallbackCode: 'browser_tab_not_found', fallbackObserved: true });
            return { ok: false, error: errorInfo.message, errorInfo };
        }

        if (this._isProtectedTab(tab)) {
            const errorInfo = browserErrorInfo(`${actionName} cannot target the assistant workspace tab.`, {
                fallbackCode: 'browser_protected_tab',
                fallbackObserved: true
            });
            return { ok: false, error: errorInfo.message, errorInfo };
        }

        return null;
    }

    _normalizeActionTarget(actionResult, tab) {
        const base = {
            ok: true,
            tab: this._describeTab(tab)
        };

        if (!actionResult || typeof actionResult !== 'object') {
            return base;
        }

        return {
            ...base,
            ...actionResult,
            tab: this._describeTab(tab)
        };
    }

    _getCurrentTabUrl(tab) {
        if (!tab) {
            return null;
        }

        try {
            if (typeof tab.webview?.getURL === 'function') {
                const url = tab.webview.getURL();
                if (url) {
                    return url;
                }
            }
        } catch {
            // Fall back to the stored URLs below.
        }

        return tab.loadUrl || tab.url || null;
    }

    _describeTab(tab) {
        if (!tab) {
            return null;
        }

        const webview = tab.webview;
        let isLoading = false;
        let canGoBack = false;

        try {
            isLoading = typeof webview?.isLoading === 'function' ? !!webview.isLoading() : false;
        } catch (error) {
            console.warn(`[BrowserTools] Could not read loading state for tab ${tab.id}: ${error?.message || error}`);
        }

        try {
            canGoBack = typeof webview?.canGoBack === 'function' ? !!webview.canGoBack() : false;
        } catch (error) {
            console.warn(`[BrowserTools] Could not read back navigation state for tab ${tab.id}: ${error?.message || error}`);
        }

        return {
            id: tab.id,
            title: tab.title,
            url: tab.url,
            loadUrl: tab.loadUrl || tab.url,
            role: tab.role || 'regular',
            assistantOwned: !!tab.assistantOwned,
            internal: !!tab.internal,
            hidden: !!tab.hidden,
            partition: tab.partition || null,
            active: this.tabManager.activeTabId === tab.id,
            loading: isLoading,
            canGoBack
        };
    }

    _documentIdentity(tabId) {
        const tab = this.getTab(tabId);
        if (!tab || this._isProtectedTab(tab)) {
            return null;
        }
        return {
            tabId: tab.id,
            url: this._getCurrentTabUrl(tab) || null,
            title: typeof tab.title === 'string' ? tab.title : '',
            documentId: null
        };
    }

    _resultDocumentIdentity(result, fallback) {
        const payload = result?.data && typeof result.data === 'object' ? result.data : result;
        const observed = payload?.observed && typeof payload.observed === 'object' ? payload.observed : null;
        const tab = payload?.tab && typeof payload.tab === 'object' ? payload.tab : null;
        if (observed?.url) {
            return {
                tabId: fallback?.tabId || tab?.id || null,
                url: observed.url,
                title: typeof observed.title === 'string' ? observed.title : '',
                documentId: typeof observed.documentId === 'string' ? observed.documentId : null
            };
        }
        if (tab?.id || tab?.url || tab?.loadUrl) {
            return {
                tabId: tab.id || fallback?.tabId || null,
                url: tab.loadUrl || tab.url || null,
                title: typeof tab.title === 'string' ? tab.title : '',
                documentId: null
            };
        }
        return fallback || null;
    }

    async batchRead({ requests = [], executeRead } = {}) {
        if (!Array.isArray(requests) || typeof executeRead !== 'function') {
            throw new Error('batchRead requires requests and an executeRead function.');
        }

        return Promise.all(requests.map(async (request) => {
            const initialDocument = this._documentIdentity(request.tabId);
            const result = await executeRead(request);
            const sourceDocument = this._resultDocumentIdentity(result, initialDocument);
            const currentDocument = this._documentIdentity(request.tabId);
            // Each page-content tool records the source document inside its
            // page-side evaluation. The host can only provide a current URL
            // snapshot without another uncoordinated page read, so do not
            // claim the source is still current when it cannot be proven.
            const identityVerified = false;
            const sourceIsCurrent = false;
            return {
                id: request.id,
                tool: request.tool,
                tabId: request.tabId,
                result,
                document: {
                    initial: initialDocument,
                    source: sourceDocument,
                    current: currentDocument,
                    identityVerified,
                    sourceIsCurrent
                }
            };
        }));
    }

    listTabs() {
        return this.tabManager.tabs
            .filter((tab) => !this._isProtectedTab(tab))
            .map((tab) => this._describeTab(tab));
    }

    getActiveTab() {
        const tab = this.tabManager.getActiveTab();
        return this._isProtectedTab(tab) ? null : this._describeTab(tab);
    }

    getTabInfo(tabId) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'getTabInfo');
        if (rejection) {
            return rejection;
        }

        return this._describeTab(tab);
    }

    openTab({ url = 'about:blank', activate = false, title = 'New Tab', assistantOwned = true, role = 'browser', hidden = false, partition = null, trackHistory = true } = {}) {
        const safeUrl = normalizeBrowserToolUrl(url);
        if (!safeUrl) return {ok: false, error: 'Browser tools allow only HTTP, HTTPS, or about:blank URLs.'};
        url = safeUrl;
        if (this._isAssistantWorkspaceUrl(url)) {
            return { ok: false, error: 'Assistant workspace tabs can only be opened by the host UI.' };
        }

        const tabId = this.tabManager.createTab(url, {
            activate,
            title,
            assistantOwned,
            role,
            hidden,
            partition,
            trackHistory
        });

        const tab = this.getTab(tabId);

        return this._normalizeActionTarget({ id: tabId }, tab);
    }

    focusTab({ tabId } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'focusTab');
        if (rejection) {
            return rejection;
        }

        this.tabManager.switchToTab(tabId);
        return { ok: true, tab: this._describeTab(tab) };
    }

    closeTab({ tabId } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'closeTab');
        if (rejection) {
            return rejection;
        }

        this.tabManager.closeTab(tabId);
        return { ok: true, closedTabId: tabId };
    }

    async navigateTab({ tabId, url, timeoutMs = 12000 } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'navigateTab');
        if (rejection) {
            return rejection;
        }
        const safeUrl = normalizeBrowserToolUrl(url);
        if (!safeUrl) return {ok: false, error: 'Browser tools allow only HTTP, HTTPS, or about:blank URLs.'};
        url = safeUrl;
        if (this._isAssistantWorkspaceUrl(url)) {
            return { ok: false, error: 'Assistant workspace tabs cannot be loaded through browsing tools.' };
        }

        tab.loadUrl = url;
        if (!tab.internal) {
            tab.url = url;
        }

        if (typeof tab.webview.loadURL === 'function') {
            tab.webview.loadURL(url);
        } else {
            tab.webview.src = url;
        }

        const waitResult = await this.waitForLoad({
            tabId,
            timeoutMs,
            settleMs: 250,
            requireNavigation: true
        });

        if (!waitResult?.ok) {
            return {
                ...waitResult,
                tab: this._describeTab(tab)
            };
        }

        return this._normalizeActionTarget({ waitResult }, tab);
    }

    waitForLoad({ tabId, timeoutMs = 10000, settleMs = 250, requireNavigation = false } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'waitForLoad');
        if (rejection) {
            return Promise.resolve(rejection);
        }

        const webview = tab.webview;
        const initialUrl = this._getCurrentTabUrl(tab);

        return new Promise((resolve) => {
            let settled = false;
            let sawLoadingStart = false;
            let sawLoadStop = false;

            try {
                sawLoadingStart = typeof webview.isLoading === 'function' && webview.isLoading();
            } catch (error) {
                console.warn(`[BrowserTools] Could not read loading state for tab ${tab.id}: ${error?.message || error}`);
                sawLoadingStart = false;
            }

            const finish = (result) => {
                if (settled) {
                    return;
                }
                settled = true;
                cleanup();
                resolve(result);
            };

            const onStart = () => {
                sawLoadingStart = true;
            };

            const onStop = () => {
                sawLoadStop = true;
                finish({
                    ok: true,
                    tab: this._describeTab(tab),
                    loaded: true,
                    navigationStarted: sawLoadingStart
                });
            };
            const onFail = (event) => finish({
                ...this._failure(tab, event?.errorDescription || 'Page failed to load', {
                    tool: requireNavigation ? 'navigate_tab' : 'wait_for_load',
                    fallbackCode: 'browser_navigation_failed',
                    fallbackObserved: true
                }),
                navigationStarted: sawLoadingStart
            });

            const startTimer = setTimeout(() => {
                if (settled) {
                    return;
                }

                const currentUrl = this._getCurrentTabUrl(tab);
                const urlChanged = currentUrl && initialUrl && currentUrl !== initialUrl;
                let isStillLoading = false;
                try {
                    isStillLoading = typeof webview.isLoading === 'function' ? webview.isLoading() : false;
                } catch (error) {
                    console.warn(`[BrowserTools] Could not read loading state for tab ${tab.id}: ${error?.message || error}`);
                    isStillLoading = false;
                }

                if (!sawLoadingStart && !sawLoadStop && !isStillLoading) {
                    if (!requireNavigation) {
                        finish({
                            ok: true,
                            tab: this._describeTab(tab),
                            alreadyLoaded: true,
                            navigationStarted: false,
                            currentUrl,
                            initialUrl
                        });
                    } else if (urlChanged) {
                        finish({
                            ok: true,
                            tab: this._describeTab(tab),
                            alreadyLoaded: true,
                            navigationStarted: false,
                            currentUrl,
                            initialUrl
                        });
                    } else {
                        finish({
                            ...this._failure(tab, `Navigation did not start for tab ${tabId}.`, {
                                tool: requireNavigation ? 'navigate_tab' : 'wait_for_load',
                                fallbackCode: 'browser_navigation_not_started',
                                fallbackObserved: true
                            }),
                            navigationStarted: false,
                            currentUrl,
                            initialUrl
                        });
                    }
                }
            }, settleMs);

            const timer = setTimeout(() => {
                finish({
                    ...this._failure(tab, `Timed out waiting for tab ${tabId}`, {
                        tool: requireNavigation ? 'navigate_tab' : 'wait_for_load',
                        fallbackCode: 'browser_timeout',
                        fallbackObserved: true,
                        actionMayHaveCompleted: requireNavigation
                    })
                });
            }, timeoutMs);

            const cleanup = () => {
                clearTimeout(startTimer);
                clearTimeout(timer);
                webview.removeEventListener('did-start-loading', onStart);
                webview.removeEventListener('did-stop-loading', onStop);
                webview.removeEventListener('did-fail-load', onFail);
            };

            webview.addEventListener('did-start-loading', onStart, { once: true });
            webview.addEventListener('did-stop-loading', onStop, { once: true });
            webview.addEventListener('did-fail-load', onFail, { once: true });
        });
    }

    waitForElement({
        tabId,
        selector,
        index = 0,
        present = true,
        visible,
        enabled,
        text,
        textChangedFrom,
        caseSensitive = false,
        timeoutMs = 10000,
        pollIntervalMs = 100,
        signal
    } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'waitForElement');
        if (rejection) {
            return Promise.resolve(rejection);
        }

        const normalizedSelector = typeof selector === 'string' ? selector.trim() : '';
        if (!normalizedSelector || normalizedSelector.length > 1_000) {
            return Promise.resolve({ ok: false, error: 'waitForElement requires a selector of at most 1000 characters.', tab: this._describeTab(tab) });
        }
        if (!Number.isInteger(index) || index < 0 || index > 100) {
            return Promise.resolve({ ok: false, error: 'waitForElement index must be an integer between 0 and 100.', tab: this._describeTab(tab) });
        }
        if (typeof present !== 'boolean' || (visible !== undefined && typeof visible !== 'boolean') || (enabled !== undefined && typeof enabled !== 'boolean') || typeof caseSensitive !== 'boolean') {
            return Promise.resolve({ ok: false, error: 'waitForElement present, visible, enabled, and caseSensitive must be booleans when provided.', tab: this._describeTab(tab) });
        }
        if (!present && (visible !== undefined || enabled !== undefined || text !== undefined || textChangedFrom !== undefined)) {
            return Promise.resolve({ ok: false, error: 'waitForElement cannot combine present: false with visible, enabled, or text conditions.', tab: this._describeTab(tab) });
        }
        if ((text !== undefined && (typeof text !== 'string' || !text.trim() || text.length > 512)) || (textChangedFrom !== undefined && (typeof textChangedFrom !== 'string' || textChangedFrom.length > 512))) {
            return Promise.resolve({ ok: false, error: 'waitForElement text and textChangedFrom must be strings of at most 512 characters; text cannot be blank.', tab: this._describeTab(tab) });
        }
        if (!Number.isInteger(timeoutMs) || timeoutMs < 500 || timeoutMs > 20_000) {
            return Promise.resolve({ ok: false, error: 'waitForElement timeoutMs must be an integer between 500 and 20000.', tab: this._describeTab(tab) });
        }
        if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 50 || pollIntervalMs > 1_000) {
            return Promise.resolve({ ok: false, error: 'waitForElement pollIntervalMs must be an integer between 50 and 1000.', tab: this._describeTab(tab) });
        }

        const condition = {
            present,
            ...(visible === undefined ? {} : { visible }),
            ...(enabled === undefined ? {} : { enabled }),
            ...(text === undefined ? {} : { text }),
            ...(textChangedFrom === undefined ? {} : { textChangedFrom }),
            ...(text !== undefined ? { caseSensitive: caseSensitive === true } : {})
        };
        const initialUrl = this._getCurrentTabUrl(tab);
        const startedAt = Date.now();
        const interval = pollIntervalMs;
        const safeText = typeof text === 'string' ? text : null;
        const safeTextChangedFrom = typeof textChangedFrom === 'string' ? textChangedFrom : null;
        const script = `(() => {
            const selector = ${JSON.stringify(normalizedSelector)};
            const index = ${JSON.stringify(index)};
            const expectedPresent = ${JSON.stringify(present)};
            const expectedVisible = ${JSON.stringify(visible)};
            const expectedEnabled = ${JSON.stringify(enabled)};
            const expectedText = ${JSON.stringify(safeText)};
            const textChangedFrom = ${JSON.stringify(safeTextChangedFrom)};
            const caseSensitive = ${JSON.stringify(caseSensitive === true)};
            const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
            const clip = (value, limit = 512) => value.length > limit ? value.slice(0, limit) : value;
            let nodes;
            try {
                nodes = Array.from(document.querySelectorAll(selector));
            } catch (error) {
                return { invalidSelector: true, error: String(error && error.message || error) };
            }
            const node = nodes[index] || null;
            const isVisible = (element) => {
                if (!element || !element.isConnected) return false;
                const style = window.getComputedStyle(element);
                if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0) return false;
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const isEnabled = (element) => {
                if (!element) return false;
                return !(element.matches(':disabled') || element.getAttribute('aria-disabled') === 'true');
            };
            const observedText = node ? normalizeText(node.innerText || node.textContent) : '';
            const observed = {
                present: !!node,
                visible: isVisible(node),
                enabled: isEnabled(node),
                text: clip(observedText),
                matchCount: nodes.length,
                url: location.href,
                title: document.title || ''
            };
            const normalizedExpectedText = expectedText === null ? null : normalizeText(expectedText);
            const normalizedTextChangedFrom = textChangedFrom === null ? null : normalizeText(textChangedFrom);
            const textForComparison = caseSensitive ? observedText : observedText.toLocaleLowerCase();
            const expectedTextForComparison = expectedText === null
                ? null
                : (caseSensitive ? normalizedExpectedText : normalizedExpectedText.toLocaleLowerCase());
            const stateMatches = observed.present === expectedPresent
                && (expectedVisible === undefined || observed.visible === expectedVisible)
                && (expectedEnabled === undefined || observed.enabled === expectedEnabled);
            const textMatches = expectedTextForComparison === null || textForComparison.includes(expectedTextForComparison);
            const textChanged = normalizedTextChangedFrom === null || observedText !== normalizedTextChangedFrom;
            return { satisfied: stateMatches && textMatches && textChanged, observed };
        })()`;

        return new Promise((resolve) => {
            let settled = false;
            let pollTimer = null;
            let timeoutTimer = null;
            let lastObserved = null;

            const currentUrl = () => this._getCurrentTabUrl(tab);
            const resultDetails = () => ({
                selector: normalizedSelector,
                index,
                condition,
                initialUrl,
                currentUrl: currentUrl(),
                navigated: currentUrl() !== initialUrl,
                elapsedMs: Date.now() - startedAt,
                ...(lastObserved ? { observed: lastObserved } : {})
            });
            const cleanup = () => {
                clearTimeout(pollTimer);
                clearTimeout(timeoutTimer);
                signal?.removeEventListener('abort', onAbort);
            };
            const finish = (result) => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(result);
            };
            const onAbort = () => finish({
                ...this._failure(tab, String(signal?.reason || 'Browser action was cancelled.'), {
                    tool: 'wait_for_element',
                    fallbackCode: 'browser_action_cancelled',
                    fallbackObserved: true
                }),
                ...resultDetails()
            });
            const scheduleNextPoll = () => {
                if (!settled) {
                    pollTimer = setTimeout(check, interval);
                }
            };
            const check = async () => {
                if (settled) return;
                if (signal?.aborted) {
                    onAbort();
                    return;
                }
                if (this.getTab(tabId) !== tab) {
                    finish({
                        ...this._failure(null, `Target tab ${tabId} was closed.`, {
                            tool: 'wait_for_element',
                            fallbackCode: 'browser_tab_closed',
                            fallbackObserved: true
                        }),
                        tabId,
                        targetTabClosed: true,
                        ...resultDetails()
                    });
                    return;
                }

                try {
                    const outcome = await tab.webview.executeJavaScript(script, true);
                    if (settled) return;
                    if (outcome?.invalidSelector) {
                        finish({
                            ...this._failure(tab, outcome.error || 'Invalid selector.', {
                                tool: 'wait_for_element',
                                fallbackCode: 'browser_invalid_selector',
                                fallbackObserved: true
                            }),
                            ...resultDetails()
                        });
                        return;
                    }
                    lastObserved = outcome?.observed || null;
                    if (outcome?.satisfied) {
                        finish({
                            ok: true,
                            tab: this._describeTab(tab),
                            ...resultDetails()
                        });
                        return;
                    }
                    scheduleNextPoll();
                } catch (error) {
                    if (this._isDomReadyError(error)) {
                        scheduleNextPoll();
                        return;
                    }
                    finish({
                        ...this._failure(tab, error, { tool: 'wait_for_element' }),
                        ...resultDetails()
                    });
                }
            };

            timeoutTimer = setTimeout(() => finish({
                ...this._failure(tab, `Timed out waiting for ${normalizedSelector} in tab ${tabId}.`, {
                    tool: 'wait_for_element',
                    fallbackCode: 'browser_timeout',
                    fallbackObserved: true
                }),
                ...resultDetails()
            }), timeoutMs);
            signal?.addEventListener('abort', onAbort, { once: true });
            check();
        });
    }

    async readPageText({ tabId, maxChars = 20000, selector = null, contentMode = 'full', includeDocumentIdentity = false } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'readPageText');
        if (rejection) {
            return rejection;
        }

        if (contentMode !== null && contentMode !== undefined && typeof contentMode !== 'string') {
            return {
                ok: false,
                error: 'contentMode must be one of full, main, article, or auto.',
                tab: this._describeTab(tab),
                extraction: { status: 'invalid_mode', requested: { selector, contentMode } }
            };
        }
        if (selector !== null && selector !== undefined && typeof selector !== 'string') {
            return {
                ok: false,
                error: 'readPageText selector must be a non-empty string when provided.',
                tab: this._describeTab(tab),
                extraction: { status: 'invalid_selector', requested: { selector, contentMode } }
            };
        }

        const normalizedMode = typeof contentMode === 'string' ? contentMode : 'full';
        const normalizedSelector = typeof selector === 'string' ? selector.trim() : null;
        const targetedRead = normalizedSelector !== null || normalizedMode !== 'full';

        // Keep the legacy path byte-for-byte compatible for existing callers.
        if (!targetedRead) {
            try {
                const raw = await this._executeJavaScriptWhenReady(
                    tab,
                    includeDocumentIdentity
                        ? `({
                            text: document.body ? document.body.innerText || '' : '',
                            observed: {
                                url: location.href,
                                title: document.title || '',
                                documentId: String(performance.timeOrigin || '')
                            }
                        })`
                        : `document.body ? document.body.innerText || '' : ''`
                );
                const text = includeDocumentIdentity && raw && typeof raw === 'object' ? raw.text : raw;
                const normalized = typeof text === 'string' ? text.trim() : '';
                const truncated = normalized.length > maxChars;

                return {
                    ok: true,
                    tab: this._describeTab(tab),
                    text: truncated ? normalized.slice(0, maxChars) : normalized,
                    length: normalized.length,
                    truncated,
                    ...(includeDocumentIdentity && raw?.observed && typeof raw.observed === 'object'
                        ? { observed: raw.observed }
                        : {})
                };
            } catch (error) {
                return this._failure(tab, error, { tool: 'read_page_text' });
            }
        }

        if (!['full', 'main', 'article', 'auto'].includes(normalizedMode)) {
            return {
                ok: false,
                error: 'contentMode must be one of full, main, article, or auto.',
                tab: this._describeTab(tab),
                extraction: { status: 'invalid_mode', requested: { selector: normalizedSelector, contentMode: normalizedMode } }
            };
        }
        if (selector !== null && (typeof selector !== 'string' || !normalizedSelector)) {
            return {
                ok: false,
                error: 'readPageText selector must be a non-empty string when provided.',
                tab: this._describeTab(tab),
                extraction: { status: 'invalid_selector', requested: { selector, contentMode: normalizedMode } }
            };
        }

        const normalizedMaxChars = Math.max(1, Math.min(20_000, Math.floor(Number(maxChars) || 20_000)));
        const payload = {
            selector: normalizedSelector,
            contentMode: normalizedMode,
            maxChars: normalizedMaxChars
        };
        const script = `(() => {
            const requestedSelector = ${JSON.stringify(payload.selector)};
            const contentMode = ${JSON.stringify(payload.contentMode)};
            const maxChars = ${payload.maxChars};
            const documentBody = document.body;
            if (!documentBody) {
                return {
                    ok: true,
                    text: '',
                    length: 0,
                    truncated: false,
                    extraction: {
                        status: 'empty_document',
                        mode: contentMode,
                        selector: requestedSelector,
                        fallback: false,
                        fallbackReason: null,
                        scope: 'main_frame'
                    }
                };
            }

            let root = documentBody;
            let extraction = {
                status: 'ok',
                mode: contentMode,
                selector: null,
                fallback: false,
                fallbackReason: null,
                scope: 'main_frame'
            };
            if (requestedSelector != null) {
                try {
                    root = document.querySelector(requestedSelector);
                } catch (error) {
                    return {
                        ok: false,
                        error: 'Invalid selector: ' + (error.message || String(error)),
                        extraction: {
                            ...extraction,
                            status: 'invalid_selector',
                            selector: requestedSelector
                        }
                    };
                }
                if (!root) {
                    return {
                        ok: false,
                        error: 'No element matched selector: ' + requestedSelector,
                        extraction: {
                            ...extraction,
                            status: 'selector_not_found',
                            selector: requestedSelector
                        }
                    };
                }
                extraction = {
                    ...extraction,
                    mode: 'selector',
                    selector: requestedSelector,
                    element: root.tagName.toLowerCase()
                };
            } else if (contentMode !== 'full') {
                const candidates = contentMode === 'article'
                    ? ['article', '[role="article"]']
                    : contentMode === 'main'
                        ? ['main', '[role="main"]']
                        : ['article', 'main', '[role="article"]', '[role="main"]'];
                let matchedSelector = null;
                for (const candidate of candidates) {
                    const candidateRoot = document.querySelector(candidate);
                    if (candidateRoot) {
                        root = candidateRoot;
                        matchedSelector = candidate;
                        break;
                    }
                }
                if (matchedSelector) {
                    extraction = {
                        ...extraction,
                        selector: matchedSelector,
                        element: root.tagName.toLowerCase()
                    };
                } else {
                    extraction = {
                        ...extraction,
                        mode: 'full',
                        fallback: true,
                        fallbackReason: contentMode + '_region_not_found',
                        selector: 'body',
                        element: 'body'
                    };
                }
            } else {
                extraction = { ...extraction, selector: 'body', element: 'body' };
            }

            const normalizedText = String(root.innerText || root.textContent || '').trim();
            return {
                ok: true,
                text: normalizedText.slice(0, maxChars),
                length: normalizedText.length,
                truncated: normalizedText.length > maxChars,
                observed: {
                    url: location.href,
                    title: document.title || '',
                    documentId: String(performance.timeOrigin || '')
                },
                extraction
            };
        })();`;

        try {
            const result = await this._executeJavaScriptWhenReady(tab, script);
            const extraction = result && typeof result === 'object' ? result : {};
            if (extraction.ok === false) {
                return {
                    ok: false,
                    error: extraction.error || 'Targeted content extraction failed.',
                    tab: this._describeTab(tab),
                    extraction: extraction.extraction || { status: 'unknown_error', requested: { selector: normalizedSelector, contentMode: normalizedMode } }
                };
            }

            return {
                ok: true,
                tab: this._describeTab(tab),
                text: typeof extraction.text === 'string' ? extraction.text : '',
                length: Number.isInteger(extraction.length) ? extraction.length : 0,
                truncated: extraction.truncated === true,
                extraction: extraction.extraction || { status: 'unknown', requested: { selector: normalizedSelector, contentMode: normalizedMode } },
                ...(includeDocumentIdentity && extraction.observed && typeof extraction.observed === 'object'
                    ? { observed: extraction.observed }
                    : {})
            };
        } catch (error) {
            return this._failure(tab, error, { tool: 'read_page_text' });
        }
    }

    async findPageText({
        tabId,
        query,
        contextChars = 240,
        maxMatches = 20,
        caseSensitive = false
    } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'findPageText');
        if (rejection) {
            return rejection;
        }
        if (typeof query !== 'string' || query.length === 0) {
            return { ok: false, error: 'findPageText requires a non-empty literal query.', tab: this._describeTab(tab) };
        }
        if (query.length > 512) {
            return { ok: false, error: 'findPageText query must be at most 512 characters.', tab: this._describeTab(tab) };
        }

        const normalizedQuery = query;
        const normalizedContextChars = Math.max(0, Math.min(512, Math.floor(Number(contextChars) || 0)));
        const normalizedMaxMatches = Math.max(1, Math.min(50, Math.floor(Number(maxMatches) || 20)));
        const normalizedCaseSensitive = caseSensitive === true;
        const payload = {
            query: normalizedQuery,
            contextChars: normalizedContextChars,
            maxMatches: normalizedMaxMatches,
            caseSensitive: normalizedCaseSensitive,
            scanLimit: 1_000_000
        };

        const script = `(() => {
            const query = ${JSON.stringify(payload.query)};
            const contextChars = ${payload.contextChars};
            const maxMatches = ${payload.maxMatches};
            const caseSensitive = ${payload.caseSensitive};
            const scanLimit = ${payload.scanLimit};
            const sourceText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
            const scannedText = sourceText.slice(0, scanLimit);
            const haystack = caseSensitive ? scannedText : scannedText.toLocaleLowerCase();
            const needle = caseSensitive ? query : query.toLocaleLowerCase();
            const matches = [];
            let matchCount = 0;
            let searchFrom = 0;

            while (searchFrom <= haystack.length - needle.length) {
                const start = haystack.indexOf(needle, searchFrom);
                if (start < 0) break;
                matchCount += 1;
                if (matches.length < maxMatches) {
                    const end = start + query.length;
                    const snippetStart = Math.max(0, start - contextChars);
                    const snippetEnd = Math.min(scannedText.length, end + contextChars);
                    matches.push({
                        index: matchCount - 1,
                        start,
                        end,
                        snippetStart,
                        snippetEnd,
                        match: scannedText.slice(start, end),
                        snippet: scannedText.slice(snippetStart, snippetEnd)
                    });
                }
                // Advancing by one keeps overlapping literal matches and preserves source order.
                searchFrom = start + 1;
            }

            const scanTruncated = sourceText.length > scannedText.length;
            return {
                observed: {
                    url: location.href,
                    title: document.title || '',
                    documentId: String(performance.timeOrigin || '')
                },
                scope: {
                    frame: 'main_frame',
                    subframes: 'not_searched'
                },
                sourceLength: sourceText.length,
                scannedChars: scannedText.length,
                matchCount,
                matchCountExact: !scanTruncated,
                noMatches: matchCount === 0,
                matches,
                truncated: {
                    matches: matchCount > matches.length,
                    scan: scanTruncated
                }
            };
        })();`;

        try {
            const result = await this._executeJavaScriptWhenReady(tab, script);
            const extraction = result && typeof result === 'object' ? result : {};
            return {
                ok: true,
                tab: this._describeTab(tab),
                query: normalizedQuery,
                caseSensitive: normalizedCaseSensitive,
                contextChars: normalizedContextChars,
                maxMatches: normalizedMaxMatches,
                observed: extraction.observed && typeof extraction.observed === 'object'
                    ? extraction.observed
                    : { url: this._getCurrentTabUrl(tab), title: tab.title || '' },
                scope: extraction.scope && typeof extraction.scope === 'object'
                    ? extraction.scope
                    : { frame: 'main_frame', subframes: 'not_searched' },
                sourceLength: Number.isInteger(extraction.sourceLength) ? extraction.sourceLength : 0,
                scannedChars: Number.isInteger(extraction.scannedChars) ? extraction.scannedChars : 0,
                matchCount: Number.isInteger(extraction.matchCount) ? extraction.matchCount : 0,
                matchCountExact: extraction.matchCountExact === true,
                noMatches: extraction.noMatches === true,
                matches: Array.isArray(extraction.matches) ? extraction.matches : [],
                truncated: extraction.truncated || { matches: false, scan: false }
            };
        } catch (error) {
            return this._failure(tab, error, { tool: 'find_page_text' });
        }
    }

    async querySelectorAll({
        tabId,
        selector,
        fields = ['text'],
        offset = 0,
        maxResults = 200,
        maxTextChars = null,
        textOffset = 0,
        maxOutputChars = null,
        compact = false,
        includeDocumentIdentity = false
    } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'querySelectorAll');
        if (rejection) {
            return rejection;
        }
        if (!selector || typeof selector !== 'string') {
            return { ok: false, error: 'querySelectorAll requires a selector' };
        }

        const compactProfile = compact === true;
        const normalizedOffset = Math.max(0, Math.floor(Number(offset) || 0));
        const normalizedMaxResults = Math.max(1, Math.min(200, Math.floor(Number(maxResults) || (compactProfile ? 20 : 200))));
        const normalizedMaxTextChars = maxTextChars !== null && maxTextChars !== undefined && Number.isFinite(Number(maxTextChars))
            ? Math.max(1, Math.min(20_000, Math.floor(Number(maxTextChars))))
            : compactProfile ? 280 : null;
        const normalizedTextOffset = Math.max(0, Math.floor(Number(textOffset) || 0));
        const normalizedMaxOutputChars = maxOutputChars !== null && maxOutputChars !== undefined && Number.isFinite(Number(maxOutputChars))
            ? Math.max(256, Math.min(64_000, Math.floor(Number(maxOutputChars))))
            : compactProfile ? 6_000 : null;
        const payload = {
            selector,
            fields: Array.isArray(fields) ? fields : ['text'],
            offset: normalizedOffset,
            maxResults: normalizedMaxResults,
            maxTextChars: normalizedMaxTextChars,
            textOffset: normalizedTextOffset,
            maxOutputChars: normalizedMaxOutputChars
        };

        const script = `(() => {
            const selector = ${JSON.stringify(payload.selector)};
            const fields = ${JSON.stringify(payload.fields)};
            const offset = ${payload.offset};
            const maxResults = ${payload.maxResults};
            const maxTextChars = ${JSON.stringify(payload.maxTextChars)};
            const textOffset = ${payload.textOffset};
            const maxOutputChars = ${JSON.stringify(payload.maxOutputChars)};
            const elements = Array.from(document.querySelectorAll(selector));
            const totalMatches = elements.length;
            const items = [];
            const truncatedItemIndexes = [];
            let outputChars = 0;
            let textTruncated = false;
            let outputTruncated = false;

            const stringValue = (value) => String(value == null ? '' : value);
            const boundedText = (value) => {
                const original = stringValue(value);
                const fromOffset = original.slice(textOffset);
                const truncatedByOffset = textOffset > 0 && textOffset < original.length;
                if (maxTextChars == null || fromOffset.length <= maxTextChars) {
                    return { value: fromOffset, truncated: truncatedByOffset };
                }
                return { value: fromOffset.slice(0, maxTextChars), truncated: true };
            };
            const fitsOutput = (item, available) => JSON.stringify(item).length <= available;

            for (let index = offset; index < totalMatches && items.length < maxResults; index += 1) {
                const element = elements[index];
                const item = { index };
                let itemTruncated = false;
                for (const field of fields) {
                    if (field === 'text') {
                        const bounded = boundedText((element.innerText || element.textContent || '').trim());
                        item.text = bounded.value;
                        itemTruncated = itemTruncated || bounded.truncated;
                        textTruncated = textTruncated || bounded.truncated;
                    }
                    else if (field === 'html') item.html = element.outerHTML;
                    else if (field === 'href') item.href = element.href || element.getAttribute('href') || null;
                    else if (field === 'src') item.src = element.src || element.getAttribute('src') || null;
                    else if (field === 'value') item.value = element.value ?? null;
                    else if (field === 'tagName') item.tagName = element.tagName;
                    else if (field === 'id') item.id = element.id || null;
                    else if (field === 'className') item.className = element.className || null;
                    else if (field === 'title') item.title = element.title || null;
                    else if (field === 'ariaLabel') item.ariaLabel = element.getAttribute('aria-label') || null;
                    else if (field === 'role') item.role = element.getAttribute('role') || null;
                    else if (field === 'dataset') item.dataset = { ...element.dataset };
                    else if (field === 'boundingRect') {
                        const rect = element.getBoundingClientRect();
                        item.boundingRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
                    }
                }
                const itemBudget = maxOutputChars == null
                    ? Infinity
                    : Math.max(0, maxOutputChars - outputChars - (items.length > 0 ? 1 : 0));
                if (!fitsOutput(item, itemBudget)) {
                    outputTruncated = true;
                    truncatedItemIndexes.push(index);
                    break;
                }
                if (itemTruncated) truncatedItemIndexes.push(index);
                outputChars += JSON.stringify(item).length + (items.length > 0 ? 1 : 0);
                items.push(item);
            }

            const nextOffset = offset + items.length < totalMatches ? offset + items.length : null;
            return {
                items,
                totalMatches,
                offset,
                nextOffset,
                nextTextOffset: textTruncated && maxTextChars != null ? textOffset + maxTextChars : null,
                truncated: {
                    results: nextOffset != null,
                    text: textTruncated,
                    output: outputTruncated
                },
                truncatedItemIndexes,
                itemOutputChars: outputChars,
                observed: {
                    url: location.href,
                    title: document.title || '',
                    documentId: String(performance.timeOrigin || '')
                }
            };
        })();`;

        try {
            const result = await this._executeJavaScriptWhenReady(tab, script);
            const extraction = Array.isArray(result)
                ? { items: result, totalMatches: result.length, offset: normalizedOffset }
                : result && typeof result === 'object' ? result : {};
            return {
                ok: true,
                tab: this._describeTab(tab),
                selector,
                items: Array.isArray(extraction.items) ? extraction.items : [],
                totalMatches: Number.isInteger(extraction.totalMatches) ? extraction.totalMatches : 0,
                offset: Number.isInteger(extraction.offset) ? extraction.offset : normalizedOffset,
                nextOffset: Number.isInteger(extraction.nextOffset) ? extraction.nextOffset : null,
                nextTextOffset: Number.isInteger(extraction.nextTextOffset) ? extraction.nextTextOffset : null,
                truncated: extraction.truncated || { results: false, text: false, output: false },
                truncatedItemIndexes: Array.isArray(extraction.truncatedItemIndexes) ? extraction.truncatedItemIndexes : [],
                itemOutputChars: Number.isInteger(extraction.itemOutputChars) ? extraction.itemOutputChars : 0,
                ...(includeDocumentIdentity && extraction.observed && typeof extraction.observed === 'object'
                    ? { observed: extraction.observed }
                    : {})
            };
        } catch (error) {
            return this._failure(tab, error, { tool: 'query_selector_all' });
        }
    }

    async clickElement({ tabId, selector, index = 0 } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'clickElement');
        if (rejection) {
            return rejection;
        }
        if (!selector || typeof selector !== 'string') {
            return { ok: false, error: 'clickElement requires a selector' };
        }

        const script = `(() => {
            const selector = ${JSON.stringify(selector)};
            const index = ${Number.isInteger(index) ? index : 0};
            const nodes = Array.from(document.querySelectorAll(selector));
            const element = nodes[index];
            if (!element) {
                return { ok: false, error: 'Element not found' };
            }
            element.scrollIntoView({ block: 'center', inline: 'center' });
            element.click();
            return { ok: true, index };
        })();`;

        try {
            const result = await this._executeJavaScriptWhenReady(tab, script, { retryOnDomReady: false });
            if (!result || result.ok === false) {
                return this._failure(tab, result?.error || 'Element not found', { tool: 'click_element' });
            }
            return { ok: true, tab: this._describeTab(tab), ...result };
        } catch (error) {
            return this._failure(tab, error, { tool: 'click_element', actionMayHaveCompleted: !this._isDomReadyError(error) });
        }
    }

    async pressAndHold({ tabId, selector, index = 0, holdMs = 3000, jitter = true } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'pressAndHold');
        if (rejection) {
            return rejection;
        }
        if (!selector || typeof selector !== 'string') {
            return { ok: false, error: 'pressAndHold requires a selector' };
        }
        if (typeof tab.webview?.sendInputEvent !== 'function') {
            return { ok: false, error: 'pressAndHold requires a webview that supports sendInputEvent.', tab: this._describeTab(tab) };
        }

        const clampedHold = Math.min(15000, Math.max(200, Number(holdMs) || 3000));

        // Resolve the button center in webview-viewport coordinates (which is
        // what sendInputEvent expects).
        const locateScript = `(() => {
            const selector = ${JSON.stringify(selector)};
            const index = ${Number.isInteger(index) ? index : 0};
            const node = Array.from(document.querySelectorAll(selector))[index];
            if (!node) {
                return { ok: false, error: 'Element not found' };
            }
            if (typeof node.scrollIntoView === 'function') {
                node.scrollIntoView({ block: 'center', inline: 'center' });
            }
            const rect = node.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
                return { ok: false, error: 'Element has no clickable box.' };
            }
            return { ok: true, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })();`;

        try {
            const located = await this._executeJavaScriptWhenReady(tab, locateScript, { retryOnDomReady: false });
            if (!located?.ok) {
                return this._failure(tab, located?.error || 'Could not locate element.', { tool: 'press_and_hold' });
            }

            const baseX = located.x;
            const baseY = located.y;
            const webview = tab.webview;

            // Move, press, hold (with small human-like jitter), then release.
            // sendInputEvent produces trusted (isTrusted) input, unlike a JS
            // element.click(), which press-and-hold bot walls reject.
            webview.sendInputEvent({ type: 'mouseMove', x: baseX, y: baseY });
            webview.sendInputEvent({ type: 'mouseDown', x: baseX, y: baseY, button: 'left', clickCount: 1 });

            const startedAt = Date.now();
            while (Date.now() - startedAt < clampedHold) {
                await this._delay(120);
                if (jitter) {
                    const jx = baseX + (Math.random() * 2 - 1);
                    const jy = baseY + (Math.random() * 2 - 1);
                    webview.sendInputEvent({ type: 'mouseMove', x: jx, y: jy, button: 'left' });
                }
            }

            webview.sendInputEvent({ type: 'mouseUp', x: baseX, y: baseY, button: 'left', clickCount: 1 });

            return { ok: true, tab: this._describeTab(tab), heldMs: clampedHold, x: baseX, y: baseY };
        } catch (error) {
            return this._failure(tab, error, { tool: 'press_and_hold', actionMayHaveCompleted: !this._isDomReadyError(error) });
        }
    }

    async typeInto({ tabId, selector, text, submit = false, clear = true } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'typeInto');
        if (rejection) {
            return rejection;
        }
        if (!selector || typeof selector !== 'string') {
            return { ok: false, error: 'typeInto requires a selector' };
        }
        if (typeof text !== 'string') {
            return { ok: false, error: 'typeInto requires text' };
        }

        const script = `(() => {
            const selector = ${JSON.stringify(selector)};
            const text = ${JSON.stringify(text)};
            const clear = ${JSON.stringify(!!clear)};
            const submit = ${JSON.stringify(!!submit)};
            const element = document.querySelector(selector);
            if (!element) {
                return { ok: false, error: 'Element not found' };
            }
            const focusable = element;
            focusable.focus();
            if (clear && 'value' in focusable) {
                focusable.value = '';
            }
            if ('value' in focusable) {
                focusable.value = text;
                focusable.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                focusable.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            } else {
                document.execCommand('insertText', false, text);
            }
            if (submit) {
                const form = focusable.form || document.querySelector('form');
                if (form) {
                    if (typeof form.requestSubmit === 'function') {
                        form.requestSubmit();
                    } else if (typeof form.submit === 'function') {
                        form.submit();
                    } else {
                        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                    }
                } else {
                    focusable.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                }
            }
            return { ok: true };
        })();`;

        try {
            const result = await this._executeJavaScriptWhenReady(tab, script, { retryOnDomReady: false });
            if (!result || result.ok === false) {
                return this._failure(tab, result?.error || 'Element not found', { tool: 'type_into' });
            }
            const waitResult = submit ? await this.waitForLoad({
                tabId,
                timeoutMs: 12000,
                settleMs: 250,
                requireNavigation: true
            }) : null;

            if (waitResult && waitResult.ok === false) {
                return {
                    ...waitResult,
                    submitted: true,
                    actionMayHaveCompleted: true,
                    tab: this._describeTab(tab)
                };
            }

            return this._normalizeActionTarget({ waitResult, ...result }, tab);
        } catch (error) {
            return this._failure(tab, error, { tool: 'type_into', actionMayHaveCompleted: !this._isDomReadyError(error) });
        }
    }

    async scrollPage({ tabId, direction = 'down', amount = 800 } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'scrollPage');
        if (rejection) {
            return rejection;
        }

        const delta = direction === 'up' ? -Math.abs(amount) : Math.abs(amount);
        const script = `(() => {
            window.scrollBy({ top: ${delta}, behavior: 'auto' });
            return { ok: true, scrollY: window.scrollY };
        })();`;

        try {
            const result = await this._executeJavaScriptWhenReady(tab, script, { retryOnDomReady: false });
            return this._normalizeActionTarget(result, tab);
        } catch (error) {
            return this._failure(tab, error, { tool: 'scroll_page', actionMayHaveCompleted: !this._isDomReadyError(error) });
        }
    }

    async searchSite({ tabId, query, siteHint = '', timeoutMs = 12000 } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'searchSite');
        if (rejection) {
            return rejection;
        }
        if (typeof query !== 'string' || !query.trim()) {
            return { ok: false, error: 'searchSite requires a non-empty query', tab: this._describeTab(tab) };
        }

        const normalizedQuery = query.trim();
        const normalizedHint = String(siteHint || '').toLowerCase();

        try {
            const initialWaitResult = await this._prepareTabForInteraction(tab, {
                timeoutMs: Math.min(timeoutMs, 10000),
                settleMs: 250
            });

            if (initialWaitResult?.ok === false && !initialWaitResult?.alreadyLoaded) {
                return {
                    ...initialWaitResult,
                    tab: this._describeTab(tab)
                };
            }
        } catch (error) {
            return { ok: false, error: error.message || String(error), tab: this._describeTab(tab) };
        }

        const script = `(() => {
            try {
            const query = ${JSON.stringify(normalizedQuery)};
            const siteHint = ${JSON.stringify(normalizedHint)};
            const normalizeText = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return style && style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 0 && rect.height > 0;
            };

            const scoreCandidate = (element) => {
                let score = 0;
                const attrs = {
                    id: (element.id || '').toLowerCase(),
                    name: (element.getAttribute('name') || '').toLowerCase(),
                    type: (element.getAttribute('type') || '').toLowerCase(),
                    placeholder: (element.getAttribute('placeholder') || '').toLowerCase(),
                    ariaLabel: (element.getAttribute('aria-label') || '').toLowerCase(),
                    title: (element.getAttribute('title') || '').toLowerCase(),
                    role: (element.getAttribute('role') || '').toLowerCase(),
                    autocomplete: (element.getAttribute('autocomplete') || '').toLowerCase()
                };
                const value = (element.value || '').toLowerCase();

                if (!isVisible(element)) score -= 100;
                if (element.disabled) score -= 100;
                if (attrs.type === 'search') score += 60;
                if (attrs.role === 'searchbox') score += 55;
                if (attrs.autocomplete === 'off') score += 10;
                if (attrs.id.includes('search')) score += 25;
                if (attrs.name.includes('search') || attrs.name === 'q' || attrs.name.includes('_nkw')) score += 25;
                if (attrs.placeholder.includes('search')) score += 20;
                if (attrs.ariaLabel.includes('search')) score += 20;
                if (attrs.title.includes('search')) score += 15;
                if (attrs.id.includes('gh-ac') || attrs.id.includes('sresult')) score += 40;
                if (attrs.name.includes('gh-ac') || attrs.name.includes('_nkw')) score += 40;
                if (siteHint.includes('ebay')) {
                    if (attrs.id.includes('gh-ac')) score += 100;
                    if (attrs.name.includes('_nkw')) score += 100;
                    if (attrs.id.includes('gh-btn') || attrs.name.includes('sacat')) score += 10;
                }
                if (value && value.length > 0) score += 5;
                const tag = element.tagName.toLowerCase();
                if (tag === 'textarea') score -= 15;
                if (tag === 'input') score += 10;
                if (tag === 'button') score -= 50;
                return score;
            };

            const candidateSelectors = [
                'input[type="search"]',
                'input[name="q"]',
                'input[name*="search" i]',
                'input[id*="search" i]',
                'input[placeholder*="search" i]',
                'input[aria-label*="search" i]',
                '[role="searchbox"]',
                'form[role="search"] input',
                'form.search input',
                'input:not([type="hidden"])'
            ];

            if (siteHint.includes('ebay')) {
                candidateSelectors.unshift(
                    '#gh-ac',
                    'input[name="_nkw"]',
                    'input[id*="gh-ac" i]',
                    'form#gh-f input',
                    '#gh-f input'
                );
            }

            const seen = new Set();
            const candidates = [];
            for (const selector of candidateSelectors) {
                for (const element of Array.from(document.querySelectorAll(selector))) {
                    if (seen.has(element)) continue;
                    seen.add(element);
                    const score = scoreCandidate(element);
                    if (score < 0) continue;
                    candidates.push({
                        element,
                        selector,
                        tagName: element.tagName,
                        id: element.id || null,
                        name: element.getAttribute('name') || null,
                        type: element.getAttribute('type') || null,
                        placeholder: element.getAttribute('placeholder') || null,
                        ariaLabel: element.getAttribute('aria-label') || null,
                        title: element.getAttribute('title') || null,
                        role: element.getAttribute('role') || null,
                        formAction: element.form?.action || null,
                        formMethod: element.form?.method || null,
                        score
                    });
                }
            }

            candidates.sort((a, b) => b.score - a.score);
            const top = candidates[0];
            if (!top) {
                return { ok: false, error: 'No usable search field was found.', candidates: [] };
            }

            const target = top.element;
            if (!target) {
                return { ok: false, error: 'Search field disappeared before it could be used.', candidates: candidates.slice(0, 8) };
            }

            target.focus();
            if ('value' in target) {
                target.value = '';
                target.value = query;
                target.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
                target.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            } else {
                target.textContent = query;
            }

            let submitted = false;
            const form = target.form || target.closest('form');
            if (form) {
                submitted = true;
                let submitWorked = false;
                if (typeof form.requestSubmit === 'function') {
                    try {
                        form.requestSubmit();
                        submitWorked = true;
                    } catch {
                        submitWorked = false;
                    }
                }
                if (!submitWorked && typeof form.submit === 'function') {
                    try {
                        form.submit();
                        submitWorked = true;
                    } catch {
                        submitWorked = false;
                    }
                }
                if (!submitWorked) {
                    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
                }
            } else {
                target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                target.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
                submitted = true;
            }

            return {
                ok: true,
                submitted,
                query,
                siteHint,
                beforeState: {
                    url: window.location.href,
                    title: document.title || '',
                    textSample: normalizeText(document.body ? document.body.innerText || '' : '').slice(0, 1500)
                },
                selected: {
                    selector: top.selector,
                    tagName: top.tagName,
                    id: top.id,
                    name: top.name,
                    type: top.type,
                    placeholder: top.placeholder,
                    ariaLabel: top.ariaLabel,
                    title: top.title,
                    role: top.role,
                    formAction: top.formAction,
                    formMethod: top.formMethod,
                    score: top.score
                },
                candidates: candidates.slice(0, 8).map(({ element, ...candidate }) => candidate)
            };
            } catch (error) {
                return {
                    ok: false,
                    error: 'Page script failed: ' + (error && error.message ? error.message : String(error)),
                    stack: String(error?.stack || ''),
                    candidates: []
                };
            }
        })();`;

        try {
            const result = await this._executeJavaScriptWhenReady(tab, script, { retryOnDomReady: false });
            if (!result || result.ok === false) {
                return {
                    ...this._failure(tab, result?.error || 'Failed to search the page.', { tool: 'search_site' }),
                    candidates: result?.candidates || [],
                    stack: result?.stack || null
                };
            }

            const waitResult = await this.waitForLoad({
                tabId,
                timeoutMs,
                settleMs: 250,
                requireNavigation: true
            });

            if (!waitResult?.ok) {
                if (/Navigation did not start/i.test(waitResult?.error || '')) {
                    const sameDocumentCheck = await this._executeJavaScriptWhenReady(
                        tab,
                        `(() => {
                            const query = ${JSON.stringify(normalizedQuery)};
                            const previous = ${JSON.stringify(result?.beforeState || null)};
                            const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
                            const currentUrl = window.location.href;
                            const currentTitle = normalize(document.title || '');
                            const currentText = normalize(document.body ? document.body.innerText || '' : '');
                            const currentSample = currentText.slice(0, 1500);
                            const previousUrl = String(previous?.url || '');
                            const previousTitle = normalize(previous?.title || '');
                            const previousSample = normalize(previous?.textSample || '');
                            const terms = normalize(query)
                                .split(/[^a-z0-9]+/i)
                                .map((term) => term.trim())
                                .filter((term) => term && !['a', 'an', 'and', 'de', 'een', 'eur', 'euro', 'for', 'het', 'i', 'need', 'of', 'the', 'to', 'under', 'used'].includes(term));
                            const urlHaystack = currentUrl.toLowerCase();
                            const queryInUrl = terms.length > 0 && terms.every((term) => urlHaystack.includes(term));
                            const queryInTitle = terms.length > 0 && terms.some((term) => currentTitle.includes(term));
                            const queryInText = terms.length > 0 && terms.some((term) => currentText.includes(term));
                            const urlChanged = !!previousUrl && previousUrl !== currentUrl;
                            const titleChanged = !!previousTitle && previousTitle !== currentTitle;
                            const textChanged = !!previousSample && previousSample !== currentSample;
                            const looksLikeSearchState = queryInUrl || queryInTitle || queryInText || urlChanged || titleChanged || textChanged;

                            return {
                                ok: looksLikeSearchState,
                                currentUrl,
                                currentTitle,
                                queryInUrl,
                                queryInTitle,
                                queryInText,
                                urlChanged,
                                titleChanged,
                                textChanged
                            };
                        })();`
                    ).catch(() => null);

                    if (sameDocumentCheck?.ok) {
                        return this._normalizeActionTarget({
                            ...result,
                            waitResult: {
                                ...waitResult,
                                ok: true,
                                sameDocument: true,
                                verification: sameDocumentCheck
                            }
                        }, tab);
                    }
                }

                return {
                    ...waitResult,
                    tab: this._describeTab(tab),
                    selected: result?.selected,
                    candidates: result?.candidates || [],
                    stack: result?.stack || null,
                    actionMayHaveCompleted: true
                };
            }

            return this._normalizeActionTarget({ ...result, waitResult }, tab);
        } catch (error) {
            return this._failure(tab, error, { tool: 'search_site', actionMayHaveCompleted: !this._isDomReadyError(error) });
        }
    }

    async extractSearchResults({ tabId, siteHint = '' } = {}) {
        const tab = this.getTab(tabId);
        const rejection = this._rejectProtectedTab(tab, 'extractSearchResults');
        if (rejection) {
            return rejection;
        }

        const hint = String(siteHint || '').toLowerCase();
        const script = `(() => {
            try {
            const siteHint = ${JSON.stringify(hint)};
            const bikeTerms = ['bike', 'bicycle', 'fiets', 'fietsen', 'fietsje', 'cycle', 'fahrrad', 'velo', 'mountainbike', 'racefiets', 'ebike', 'e-bike'];
            const bikeNoiseTerms = ['adapter', 'diagnose', 'diagnostic', 'mirror', 'glass', 'stamps', 'stamp', 'collection', 'mercedes', 'obd', 'fairing', 'motorcycle', 'motorbike', 'moto', 'scooter', 'helmet', 'car', 'auto', 'parts', 'part', 'charger', 'scanner', 'tool'];
            const categoryNoiseTerms = ['rubriek', 'category', 'categorie', 'shop by category', 'sport en vrije tijd', 'fietsen en wielersport', 'fietsaccessoires', 'fietsonderdelen', 'objectstaat'];
            const currencyPattern = /(?:€|EUR|\\$|£)\\s?\\d[\\d.,]*/i;
            const junkPatterns = [
                /shop on ebay/i,
                /results matching/i,
                /sponsored/i,
                /more results/i,
                /see all/i,
                /feedback/i,
                /watch list/i,
                /add to cart/i
            ];
            const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
            const extractedQuery = (() => {
                try {
                    const url = new URL(window.location.href);
                    for (const key of ['_nkw', 'q', 'query', 'keyword', 'keywords']) {
                        const value = url.searchParams.get(key);
                        if (value) {
                            return normalizeText(decodeURIComponent(value));
                        }
                    }
                } catch {
                    // Ignore URL parsing issues.
                }
                return '';
            })();
            const queryTerms = normalizeText(extractedQuery.toLowerCase())
                .split(/[^a-z0-9]+/i)
                .map((term) => term.trim())
                .filter((term) => term && !['used', 'under', 'euro', 'eur', 'best', 'buy', 'new', 'nieuw', 'of', 'the', 'and', 'for', 'with', 'from', 'to', 'a', 'an', 'de', 'het', 'een'].includes(term));
            const hasBikeIntent = bikeTerms.some((term) => extractedQuery.toLowerCase().includes(term));

            const isVisible = (element) => {
                if (!element) return false;
                const style = window.getComputedStyle(element);
                if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
                    return false;
                }
                const rect = element.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const absoluteUrl = (value) => {
                const raw = String(value || '').trim();
                if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) {
                    return null;
                }
                try {
                    return new URL(raw, document.baseURI).href;
                } catch {
                    return raw || null;
                }
            };
            const cleanTitle = (value) => normalizeText(value).replace(/^new listing\\s*/i, '').trim();
            const isLikelyListingUrl = (value) => /\\/itm\\/|\\/p\\/|[?&]item=/i.test(String(value || ''));
            const scoreResult = (item) => {
                let score = 0;
                const textBlob = normalizeText((item.title || '') + ' ' + (item.snippet || '') + ' ' + (item.condition || '')).toLowerCase();
                if (item.title) score += 40;
                if (item.href) score += 20;
                if (item.price) score += 20;
                if (item.location) score += 5;
                if (item.condition) score += 5;
                if (item.shipping) score += 5;
                if (item.href && isLikelyListingUrl(item.href)) score += 25;
                if (item.href && !isLikelyListingUrl(item.href)) score -= 80;
                if (bikeTerms.some((term) => textBlob.includes(term))) score += 30;
                if (bikeNoiseTerms.some((term) => textBlob.includes(term))) score -= 40;
                if (categoryNoiseTerms.some((term) => textBlob.includes(term))) score -= 80;
                if (hasBikeIntent && !bikeTerms.some((term) => textBlob.includes(term))) score -= 15;
                if (hasBikeIntent && !item.price) score -= 30;
                for (const term of queryTerms) {
                    if (term.length >= 3 && textBlob.includes(term)) {
                        score += term.length >= 5 ? 8 : 4;
                    }
                }
                if (item.title && junkPatterns.some((pattern) => pattern.test(item.title))) score -= 100;
                if (item.snippet && junkPatterns.some((pattern) => pattern.test(item.snippet))) score -= 30;
                return score;
            };
            const resultMap = new Map();
            const pushResult = (item) => {
                if (!item) return;
                const title = cleanTitle(item.title);
                const href = absoluteUrl(item.href);
                if (!title || !href) return;
                if (junkPatterns.some((pattern) => pattern.test(title))) return;
                const key = href + '|' + title;
                const existing = resultMap.get(key);
                const normalized = {
                    title,
                    href,
                    price: item.price || null,
                    shipping: item.shipping || null,
                    condition: item.condition || null,
                    location: item.location || null,
                    seller: item.seller || null,
                    rating: item.rating || null,
                    reviews: item.reviews || null,
                    snippet: item.snippet || null,
                    image: item.image || null,
                    source: item.source || null,
                    score: item.score || scoreResult({ ...item, title, href })
                };
                if (!existing || normalized.score > existing.score) {
                    resultMap.set(key, normalized);
                }
            };

            const collectResultFromNode = (node, config = {}) => {
                if (!node || !isVisible(node)) return;
                const link = node.querySelector(config.linkSelector || 'a[href]');
                if (!link) return;

                const textBySelector = (selectors) => {
                    if (!selectors) return null;
                    for (const selector of selectors) {
                        const candidate = node.querySelector(selector);
                        if (candidate) {
                            const text = normalizeText(candidate.innerText || candidate.textContent);
                            if (text) return text;
                        }
                    }
                    return null;
                };

                const titleSelectors = config.titleSelectors || ['.s-item__title', 'h2', 'h3', '[data-testid*="title" i]'];
                const priceSelectors = config.priceSelectors || ['.s-item__price', '[class*="price" i]', '[data-testid*="price" i]'];
                const shippingSelectors = config.shippingSelectors || ['.s-item__shipping', '.s-item__logisticsCost', '[class*="shipping" i]'];
                const conditionSelectors = config.conditionSelectors || ['.SECONDARY_INFO', '.s-item__subtitle', '[class*="condition" i]'];
                const locationSelectors = config.locationSelectors || ['.s-item__location', '[class*="location" i]'];
                const sellerSelectors = config.sellerSelectors || ['[class*="seller" i]', '[class*="store" i]'];
                const ratingSelectors = config.ratingSelectors || ['[class*="rating" i]', '[aria-label*="rating" i]'];
                const reviewSelectors = config.reviewSelectors || ['[class*="review" i]'];
                const imageSelector = config.imageSelector || 'img';

                const title = cleanTitle(textBySelector(titleSelectors) || link.getAttribute('aria-label') || link.innerText || link.textContent);
                const href = link.href || link.getAttribute('href');
                const price = textBySelector(priceSelectors) || null;
                const shipping = textBySelector(shippingSelectors) || null;
                const condition = textBySelector(conditionSelectors) || null;
                const location = textBySelector(locationSelectors) || null;
                const seller = textBySelector(sellerSelectors) || null;
                const rating = textBySelector(ratingSelectors) || null;
                const reviews = textBySelector(reviewSelectors) || null;
                const imageNode = node.querySelector(imageSelector);
                const image = imageNode ? (imageNode.currentSrc || imageNode.src || imageNode.getAttribute('src') || null) : null;
                const snippet = normalizeText(node.innerText || node.textContent);

                pushResult({
                    title,
                    href,
                    price,
                    shipping,
                    condition,
                    location,
                    seller,
                    rating,
                    reviews,
                    image,
                    snippet,
                    source: config.source || null,
                    score: config.baseScore || 0
                });
            };

            if (siteHint.includes('ebay')) {
                const ebayRoots = [
                    ...document.querySelectorAll('li.s-item'),
                    ...document.querySelectorAll('div.s-item__wrapper'),
                    ...document.querySelectorAll('article.s-item')
                ];
                ebayRoots.slice(0, 60).forEach((item) => {
                    collectResultFromNode(item, {
                        source: 'ebay',
                        linkSelector: 'a.s-item__link[href], a[href*="/itm/"], a[href*="/p/"]',
                        titleSelectors: ['.s-item__title', 'h3', 'h2'],
                        priceSelectors: ['.s-item__price'],
                        shippingSelectors: ['.s-item__shipping', '.s-item__logisticsCost'],
                        conditionSelectors: ['.SECONDARY_INFO', '.s-item__subtitle'],
                        locationSelectors: ['.s-item__location'],
                        sellerSelectors: ['.s-item__seller-info-text', '[class*="seller" i]'],
                        ratingSelectors: ['.x-star-rating', '.s-item__reviews'],
                        reviewSelectors: ['.s-item__reviews'],
                        imageSelector: 'img.s-item__image-img, img'
                    });
                });
            }

            const genericRoots = [
                ...document.querySelectorAll('article'),
                ...document.querySelectorAll('li'),
                ...document.querySelectorAll('[data-testid*="item" i]'),
                ...document.querySelectorAll('[class*="product" i]'),
                ...document.querySelectorAll('[class*="listing" i]')
            ];

            genericRoots.slice(0, 120).forEach((node) => {
                collectResultFromNode(node, {
                    source: 'generic',
                    titleSelectors: ['h2', 'h3', '[data-testid*="title" i]', '[class*="title" i]'],
                    priceSelectors: ['[class*="price" i]', '[data-testid*="price" i]'],
                    shippingSelectors: ['[class*="shipping" i]'],
                    conditionSelectors: ['[class*="condition" i]'],
                    locationSelectors: ['[class*="location" i]'],
                    sellerSelectors: ['[class*="seller" i]'],
                    ratingSelectors: ['[class*="rating" i]'],
                    reviewSelectors: ['[class*="review" i]']
                });
            });

            if (resultMap.size === 0) {
                Array.from(document.querySelectorAll('a[href]')).slice(0, 250).forEach((link) => {
                    const title = cleanTitle(link.innerText || link.textContent || link.getAttribute('aria-label') || '');
                    if (!title || title.length < 3) return;
                    pushResult({
                        title,
                        href: link.href || link.getAttribute('href'),
                        snippet: normalizeText(link.innerText || link.textContent),
                        source: 'anchor-fallback',
                        score: 5
                    });
                });
            }

            const ranked = Array.from(resultMap.values())
                .sort((a, b) => b.score - a.score);

            const listingLike = ranked.filter((item) => isLikelyListingUrl(item.href) && item.price && item.score >= 20);
            const output = (siteHint.includes('ebay') && listingLike.length > 0 ? listingLike : ranked)
                .slice(0, 30)
                .map(({ score, ...item }) => ({
                    ...item,
                    score
                }));
            return output;
            } catch (error) {
                return {
                    ok: false,
                    error: 'Page extractor failed: ' + (error && error.message ? error.message : String(error)),
                    stack: String(error?.stack || '')
                };
            }
        })();`;

        try {
            const items = await this._executeJavaScriptWhenReady(tab, script);
            if (items && !Array.isArray(items) && items.ok === false) {
                return {
                    ...this._failure(tab, items.error || 'Failed to extract search results.', { tool: 'extract_search_results' }),
                    stack: items.stack || null,
                    siteHint: hint,
                    items: []
                };
            }
            return { ok: true, tab: this._describeTab(tab), siteHint: hint, items: Array.isArray(items) ? items : [] };
        } catch (error) {
            return this._failure(tab, error, { tool: 'extract_search_results' });
        }
    }
}

export default BrowserTools;
