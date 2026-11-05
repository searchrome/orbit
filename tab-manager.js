// tab-manager.js - Manages browser tabs functionality

import HistoryManager from './history-manager.js';

function createWindowCustomEvent(name, detail) {
    if (typeof document === 'undefined') {
        return null;
    }

    if (typeof document.createEvent === 'function') {
        const event = document.createEvent('Event');
        event.initEvent(name, false, false);

        if (typeof detail !== 'undefined') {
            Object.defineProperty(event, 'detail', {
                value: detail,
                configurable: true,
                enumerable: true
            });
        }

        return event;
    }

    if (typeof window !== 'undefined' && typeof window.CustomEvent === 'function') {
        return new window.CustomEvent(name, { detail });
    }

    return null;
}

function guestPreloadUrl() {
    // Electron resolves a webview preload independently from the page URL.
    // Supplying an absolute file URL keeps the guest bridge available on every
    // remote site, rather than looking for /preload.js on that site.
    return new URL('./preload.js', window.location.href).href;
}

class TabManager {
    constructor(containerElement, historyManager = null, bookmarkButton = null) {
        this.historyManager = historyManager || new HistoryManager();
        this.bookmarkBtn = bookmarkButton || document.getElementById('bookmark-btn');
        this.tabContainer = document.getElementById('tab-bar');
        this.contentContainer = containerElement;
        this.tabs = [];
        this.activeTabId = null;
        this.tabCounter = 0; // Used to generate unique IDs
        
        // Bind methods to this instance
        this.createTab = this.createTab.bind(this);
        this.closeTab = this.closeTab.bind(this);
        this.closeTabsToRight = this.closeTabsToRight.bind(this);
        this.switchToTab = this.switchToTab.bind(this);
        this.updateTabTitle = this.updateTabTitle.bind(this);
        this.updateTabFavicon = this.updateTabFavicon.bind(this);
        this.recoverTab = this.recoverTab.bind(this);
        this.reloadTab = this.reloadTab.bind(this);
        this.markTabRendererGone = this.markTabRendererGone.bind(this);
        this.reorderTab = this.reorderTab.bind(this);
        this.hideTabContextMenu = this.hideTabContextMenu.bind(this);
        this.showTabContextMenu = this.showTabContextMenu.bind(this);
        this.draggedTabId = null;
        this.collapsedGroups = new Set();
        this.tabSearchQuery = '';

        this.tabContextMenu = this._createTabContextMenu();
        
        // Initialize new tab button
        const newTabButton = document.getElementById('new-tab-btn');
        if (newTabButton) {
            newTabButton.addEventListener('click', this.createTab);
        }

        if (typeof document !== 'undefined') {
            document.addEventListener('click', this.hideTabContextMenu);
            document.addEventListener('keydown', (event) => {
                if (event.key === 'Escape') {
                    this.hideTabContextMenu();
                }
            });
        }
    }

    _createTabContextMenu() {
        if (typeof document === 'undefined') {
            return null;
        }

        const existing = document.getElementById('tab-context-menu');
        if (existing) {
            existing.remove();
        }

        const menu = document.createElement('div');
        menu.id = 'tab-context-menu';
        menu.className = 'tab-context-menu hidden';
        menu.innerHTML = `
            <div class="tab-context-menu-label">Add to group</div>
            <div class="tab-context-existing-groups"></div>
            <button type="button" class="tab-context-menu-item" data-action="group">New group…</button>
            <button type="button" class="tab-context-menu-item" data-action="ungroup">Remove from group</button>
            <button type="button" class="tab-context-menu-item" data-action="close-right">
                Close Tabs to the Right
            </button>
        `;

        menu.addEventListener('click', (event) => {
            event.stopPropagation();
            const item = event.target.closest?.('[data-action]');
            const action = item?.dataset?.action;
            const tabId = menu.dataset.tabId;
            if (action === 'existing-group' && tabId) this.setTabGroup(tabId, item.dataset.group);
            if (action === 'ungroup' && tabId) this.setTabGroup(tabId, '');
            if (action === 'group' && tabId) {
                window.dispatchEvent(createWindowCustomEvent('tab-group-request', { tabId }));
            }
            if (action === 'close-right' && tabId) {
                this.closeTabsToRight(tabId);
            }
            this.hideTabContextMenu();
        });

        document.body.appendChild(menu);
        return menu;
    }

    hideTabContextMenu() {
        if (!this.tabContextMenu) {
            return;
        }

        this.tabContextMenu.classList.add('hidden');
        delete this.tabContextMenu.dataset.tabId;
    }

    showTabContextMenu(tabId, event) {
        if (!this.tabContextMenu) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();

        const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex === -1) {
            this.hideTabContextMenu();
            return;
        }

