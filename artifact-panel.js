function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatCreatedAt(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Created this session';
    return `Created ${date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`;
}

function errorMessage(error) {
    return error?.message || String(error || 'The artifact request failed.');
}

export default class ArtifactPanel {
    constructor() {
        this.panel = document.getElementById('artifact-panel');
        this.openButton = document.getElementById('artifacts-btn');
        this.closeButton = document.getElementById('artifact-close-btn');
        this.refreshButton = document.getElementById('artifact-refresh-btn');
        this.status = document.getElementById('artifact-status');
        this.list = document.getElementById('artifact-list');
        this.enabled = true;

        if (!this.panel || !this.openButton || !this.status || !this.list) return;

        this.openButton.addEventListener('click', () => this.show());
        this.closeButton?.addEventListener('click', () => this.hide());
        this.refreshButton?.addEventListener('click', () => this.refresh());
        this.list.addEventListener('click', (event) => this.handleArtifactAction(event));
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.panel.hidden) this.hide();
        });
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        if (this.openButton) this.openButton.hidden = !this.enabled;
        if (!this.enabled) this.hide();
    }

    setStatus(message = '', state = '') {
        if (!this.status) return;
        this.status.textContent = message;
        if (state) this.status.dataset.state = state;
        else delete this.status.dataset.state;
    }

    async show() {
        if (!this.panel || !this.enabled) return;
        this.panel.hidden = false;
        await this.refresh({ notifyOnLimit: true });
    }

    hide() {
        if (this.panel) this.panel.hidden = true;
    }

    async refresh({ notifyOnLimit = false } = {}) {
        if (!this.list) return;
        this.refreshButton && (this.refreshButton.disabled = true);
        this.setStatus('Loading artifacts…');
        try {
            const result = await window.electronAPI.invoke('opencode-artifacts-list');
            if (result?.ok === false) throw new Error(result.error?.message || 'Could not load artifacts.');
            this.render(Array.isArray(result?.artifacts) ? result.artifacts : []);
            if (notifyOnLimit && result?.storage?.atLimit) {
                window.alert('Artifact storage is full (1 GB). Delete artifacts before creating more files.');
            }
        } catch (error) {
            this.list.replaceChildren();
            this.setStatus(errorMessage(error), 'error');
        } finally {
            this.refreshButton && (this.refreshButton.disabled = false);
        }
    }

    render(artifacts) {
        this.list.replaceChildren();
        if (!artifacts.length) {
            const empty = document.createElement('div');
            empty.className = 'artifact-empty';
            empty.textContent = 'No artifacts yet. Ask OpenCode to create a report, file, or interactive HTML page.';
            this.list.appendChild(empty);
            this.setStatus('Artifacts stay here until you delete them.');
            return;
        }

        this.setStatus(`${artifacts.length} saved artifact${artifacts.length === 1 ? '' : 's'} available.`);
        for (const artifact of artifacts) {
            this.list.appendChild(this.createCard(artifact));
        }
    }

    createCard(artifact) {
        const card = document.createElement('article');
        card.className = 'artifact-card';

        const icon = document.createElement('div');
        icon.className = 'artifact-card__icon';
        icon.textContent = artifact.html ? '⌘' : '▤';

        const details = document.createElement('div');
        const name = document.createElement('div');
        name.className = 'artifact-card__name';
        name.textContent = String(artifact.name || 'Untitled artifact');
        name.title = name.textContent;
        const meta = document.createElement('div');
        meta.className = 'artifact-card__meta';
        meta.textContent = `${artifact.dynamic ? 'Dynamic web app' : artifact.html ? 'Interactive HTML' : String(artifact.contentType || 'File')} · ${formatBytes(artifact.size)} · ${formatCreatedAt(artifact.createdAt)}`;
        details.append(name, meta);

        const actions = document.createElement('div');
        actions.className = 'artifact-card__actions';
        const artifactName = String(artifact.name || 'artifact');
        actions.appendChild(this.createActionButton('Open', 'open', artifact.id, false, artifactName));
        if (!artifact.dynamic) actions.appendChild(this.createActionButton('Download', 'download', artifact.id, true, artifactName));
        actions.appendChild(this.createActionButton('Delete', 'delete', artifact.id, false, artifactName));

        card.append(icon, details, actions);
        return card;
    }

    createActionButton(label, action, id, emphasized = false, artifactName = 'artifact') {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `artifact-card__button${emphasized ? ' artifact-card__button--download' : ''}${action === 'delete' ? ' artifact-card__button--delete' : ''}`;
        const icon = action === 'open' ? '↗' : action === 'download' ? '↓' : '×';
        button.textContent = icon;
        button.setAttribute('aria-label', `${label} ${artifactName}`);
        button.title = `${label} ${artifactName}`;
        button.dataset.artifactAction = action;
        button.dataset.artifactId = String(id || '');
        return button;
    }

    async handleArtifactAction(event) {
        const button = event.target?.closest?.('[data-artifact-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.artifactAction;
        const id = button.dataset.artifactId;
        if (action === 'delete' && !window.confirm('Delete this artifact? This cannot be undone.')) return;
        const channel = action === 'open'
            ? 'opencode-artifacts-open'
            : action === 'download'
                ? 'opencode-artifacts-download'
                : 'opencode-artifacts-delete';
        button.disabled = true;
        this.setStatus(action === 'open' ? 'Opening artifact…' : action === 'download' ? 'Starting download…' : 'Deleting artifact…');
        try {
            const result = await window.electronAPI.invoke(channel, { id });
            if (result?.ok === false) throw new Error(result.error?.message || `Could not ${action} artifact.`);
            if (action === 'open') this.hide();
            else if (action === 'download') this.setStatus('Download started. Choose a save location if the browser asks.');
            else await this.refresh();
        } catch (error) {
            this.setStatus(errorMessage(error), 'error');
        } finally {
            button.disabled = false;
        }
    }
}
