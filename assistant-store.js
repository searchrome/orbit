const STORAGE_KEY = 'browser-assistant:sessions';

class AssistantStore {
    constructor() {
        this.state = this._loadState();
    }

    _createEmptyState() {
        return {
            activeSessionId: null,
            sessions: []
        };
    }

    _loadState() {
        try {
            const raw = localStorage.getItem(STORAGE_KEY);
            if (!raw) {
                return this._createEmptyState();
            }

            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') {
                return this._createEmptyState();
            }

            return {
                activeSessionId: parsed.activeSessionId || null,
                sessions: Array.isArray(parsed.sessions) ? parsed.sessions : []
            };
        } catch (error) {
            console.error('[AssistantStore] Failed to load state:', error);
            return this._createEmptyState();
        }
    }

    _isLegacyGeminiFailure(session) {
        if (!session || session.status !== 'failed') {
            return false;
        }

        const haystack = [];
        if (Array.isArray(session.messages)) {
            for (const message of session.messages) {
                haystack.push(message?.content);
                haystack.push(message?.meta?.message);
            }
        }
        if (Array.isArray(session.logs)) {
            for (const log of session.logs) {
                haystack.push(log?.message);
                haystack.push(log?.meta?.error);
            }
        }

        const text = haystack
            .filter((value) => typeof value === 'string' && value.trim())
            .join('\n')
            .toLowerCase();

        return text.includes('gemini')
            || text.includes('googlegenerativeai')
            || text.includes('generativelanguage.googleapis.com');
    }

    save() {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    }

    getSessions() {
        return this.state.sessions;
    }

    getSession(sessionId) {
        return this.state.sessions.find((session) => session.id === sessionId) || null;
    }

    getActiveSession() {
        if (this.state.activeSessionId) {
            const existing = this.getSession(this.state.activeSessionId);
            if (existing) {
                if (this._isLegacyGeminiFailure(existing)) {
                    this.state.activeSessionId = null;
                    this.save();
                    return this.createSession();
                }
                return existing;
            }
        }

        return this.createSession();
    }

    createSession(title = 'New chat') {
        const now = Date.now();
        const session = {
            id: `assistant-session-${now}-${Math.random().toString(36).slice(2, 8)}`,
            title,
            createdAt: now,
            updatedAt: now,
            messages: [],
            logs: [],
            status: 'idle',
            pendingClarification: null
        };

        this.state.sessions.unshift(session);
        this.state.activeSessionId = session.id;
        this.save();
        return session;
    }

    setActiveSession(sessionId) {
        const session = this.getSession(sessionId);
        if (!session) {
            return null;
        }

        this.state.activeSessionId = sessionId;
        this.save();
        return session;
    }

    renameActiveSession(title) {
        const session = this.getActiveSession();
        if (!session) {
            return null;
        }

        session.title = title || session.title;
        session.updatedAt = Date.now();
        this.save();
        return session;
    }

    appendMessage(role, content, meta = {}) {
        const session = this.getActiveSession();
        const entry = {
            role,
            content,
            meta,
            createdAt: Date.now()
        };

        session.messages.push(entry);
        session.updatedAt = entry.createdAt;

        if (session.title === 'New chat' && role === 'user') {
            const preview = String(content || '').trim().split(/\s+/).slice(0, 6).join(' ');
            session.title = preview ? preview.slice(0, 48) : session.title;
        }

        this.save();
        return entry;
    }

    appendLog(message, level = 'info', meta = {}) {
        const session = this.getActiveSession();
        const entry = {
            message,
            level,
            meta,
            createdAt: Date.now()
        };

        session.logs.push(entry);
        session.updatedAt = entry.createdAt;
        this.save();
        return entry;
    }

    updateStatus(status) {
        const session = this.getActiveSession();
        session.status = status;
        session.updatedAt = Date.now();
        this.save();
        return session;
    }

    setPendingClarification(pendingClarification) {
        const session = this.getActiveSession();
        session.pendingClarification = pendingClarification
            ? { ...pendingClarification }
            : null;
        session.updatedAt = Date.now();
        this.save();
        return session;
    }

    clearPendingClarification() {
        return this.setPendingClarification(null);
    }

    clearActiveSession() {
        const session = this.getActiveSession();
        session.messages = [];
        session.logs = [];
        session.status = 'idle';
        session.pendingClarification = null;
        session.updatedAt = Date.now();
        this.save();
        return session;
    }
}

export default AssistantStore;