        const groupList = this.tabContextMenu.querySelector('.tab-context-existing-groups');
        if (groupList) {
            groupList.replaceChildren();
            for (const group of this.getTabGroups()) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'tab-context-menu-item';
                button.dataset.action = 'existing-group';
                button.dataset.group = group;
                button.textContent = group;
                groupList.appendChild(button);
            }
        }
        const ungroup = this.tabContextMenu.querySelector('[data-action="ungroup"]');
        if (ungroup) ungroup.disabled = !this.tabs[tabIndex].group;
        const hasRightTabs = tabIndex < this.tabs.length - 1;
        const closeRightButton = this.tabContextMenu.querySelector('[data-action="close-right"]');
        if (closeRightButton) {
            closeRightButton.disabled = !hasRightTabs;
        }

        this.tabContextMenu.dataset.tabId = tabId;
        this.tabContextMenu.style.left = `${event.clientX}px`;
        this.tabContextMenu.style.top = `${event.clientY}px`;
        this.tabContextMenu.classList.remove('hidden');
    }

    _clearTabDragState() {
        this.draggedTabId = null;
        this.tabContainer?.querySelectorAll?.('.tab--dragging, .tab--drop-before, .tab--drop-after')
            .forEach((element) => element.classList.remove('tab--dragging', 'tab--drop-before', 'tab--drop-after'));
    }

    _showTabDropTarget(tabElement, insertAfter) {
        this.tabContainer?.querySelectorAll?.('.tab--drop-before, .tab--drop-after')
            .forEach((element) => element.classList.remove('tab--drop-before', 'tab--drop-after'));
        tabElement?.classList?.add(insertAfter ? 'tab--drop-after' : 'tab--drop-before');
    }

    _getDraggedTabId(event) {
        const fromState = this.draggedTabId;
        if (fromState) return fromState;

        try {
            return event?.dataTransfer?.getData?.('text/plain') || null;
        } catch {
            return null;
        }
    }

    _setUpTabDragAndDrop(tabElement, tabId) {
        tabElement.draggable = true;

        tabElement.addEventListener('dragstart', (event) => {
            if (event.target?.closest?.('.tab-close-btn')) {
                event.preventDefault();
                return;
            }

            this.draggedTabId = tabId;
            this.hideTabContextMenu();
            tabElement.classList.add('tab--dragging');
            if (event.dataTransfer) {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tabId);
            }
        });

        tabElement.addEventListener('dragover', (event) => {
            const draggedTabId = this._getDraggedTabId(event);
            if (!draggedTabId || draggedTabId === tabId) return;

            event.preventDefault();
            if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
            const bounds = tabElement.getBoundingClientRect();
            const insertAfter = document.body.classList.contains('vertical-tabs')
                ? event.clientY >= bounds.top + bounds.height / 2
                : event.clientX >= bounds.left + bounds.width / 2;
            this._showTabDropTarget(tabElement, insertAfter);
        });

        tabElement.addEventListener('dragleave', (event) => {
            if (event.relatedTarget && tabElement.contains(event.relatedTarget)) return;
            tabElement.classList.remove('tab--drop-before', 'tab--drop-after');
        });

        tabElement.addEventListener('drop', (event) => {
            const draggedTabId = this._getDraggedTabId(event);
            if (!draggedTabId || draggedTabId === tabId) return;

            event.preventDefault();
            const bounds = tabElement.getBoundingClientRect();
            const insertAfter = document.body.classList.contains('vertical-tabs')
                ? event.clientY >= bounds.top + bounds.height / 2
                : event.clientX >= bounds.left + bounds.width / 2;
            this.setTabGroup(draggedTabId, this.getTabById(tabId)?.group || '');
            this.reorderTab(draggedTabId, tabId, insertAfter);
            this._clearTabDragState();
        });

        tabElement.addEventListener('dragend', () => this._clearTabDragState());
    }

    // Move one visible tab immediately before or after another visible tab.
    // The tabs array is also the session-order source, so emitting here keeps
    // the browser recovery journal in sync with what the user sees.
    reorderTab(tabId, targetTabId, insertAfter = false) {
        const sourceIndex = this.tabs.findIndex((tab) => tab.id === tabId);
        const targetIndex = this.tabs.findIndex((tab) => tab.id === targetTabId);
        const sourceTab = this.tabs[sourceIndex];
        const targetTab = this.tabs[targetIndex];
        if (
            sourceIndex === -1
            || targetIndex === -1
            || sourceIndex === targetIndex
            || sourceTab?.hidden
            || targetTab?.hidden
        ) {
            return false;
        }

        const [tab] = this.tabs.splice(sourceIndex, 1);
        const updatedTargetIndex = this.tabs.findIndex((candidate) => candidate.id === targetTabId);
        const insertIndex = updatedTargetIndex + (insertAfter ? 1 : 0);
        this.tabs.splice(insertIndex, 0, tab);

        const targetElement = this.getTabById(targetTabId)?.element;
        if (this.tabContainer && tab.element && targetElement) {
            this.tabContainer.insertBefore(
                tab.element,
                insertAfter ? targetElement.nextSibling : targetElement
            );
        }

        this._emitSessionChange();
        return true;
    }

    getTabGroups() {
        return [...new Set(this.tabs.filter(tab => !tab.hidden && tab.group).map(tab => tab.group))];
    }

    toggleTabGroup(group) {
        this.setTabGroupCollapsed(group, !this.collapsedGroups.has(group));
    }

    setTabGroupCollapsed(group, collapsed) {
        const members = this.tabs.filter(tab => !tab.hidden && tab.group === group);
        if (!members.length) return;
        if (collapsed) {
            this.collapsedGroups.add(group);
            for (const tab of members) this.suspendTab(tab.id);
            this._selectOutsideCollapsedGroups();
        } else {
            this.collapsedGroups.delete(group);
            // Opening a section loads exactly one page. Other entries stay unloaded.
            this.switchToTab(members[0].id);
        }
        this._emitSessionChange();
        window.dispatchEvent(createWindowCustomEvent('tab-groups-changed'));
    }

    suspendTab(tabId) {
        const tab = this.getTabById(tabId);
        if (!tab || tab.hidden || tab.internal) return false;
        tab.deferredUrl = tab.crashed ? this._getCrashedTabPageUrl()
            : (tab.deferredUrl || tab.loadUrl || this._resolveTabRequest(tab.url).loadUrl);
        // Clear the live reference before removing the element so late guest events
        // cannot mark this intentional unload as a crash or overwrite saved metadata.
        const view = tab.webview;
        tab.suspended = true;
        tab.webview = null;
        tab.loadState = tab.crashed ? 'crashed' : 'idle';
        tab.element?.classList?.add('tab--suspended');
        view?.remove?.();
        return true;
    }

    _selectOutsideCollapsedGroups() {
        const active = this.getActiveTab();
        if (!active || !this.collapsedGroups.has(active.group)) return;
        const candidates = this.tabs.filter(tab => !tab.hidden && !this.collapsedGroups.has(tab.group));
        const next = candidates.find(tab => tab.webview?.isConnected && !tab.deferredUrl) || candidates[0];
        if (next) {
            this.switchToTab(next.id);
            return;
        }
        this.activeTabId = null;
        for (const tab of this.tabs) tab.element?.classList?.remove('active');
        this._clearErrorOverlay();
        const input = document.getElementById('url-input');
        if (input) input.value = '';
        const back = document.getElementById('back-btn');
        if (back) back.disabled = true;
        window.dispatchEvent(createWindowCustomEvent('tab-switched', {tabId: null, tab: null}));
    }

    _createTabWebview(tabId, partition, loadUrl) {
        const webview = document.createElement('webview');
        webview.id = `webview-${tabId}`;
        webview.className = 'tab-webview';
        if (partition) webview.setAttribute('partition', partition);
        webview.setAttribute('style', 'width:100%; height:100%; display:none;');
        webview.setAttribute('nodeintegration', 'false');
        webview.setAttribute('allowpopups', '');
        if (!this._isArtifactUrl(loadUrl)) webview.setAttribute('preload', guestPreloadUrl());
        return webview;
    }

    _setupTabNetworkReady(tab) {
        const webview = tab.webview;
        webview.addEventListener('dom-ready', () => {
            if (tab.webview !== webview || tab.suspended) return;
            try {
                const id = webview.getWebContentsId();
                if (id) window.electronAPI.send('set-network-status-for-tab', id, false);
            } catch { /* A page may be unloaded again before dom-ready completes. */ }
        });
    }

    _resumeTab(tab) {
        const target = tab.crashed ? this._getCrashedTabPageUrl()
            : (tab.deferredUrl || tab.loadUrl || this._resolveTabRequest(tab.url).loadUrl);
        if (!tab.webview) {
            tab.webview = this._createTabWebview(tab.id, tab.partition, target);
            this.setupWebviewEvents(tab);
            this._setupTabNetworkReady(tab);
        }
        tab.suspended = false;
        tab.element?.classList?.remove('tab--suspended');
        if (tab.deferredUrl || !tab.webview.getAttribute('src')) {
            tab.webview.setAttribute('src', target);
            tab.loadUrl = target;
            tab.deferredUrl = null;
            tab.loadState = tab.crashed ? 'crashed' : (target === 'about:blank' ? 'idle' : 'loading');
        }
        if (!tab.webview.isConnected) this.contentContainer.appendChild(tab.webview);
        document.getElementById('collapsed-groups-placeholder')?.remove();
        return tab.webview;
    }

    setTabSearchQuery(value) {
        this.tabSearchQuery = String(value || '').trim().toLocaleLowerCase();
        // Filtering changes the tab strip only; all webviews and saved tabs stay intact.
        this._renderGroupHeaders();
    }

    _matchesTabSearch(tab) {
        if (!this.tabSearchQuery) return true;
        let address = String(tab.url || '');
        try { address = decodeURI(address); } catch { /* Keep malformed addresses searchable as written. */ }
        return String(tab.title || '').toLocaleLowerCase().includes(this.tabSearchQuery)
            || address.toLocaleLowerCase().includes(this.tabSearchQuery);
    }

    _renderGroupHeaders() {
        if (!this.tabContainer) return;
        const allTabs = this.tabs.filter(tab => !tab.hidden && tab.element);
        const searching = !!this.tabSearchQuery;
        const visibleTabs = allTabs.filter(tab => this._matchesTabSearch(tab));
        const key = JSON.stringify([visibleTabs.map(tab => [tab.id, tab.group || '']), allTabs.map(tab => tab.id), [...this.collapsedGroups], this.tabSearchQuery]);
        if (key === this._groupRenderKey) return;
        this._groupRenderKey = key;
        this.tabContainer.querySelectorAll?.('.tab-group-header')?.forEach(header => header.remove());
        for (const tab of allTabs) {
            tab.element.hidden = !this._matchesTabSearch(tab) || (!searching && !!tab.group && this.collapsedGroups.has(tab.group));
        }
        let empty = document.getElementById('tab-search-empty');
        if (searching && !visibleTabs.length) {
            if (!empty) {
                empty = document.createElement('span');
                empty.id = 'tab-search-empty';
                empty.className = 'tab-search-empty';
                empty.textContent = 'No matching tabs';
                this.tabContainer.insertBefore(empty, document.getElementById('new-tab-btn'));
            }
        } else empty?.remove();
        const status = document.getElementById('tab-search-status');
        if (status) status.textContent = searching ? `${visibleTabs.length} of ${allTabs.length} tabs` : '';
        const seen = new Set();
        for (const tab of visibleTabs) {
            if (!tab.group || seen.has(tab.group)) continue;
            const group = tab.group;
            seen.add(group);
            const header = document.createElement('button');
            header.type = 'button';
            header.className = 'tab-group-header';
            header.dataset.group = group;
            header.setAttribute('aria-expanded', String(searching || !this.collapsedGroups.has(group)));
            if (searching) header.setAttribute('aria-disabled', 'true');
            header.title = `Drop a tab here to add it to ${group}`;
            const chevron = document.createElement('span');
            chevron.className = 'tab-group-chevron';
            chevron.textContent = !searching && this.collapsedGroups.has(group) ? '›' : '⌄';
            const label = document.createElement('span'); label.textContent = group;
            const count = document.createElement('small');
            count.textContent = String(visibleTabs.filter(tab => tab.group === group).length);
            header.append(chevron, label, count);
            header.addEventListener('click', () => { if (!searching) this.toggleTabGroup(group); });
            header.addEventListener('dragover', event => {
                if (!this._getDraggedTabId(event)) return;
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
                header.classList.add('tab-group-header--drop');
            });
            header.addEventListener('dragleave', () => header.classList.remove('tab-group-header--drop'));
            header.addEventListener('drop', event => {
                const tabId = this._getDraggedTabId(event);
                if (!tabId) return;
                event.preventDefault(); event.stopPropagation();
                this.setTabGroup(tabId, group);
                this._clearTabDragState();
            });
            this.tabContainer.insertBefore(header, tab.element);
        }
    }

    setTabGroup(tabId, name) {
        const tab = this.getTabById(tabId);
        if (!tab || tab.hidden) return;
        tab.group = String(name || '').trim().slice(0, 60);
        const expandingGroup = this.collapsedGroups.has(tab.group);
        this.collapsedGroups.delete(tab.group);
        tab.element.hidden = false;
        tab.element.dataset.group = tab.group;
        tab.element.title = tab.group ? `${tab.group} · ${tab.title}` : tab.title;
        let badge = tab.element.querySelector('.tab-group-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'tab-group-badge';
            tab.element.prepend(badge);
        }
        badge.textContent = tab.group;
        badge.hidden = !tab.group;
        const peers = this.tabs.filter(candidate => candidate.id !== tabId && candidate.group === tab.group);
        if (tab.group && peers.length) this.reorderTab(tabId, peers[peers.length - 1].id, true);
        if (expandingGroup) this.setTabGroupCollapsed(tab.group, false);
        this._emitSessionChange();
        window.dispatchEvent(createWindowCustomEvent('tab-groups-changed'));
    }

    _resolveTabRequest(urlOrEvent) {
        const url = typeof urlOrEvent === 'string' ? urlOrEvent : 'about:blank';

        const transformedViewMatch = url.match(/^browser:\/\/view\/([0-9a-f-]{36})$/i);
        if (transformedViewMatch) {
            const viewId = transformedViewMatch[1].toLowerCase();
            return {
                displayUrl: `browser://view/${viewId}`,
                loadUrl: new URL(`transformed-view.html?viewId=${viewId}`, window.location.href).toString(),
                title: 'Transformed view',
                role: 'transformed',
                internal: false,
                viewId
            };
        }

        if (url === 'browser://assistant' || url === 'assistant.html' || url === 'assistant://assistant' || url === 'assistant') {
            return {
                displayUrl: 'browser://assistant',
                loadUrl: 'assistant.html',
                title: 'AI Workspace',
                role: 'assistant',
                internal: true
            };
        }

        return {
            displayUrl: url,
            loadUrl: url,
            title: null,
            role: 'regular',
            internal: false
        };
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

    _isArtifactUrl(url) {
        try {
            const parsed = new URL(url);
            return parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1'
                && /^\/artifact\/[0-9a-f-]+\/[A-Za-z0-9_-]+\/(view|download)$/.test(parsed.pathname);
        } catch {
            return false;
        }
    }

    _getCrashedTabPageUrl() {
        return new URL('tab-crashed.html', window.location.href).toString();
    }

    _emitSessionChange() {
        this._renderGroupHeaders();
        let placeholder = document.getElementById('collapsed-groups-placeholder');
        if (!this.activeTabId && this.tabs.some(tab => !tab.hidden && this.collapsedGroups.has(tab.group))) {
            if (!placeholder) {
                placeholder = document.createElement('div');
                placeholder.id = 'collapsed-groups-placeholder';
                placeholder.className = 'collapsed-groups-placeholder';
                placeholder.textContent = 'Expand a group or select a tab to load a page.';
                this.contentContainer.appendChild(placeholder);
            }
        } else placeholder?.remove();
        const event = createWindowCustomEvent('tab-session-changed', this.getSessionSnapshot());
        if (event) {
            window.dispatchEvent(event);
        }
    }

    restoreCollapsedGroups(groups = []) {
        const known = new Set(this.getTabGroups());
        this.collapsedGroups = new Set(groups.filter(group => known.has(group)));
        for (const tab of this.tabs) {
            if (this.collapsedGroups.has(tab.group)) this.suspendTab(tab.id);
        }
        this._selectOutsideCollapsedGroups();
        this._emitSessionChange();
    }

    getSessionSnapshot() {
        return {
            collapsedGroups: [...this.collapsedGroups],
            activeTabId: this.activeTabId,
            tabs: this.tabs
                .filter((tab) => !tab.hidden && !tab.internal && (tab.trackHistory !== false || tab.role === 'transformed'))
                .map((tab) => ({
                    id: tab.id,
                    url: tab.role === 'transformed' ? tab.url : (tab.recoveryUrl || tab.loadUrl || tab.url),
                    title: tab.title || 'Untitled',
                    loadState: tab.loadState || 'idle',
                    crashed: tab.crashed === true,
                    role: tab.role,
                    group: tab.group || '',
                    ...(tab.viewId ? { viewId: tab.viewId } : {})
                }))
        };
    }

    _clearErrorOverlay() {
        const errorOverlay = document.getElementById('error-message-overlay');
        if (!errorOverlay) return;
        errorOverlay.replaceChildren();
        errorOverlay.classList.remove('visible', 'error-overlay--crashed');
    }

    _showCrashedTabOverlay(tab) {
        const errorOverlay = document.getElementById('error-message-overlay');
        if (!errorOverlay || !tab || tab.crashPage || this.activeTabId !== tab.id) return;

        const heading = document.createElement('strong');
        heading.textContent = 'This tab stopped responding';
        const message = document.createElement('p');
        message.textContent = tab.recoveryMessage || 'The page renderer exited. The rest of the browser is still available.';
        const actions = document.createElement('div');
        actions.className = 'error-overlay__actions';
        const reload = document.createElement('button');
        reload.type = 'button';
        reload.textContent = 'Reload tab';
        reload.addEventListener('click', () => this.recoverTab(tab.id));
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'error-overlay__secondary-action';
        close.textContent = 'Close tab';
        close.addEventListener('click', () => this.closeTab(tab.id));
        actions.append(reload, close);

        errorOverlay.replaceChildren(heading, message, actions);
        errorOverlay.classList.add('visible', 'error-overlay--crashed');
    }

    _syncOverlayForActiveTab() {
        const activeTab = this.getActiveTab();
        if (activeTab?.crashed) {
            this._showCrashedTabOverlay(activeTab);
        } else {
            this._clearErrorOverlay();
        }
    }

    markTabRendererGone(tabId, details = {}) {
        const tab = this.getTabById(tabId);
        if (!tab || tab.crashed || tab.suspended) return false;

        tab.crashed = true;
        tab.loadState = 'crashed';
        tab.recoveryUrl = tab.recoveryUrl || tab.loadUrl || tab.url;
        tab.recoveryMessage = details.recoveryMessage
            || `The page renderer exited${details.reason ? ` (${details.reason})` : ''}. Reload this tab to try again.`;
        tab.crashPage = false;
        tab.element?.classList?.add('tab--crashed');
        this._showCrashedTabOverlay(tab);
        this._emitSessionChange();
        return true;
    }

    recoverTab(tabId) {
        const tab = this.getTabById(tabId);
        if (!tab || !tab.crashed || !tab.recoveryUrl) return false;

        const targetUrl = tab.recoveryUrl;
        this._resumeTab(tab);
        tab.crashed = false;
        tab.recoveryUrl = null;
        tab.recoveryMessage = null;
        tab.crashPage = false;
        tab.loadState = 'loading';
        tab.loadUrl = targetUrl;
        tab.element?.classList?.remove('tab--crashed');
        this._clearErrorOverlay();

        try {
            tab.webview.loadURL(targetUrl);
        } catch (error) {
            console.error(`Could not reload crashed tab ${tab.id}:`, error);
            this.markTabRendererGone(tab.id, { recoveryMessage: 'The tab could not be restarted. Try closing it and opening the page again.' });
            return false;
        }

        this._emitSessionChange();
        return true;
    }

    reloadTab(tabId = this.activeTabId) {
        const tab = this.getTabById(tabId);
        if (!tab) return false;
        if (tab.suspended || tab.deferredUrl) {
            this._resumeTab(tab);
            if (this.activeTabId === tab.id) tab.webview.style.display = 'flex';
            this._emitSessionChange();
            return true;
        }
        if (tab.role === 'transformed') {
            const event = createWindowCustomEvent('transformed-view-reload-request', { tabId: tab.id });
            if (event) window.dispatchEvent(event);
            return true;
        }
        try {
            tab.webview?.reload?.();
            return true;
        } catch (error) {
            console.warn(`Could not reload tab ${tab.id}:`, error);
            return false;
        }
    }

    // Create a new tab and return its ID
    createTab(urlOrEvent = 'about:blank', options = {}) {
        const {
            activate = true,
            deferLoad = false,
            title = 'New Tab',
            role = 'regular',
            assistantOwned = false,
            hidden = false,
            partition = null,
            trackHistory = true,
            recoveryPaused = false,
            recoveryMessage = null
        } = options;

        // Check if this was called from an event handler (like the new tab button click)
        let url = 'about:blank';
        if (typeof urlOrEvent === 'string') {
            url = urlOrEvent;
        } else if (urlOrEvent && urlOrEvent.type === 'click') {
            // This was called from a click event, use the default URL
            url = 'about:blank';
        }
        const resolved = this._resolveTabRequest(url);
        const displayUrl = resolved.displayUrl;
        const loadUrl = resolved.loadUrl;
        const initialLoadUrl = recoveryPaused ? this._getCrashedTabPageUrl() : loadUrl;
        const shouldDeferLoad = deferLoad && !recoveryPaused;
        const tabRole = resolved.role || role;
        const tabTitle = title && title !== 'New Tab' ? title : (resolved.title || title);
        const shouldTrackHistory = trackHistory !== false && tabRole !== 'transformed';
        const tabId = `tab-${this.tabCounter++}`;
        
        let tabElement = null;
        if (!hidden) {
            tabElement = document.createElement('div');
            tabElement.className = 'tab';
            tabElement.id = `tab-element-${tabId}`;
            tabElement.innerHTML = `
                <img class="tab-favicon" src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=" alt="">
                <span class="tab-title"></span>
                <button class="tab-close-btn">×</button>
            `;

            const initialTitleNode = tabElement.querySelector('.tab-title');
            if (initialTitleNode) initialTitleNode.textContent = tabTitle;
            tabElement.addEventListener('click', (e) => {
                if (e.target.className !== 'tab-close-btn') {
                    this.switchToTab(tabId);
                }
            });

            tabElement.addEventListener('contextmenu', (event) => {
                this.showTabContextMenu(tabId, event);
            });

            this._setUpTabDragAndDrop(tabElement, tabId);

            const closeBtn = typeof tabElement.querySelector === 'function'
                ? tabElement.querySelector('.tab-close-btn')
                : tabElement.getElementsByClassName?.('tab-close-btn')?.[0] || tabElement.children?.[1] || null;
            if (closeBtn && typeof closeBtn.addEventListener === 'function') {
                closeBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.closeTab(tabId);
                });
            }

            this.tabContainer.insertBefore(tabElement, document.getElementById('new-tab-btn'));
        }
        
        const webview = this._createTabWebview(tabId, partition, loadUrl);
        if (!shouldDeferLoad) webview.setAttribute('src', initialLoadUrl);

        // Create tab object
        const tab = {
            id: tabId,
            url: displayUrl, // Store the display URL regardless of load state
            loadUrl: initialLoadUrl, // Store the actual URL loaded into the webview
            title: tabTitle, // Use initial title
            favicon: null,
            webview: webview,
            suspended: shouldDeferLoad,
            element: tabElement,
            deferredUrl: shouldDeferLoad ? loadUrl : null, // Store URL if loading is deferred
            role: tabRole,
            assistantOwned: !!assistantOwned,
            internal: resolved.internal,
            hidden: !!hidden,
            partition: partition || null,
            trackHistory: shouldTrackHistory,
            viewId: resolved.viewId || null,
            loadState: recoveryPaused || shouldDeferLoad
                ? (recoveryPaused ? 'crashed' : 'idle')
                : (initialLoadUrl === 'about:blank' ? 'idle' : 'loading'),
            crashed: recoveryPaused,
            recoveryUrl: recoveryPaused ? loadUrl : null,
            recoveryMessage: recoveryPaused ? (recoveryMessage || 'This page was still loading when the browser stopped unexpectedly. Reload it only when you are ready.') : null,
            crashPage: recoveryPaused
        };
        
        // Add tab to tabs array
        this.tabs.push(tab);
        
        // Set up webview event listeners
        this.setupWebviewEvents(tab);
        this._setupTabNetworkReady(tab);
        // Deferred entries have no attached guest, so they consume no page renderer.
        if (!shouldDeferLoad) this.contentContainer.appendChild(webview);
        
        // Switch to the new tab if activate is true
        if (activate && !hidden) {
            this.switchToTab(tabId);
        }

        // Add to history if a valid URL, using the initial title
        if (shouldTrackHistory && displayUrl !== 'about:blank') {
            this.historyManager.addOrUpdateEntry(displayUrl, tabTitle, 'open');
        }

        if (recoveryPaused) {
            tab.element?.classList?.add('tab--crashed');
        }

        this._emitSessionChange();


        return tabId;
    }
    
    // Close a tab by ID
    closeTab(tabId) {
        const tabIndex = this.tabs.findIndex(tab => tab.id === tabId);
        if (tabIndex === -1) return;

        const tab = this.tabs[tabIndex];

        const closeEvent = createWindowCustomEvent('tab-closed', { tabId: tab.id, tab });
        if (closeEvent) {
            window.dispatchEvent(closeEvent);
        }

        if (tab.trackHistory !== false) {
            this.historyManager.markAsClosed(tab.url);
        }
        
        // Remove tab element from DOM
        tab.element?.remove?.();
        
        // Remove webview from DOM
        tab.webview?.remove?.();
        
        // Remove tab from tabs array
        this.tabs.splice(tabIndex, 1);
        this._syncOverlayForActiveTab();
        this._emitSessionChange();
        
        // If we closed the active tab, switch to another tab
        if (this.activeTabId === tabId) {
            // If there are no tabs left, create a new one
            const visibleTabs = this.tabs.filter((candidate) => !candidate.hidden);
            if (visibleTabs.length === 0) {
                this.createTab();
            } else {
                const candidates = this.tabs.filter((candidate) => !candidate.hidden);
                const rightVisible = this.tabs.slice(tabIndex).find((candidate) => !candidate.hidden);
                const fallbackVisible = candidates[candidates.length - 1];
                const nextVisible = rightVisible || fallbackVisible;
                if (nextVisible) {
                    this.switchToTab(nextVisible.id);
                } else {
                    this.createTab();
                }
            }
        }
    }
    
    // Switch to a tab by ID
    switchToTab(tabId) {
        // Hide all webviews
        this.tabs.forEach(tab => {
            if (tab.webview?.style) {
                tab.webview.style.display = 'none';
            }
            if (tab.element?.classList?.remove) {
                tab.element.classList.remove('active');
            }
        });
        
        // Show the selected tab's webview
        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
            // Clicking a search result may reopen a collapsed section, but only
            // the selected page is loaded; its siblings remain unloaded.
            if (tab.group) this.collapsedGroups.delete(tab.group);
            this._resumeTab(tab);

            if (tab.webview?.style) {
                tab.webview.style.display = 'flex';
            }
            if (tab.element?.classList?.add) {
                tab.element.classList.add('active');
            }
            
            // Update URL input to reflect the active tab's URL
            const urlInput = document.getElementById('url-input');
            if (urlInput) {
                if (tab.url === 'about:blank') {
                    urlInput.value = ''; // Clear the URL input for new tabs
                } else {
                    urlInput.value = tab.url;
                }
            }
            
            // Update active tab ID
            this.activeTabId = tabId;

            // Update history entry state and last opened time
            if (tab.trackHistory !== false) {
                this.historyManager.addOrUpdateEntry(tab.url, tab.title, 'open');
            }
            
            // Update back button state
            this.updateBackButtonState();
            
            // Dispatch custom event for tab switch
            const event = createWindowCustomEvent('tab-switched', { tabId, tab });
            if (event) {
                window.dispatchEvent(event);
            }
            this._syncOverlayForActiveTab();
            this._emitSessionChange();
        }
    }
    
    // Update the title of a tab
    updateTabTitle(tabId, title) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
            tab.title = title || 'Untitled';
            const titleElement = tab.element?.querySelector?.('.tab-title');
            if (titleElement) {
                titleElement.textContent = tab.title;
                // Truncate long titles with ellipsis in CSS
            }
            // Update history entry title
            if (tab.trackHistory !== false) {
                this.historyManager.addOrUpdateEntry(tab.url, tab.title, 'open');
            }
            this._emitSessionChange();
        }
    }
    
    // Update the favicon of a tab
    updateTabFavicon(tabId, faviconUrl) {
        const tab = this.tabs.find(t => t.id === tabId);
        if (tab) {
            tab.favicon = faviconUrl;
            const faviconElement = tab.element?.querySelector?.('.tab-favicon');
            if (faviconElement && faviconUrl) {
                faviconElement.src = faviconUrl;
            }
        }
    }
    
    // Get the active tab
    getActiveTab() {
        return this.tabs.find(tab => tab.id === this.activeTabId);
    }
    
    // Get a tab by ID
    getTabById(tabId) {
        return this.tabs.find(tab => tab.id === tabId);
    }
    
    // Get the active webview
    getActiveWebview() {
        const activeTab = this.getActiveTab();
        return activeTab ? activeTab.webview : null;
    }
    
    // Set up event listeners for a tab's webview
    setupWebviewEvents(tab) {
        const webview = tab.webview;
        const on = (name, callback) => webview.addEventListener(name, event => {
            if (tab.webview === webview && !tab.suspended) callback(event);
        });
        
        // Update tab title when page title changes
        on('page-title-updated', (e) => {
            this.updateTabTitle(tab.id, e.title);
        });
        
        // Update tab URL when navigation occurs
        on('did-navigate', (e) => {
            // A recovery-paused tab loads about:blank as a placeholder. Do not
            // let that navigation overwrite the URL the user may choose to
            // reload later.
            if (tab.crashed && tab.recoveryUrl) {
                return;
            }
            tab.loadUrl = e.url;
            tab.loadState = 'loading';
            tab.crashed = false;
            tab.recoveryUrl = null;
            tab.recoveryMessage = null;
            tab.element?.classList?.remove('tab--crashed');
            if (!tab.internal && tab.role !== 'transformed') {
                tab.url = e.url;
            }
            
            // Update URL input if this is the active tab
            if (this.activeTabId === tab.id) {
                const urlInput = document.getElementById('url-input');
                if (urlInput) {
                    if (e.url === 'about:blank') {
                        urlInput.value = ''; // Clear the URL input for blank pages
                    } else {
                        urlInput.value = e.url;
                    }
                }
                
                // Update back button state
                this.updateBackButtonState();
            }
            // Add or update history entry on navigation
            if (tab.trackHistory !== false) {
                this.historyManager.addOrUpdateEntry(tab.url, tab.title, 'open');
            }
            this._emitSessionChange();
        });

        on('did-start-navigation', (e) => {
            if (e.isMainFrame === false) return;
            if (tab.crashed && tab.recoveryUrl) return;
            tab.loadUrl = e.url || tab.loadUrl;
            tab.loadState = 'loading';
            this._emitSessionChange();
        });
        
        // Update favicon when available
        on('page-favicon-updated', (e) => {
            if (e.favicons && e.favicons.length > 0) {
                this.updateTabFavicon(tab.id, e.favicons[0]);
            }
        });
        
        // Get reference to the error overlay element
        const errorOverlay = document.getElementById('error-message-overlay');

        // Set up the same event listeners as in the original renderer.js
        on('did-start-loading', () => {
            console.log(`Tab ${tab.id} started loading`);
            if (!tab.crashed) {
                tab.loadState = 'loading';
                this._emitSessionChange();
            }
            // Hide error overlay when loading starts
            if (errorOverlay) {
                errorOverlay.classList.remove('visible');
                errorOverlay.textContent = ''; // Clear previous message
            }
        });
        
        on('did-stop-loading', () => {
            console.log(`Tab ${tab.id} finished loading`);
            if (!tab.crashed) {
                tab.loadState = 'idle';
                this._emitSessionChange();
            }
            // Ensure error overlay is hidden if loading succeeds
            if (errorOverlay && !errorOverlay.classList.contains('visible')) { // Only hide if not already shown by did-fail-load
                 errorOverlay.classList.remove('visible');
                 errorOverlay.textContent = '';
            }
            // Inject interaction listeners script
            if (!tab.internal && typeof injectInteractionListeners === 'function') {
                injectInteractionListeners(webview);
            }
        });

        if (tab.internal) {
            on('will-navigate', (event) => {
                if (this._isAssistantWorkspaceUrl(event.url)) {
                    return;
                }

                console.warn(`Blocking navigation away from assistant workspace tab ${tab.id} to ${event.url}`);
                event.preventDefault();
            });
        }
        
        // Add a did-finish-load event to ensure summarizer is properly initialized and update bookmark button
        on('did-finish-load', (e) => {
            console.log(`Tab ${tab.id} finished loading completely - ensuring summarizer is initialized and updating bookmark button`);
            if (!tab.internal && !tab.crashed) {
                // Dispatch a custom event to ensure summarizer is initialized for this tab
                const summarizerEvent = createWindowCustomEvent('ensure-summarizer-initialized', {
                    tabId: tab.id,
                    webview
                });
                if (summarizerEvent) {
                    window.dispatchEvent(summarizerEvent);
                }

                // Update bookmark button state based on the loaded URL
                const loadedUrl = e.url;
                const isBookmarked = loadedUrl ? this.historyManager.isBookmarked(loadedUrl) : false;
                if (this.bookmarkBtn) {
                    this.bookmarkBtn.classList.toggle('bookmarked', isBookmarked);
                    this.bookmarkBtn.setAttribute('aria-pressed', String(isBookmarked));
                    this.bookmarkBtn.setAttribute('aria-label', isBookmarked
                        ? 'Current page is bookmarked'
                        : 'Add current page to bookmarks');
                    this.bookmarkBtn.title = isBookmarked ? 'Bookmarked' : 'Add bookmark';
                    console.log(`Bookmark button state updated for loaded URL: ${loadedUrl}. Bookmarked: ${isBookmarked}`);
                } else {
                    console.error('Bookmark button not available in TabManager.');
                }
            }
        });
        
        on('did-fail-load', (error) => {
            console.error(`Tab ${tab.id} failed to load:`, error.errorCode, error.errorDescription);
            // Check if it's the specific error we want to display
            if (error.errorDescription === 'ERR_CONNECTION_TIMED_OUT') {
                if (errorOverlay) {
                    errorOverlay.textContent = 'Connection Timed Out. Please check your internet connection and try again.';
                    errorOverlay.classList.add('visible');
                }
            } else if (error.errorCode !== -3) { // Ignore Aborted errors (-3) which happen on navigation
                 tab.loadState = 'failed';
                 this._emitSessionChange();
                 if (errorOverlay) {
                    errorOverlay.textContent = `Failed to load page: ${error.errorDescription || error.errorCode}`;
                    errorOverlay.classList.add('visible');
                 }
            }
        });

        on('render-process-gone', (event) => {
            const details = event?.detail || event || {};
            this.markTabRendererGone(tab.id, details);
        });
        
    // Set up IPC message listener
    on('ipc-message', (event) => {
        console.log(`Received IPC message from tab ${tab.id}:`, event.channel);
        const ipcEvent = createWindowCustomEvent('webview-ipc-message', {
            tabId: tab.id,
            tab,
            channel: event.channel,
            args: event.args || []
        });
        if (ipcEvent) {
            window.dispatchEvent(ipcEvent);
        }
        
        // Handle open-in-new-tab message from Ctrl+click
        if (event.channel === 'open-in-new-tab' && event.args && event.args[0]) {
            // Check if the message is in the new format (object with url and timestamp)
            const data = event.args[0];
            let url;
            
            if (typeof data === 'object' && data.url) {
                url = data.url;
            } else {
                // Fallback for backward compatibility
                url = data;
            }
            
            console.log(`Opening URL in new tab: ${url}`);
            this.createTab(url);
            return;
        }

        if (event.channel === 'recover-crashed-tab') {
            this.recoverTab(tab.id);
            return;
        }

        if (event.channel === 'close-crashed-tab') {
            this.closeTab(tab.id);
            return;
        }

        // Handle scroll and click events by re-dispatching them with the tabId
        if (event.channel === 'webview-scrolled-down') {
            console.log(`Tab ${tab.id} scrolled down, dispatching event with tabId.`);
            const scrolledEvent = createWindowCustomEvent('webview-scrolled-down', { tabId: tab.id });
            if (scrolledEvent) {
                window.dispatchEvent(scrolledEvent);
            }
        } else if (event.channel === 'webview-clicked') {
            console.log(`Tab ${tab.id} clicked, dispatching event with tabId.`);
            const clickedEvent = createWindowCustomEvent('webview-clicked', { tabId: tab.id });
            if (clickedEvent) {
                window.dispatchEvent(clickedEvent);
            }
        }
    });

    }
    
    // Update back button state based on active tab
    updateBackButtonState() {
        const activeTab = this.getActiveTab();
        const backBtn = document.getElementById('back-btn');
        
        if (activeTab && backBtn) {
            try {
                backBtn.disabled = !activeTab.webview.canGoBack();
            } catch (error) {
                console.warn(`Could not read back state for tab ${activeTab.id}: ${error?.message || error}`);
                backBtn.disabled = true;
            }
        }
    }

    closeTabsToRight(tabId) {
        const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
        if (tabIndex === -1 || tabIndex >= this.tabs.length - 1) {
            return;
        }

        const rightTabIds = this.tabs.slice(tabIndex + 1).map((tab) => tab.id);
        for (const rightTabId of rightTabIds) {
            this.closeTab(rightTabId);
        }
    }
}

// Export the class if using modules
// export default TabManager;
export default TabManager;
