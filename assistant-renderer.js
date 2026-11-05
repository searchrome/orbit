import AssistantStore from './assistant-store.js';

const store = new AssistantStore();

const elements = {
    app: document.getElementById('assistant-app'),
    sessionTitle: document.getElementById('assistant-session-title'),
    sessionStatus: document.getElementById('assistant-status'),
    messageList: document.getElementById('assistant-messages'),
    logList: document.getElementById('assistant-log-list'),
    tabList: document.getElementById('assistant-tab-list'),
    composerForm: document.getElementById('assistant-composer-form'),
    composerInput: document.getElementById('assistant-input'),
    sendButton: document.getElementById('assistant-send'),
    stopButton: document.getElementById('assistant-stop'),
    newChatButton: document.getElementById('assistant-new-chat'),
    sessionList: document.getElementById('assistant-session-list')
};

const state = {
    session: store.getActiveSession(),
    runState: 'idle',
    touchedTabs: []
};

function escapeText(value) {
    return String(value ?? '');
}

function scrollToBottom(element) {
    if (!element) {
        return;
    }
    element.scrollTop = element.scrollHeight;
}

function normalizeTouchedTab(tab) {
    if (typeof tab === 'string') {
        const id = tab.trim();
        return id ? { id, title: id, url: '' } : null;
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
        closed: !!tab.closed
    };
}

function updateTouchedTabs(nextTabs) {
    const items = Array.isArray(nextTabs) ? nextTabs.map(normalizeTouchedTab).filter(Boolean) : [];
    if (!items.length) {
        return;
    }

    const merged = [...state.touchedTabs];
    for (const item of items) {
        const existingIndex = merged.findIndex((entry) => entry.id === item.id);
        if (existingIndex >= 0) {
            merged.splice(existingIndex, 1);
        }
        merged.unshift(item);
    }

    state.touchedTabs = merged.slice(0, 8);
    renderTouchedTabs();
}

function renderTouchedTabs() {
    if (!elements.tabList) {
        return;
    }

    elements.tabList.innerHTML = '';

    if (!state.touchedTabs.length) {
        const empty = document.createElement('div');
        empty.className = 'assistant-tab-chip';
        empty.textContent = 'No tabs touched yet';
        elements.tabList.appendChild(empty);
        return;
    }

    state.touchedTabs.forEach((tab) => {
        const chip = document.createElement('div');
        chip.className = 'assistant-tab-chip';

        const title = document.createElement('div');
        title.className = 'tab-title';
        title.textContent = tab.title || tab.id;
        chip.appendChild(title);

        const url = document.createElement('div');
        url.className = 'tab-url';
        url.textContent = tab.closed ? `${tab.id} closed` : tab.url || tab.id;
        chip.appendChild(url);

        elements.tabList.appendChild(chip);
    });
}

function getDisplayedStatus() {
    if (state.runState === 'running' || state.runState === 'waiting') {
        return state.runState;
    }

    return state.session.status || 'idle';
}

function isInteractionBlocked() {
    const status = getDisplayedStatus();
    return status === 'running' || status === 'waiting';
}

function renderSessionList() {
    if (!elements.sessionList) {
        return;
    }

    const sessions = store.getSessions();
    elements.sessionList.innerHTML = '';

    sessions.slice(0, 8).forEach((session) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `assistant-session-chip${session.id === state.session.id ? ' active' : ''}`;
        button.textContent = session.title || 'New chat';
        button.addEventListener('click', () => {
            if (isInteractionBlocked()) {
                appendLocalLog('Stop the current task before switching sessions.', 'warn');
                return;
            }

            state.session = store.setActiveSession(session.id) || store.getActiveSession();
            state.touchedTabs = [];
            renderAll();
        });
        elements.sessionList.appendChild(button);
    });
}

