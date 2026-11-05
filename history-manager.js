// history-manager.js - Manages browsing history

class HistoryManager {
    constructor() {
        // Initialize history as empty, it will be loaded asynchronously
        this.history = [];
        // Load history when the instance is created
        this.loadHistory();
    }

    _getHistoryKey(fullUrl) {
        try {
            const parsedUrl = new URL(fullUrl);

            if (parsedUrl.origin && parsedUrl.origin !== 'null') {
                return parsedUrl.origin + parsedUrl.pathname;
            }

            // Preserve custom schemes and file URLs in a stable form.
            return `${parsedUrl.protocol}//${parsedUrl.host}${parsedUrl.pathname}`;
        } catch (e) {
            console.error(`[HistoryManager] Invalid URL encountered: ${fullUrl}`, e);
            return fullUrl;
        }
    }

    async loadHistory() {
        console.log('[HistoryManager] Attempting to load history via IPC...');
        try {
            // Use electronAPI.invoke to call the main process handler
            this.history = await window.electronAPI.invoke('load-history');
            console.log('[HistoryManager] History loaded successfully via IPC.');
        } catch (e) {
            console.error('[HistoryManager] Failed to load history via IPC:', e);
            this.history = []; // Ensure history is an empty array on failure
        }
    }

    async saveHistory() {
        console.log('[HistoryManager] Attempting to save history via IPC...');
        try {
            // Use electronAPI.send to send history data to the main process
            window.electronAPI.send('save-history', this.history);
            console.log('[HistoryManager] Save history IPC message sent.');
            // Note: We don't await a response here, assuming the main process handles the save.
            // If confirmation is needed, main process would send a separate IPC back.
        } catch (e) {
            console.error('[HistoryManager] Failed to send save history IPC:', e);
        }
    }

    async addOrUpdateEntry(url, title, state, summary = null, isBookmarked = undefined) {
        if (url === 'about:blank') {
            return; // Do not record blank pages
        }
        const baseUrl = this._getHistoryKey(url);
        const existingEntryIndex = this.history.findIndex(entry => this._getHistoryKey(entry.url) === baseUrl);
        const timestamp = Date.now();

        if (existingEntryIndex > -1) {
            // Update existing entry - Importantly, update the URL to the latest version visited
            this.history[existingEntryIndex].url = url;
            // Update existing entry
            this.history[existingEntryIndex].title = title || this.history[existingEntryIndex].title; // Keep old title if new is empty
            this.history[existingEntryIndex].lastOpened = timestamp;
            this.history[existingEntryIndex].state = state;
            // Add or update the summary
            if (summary !== null) {
                this.history[existingEntryIndex].summary = summary;
            }
            if (isBookmarked !== undefined) {
                this.history[existingEntryIndex].bookmarked = !!isBookmarked;
            }
        } else {
            // Add new entry
            const newEntry = {
                url: url,
                title: title || 'Untitled',
                lastOpened: timestamp,
                state: state,
                bookmarked: isBookmarked !== undefined ? !!isBookmarked : false
            };
            // Add summary if provided
            if (summary !== null) {
                newEntry.summary = summary;
            }
            this.history.push(newEntry);
        }
        // Await the save operation
        await this.saveHistory();
    }

    async markAsClosed(url) {
        const baseUrl = this._getHistoryKey(url);
        // Find the entry based on the base URL
        const entry = this.history.find(entry => this._getHistoryKey(entry.url) === baseUrl);
        if (entry) {
            // Update the state of the found entry
            entry.state = 'closed';
            // Await the save operation
            await this.saveHistory();
        }
    }

    async updateBookmarkEnrichment(url, enrichment = {}) {
        const baseUrl = this._getHistoryKey(url);
        const entry = this.history.find((candidate) => this._getHistoryKey(candidate.url) === baseUrl);
        if (!entry) {
            return false;
        }

        entry.bookmarked = true;
        entry.bookmarkEnrichmentState = enrichment.state || 'ready';
        entry.bookmarkDefinition = typeof enrichment.definition === 'string'
            ? enrichment.definition.trim().slice(0, 320)
            : (entry.bookmarkDefinition || '');
        entry.bookmarkSummary = typeof enrichment.summary === 'string'
            ? enrichment.summary.trim().slice(0, 1_600)
            : (entry.bookmarkSummary || '');
        entry.bookmarkKeywords = Array.isArray(enrichment.keywords)
            ? enrichment.keywords
                .map((keyword) => String(keyword || '').trim().slice(0, 80))
                .filter(Boolean)
                .slice(0, 8)
            : (Array.isArray(entry.bookmarkKeywords) ? entry.bookmarkKeywords : []);
        entry.bookmarkEnrichedAt = Date.now();

        if (enrichment.error) {
            entry.bookmarkEnrichmentError = String(enrichment.error).trim().slice(0, 300);
        } else {
            delete entry.bookmarkEnrichmentError;
        }

        await this.saveHistory();
        return true;
    }

    // Check if a URL is bookmarked
    isBookmarked(url) {
        const baseUrl = this._getHistoryKey(url);
        const entry = this.history.find(entry => this._getHistoryKey(entry.url) === baseUrl);
        return entry ? !!entry.bookmarked : false; // Return true if entry exists and is bookmarked
    }

    getHistory() {
        // Note: This returns the current state in the renderer.
        // For the most up-to-date history after a save, you might need to reload.
        return this.history;
    }
}

export default HistoryManager;
