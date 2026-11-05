const http = require('http');

const DEFAULT_CDP_BASE_URL = 'http://127.0.0.1:9222';
const DEFAULT_PAGE_LOAD_TIMEOUT_MS = 12000;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncateText(value, maxChars = 12000) {
    const text = String(value ?? '');
    if (text.length <= maxChars) {
        return text;
    }
    return `${text.slice(0, maxChars)}...[truncated]`;
}

function requestJson(url, { method = 'GET' } = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request(url, { method }, (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => {
                body += chunk;
            });
            response.on('end', () => {
                if (response.statusCode && response.statusCode >= 400) {
                    reject(new Error(`HTTP ${response.statusCode} for ${url}`));
                    return;
                }

                try {
                    resolve(body ? JSON.parse(body) : {});
                } catch (error) {
                    reject(new Error(`Failed to parse JSON from ${url}: ${error.message}`));
                }
            });
        });

        request.on('error', reject);
        request.end();
    });
}

class CdpClient {
    constructor(wsUrl) {
        this.wsUrl = wsUrl;
        this.socket = null;
        this.nextId = 1;
        this.pending = new Map();
        this.openPromise = null;
        this.closed = false;
        this.onMessage = this.onMessage.bind(this);
        this.onClose = this.onClose.bind(this);
    }

    async connect() {
        if (this.socket && this.socket.readyState === WebSocket.OPEN) {
            return;
        }

        if (this.openPromise) {
            return this.openPromise;
        }

        this.openPromise = new Promise((resolve, reject) => {
            const socket = new WebSocket(this.wsUrl);
            this.socket = socket;

            socket.addEventListener('message', this.onMessage);
            socket.addEventListener('close', this.onClose);
            socket.addEventListener('error', (event) => {
                reject(event.error || new Error(`WebSocket error for ${this.wsUrl}`));
            }, { once: true });
            socket.addEventListener('open', () => resolve(), { once: true });
        });

        try {
            await this.openPromise;
        } finally {
            this.openPromise = null;
        }
    }

    onMessage(event) {
        let payload;
        try {
            payload = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8'));
        } catch {
            return;
        }

        if (!payload || typeof payload.id !== 'number') {
            return;
        }

        const pending = this.pending.get(payload.id);
        if (!pending) {
            return;
        }

        this.pending.delete(payload.id);
        clearTimeout(pending.timeoutId);

        if (payload.error) {
            pending.reject(new Error(payload.error.message || `CDP ${pending.method} failed.`));
            return;
        }

        pending.resolve(payload.result || {});
    }

