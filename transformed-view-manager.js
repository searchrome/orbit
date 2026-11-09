const MAX_CONTENT_CHARS = 120_000;
const SOURCE_LOAD_TIMEOUT_MS = 20_000;
const SOURCE_READY_TIMEOUT_MS = 20_000;
const READY_POLL_INTERVAL_MS = 125;

function cancellationError(reason = 'Transformed view refresh was cancelled.') {
    const error = new Error(String(reason));
    error.code = 'browser_action_cancelled';
    return error;
}

function throwIfAborted(signal) {
    if (signal?.aborted) throw cancellationError(signal.reason);
}

function waitForDelay(duration, signal) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(cleanupAndResolve, duration);
        const abort = () => cleanupAndReject(cancellationError(signal.reason));
        function cleanup() {
            clearTimeout(timeout);
            signal?.removeEventListener?.('abort', abort);
        }
        function cleanupAndResolve() {
            cleanup();
            resolve();
        }
        function cleanupAndReject(error) {
            cleanup();
            reject(error);
        }
        if (signal?.aborted) {
            abort();
            return;
        }
        signal?.addEventListener?.('abort', abort, { once: true });
    });
}

function boundedMessage(error) {
    return String(error?.message || error || 'Could not refresh this transformed view.')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

export default class TransformedViewManager {
    constructor({ tabManager }) {
        this.tabManager = tabManager;
        this.operations = new Map();
        this.handleWebviewMessage = this.handleWebviewMessage.bind(this);
        this.handleTabClosed = this.handleTabClosed.bind(this);
        window.addEventListener('webview-ipc-message', this.handleWebviewMessage);
        window.addEventListener('tab-closed', this.handleTabClosed);
        window.addEventListener('transformed-view-reload-request', (event) => {
            this.refresh(event.detail?.tabId).catch(() => undefined);
        });
    }

    async list() {
        return window.electronAPI.invoke('transformed-view-list');
    }

    async create(input) {
        const view = await window.electronAPI.invoke('transformed-view-create', input);
        const tabId = await this.open(view.id, { title: view.name });
        return { view, tabId };
    }

    async update(input) {
        this.cancel(input?.id, 'The transformed view was updated.');
        return window.electronAPI.invoke('transformed-view-update', input);
    }

    async open(viewId, { title } = {}) {
        const view = await window.electronAPI.invoke('transformed-view-get', { id: viewId });
        const existing = this.tabManager.tabs.find((tab) => tab.role === 'transformed' && tab.viewId === view.id);
        if (existing) {
            this.tabManager.switchToTab(existing.id);
            await this.refresh(existing.id);
            return existing.id;
        }

        return this.tabManager.createTab(`browser://view/${view.id}`, {
            title: title || view.name,
            role: 'transformed',
            trackHistory: false
        });
    }

    async refresh(tabId, { signal } = {}) {
        const tab = this.tabManager.getTabById(tabId);
        if (!tab || tab.role !== 'transformed' || !tab.viewId) {
            throw new Error('Select a transformed view before refreshing it.');
        }
        const view = await window.electronAPI.invoke('transformed-view-get', { id: tab.viewId });
        return this.refreshView(tab, view, { signal });
    }

    async refreshView(tab, view, { signal } = {}) {
        this.cancel(view.id, 'A newer refresh replaced this transformed view request.');
        throwIfAborted(signal);

        const controller = new AbortController();
        const operation = { cancelled: false, sourceTabId: null, controller };
        this.operations.set(view.id, operation);
        this.send(tab, { state: 'loading', message: 'Loading current source content…' });
        const abortFromRequest = () => this.cancel(view.id, signal.reason || 'Transformed view refresh was cancelled.', operation);
        signal?.addEventListener?.('abort', abortFromRequest, { once: true });

        try {
            throwIfAborted(controller.signal);
            const sourceTabId = this.tabManager.createTab(view.sourceUrl, {
                activate: false,
                hidden: true,
                deferLoad: true,
                trackHistory: false,
                partition: 'transformed-view-source'
            });
            operation.sourceTabId = sourceTabId;
            const sourceTab = this.tabManager.getTabById(sourceTabId);
            if (!sourceTab?.webview) throw new Error('Could not create the source page.');
            // Attach load listeners before assigning src. A fast cached response
            // must not complete before the manager is ready to observe it.
            const loaded = this.waitForLoad(sourceTab.webview, controller.signal);
            sourceTab.loadUrl = view.sourceUrl;
            // Deferred tabs have no attached renderer. Resume the hidden
            // source after listeners are installed, without selecting it.
            this.tabManager._resumeTab(sourceTab);
            await loaded;
            await this.waitForReady(sourceTab.webview, view.recipe.readySelector, controller.signal);
            const extracted = await this.extractSource(sourceTab.webview, view.recipe, controller.signal);
            if (operation.cancelled || this.operations.get(view.id) !== operation) {
                throw cancellationError('Transformed view refresh was replaced.');
            }

            const sourceUrl = extracted.url || view.sourceUrl;
            this.send(tab, {
                state: 'ready',
                title: extracted.title || view.name,
                sourceUrl,
                content: extracted.content,
                theme: view.recipe.theme,
                updatedAt: new Date().toISOString()
            });
            await window.electronAPI.invoke('transformed-view-record-success', { id: view.id, sourceUrl });
        } catch (error) {
            if (!operation.cancelled && this.operations.get(view.id) === operation) {
                this.send(tab, { state: 'error', message: boundedMessage(error) });
            }
            throw error;
        } finally {
            signal?.removeEventListener?.('abort', abortFromRequest);
            if (operation.sourceTabId) this.tabManager.closeTab(operation.sourceTabId);
            if (this.operations.get(view.id) === operation) this.operations.delete(view.id);
        }
    }

    cancel(viewId, reason = 'Transformed view refresh was cancelled.', expectedOperation = null) {
        const operation = this.operations.get(viewId);
        if (!operation || (expectedOperation && operation !== expectedOperation)) return false;
        operation.cancelled = true;
        if (!operation.controller.signal.aborted) operation.controller.abort(reason);
        if (operation.sourceTabId) this.tabManager.closeTab(operation.sourceTabId);
        return true;
    }

    cancelRefresh(tabId, reason = 'Transformed view refresh was cancelled.') {
        const tab = this.tabManager.getTabById(tabId);
        if (!tab || tab.role !== 'transformed' || !tab.viewId) return false;
        return this.cancel(tab.viewId, reason);
    }

    handleTabClosed(event) {
        const tab = event.detail?.tab;
        if (tab?.role === 'transformed' && tab.viewId) {
            this.cancel(tab.viewId, 'The transformed view tab was closed.');
        }
    }

    waitForLoad(webview, signal) {
        if (!webview) return Promise.reject(new Error('Could not create the source page.'));
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                clearTimeout(timeout);
                webview.removeEventListener?.('did-finish-load', finish);
                webview.removeEventListener?.('did-fail-load', fail);
                signal?.removeEventListener?.('abort', abort);
            };
            const settle = (callback, value) => {
                if (settled) return;
                settled = true;
                cleanup();
                callback(value);
            };
            const finish = () => settle(resolve);
            const fail = (event) => {
                if (signal?.aborted || event?.errorCode === -3) {
                    settle(reject, cancellationError(signal?.reason || 'The source navigation was cancelled.'));
                    return;
                }
                settle(reject, new Error(event?.errorDescription || 'The source page could not load.'));
            };
            const abort = () => settle(reject, cancellationError(signal.reason));
            const timeout = setTimeout(() => fail({ errorDescription: 'The source page took too long to load.' }), SOURCE_LOAD_TIMEOUT_MS);
            webview.addEventListener('did-finish-load', finish, { once: true });
            webview.addEventListener('did-fail-load', fail, { once: true });
            if (signal?.aborted) abort();
            else signal?.addEventListener?.('abort', abort, { once: true });
        });
    }

    async waitForReady(webview, readySelector, signal) {
        if (!readySelector) return;
        const deadline = Date.now() + SOURCE_READY_TIMEOUT_MS;
        const selector = JSON.stringify(readySelector);
        while (Date.now() < deadline) {
            throwIfAborted(signal);
            let ready;
            try {
                ready = await webview.executeJavaScript(`Boolean(document.querySelector(${selector}))`, true);
            } catch (error) {
                throw new Error(`Could not evaluate the configured ready selector: ${boundedMessage(error)}`);
            }
            if (ready) return;
            await waitForDelay(READY_POLL_INTERVAL_MS, signal);
        }
        throw new Error(`Timed out waiting for configured page content: ${readySelector}`);
    }

    async extractSource(webview, recipe, signal) {
        throwIfAborted(signal);
        const values = JSON.stringify({
            rootSelector: recipe.rootSelector,
            titleSelector: recipe.titleSelector,
            removeSelectors: recipe.removeSelectors,
            maxChars: MAX_CONTENT_CHARS
        });
        const script = `(() => {
            const config = ${values};
            const source = document.querySelector(config.rootSelector);
            if (!source) throw new Error('Could not find configured page content.');
            const copy = source.cloneNode(true);
            for (const selector of config.removeSelectors) {
                for (const node of copy.querySelectorAll(selector)) node.remove();
            }
            const heading = document.querySelector(config.titleSelector)?.innerText?.trim() || document.title || '';
            return {
                title: heading.slice(0, 500),
                url: location.href,
                content: (copy.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, config.maxChars)
            };
        })()`;
        const result = await webview.executeJavaScript(script, true);
        throwIfAborted(signal);
        if (!result?.content) throw new Error('The selected source content was empty.');
        return result;
    }

    send(tab, payload) {
        try {
            tab?.webview?.send?.('transformed-view-data', payload);
        } catch {
            // A closed or still-loading view will request its data again when ready.
        }
    }

    async handleWebviewMessage(event) {
        const { tab, channel } = event.detail || {};
        if (!tab || tab.role !== 'transformed' || !tab.viewId) return;
        if (channel === 'transformed-view-ready' || channel === 'transformed-view-refresh') {
            await this.refresh(tab.id);
        } else if (channel === 'transformed-view-open-original') {
            const view = await window.electronAPI.invoke('transformed-view-get', { id: tab.viewId });
            this.tabManager.createTab(view.sourceUrl);
        }
    }
}
