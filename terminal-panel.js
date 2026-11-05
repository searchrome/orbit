const DEFAULT_DRAWER_HEIGHT = 340;
const MIN_DRAWER_HEIGHT = 180;
const MAX_DRAWER_HEIGHT = 720;
const DEFAULT_DRAWER_WIDTH = 420;
const MIN_DRAWER_WIDTH = 300;
const MAX_DRAWER_WIDTH = 720;

function clampHeight(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_DRAWER_HEIGHT;
    return Math.max(MIN_DRAWER_HEIGHT, Math.min(MAX_DRAWER_HEIGHT, Math.round(number)));
}

function clampWidth(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return DEFAULT_DRAWER_WIDTH;
    return Math.max(MIN_DRAWER_WIDTH, Math.min(MAX_DRAWER_WIDTH, Math.round(number)));
}

function normalizeDock(value) {
    return value === 'left' ? 'left' : 'bottom';
}

export default class TerminalPanel {
    constructor({ onBrowserControlChange = null } = {}) {
        this.panel = document.getElementById('terminal-panel');
        this.terminalHost = document.getElementById('opencode-terminal');
        this.statusNode = document.getElementById('terminal-status');
        this.modelDisplay = document.getElementById('terminal-model-display');
        this.newSessionButton = document.getElementById('terminal-new-session-btn');
        this.stopButton = document.getElementById('terminal-stop-btn');
        this.closeButton = document.getElementById('terminal-close-btn');
        this.resizer = document.getElementById('terminal-resizer');
        this.dockBottomButton = document.getElementById('terminal-dock-bottom-btn');
        this.dockLeftButton = document.getElementById('terminal-dock-left-btn');
        this.xterm = null;
        this.fitAddon = null;
        this.resizeObserver = null;
        this.drawerHeight = DEFAULT_DRAWER_HEIGHT;
        this.drawerWidth = DEFAULT_DRAWER_WIDTH;
        this.dock = 'bottom';
        this.state = 'stopped';
        this.restartAfterStop = false;
        this.pendingRestartOptions = null;
        this.startRequested = false;
        this.ready = false;
        this.enabled = true;
        this.browserControlActive = false;
        this.onBrowserControlChange = onBrowserControlChange;

        if (!this.panel || !this.terminalHost || !this.modelDisplay) return;

        this.initializeTerminal();
        this.bindEvents();
        this.settingsReady = this.loadSettings();
    }

    initializeTerminal() {
        if (typeof window.Terminal !== 'function' || !window.FitAddon?.FitAddon) {
            this.setStatus('error', 'Terminal renderer failed to load.');
            return;
        }
        this.xterm = new window.Terminal({
            cursorBlink: true,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
            fontSize: 13,
            lineHeight: 1.15,
            scrollback: 5_000,
            theme: { background: '#0d1117', foreground: '#d1d5db', cursor: '#e2e8f0', selectionBackground: '#334155' }
        });
        this.fitAddon = new window.FitAddon.FitAddon();
        this.xterm.loadAddon(this.fitAddon);
        this.xterm.open(this.terminalHost);
        this.xterm.writeln('\x1b[2mOpenCode terminal is ready. Change the model in Settings, then open the drawer to begin.\x1b[0m');
        this.xterm.onData((data) => {
            if (this.state === 'running' || this.state === 'starting') {
                window.electronAPI.send('opencode-terminal-input', data);
            }
        });
        this.resizeObserver = new ResizeObserver(() => this.fitTerminal());
        this.resizeObserver.observe(this.terminalHost);
        this.ready = true;
    }