function renderMessages() {
    if (!elements.messageList) {
        return;
    }

    elements.messageList.innerHTML = '';

    state.session.messages.forEach((message) => {
        const isThinking = message.role === 'assistant'
            && message.meta?.source === 'planner'
            && !message.meta?.clarification
            && !message.meta?.results?.length;

        const row = document.createElement('article');
        row.className = `assistant-message ${message.role === 'user' ? 'user' : 'assistant'}${isThinking ? ' thinking' : ''}`;

        const meta = document.createElement('div');
        meta.className = 'assistant-message-meta';
        meta.textContent = message.role === 'user' ? 'You' : isThinking ? 'Thinking' : 'Assistant';

        const body = document.createElement('div');
        body.className = 'assistant-message-body';
        body.textContent = escapeText(message.content);

        row.appendChild(meta);
        row.appendChild(body);

        if (message.meta?.results?.length) {
            const results = document.createElement('div');
            results.className = 'assistant-result-list';

            message.meta.results.forEach((result) => {
                const card = document.createElement('div');
                card.className = 'assistant-result-card';

                const title = document.createElement('div');
                title.className = 'assistant-result-title';
                title.textContent = result.title || result.url || 'Result';

                card.appendChild(title);

                if (result.url) {
                    const link = document.createElement('a');
                    link.href = result.url;
                    link.textContent = result.url;
                    link.target = '_blank';
                    link.rel = 'noreferrer';
                    card.appendChild(link);
                }

                if (result.price) {
                    const price = document.createElement('div');
                    price.className = 'assistant-result-price';
                    price.textContent = result.price;
                    card.appendChild(price);
                }

                if (result.reason) {
                    const reason = document.createElement('div');
                    reason.className = 'assistant-result-reason';
                    reason.textContent = result.reason;
                    card.appendChild(reason);
                }

                results.appendChild(card);
            });

            row.appendChild(results);
        }

        elements.messageList.appendChild(row);
    });

    scrollToBottom(elements.messageList);
}

function renderLogs() {
    if (!elements.logList) {
        return;
    }

    elements.logList.innerHTML = '';

    state.session.logs.slice(-50).forEach((entry) => {
        const row = document.createElement('div');
        row.className = `assistant-log-entry ${entry.level || 'info'}`;
        row.textContent = entry.message;
        elements.logList.appendChild(row);
    });

    scrollToBottom(elements.logList);
}

function renderStatus() {
    const displayStatus = getDisplayedStatus();

    if (elements.sessionTitle) {
        elements.sessionTitle.textContent = state.session.title || 'New chat';
    }

    if (elements.sessionStatus) {
        elements.sessionStatus.textContent = displayStatus === 'running'
            ? 'Working'
            : displayStatus === 'waiting'
                ? 'Waiting for approval'
                : displayStatus === 'clarifying'
                    ? 'Need your reply'
                : displayStatus === 'failed'
                    ? 'Failed'
                    : 'Idle';
        elements.sessionStatus.dataset.state = displayStatus;
    }

    if (elements.sendButton) {
        elements.sendButton.disabled = displayStatus === 'running' || displayStatus === 'waiting';
    }

    if (elements.stopButton) {
        elements.stopButton.disabled = !(displayStatus === 'running' || displayStatus === 'waiting');
    }

    if (elements.composerInput) {
        elements.composerInput.placeholder = displayStatus === 'running'
            ? 'The assistant is working...'
            : displayStatus === 'waiting'
                ? 'Waiting for approval...'
                : displayStatus === 'clarifying'
                    ? 'Reply with the missing detail to continue...'
                    : 'Describe what you want the browser to do...';
    }
}

function getClarificationPayload(payload, allowMessageFallback = false) {
    const clarification = payload?.meta?.clarification || payload?.pendingClarification;
    if (clarification && typeof clarification === 'object') {
        return clarification;
    }

    if (allowMessageFallback && typeof payload?.message === 'string' && payload.message.trim()) {
        return {
            question: payload.message.trim()
        };
    }

    return null;
}

function renderAll() {
    renderSessionList();
    renderStatus();
    renderMessages();
    renderLogs();
    renderTouchedTabs();
}