    onClose() {
        this.closed = true;
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timeoutId);
            pending.reject(new Error('CDP connection closed.'));
        }
        this.pending.clear();
        this.socket = null;
    }

    async send(method, params = {}, timeoutMs = 20000) {
        await this.connect();

        if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
            throw new Error('CDP socket is not open.');
        }

        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Timeout: ${method}`));
            }, timeoutMs);

            this.pending.set(id, { resolve, reject, timeoutId, method });
            this.socket.send(JSON.stringify({ id, method, params }));
        });
    }

    async close() {
        if (!this.socket) {
            return;
        }

        const socket = this.socket;
        this.socket = null;
        socket.removeEventListener('message', this.onMessage);
        socket.removeEventListener('close', this.onClose);
        if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
            socket.close();
        }
    }
}

class CdpBrowserSession {
    constructor(options = {}) {
        this.baseUrl = String(options.baseUrl || DEFAULT_CDP_BASE_URL).replace(/\/+$/, '');
        this.targets = new Map();
        this.pageClients = new Map();
        this.browserClient = null;
        this.activeTabId = null;
        this.assistantOwnedTabIds = new Set();
    }

    async initialize() {
        await this.refreshTargets();
        return this;
    }

    async getBrowserClient() {
        if (this.browserClient) {
            return this.browserClient;
        }

        const version = await requestJson(`${this.baseUrl}/json/version`);
        if (!version.webSocketDebuggerUrl) {
            throw new Error('CDP browser websocket is not available.');
        }

        this.browserClient = new CdpClient(version.webSocketDebuggerUrl);
        await this.browserClient.connect();
        return this.browserClient;
    }

    async getPageClient(tabId) {
        const normalizedId = String(tabId || '').trim();
        if (!normalizedId) {
            throw new Error('A tab id is required.');
        }

        await this.refreshTargets();
        const target = this.targets.get(normalizedId);
        if (!target?.webSocketDebuggerUrl) {
            throw new Error(`No CDP target found for tab ${normalizedId}.`);
        }

        let client = this.pageClients.get(normalizedId);
        if (!client || client.closed) {
            client = new CdpClient(target.webSocketDebuggerUrl);
            this.pageClients.set(normalizedId, client);
        }

        await client.connect();
        return client;
    }

    async refreshTargets() {
        const targets = await requestJson(`${this.baseUrl}/json/list`);
        this.targets.clear();

        for (const target of targets) {
            if (!target || !target.id) {
                continue;
            }
            this.targets.set(String(target.id), target);
        }

        if (!this.activeTabId || !this.targets.has(this.activeTabId)) {
            const candidate = this.listTabs().find((tab) => !tab.internal);
            this.activeTabId = candidate?.id || null;
        }

        return this.listTabs();
    }

    isAssistantTarget(target) {
        const url = String(target?.url || '');
        return url.startsWith('file:') && /assistant\.html$/i.test(url);
    }

    isBrowsableTarget(target) {
        if (!target || !target.id) {
            return false;
        }

        if (!['page', 'webview'].includes(target.type)) {
            return false;
        }

        // Exclude the Electron shell page and assistant page
        const url = String(target.url || '').toLowerCase();
        if (url.startsWith('file:') && /index\.html$/i.test(url)) {
            return false;
        }
        if (this.isAssistantTarget(target)) {
            return false;
        }

        return true;
    }

    getShellTarget() {
        return Array.from(this.targets.values()).find((target) => {
            if (target?.type !== 'page') {
                return false;
            }

            const url = String(target.url || '').toLowerCase();
            return url.startsWith('file:') && /index\.html$/i.test(url);
        }) || null;
    }

    describeTarget(target) {
        const id = String(target?.id || '');
        return {
            id,
            title: target?.title || target?.url || id,
            url: target?.url || '',
            loadUrl: target?.url || '',
            role: this.isAssistantTarget(target) ? 'assistant' : 'regular',
            assistantOwned: this.assistantOwnedTabIds.has(id),
            internal: this.isAssistantTarget(target),
            active: this.activeTabId === id,
            loading: false,
            canGoBack: false,
            type: target?.type || 'page'
        };
    }

    listTabs() {
        return Array.from(this.targets.values())
            .filter((target) => this.isBrowsableTarget(target))
            .map((target) => this.describeTarget(target));
    }

    getTab(tabId) {
        const target = this.targets.get(String(tabId || ''));
        return target ? this.describeTarget(target) : null;
    }

    getActiveTab() {
        if (this.activeTabId) {
            return this.getTab(this.activeTabId);
        }

        const tab = this.listTabs().find((entry) => !entry.internal) || null;
        if (tab) {
            this.activeTabId = tab.id;
        }
        return tab;
    }

    async activateTab(tabId) {
        const id = String(tabId || '').trim();
        if (!id) {
            throw new Error('A tab id is required.');
        }

        const browser = await this.getBrowserClient();
        try {
            await browser.send('Target.activateTarget', { targetId: id });
        } catch {
            try {
                await requestJson(`${this.baseUrl}/json/activate/${id}`);
            } catch {
                // Best effort only.
            }
        }

        this.activeTabId = id;
        await this.refreshTargets();
        return this.getTab(id);
    }

    async createTarget(url) {
        const browser = await this.getBrowserClient();
        try {
            const result = await browser.send('Target.createTarget', { url: url || 'about:blank' });
            const targetId = String(result.targetId || '').trim();
            if (!targetId) {
                throw new Error('CDP did not return a target id.');
            }

            this.assistantOwnedTabIds.add(targetId);
            await this.refreshTargets();
            await this.activateTab(targetId);
            return this.getTab(targetId);
        } catch (error) {
            if (!/not supported/i.test(error?.message || '')) {
                throw error;
            }
        }

        const shellTarget = this.getShellTarget();
        if (!shellTarget?.id) {
            throw new Error('CDP target creation is not supported and the browser shell target is unavailable.');
        }

        const beforeIds = new Set(this.listTabs().map((tab) => tab.id));
        const shellClient = await this.getPageClient(shellTarget.id);
        await shellClient.send('Runtime.enable');
        await shellClient.send('Runtime.evaluate', {
            expression: `(() => {
                if (!window.tabManager || typeof window.tabManager.createTab !== 'function') {
                    return { ok: false, error: 'window.tabManager.createTab is unavailable' };
                }
                const tabId = window.tabManager.createTab(${JSON.stringify(url || 'about:blank')}, {
                    assistantOwned: true,
                    role: 'regular',
                    activate: true
                });
                return { ok: true, tabId };
            })()`,
            returnByValue: true,
            awaitPromise: true
        });

        const deadline = Date.now() + 10000;
        while (Date.now() < deadline) {
            await sleep(300);
            await this.refreshTargets();
            const candidate = this.listTabs().find((tab) => !beforeIds.has(tab.id) && !tab.internal);
            if (candidate) {
                this.assistantOwnedTabIds.add(candidate.id);
                await this.activateTab(candidate.id);
                return this.getTab(candidate.id);
            }
        }

        throw new Error('The shell created a tab, but no new CDP webview target appeared.');
    }

    async closeTarget(tabId) {
        const id = String(tabId || '').trim();
        if (!id) {
            throw new Error('A tab id is required.');
        }

        const browser = await this.getBrowserClient();
        await browser.send('Target.closeTarget', { targetId: id });
        this.assistantOwnedTabIds.delete(id);

        const client = this.pageClients.get(id);
        if (client) {
            await client.close();
            this.pageClients.delete(id);
        }

        await this.refreshTargets();
        return { ok: true, closedTabId: id };
    }

    async navigate(tabId, url) {
        const client = await this.getPageClient(tabId);
        await client.send('Page.enable');
        await client.send('Page.navigate', { url });
        await this.waitForLoad(tabId);
        await this.refreshTargets();
        return this.getTab(tabId);
    }

    async evaluate(tabId, expression, { returnByValue = true, timeoutMs = 20000 } = {}) {
        const client = await this.getPageClient(tabId);
        await client.send('Runtime.enable');
        const result = await client.send('Runtime.evaluate', {
            expression,
            returnByValue,
            awaitPromise: true
        }, timeoutMs);
        return result?.result?.value;
    }

    async waitForLoad(tabId, timeoutMs = DEFAULT_PAGE_LOAD_TIMEOUT_MS) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            try {
                const readyState = await this.evaluate(tabId, 'document.readyState');
                if (readyState === 'complete' || readyState === 'interactive') {
                    await sleep(250);
                    return { ok: true, tab: this.getTab(tabId), loaded: true };
                }
            } catch {
                // Keep polling during navigation churn.
            }
            await sleep(250);
        }

        return { ok: false, error: `Timed out waiting for tab ${tabId} to load.`, tab: this.getTab(tabId) };
    }

    async openTab({ url, activate = true } = {}) {
        const previous = this.getActiveTab();
        const tab = await this.createTarget(url || 'about:blank');
        if (!activate) {
            if (previous?.id && previous.id !== tab.id) {
                await this.activateTab(previous.id);
            }
        }
        return { ok: true, id: tab.id, tab };
    }

    async focusTab({ tabId } = {}) {
        const tab = await this.activateTab(tabId);
        return { ok: true, tab };
    }

    async closeTab({ tabId } = {}) {
        return this.closeTarget(tabId);
    }

    async navigateTab({ tabId, url } = {}) {
        const tab = await this.navigate(tabId, url);
        return { ok: true, tab };
    }

    async getTabInfo({ tabId } = {}) {
        await this.refreshTargets();
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }
        return { ok: true, tab };
    }

    async getActiveTabInfo() {
        await this.refreshTargets();
        const tab = this.getActiveTab();
        if (!tab) {
            return { ok: false, error: 'No active tab found.' };
        }
        return { ok: true, tab };
    }

    async close() {
        for (const [tabId, client] of this.pageClients.entries()) {
            try {
                await client.close();
            } catch {
                // Best effort cleanup.
            }
            this.pageClients.delete(tabId);
        }

        if (this.browserClient) {
            try {
                await this.browserClient.close();
            } catch {
                // Best effort cleanup.
            }
            this.browserClient = null;
        }
    }

    async readPageText({ tabId, maxChars = 12000 } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const text = await this.evaluate(tabId, `(() => String(document.body?.innerText || '').slice(0, ${Math.max(1, Number(maxChars) || 12000)}))()`);
        return {
            ok: true,
            tab: this.getTab(tabId),
            text: text || '',
            length: String(text || '').length,
            truncated: String(text || '').length >= maxChars
        };
    }

    async querySelectorAll({ tabId, selector, fields = [] } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const safeFields = Array.isArray(fields) && fields.length ? fields : ['text', 'href'];
        const payload = await this.evaluate(tabId, `(() => {
            const selector = ${JSON.stringify(String(selector || ''))};
            const fields = ${JSON.stringify(safeFields)};
            const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
            return Array.from(document.querySelectorAll(selector)).map((node, index) => {
                const item = { index };
                for (const field of fields) {
                    if (field === 'text') item.text = normalize(node.innerText || node.textContent);
                    else if (field === 'href') item.href = node.href || node.getAttribute('href') || null;
                    else if (field === 'value') item.value = node.value ?? null;
                    else if (field === 'html') item.html = node.outerHTML || '';
                    else item[field] = node.getAttribute(field);
                }
                return item;
            });
        })()`);

        return { ok: true, tab: this.getTab(tabId), items: Array.isArray(payload) ? payload : [] };
    }

    async clickElement({ tabId, selector, index = 0 } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const result = await this.evaluate(tabId, `(() => {
            const selector = ${JSON.stringify(String(selector || ''))};
            const index = ${Number(index) || 0};
            const nodes = Array.from(document.querySelectorAll(selector));
            const target = nodes[index];
            if (!target) {
                return { ok: false, error: 'Element not found.' };
            }
            target.click();
            return { ok: true };
        })()`);

        if (!result?.ok) {
            return { ok: false, error: result?.error || 'Click failed.', tab: this.getTab(tabId) };
        }

        return { ok: true, tab: this.getTab(tabId) };
    }

    async trustedClickElement({ tabId, selector, index = 0 } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const target = await this.evaluate(tabId, `(() => {
            const selector = ${JSON.stringify(String(selector || ''))};
            const index = ${Number(index) || 0};
            const nodes = Array.from(document.querySelectorAll(selector));
            const node = nodes[index];
            if (!node) {
                return { ok: false, error: 'Element not found.' };
            }
            if (typeof node.scrollIntoView === 'function') {
                node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
            }
            const rect = node.getBoundingClientRect();
            return {
                ok: rect.width > 0 && rect.height > 0,
                error: rect.width > 0 && rect.height > 0 ? '' : 'Element has no clickable box.',
                x: rect.left + (rect.width / 2),
                y: rect.top + (rect.height / 2)
            };
        })()`);

        if (!target?.ok) {
            return { ok: false, error: target?.error || 'Trusted click target not found.', tab: this.getTab(tabId) };
        }

        const client = await this.getPageClient(tabId);
        await client.send('Page.enable');
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: target.x,
            y: target.y,
            button: 'none'
        });
        await client.send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: target.x,
            y: target.y,
            button: 'left',
            clickCount: 1
        });
        await client.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: target.x,
            y: target.y,
            button: 'left',
            clickCount: 1
        });

        await sleep(300);
        return { ok: true, tab: this.getTab(tabId) };
    }

    async typeInto({ tabId, selector, text, submit = false, clear = true } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const result = await this.evaluate(tabId, `(() => {
            const selector = ${JSON.stringify(String(selector || ''))};
            const text = ${JSON.stringify(String(text || ''))};
            const clear = ${clear ? 'true' : 'false'};
            const submit = ${submit ? 'true' : 'false'};
            const node = document.querySelector(selector);
            if (!node) {
                return { ok: false, error: 'Input not found.' };
            }

            node.focus();
            if (clear && 'value' in node) {
                node.value = '';
            }

            if ('value' in node) {
                node.value = text;
            } else {
                node.textContent = text;
            }

            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));

            let submitted = false;
            if (submit) {
                const form = node.form || node.closest('form');
                if (form) {
                    if (typeof form.requestSubmit === 'function') {
                        form.requestSubmit();
                    } else if (typeof form.submit === 'function') {
                        form.submit();
                    }
                    submitted = true;
                } else {
                    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                    node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
                }
            }

            return { ok: true, submitted };
        })()`);

        if (!result?.ok) {
            return { ok: false, error: result?.error || 'Typing failed.', tab: this.getTab(tabId) };
        }

        if (submit) {
            await this.waitForLoad(tabId);
        }

        return { ok: true, tab: this.getTab(tabId), submitted: !!result.submitted };
    }

    async scrollPage({ tabId, direction = 'down', amount = 800 } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const delta = Math.abs(Number(amount) || 800) * (String(direction).toLowerCase() === 'up' ? -1 : 1);
        await this.evaluate(tabId, `window.scrollBy({ top: ${delta}, behavior: 'instant' }); true`);
        return { ok: true, tab: this.getTab(tabId), amount: delta };
    }

    buildSearchUrl(currentUrl, query, siteHint = '') {
        const normalizedQuery = encodeURIComponent(String(query || '').trim()).replace(/%20/g, '+');
        const normalizedHint = String(siteHint || '').toLowerCase();
        const current = String(currentUrl || '').toLowerCase();

        if (normalizedHint.includes('marktplaats') || current.includes('marktplaats.nl')) {
            return `https://www.marktplaats.nl/q/${normalizedQuery}/`;
        }

        if (normalizedHint.includes('ebay') || current.includes('ebay.nl') || current.includes('ebay.com')) {
            return `https://www.ebay.nl/sch/i.html?_nkw=${normalizedQuery}&_sacat=0&_from=R40`;
        }

        if (current.includes('google.')) {
            return `https://www.google.com/search?q=${normalizedQuery}`;
        }

        return null;
    }

    async searchSite({ tabId, query, siteHint = '', timeoutMs = DEFAULT_PAGE_LOAD_TIMEOUT_MS } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const trimmedQuery = String(query || '').trim();
        if (!trimmedQuery) {
            return { ok: false, error: 'searchSite requires a non-empty query.', tab };
        }

        const shortcutUrl = this.buildSearchUrl(tab.url, trimmedQuery, siteHint);
        if (shortcutUrl) {
            const nextTab = await this.navigate(tabId, shortcutUrl);
            return {
                ok: true,
                tab: nextTab,
                submitted: true,
                query: trimmedQuery,
                siteHint,
                selected: { strategy: 'shortcut_url' },
                candidates: []
            };
        }

        const result = await this.evaluate(tabId, `(() => {
            const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
            const query = ${JSON.stringify(trimmedQuery)};
            const selectors = [
                'input[type="search"]',
                'input[name="q"]',
                'input[name="query"]',
                'input[name="search"]',
                'input[placeholder*="search" i]',
                'input[aria-label*="search" i]',
                'input[type="text"]'
            ];
            const isVisible = (node) => {
                if (!node) return false;
                const style = window.getComputedStyle(node);
                if (!style || style.display === 'none' || style.visibility === 'hidden') return false;
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const candidates = [];
            for (const selector of selectors) {
                const nodes = Array.from(document.querySelectorAll(selector)).filter(isVisible);
                for (const node of nodes) {
                    const score = selector.includes('search') ? 20 : selector.includes('q') ? 15 : 10;
                    candidates.push({
                        selector,
                        tagName: node.tagName,
                        id: node.id || null,
                        name: node.getAttribute('name'),
                        type: node.getAttribute('type'),
                        placeholder: node.getAttribute('placeholder'),
                        ariaLabel: node.getAttribute('aria-label'),
                        formAction: node.form?.action || null,
                        formMethod: node.form?.method || null,
                        score
                    });
                }
            }
            candidates.sort((a, b) => b.score - a.score);
            const best = candidates[0];
            if (!best) {
                return { ok: false, error: 'No visible search field found.', candidates: [] };
            }
            const node = document.querySelector(best.selector);
            if (!node) {
                return { ok: false, error: 'Search field disappeared.', candidates };
            }
            node.focus();
            if ('value' in node) node.value = query;
            node.dispatchEvent(new Event('input', { bubbles: true }));
            node.dispatchEvent(new Event('change', { bubbles: true }));
            let submitted = false;
            const form = node.form || node.closest('form');
            if (form) {
                if (typeof form.requestSubmit === 'function') {
                    form.requestSubmit();
                } else if (typeof form.submit === 'function') {
                    form.submit();
                }
                submitted = true;
            } else {
                node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
                node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
            }
            return { ok: true, submitted, selected: best, candidates };
        })()`, { timeoutMs });

        if (!result?.ok) {
            return { ok: false, error: result?.error || 'Search failed.', tab: this.getTab(tabId), candidates: result?.candidates || [] };
        }

        const waitResult = await this.waitForLoad(tabId, timeoutMs);
        if (!waitResult.ok) {
            return { ok: false, error: waitResult.error, tab: this.getTab(tabId), selected: result.selected, candidates: result.candidates || [] };
        }

        await this.refreshTargets();
        return {
            ok: true,
            tab: this.getTab(tabId),
            submitted: !!result.submitted,
            query: trimmedQuery,
            siteHint,
            selected: result.selected,
            candidates: result.candidates || []
        };
    }

    async extractSearchResults({ tabId, siteHint = '' } = {}) {
        const tab = this.getTab(tabId);
        if (!tab) {
            return { ok: false, error: `Tab ${tabId} not found.` };
        }

        const hint = String(siteHint || '').toLowerCase();
        const items = await this.evaluate(tabId, `(() => {
            const siteHint = ${JSON.stringify(hint)};
            const bikeTerms = ['bike', 'bicycle', 'fiets', 'fietsen', 'fietsje', 'cycle', 'fahrrad', 'velo', 'mountainbike', 'racefiets', 'ebike', 'e-bike'];
            const bikeNoiseTerms = ['adapter', 'diagnose', 'diagnostic', 'mirror', 'glass', 'stamps', 'stamp', 'collection', 'mercedes', 'obd', 'fairing', 'motorcycle', 'motorbike', 'moto', 'scooter', 'helmet', 'car', 'auto', 'parts', 'part', 'charger', 'scanner', 'tool', 'zadel', 'saddle', 'fietsaccu', 'accu', 'battery', 'batterij', 'fietshoes', 'hoes', 'cover', 'ketting', 'chain', 'slot', 'lock', 'pomp', 'pump', 'band', 'tyre', 'tire', 'drager', 'rack', 'onderdelen', 'accessoire', 'accessory', 'mand', 'basket'];
            const categoryNoiseTerms = ['rubriek', 'category', 'categorie', 'shop by category', 'sport en vrije tijd', 'fietsen en wielersport', 'fietsaccessoires', 'fietsonderdelen', 'objectstaat'];
            const junkPatterns = [/shop on ebay/i, /results matching/i, /sponsored/i, /more results/i, /see all/i, /feedback/i, /watch list/i, /add to cart/i];
            const normalizeText = (value) => (value || '').replace(/\\s+/g, ' ').trim();
            const absoluteUrl = (value) => {
                const raw = String(value || '').trim();
                if (!raw || raw.startsWith('#') || raw.startsWith('javascript:') || raw.startsWith('mailto:') || raw.startsWith('tel:')) return null;
                try { return new URL(raw, document.baseURI).href; } catch { return raw || null; }
            };
            const canonicalizeHref = (value) => {
                const href = absoluteUrl(value);
                if (!href) return null;
                try {
                    const parsed = new URL(href, document.baseURI);
                    ['c', 'casData', 'trackSearch', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'fbclid'].forEach((key) => {
                        parsed.searchParams.delete(key);
                    });
                    const search = parsed.searchParams.toString();
                    parsed.search = search ? ('?' + search) : '';
                    parsed.hash = '';
                    return parsed.toString();
                } catch {
                    return href.split('#')[0];
                }
            };
            const cleanTitle = (value) => normalizeText(value).replace(/^new listing\\s*/i, '').trim();
            const isVisible = (node) => {
                if (!node) return false;
                const style = window.getComputedStyle(node);
                if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
                const rect = node.getBoundingClientRect();
                return rect.width > 0 && rect.height > 0;
            };
            const isLikelyListingUrl = (value) => /\\/itm\\/|\\/p\\/|\\/v\\//i.test(String(value || ''));
            const scoreResult = (item) => {
                let score = 0;
                const blob = normalizeText([item.title, item.snippet, item.condition].filter(Boolean).join(' ')).toLowerCase();
                const priceMatches = blob.match(/(?:€|eur)\s*[\d.,]+/gi) || [];
                const snippetLength = String(item.snippet || '').length;
                if (item.title) score += 40;
                if (item.href) score += 20;
                if (item.price) score += 20;
                if (item.location) score += 5;
                if (item.condition) score += 5;
                if (item.href && isLikelyListingUrl(item.href)) score += 25;
                if (item.href && !isLikelyListingUrl(item.href)) score -= 80;
                if (bikeTerms.some((term) => blob.includes(term))) score += 30;
                if (bikeNoiseTerms.some((term) => blob.includes(term))) score -= 40;
                if (categoryNoiseTerms.some((term) => blob.includes(term))) score -= 80;
                if (!item.price) score -= 20;
                if (snippetLength > 700) score -= 120;
                else if (snippetLength > 450) score -= 70;
                if (priceMatches.length > 2) score -= 120;
                else if (priceMatches.length > 1) score -= 60;
                if (String(item.title || '').length > 160) score -= 50;
                if ((blob.match(/\b(vandaag|gisteren|mei|apr|mrt|feb|jan)\b/gi) || []).length > 2) score -= 40;
                if (junkPatterns.some((pattern) => pattern.test(item.title || '') || pattern.test(item.snippet || ''))) score -= 100;
                return score;
            };
            const resultMap = new Map();
            const push = (item) => {
                const title = cleanTitle(item.title);
                const href = canonicalizeHref(item.href);
                if (!title || !href) return;
                const key = href;
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
                const previous = resultMap.get(key);
                const shouldReplace = !previous
                    || normalized.score > previous.score
                    || (normalized.score === previous.score
                        && String(normalized.title || '').length < String(previous.title || '').length)
                    || (!previous.price && normalized.price);
                if (shouldReplace) {
                    resultMap.set(key, normalized);
                }
            };
            const collect = (node, config = {}) => {
                if (!node || !isVisible(node)) return;
                const link = node.querySelector(config.linkSelector || 'a[href]');
                if (!link) return;
                const read = (selectors) => {
                    for (const selector of selectors || []) {
                        const candidate = node.querySelector(selector);
                        if (!candidate) continue;
                        const text = normalizeText(candidate.innerText || candidate.textContent);
                        if (text) return text;
                    }
                    return null;
                };
                const title = cleanTitle(read(config.titleSelectors || ['h2', 'h3', '[data-testid*="title" i]', '[class*="title" i]']) || link.innerText || link.textContent);
                const href = link.href || link.getAttribute('href');
                const snippet = normalizeText(node.innerText || node.textContent);
                push({
                    title,
                    href,
                    price: read(config.priceSelectors || ['[class*="price" i]', '[data-testid*="price" i]']),
                    shipping: read(config.shippingSelectors || ['[class*="shipping" i]']),
                    condition: read(config.conditionSelectors || ['.SECONDARY_INFO', '[class*="condition" i]']),
                    location: read(config.locationSelectors || ['.s-item__location', '[class*="location" i]']),
                    seller: read(config.sellerSelectors || ['[class*="seller" i]', '[class*="store" i]']),
                    rating: read(config.ratingSelectors || ['[class*="rating" i]']),
                    reviews: read(config.reviewSelectors || ['[class*="review" i]']),
                    snippet,
                    image: node.querySelector('img')?.src || null,
                    source: config.source || 'generic'
                });
            };
            if (siteHint.includes('ebay')) {
                Array.from(document.querySelectorAll('li.s-item, article.s-item, div.s-item__wrapper')).slice(0, 80).forEach((node) => {
                    collect(node, {
                        source: 'ebay',
                        linkSelector: 'a.s-item__link[href], a[href*="/itm/"], a[href*="/p/"]',
                        titleSelectors: ['.s-item__title', 'h2', 'h3'],
                        priceSelectors: ['.s-item__price'],
                        shippingSelectors: ['.s-item__shipping', '.s-item__logisticsCost'],
                        conditionSelectors: ['.SECONDARY_INFO', '.s-item__subtitle'],
                        locationSelectors: ['.s-item__location'],
                        sellerSelectors: ['.s-item__seller-info-text', '[class*="seller" i]']
                    });
                });
            }
            if (siteHint.includes('marktplaats')) {
                const seenRoots = new Set();
                Array.from(document.querySelectorAll('a[href*="/v/"]')).slice(0, 160).forEach((link) => {
                    const root = link.closest('li')
                        || link.closest('article')
                        || link.closest('[class*="item-wrapper" i]')
                        || link.parentElement;
                    if (!root || seenRoots.has(root)) {
                        return;
                    }
                    seenRoots.add(root);
                    collect(root, {
                        source: 'marktplaats',
                        linkSelector: 'a[href*="/v/"]',
                        titleSelectors: ['h2', 'h3', '[data-testid*="title" i]'],
                        priceSelectors: ['[class*="price" i]'],
                        conditionSelectors: ['[class*="condition" i]'],
                        locationSelectors: ['[class*="location" i]'],
                        sellerSelectors: ['[class*="seller" i]']
                    });
                });
            }
            Array.from(document.querySelectorAll('article, li, [data-testid*="item" i], [class*="product" i], [class*="listing" i]')).slice(0, 150).forEach((node) => {
                collect(node, { source: 'generic' });
            });
            return Array.from(resultMap.values()).filter((item) => item.score > 0).sort((a, b) => b.score - a.score).slice(0, 25);
        })()`, { timeoutMs: 25000 });

        return {
            ok: true,
            tab: this.getTab(tabId),
            siteHint,
            items: Array.isArray(items) ? items : []
        };
    }
}

module.exports = {
    CdpBrowserSession,
    DEFAULT_CDP_BASE_URL,
    truncateText
};