    bindEvents() {
        window.electronAPI.on('opencode-terminal-output', (data) => this.xterm?.write(String(data || '')));
        window.electronAPI.on('opencode-terminal-status', (status) => this.handleStatus(status || {}));
        this.closeButton?.addEventListener('click', () => this.hide());
        this.stopButton?.addEventListener('click', () => this.stop());
        this.newSessionButton?.addEventListener('click', () => this.startNewSession());
        this.dockBottomButton?.addEventListener('click', () => this.setDock('bottom', true));
        this.dockLeftButton?.addEventListener('click', () => this.setDock('left', true));
        window.addEventListener('opencode-settings-saved', (event) => this.setModel(event.detail?.model));
        this.resizer?.addEventListener('pointerdown', (event) => this.startResize(event));
    }

    async loadSettings() {
        try {
            const settings = await window.electronAPI.invoke('opencode-terminal-get-settings');
            this.setModel(settings.model);
            this.setDrawerHeight(settings.drawerHeight || DEFAULT_DRAWER_HEIGHT, false);
            this.setDrawerWidth(settings.drawerWidth || DEFAULT_DRAWER_WIDTH, false);
            this.setDock(settings.dock, false);
        } catch (error) {
            this.setStatus('error', error?.message || 'Could not load OpenCode settings.');
        }
    }

    getLaunchOptions() {
        return {
            model: this.modelDisplay.textContent.trim(),
            cols: this.xterm?.cols || 120,
            rows: this.xterm?.rows || 28,
            drawerHeight: this.drawerHeight,
            drawerWidth: this.drawerWidth,
            dock: this.dock
        };
    }

    async saveSettings(launchOptions = this.getLaunchOptions()) {
        try {
            const settings = await window.electronAPI.invoke('opencode-terminal-save-settings', launchOptions);
            if (settings?.model) this.setModel(settings.model);
            return settings;
        } catch (error) {
            this.setStatus('error', error?.message || 'Could not save OpenCode settings.');
            return null;
        }
    }

    async show() {
        if (!this.panel || !this.enabled) return;
        await this.settingsReady;
        document.body.classList.add('terminal-open');
        this.panel.hidden = false;
        this.fitTerminal();
        this.xterm?.focus();
        await this.startIfNeeded();
    }

    hide() {
        document.body.classList.remove('terminal-open');
        if (this.panel) this.panel.hidden = true;
    }

    async startIfNeeded(launchOptions = this.getLaunchOptions()) {
        if (!this.ready || this.state === 'running' || this.state === 'starting' || this.startRequested) return;
        this.startRequested = true;
        this.setStatus('starting', 'Starting OpenCode…');
        try {
            const result = await window.electronAPI.invoke('opencode-terminal-start', launchOptions);
            if (result?.running) {
                this.state = 'running';
                this.setStatus('running', 'Running');
                if (result.session?.id) {
                    window.dispatchEvent(new CustomEvent('opencode-session-started', { detail: result.session }));
                }
            }
        } catch (error) {
            this.state = 'error';
            this.xterm?.writeln(`\r\n\x1b[31mOpenCode could not start: ${error?.message || error}\x1b[0m`);
            this.setStatus('error', error?.message || 'OpenCode could not start.');
        } finally {
            this.startRequested = false;
        }
    }

    async startNewSession() {
        const restartOptions = this.getLaunchOptions();
        const saved = await this.saveSettings(restartOptions);
        if (!saved) return;
        if (this.state === 'running' || this.state === 'starting' || this.state === 'stopping') {
            this.pendingRestartOptions = restartOptions;
            this.restartAfterStop = true;
            await this.stop({ preserveRestart: true });
            return;
        }
        await this.startIfNeeded(restartOptions);
    }

    async stop({ preserveRestart = false } = {}) {
        if (!preserveRestart) {
            this.restartAfterStop = false;
            this.pendingRestartOptions = null;
        }
        try {
            await window.electronAPI.invoke('opencode-terminal-stop');
        } catch (error) {
            this.setStatus('error', error?.message || 'Could not stop OpenCode.');
        }
    }