function setRunState(runState, statusOverride = null) {
    state.runState = runState;
    store.updateStatus(statusOverride || runState);
    renderStatus();
}

function appendLocalMessage(role, content, meta = {}) {
    const entry = store.appendMessage(role, content, meta);
    state.session = store.getActiveSession();
    renderAll();
    return entry;
}

function appendLocalLog(message, level = 'info', meta = {}) {
    const entry = store.appendLog(message, level, meta);
    state.session = store.getActiveSession();
    renderLogs();
    return entry;
}

function sendToHost(channel, payload) {
    if (!window.electronAPI || typeof window.electronAPI.sendToHost !== 'function') {
        appendLocalLog(`Bridge unavailable for ${channel}`, 'error');
        return;
    }

    window.electronAPI.sendToHost(channel, payload);
}

function submitPrompt(prompt) {
    const value = String(prompt || '').trim();
    if (!value) {
        return;
    }

    if (isInteractionBlocked()) {
        appendLocalLog('The assistant is already working or waiting for approval. Stop the current task before sending another prompt.', 'warn');
        return;
    }

    const clarificationContext = state.session.pendingClarification
        ? { ...state.session.pendingClarification }
        : null;

    appendLocalMessage('user', value, {
        source: 'composer',
        replyToClarification: clarificationContext?.question || null
    });
    state.touchedTabs = [];
    renderTouchedTabs();
    setRunState('running', 'running');
    appendLocalLog(`Queued prompt: ${value}`);

    if (clarificationContext) {
        store.clearPendingClarification();
        state.session = store.getActiveSession();
    }

    sendToHost('assistant-user-message', {
        sessionId: state.session.id,
        prompt: value,
        clarificationContext,
        session: {
            id: state.session.id,
            title: state.session.title,
            messages: state.session.messages,
            logs: state.session.logs,
            status: state.session.status
        }
    });

    if (elements.composerInput) {
        elements.composerInput.value = '';
    }
}

function handleHostResponse(payload) {
    if (!payload || (payload.sessionId && payload.sessionId !== state.session.id)) {
        return;
    }

    if (payload.meta?.touchedTabs || payload.touchedTabs) {
        updateTouchedTabs(payload.touchedTabs || payload.meta.touchedTabs);
    }

    if (typeof payload.message === 'string' && payload.message.trim()) {
        appendLocalMessage('assistant', payload.message, {
            source: payload.source || 'host',
            results: Array.isArray(payload.results) ? payload.results : undefined,
            clarification: payload.meta?.clarification || payload.pendingClarification || null
        });
    }

    if (Array.isArray(payload.results) && !payload.message) {
        appendLocalMessage('assistant', 'Results ready.', {
            source: payload.source || 'host',
            results: payload.results
        });
    }

    if (payload.log) {
        appendLocalLog(payload.log, payload.level || 'info', payload.meta || {});
    }

    if (payload.status) {
        store.updateStatus(payload.status);
    }

    if (payload.status === 'waiting') {
        setRunState('waiting', 'waiting');
    } else if (payload.status === 'clarifying') {
        const clarification = getClarificationPayload(payload, true);
        if (clarification) {
            store.setPendingClarification(clarification);
        }
        setRunState('idle', 'clarifying');
    } else if (payload.status === 'failed') {
        store.clearPendingClarification();
        setRunState('idle', 'failed');
    } else if (payload.isFinal || payload.status === 'idle' || payload.status === 'finished' || !payload.status) {
        store.clearPendingClarification();
        setRunState('idle', 'idle');
    }

    state.session = store.getActiveSession();
    renderAll();
}

function handleStop() {
    appendLocalLog('Stop requested by user.', 'warn');
    setRunState('idle');
    sendToHost('assistant-stop-task', {
        sessionId: state.session.id
    });
}

