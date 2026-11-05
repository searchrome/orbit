function formatSavedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Saved recently';
    return `Saved ${date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

export default class BookmarksPanel {
    constructor({ historyManager, tabManager }) {
        this.historyManager = historyManager;
        this.tabManager = tabManager;
        this.panel = document.getElementById('bookmarks-panel');
        this.openButton = document.getElementById('bookmarks-btn');
        this.closeButton = document.getElementById('bookmarks-close-btn');
        this.refreshButton = document.getElementById('bookmarks-refresh-btn');
        this.status = document.getElementById('bookmarks-status');
        this.searchForm = document.getElementById('bookmarks-search-form');
        this.searchInput = document.getElementById('bookmarks-search-input');
        this.searchButton = document.getElementById('bookmarks-search-btn');
        this.list = document.getElementById('bookmarks-list');

        if (!this.panel || !this.openButton || !this.list) return;

        this.openButton.addEventListener('click', () => this.show());
        this.closeButton?.addEventListener('click', () => this.hide());
        this.refreshButton?.addEventListener('click', () => this.refresh());
        this.searchForm?.addEventListener('submit', (event) => this.search(event));
        this.list.addEventListener('click', (event) => this.openBookmark(event));
        window.addEventListener('bookmarks-updated', () => {
            if (!this.panel.hidden) this.refresh();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.panel.hidden) this.hide();
        });
    }

    setStatus(message = '') {
        if (this.status) this.status.textContent = message;
    }

    async show() {
        if (!this.panel) return;
        this.panel.hidden = false;
        await this.refresh();
    }

    hide() {
        if (this.panel) this.panel.hidden = true;
    }

    async refresh() {
        if (!this.list) return;
        this.refreshButton && (this.refreshButton.disabled = true);
        const bookmarks = this.historyManager.getHistory()
            .filter((entry) => entry?.bookmarked && entry.url && entry.url !== 'about:blank')
            .sort((first, second) => Number(second.lastOpened || 0) - Number(first.lastOpened || 0));
        this.render(bookmarks);
        this.refreshButton && (this.refreshButton.disabled = false);
    }

    render(bookmarks, { emptyMessage, statusMessage } = {}) {
        this.list.replaceChildren();
        if (!bookmarks.length) {
            const empty = document.createElement('div');
            empty.className = 'bookmarks-panel__empty';
            empty.textContent = emptyMessage || 'No bookmarks yet. Use the star beside the address bar to save the current page.';
            this.list.appendChild(empty);
            this.setStatus(statusMessage || 'Saved pages appear here.');
            return;
        }

        this.setStatus(statusMessage || `${bookmarks.length} saved page${bookmarks.length === 1 ? '' : 's'}.`);
        for (const bookmark of bookmarks) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'bookmark-item';
            item.dataset.bookmarkUrl = bookmark.url;
            item.title = `Open ${bookmark.title || bookmark.url}`;

            const icon = document.createElement('span');
            icon.className = 'bookmark-item__icon';
            icon.textContent = '★';
            icon.setAttribute('aria-hidden', 'true');

            const copy = document.createElement('span');
            copy.className = 'bookmark-item__copy';
            const title = document.createElement('span');
            title.className = 'bookmark-item__title';
            title.textContent = bookmark.title || bookmark.url;
            const url = document.createElement('span');
            url.className = 'bookmark-item__url';
            url.textContent = bookmark.url;
            const date = document.createElement('span');
            date.className = 'bookmark-item__date';
            date.textContent = formatSavedAt(bookmark.lastOpened);
            copy.append(title, url, date);

            if (bookmark.bookmarkDefinition) {
                const definition = document.createElement('span');
                definition.className = 'bookmark-item__definition';
                definition.textContent = bookmark.bookmarkDefinition;
                copy.appendChild(definition);
            }

            if (bookmark.reason) {
                const reason = document.createElement('span');
                reason.className = 'bookmark-item__reason';
                reason.textContent = bookmark.reason;
                copy.appendChild(reason);
            }

            item.append(icon, copy);
            this.list.appendChild(item);
        }
    }

    async search(event) {
        event?.preventDefault?.();
        const query = this.searchInput?.value?.trim();
        if (!query) {
            await this.refresh();
            return;
        }

        if (!window.electronAPI?.invoke) {
            this.setStatus('AI bookmark search is unavailable.');
            return;
        }

        if (this.searchButton) this.searchButton.disabled = true;
        this.setStatus('Searching saved pages with AI…');
        try {
            const result = await window.electronAPI.invoke('bookmark-search', { query });
            const matches = Array.isArray(result?.matches) ? result.matches : [];
            const searchedCount = Number(result?.searchedCount || 0);
            this.render(matches, {
                emptyMessage: 'No saved page matched that question. Try different words or save more pages.',
                statusMessage: matches.length
                    ? `${matches.length} AI match${matches.length === 1 ? '' : 'es'} from ${searchedCount} saved page${searchedCount === 1 ? '' : 's'}.`
                    : `No AI matches from ${searchedCount} saved page${searchedCount === 1 ? '' : 's'}.`
            });
        } catch (error) {
            this.setStatus(`AI search could not finish: ${error?.message || error}`);
        } finally {
            if (this.searchButton) this.searchButton.disabled = false;
        }
    }

    openBookmark(event) {
        const button = event.target?.closest?.('[data-bookmark-url]');
        const url = button?.dataset.bookmarkUrl;
        if (!url) return;
        this.tabManager.createTab(url);
        this.hide();
    }
}