    handleStatus(status) {
        this.state = status.state || this.state;
        this.setStatus(this.state, status.message || '');
        this.setBrowserControlActive(['starting', 'running', 'stopping'].includes(this.state));
        if (!this.pendingRestartOptions && status.model) this.setModel(status.model);
        if (this.state === 'stopped' && this.restartAfterStop) {
            this.restartAfterStop = false;
            const restartOptions = this.pendingRestartOptions || this.getLaunchOptions();
            this.pendingRestartOptions = null;
            this.startIfNeeded(restartOptions);
        }
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        if (!this.enabled) {
            this.hide();
            this.setStatus('stopped', 'OpenCode terminal is disabled by this browser profile.');
        }
    }

    setBrowserControlActive(active) {
        const next = !!active;
        if (this.browserControlActive === next) return;
        this.browserControlActive = next;
        this.onBrowserControlChange?.(next);
    }

    setStatus(state, message) {
        if (!this.statusNode) return;
        this.statusNode.dataset.state = state;
        this.statusNode.textContent = message || (state === 'running' ? 'Running' : 'Stopped');
        if (this.stopButton) this.stopButton.disabled = state !== 'running' && state !== 'starting';
    }

    setModel(model) {
        const value = typeof model === 'string' ? model.trim() : '';
        if (!value || !this.modelDisplay) return;
        this.modelDisplay.textContent = value;
        this.modelDisplay.title = `Model: ${value}. Change it in Settings.`;
    }

    fitTerminal() {
        if (!this.fitAddon || !this.xterm || this.panel?.hidden) return;
        requestAnimationFrame(() => {
            try {
                this.fitAddon.fit();
                window.electronAPI.send('opencode-terminal-resize', { cols: this.xterm.cols, rows: this.xterm.rows });
            } catch {
                // The terminal host may be temporarily hidden during layout.
            }
        });
    }

    startResize(event) {
        if (!this.panel) return;
        event.preventDefault();
        this.resizer?.setPointerCapture?.(event.pointerId);
        const isLeftDock = this.dock === 'left';
        const startPosition = isLeftDock ? event.clientX : event.clientY;
        const startSize = isLeftDock ? this.drawerWidth : this.drawerHeight;
        const onMove = (moveEvent) => {
            const position = isLeftDock ? moveEvent.clientX : moveEvent.clientY;
            const nextSize = isLeftDock
                ? startSize + (position - startPosition)
                : startSize + (startPosition - position);
            if (isLeftDock) this.setDrawerWidth(nextSize, false);
            else this.setDrawerHeight(nextSize, false);
        };
        const onEnd = () => {
            document.removeEventListener('pointermove', onMove);
            document.removeEventListener('pointerup', onEnd);
            document.removeEventListener('pointercancel', onEnd);
            this.saveSettings();
        };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onEnd, { once: true });
        document.addEventListener('pointercancel', onEnd, { once: true });
    }

    setDrawerHeight(value, persist) {
        this.drawerHeight = clampHeight(value);
        document.documentElement.style.setProperty('--terminal-drawer-height', `${this.drawerHeight}px`);
        this.fitTerminal();
        if (persist) this.saveSettings();
    }

    setDrawerWidth(value, persist) {
        this.drawerWidth = clampWidth(value);
        document.documentElement.style.setProperty('--terminal-drawer-width', `${this.drawerWidth}px`);
        this.fitTerminal();
        if (persist) this.saveSettings();
    }

    setDock(value, persist) {
        this.dock = normalizeDock(value);
        const isLeftDock = this.dock === 'left';
        document.body.classList.toggle('terminal-docked-left', isLeftDock);
        this.dockBottomButton?.setAttribute('aria-pressed', String(!isLeftDock));
        this.dockLeftButton?.setAttribute('aria-pressed', String(isLeftDock));
        this.resizer?.setAttribute('aria-orientation', isLeftDock ? 'vertical' : 'horizontal');
        this.fitTerminal();
        if (persist) this.saveSettings();
    }
}
