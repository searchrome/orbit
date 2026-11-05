function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function message(error) {
    return error?.message || String(error || 'Could not load session files.');
}

export default class SessionFilesPanel {
    constructor() {
        this.panel = document.getElementById('session-files-panel');
        this.openButton = document.getElementById('terminal-files-btn');
        this.closeButton = document.getElementById('session-files-close-btn');
        this.refreshButton = document.getElementById('session-files-refresh-btn');
        this.uploadButton = document.getElementById('session-files-upload-btn');
        this.status = document.getElementById('session-files-status');
        this.list = document.getElementById('session-files-list');
        if (!this.panel || !this.openButton || !this.status || !this.list) return;

        this.openButton.addEventListener('click', () => this.show());
        this.closeButton?.addEventListener('click', () => this.hide());
        this.refreshButton?.addEventListener('click', () => this.refresh());
        this.uploadButton?.addEventListener('click', () => this.upload());
        window.addEventListener('opencode-session-started', () => {
            if (!this.panel.hidden) this.refresh();
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.panel.hidden) this.hide();
        });
    }

    setStatus(value, state = '') {
        if (!this.status) return;
        this.status.textContent = value;
        if (state) this.status.dataset.state = state;
        else delete this.status.dataset.state;
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
        this.setStatus('Loading current session files…');
        try {
            const result = await window.electronAPI.invoke('opencode-session-files-list');
            this.render(result?.files || [], result?.storage);
        } catch (error) {
            this.list.replaceChildren();
            this.setStatus(message(error), 'error');
        } finally {
            this.refreshButton && (this.refreshButton.disabled = false);
        }
    }

    async upload() {
        this.uploadButton && (this.uploadButton.disabled = true);
        this.setStatus('Choose files to add to the current session…');
        try {
            const result = await window.electronAPI.invoke('opencode-session-files-upload');
            this.render(result?.files || [], result?.storage);
        } catch (error) {
            this.setStatus(message(error), 'error');
        } finally {
            this.uploadButton && (this.uploadButton.disabled = false);
        }
    }

    render(files, storage = {}) {
        this.list.replaceChildren();
        if (!files.length) {
            const empty = document.createElement('div');
            empty.className = 'session-files-empty';
            empty.textContent = 'No task files yet. Upload a CSV, list, or document after starting this OpenCode session.';
            this.list.appendChild(empty);
        } else {
            for (const file of files) {
                const row = document.createElement('div');
                row.className = 'session-file';
                const name = document.createElement('strong');
                name.textContent = String(file.name || 'Untitled file');
                const meta = document.createElement('span');
                meta.textContent = `${formatBytes(file.size)} · uploaded ${new Date(file.uploadedAt).toLocaleString()}`;
                row.append(name, meta);
                this.list.appendChild(row);
            }
        }
        this.setStatus(`${files.length} file${files.length === 1 ? '' : 's'} · ${formatBytes(storage.usedBytes)} of ${formatBytes(storage.maxBytes)} available.`);
        if (this.uploadButton) this.uploadButton.disabled = storage.atLimit === true;
    }
}