function attachListeners() {
    if (elements.composerForm) {
        elements.composerForm.addEventListener('submit', (event) => {
            event.preventDefault();
            submitPrompt(elements.composerInput ? elements.composerInput.value : '');
        });
    }

    if (elements.sendButton) {
        elements.sendButton.addEventListener('click', () => {
            submitPrompt(elements.composerInput ? elements.composerInput.value : '');
        });
    }

    if (elements.stopButton) {
        elements.stopButton.addEventListener('click', handleStop);
    }

    if (elements.newChatButton) {
        elements.newChatButton.addEventListener('click', () => {
            if (isInteractionBlocked()) {
                appendLocalLog('Stop the current task before starting a new chat.', 'warn');
                return;
            }

            state.session = store.createSession();
            state.touchedTabs = [];
            renderTouchedTabs();
            setRunState('idle');
            renderAll();
            if (elements.composerInput) {
                elements.composerInput.focus();
            }
        });
    }

    document.querySelectorAll('[data-prompt]').forEach((button) => {
        button.addEventListener('click', () => {
            const prompt = button.getAttribute('data-prompt');
            if (elements.composerInput && prompt) {
                elements.composerInput.value = prompt;
                submitPrompt(prompt);
            }
        });
    });

    if (elements.composerInput) {
        elements.composerInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submitPrompt(elements.composerInput.value);
            }
        });
    }

    window.electronAPI?.on('assistant-response', (payload) => handleHostResponse(payload));
    window.electronAPI?.on('assistant-progress', (payload) => {
        if (!payload || (payload.sessionId && payload.sessionId !== state.session.id)) {
            return;
        }
        if (payload.meta?.touchedTabs || payload.touchedTabs) {
            updateTouchedTabs(payload.touchedTabs || payload.meta.touchedTabs);
        }
        if (typeof payload.message === 'string') {
            appendLocalLog(payload.message, payload.level || 'info', payload.meta || {});
        }
    });
    window.electronAPI?.on('assistant-log', (payload) => {
        if (!payload || (payload.sessionId && payload.sessionId !== state.session.id)) {
            return;
        }
        appendLocalLog(payload.message || 'Log entry received.', payload.level || 'info', payload.meta || {});
    });
    window.electronAPI?.on('assistant-status', (payload) => {
        if (!payload || (payload.sessionId && payload.sessionId !== state.session.id)) {
            return;
        }
        if (payload.status) {
            store.updateStatus(payload.status);
        }
        if (payload.status === 'waiting') {
            setRunState('waiting', 'waiting');
        } else if (payload.status === 'clarifying') {
            const clarification = getClarificationPayload(payload, false);
            if (clarification) {
                store.setPendingClarification(clarification);
            }
            setRunState('idle', 'clarifying');
        } else if (payload.status === 'failed') {
            store.clearPendingClarification();
            setRunState('idle', 'failed');
        } else if (payload.status === 'idle' || payload.status === 'finished') {
            store.clearPendingClarification();
            setRunState('idle', 'idle');
        }
        renderStatus();
    });
    window.electronAPI?.on('assistant-task-started', (payload) => {
        if (payload?.sessionId && payload.sessionId !== state.session.id) {
            return;
        }
        setRunState('running', 'running');
        state.touchedTabs = [];
        renderTouchedTabs();
        if (payload?.message) {
            appendLocalLog(payload.message, 'info');
        }
    });
    window.electronAPI?.on('assistant-task-finished', (payload) => {
        if (payload?.sessionId && payload.sessionId !== state.session.id) {
            return;
        }
        if (payload?.message) {
            appendLocalLog(payload.message, 'info');
        }
        store.clearPendingClarification();
        setRunState('idle', 'idle');
    });
    window.electronAPI?.on('assistant-task-failed', (payload) => {
        if (payload?.sessionId && payload.sessionId !== state.session.id) {
            return;
        }
        appendLocalLog(payload?.message || 'Task failed.', 'error');
        store.clearPendingClarification();
        setRunState('idle', 'failed');
    });
}

function bootstrap() {
    attachListeners();
    renderAll();

    if (elements.composerInput) {
        elements.composerInput.focus();
    }
}

bootstrap();
