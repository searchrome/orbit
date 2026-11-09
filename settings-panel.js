function errorMessage(error) {
    return error?.message || String(error || 'Could not save settings.');
}

// Saved keys are never returned to the renderer, so a configured field shows a
// mask instead of staying blank. A mask-only value is treated as "unchanged"
// and never sent back, so it cannot overwrite a stored key.
const SAVED_KEY_MASK = '••••••••••••';

function isMaskedValue(value) {
    return /^•+$/.test(String(value || '').trim());
}

function describeKeyStatus(settings = {}) {
    if (!settings.openRouterKeyConfigured) {
        return settings.secureCredentialStorageAvailable === false
            ? 'No key is configured. Secure credential storage is unavailable on this device.'
            : 'No key is configured.';
    }

    return settings.openRouterKeySource === 'environment'
        ? 'Using an API key supplied by the app environment.'
        : 'A key is saved securely on this device.';
}

export default class SettingsPanel {
    constructor() {
        this.panel = document.getElementById('settings-panel');
        this.openButton = document.getElementById('settings-btn');
        this.closeButton = document.getElementById('settings-close-btn');
        this.cancelButton = document.getElementById('settings-cancel-btn');
        this.form = document.getElementById('settings-form');
        this.keyInput = document.getElementById('settings-openrouter-api-key');
        this.clearKeyInput = document.getElementById('settings-clear-openrouter-key');
        this.modelInput = document.getElementById('settings-model-input');
        this.keyStatus = document.getElementById('settings-openrouter-key-status');
        this.status = document.getElementById('settings-status');
        this.saveButton = document.getElementById('settings-save-btn');
        this.providerInput = document.getElementById('settings-provider');
        this.entrimKeyInput = document.getElementById('settings-entrim-api-key');
        this.entrimClear = document.getElementById('settings-clear-entrim-key');
        this.entrimStatus = document.getElementById('settings-entrim-key-status');
        this.subtitlesKeyInput = document.getElementById('settings-subtitles-api-key');
        this.subtitlesClear = document.getElementById('settings-clear-subtitles-key');
        this.subtitlesStatus = document.getElementById('settings-subtitles-key-status');
        this.enabled = true;

        if (!this.panel || !this.openButton || !this.form || !this.keyInput || !this.clearKeyInput || !this.modelInput) return;

        this.openButton.addEventListener('click', () => this.show());
        this.closeButton?.addEventListener('click', () => this.hide());
        this.cancelButton?.addEventListener('click', () => this.hide());
        this.form.addEventListener('submit', (event) => this.save(event));
        this.providerInput?.addEventListener('change', () => {
            if (this.providerInput.value === 'opencode-go') this.modelInput.value = 'opencode-go/glm-5.3-flash';
            if (this.providerInput.value === 'entrim') this.modelInput.value = 'entrim/zai-org/GLM-5.3-Flash';
            if (this.providerInput.value === 'openrouter') this.modelInput.value = 'openrouter/z-ai/glm-5.3-flash';
            this.syncProvider();
        });
        this.modelInput.addEventListener('input', () => this.syncProvider());
        this.entrimClear?.addEventListener('change', () => {
            this.entrimKeyInput.disabled = this.entrimClear.checked;
            if (this.entrimClear.checked) this.entrimKeyInput.value = '';
        });
        this.subtitlesClear?.addEventListener('change', () => {
            this.subtitlesKeyInput.disabled = this.subtitlesClear.checked;
            if (this.subtitlesClear.checked) this.subtitlesKeyInput.value = '';
        });
        // Typing into a masked field drops the mask characters so the new key
        // is saved without the indicator dots.
        for (const input of [this.keyInput, this.entrimKeyInput, this.subtitlesKeyInput]) {
            input?.addEventListener('input', () => {
                if (input.dataset.saved === 'true') {
                    input.dataset.saved = 'false';
                    input.value = input.value.replace(/•/g, '');
                }
            });
        }
        this.clearKeyInput.addEventListener('change', () => {
            this.keyInput.disabled = this.clearKeyInput.checked;
            if (this.clearKeyInput.checked) this.keyInput.value = '';
        });
        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && !this.panel.hidden) this.hide();
        });
    }

    setEnabled(enabled) {
        this.enabled = !!enabled;
        // Browser version information remains available without the AI terminal.
        if (this.openButton) this.openButton.hidden = false;
        if (this.form) this.form.hidden = !this.enabled;
    }

    setStatus(message = '', state = '') {
        if (!this.status) return;
        this.status.textContent = message;
        if (state) this.status.dataset.state = state;
        else delete this.status.dataset.state;
    }

    setKeyStatus(settings = {}) {
        if (this.entrimStatus) {
            this.entrimStatus.textContent = settings.entrimKeyConfigured
                ? (settings.entrimKeySource === 'saved' ? 'An Entrim key is saved securely on this device.' : 'Using Entrim credentials from the app environment.')
                : 'No app-specific key. OpenCode will use its configured Entrim credentials if available.';
            this.entrimClear.disabled = settings.entrimKeySource !== 'saved';
        }
        if (!this.keyStatus) return;
        this.keyStatus.textContent = describeKeyStatus(settings);
        this.keyStatus.dataset.source = settings.openRouterKeySource || 'none';
        this.clearKeyInput.disabled = settings.openRouterKeySource !== 'saved';
        if (this.clearKeyInput.disabled) this.clearKeyInput.checked = false;
    }

    setSubtitlesKeyStatus(settings = {}) {
        if (!this.subtitlesStatus) return;
        this.subtitlesStatus.textContent = settings.openSubtitlesKeyConfigured
            ? 'An OpenSubtitles key is saved securely on this device.'
            : (settings.secureCredentialStorageAvailable === false
                ? 'No key is configured. Secure credential storage is unavailable on this device.'
                : 'No key is configured. Casting falls back to the player’s own captions.');
        if (this.subtitlesClear) this.subtitlesClear.disabled = settings.openSubtitlesKeyConfigured !== true;
    }

    applySavedMask(input, saved) {
        if (!input) return;
        if (saved) {
            input.value = SAVED_KEY_MASK;
            input.dataset.saved = 'true';
        } else {
            input.value = '';
            delete input.dataset.saved;
        }
        input.disabled = false;
    }

    // Returns the typed key, or '' when the field still shows the saved-mask
    // (meaning: unchanged — do not resend).
    unmaskedValue(input) {
        if (!input) return '';
        const value = input.value.trim();
        return isMaskedValue(value) ? '' : value;
    }

    async show() {
        if (!this.panel) return;
        this.panel.hidden = false;
        if (!this.enabled) return;
        this.keyInput.value = '';
        this.keyInput.disabled = false;
        this.clearKeyInput.checked = false;
        if (this.entrimKeyInput) { this.entrimKeyInput.value = ''; this.entrimKeyInput.disabled = false; this.entrimClear.checked = false; }
        if (this.subtitlesKeyInput) { this.subtitlesKeyInput.value = ''; this.subtitlesKeyInput.disabled = false; this.subtitlesClear.checked = false; }
        this.setStatus('Loading settings…');
        try {
            const settings = await window.electronAPI.invoke('opencode-terminal-get-settings');
            this.setKeyStatus(settings || {});
            if (settings?.model) this.modelInput.value = settings.model;
            this.applySavedMask(this.keyInput, !!settings?.openRouterKeyConfigured);
            this.applySavedMask(this.entrimKeyInput, !!settings?.entrimKeyConfigured);
            this.syncProvider();
            this.setStatus('');
            (this.providerInput || this.keyInput).focus();
        } catch (error) {
            this.setStatus(errorMessage(error), 'error');
        }
        if (this.subtitlesStatus) {
            try {
                const castSettings = await window.electronAPI.invoke('cast-get-settings') || {};
                this.setSubtitlesKeyStatus(castSettings);
                this.applySavedMask(this.subtitlesKeyInput, !!castSettings.openSubtitlesKeyConfigured);
            } catch {
                this.setSubtitlesKeyStatus({});
            }
        }
    }

    hide() {
        if (this.panel) this.panel.hidden = true;
    }

    syncProvider() {
        if (!this.providerInput) return;
        const provider = this.modelInput.value.split('/')[0];
        this.providerInput.value = ['opencode-go', 'entrim', 'openrouter'].includes(provider) ? provider : 'custom';
        document.getElementById('settings-entrim-section').hidden = provider !== 'entrim';
        document.getElementById('settings-openrouter-title').closest('section').hidden = provider !== 'openrouter';
    }

    async save(event) {
        event.preventDefault();
        if (!this.enabled || !this.saveButton) return;

        const openRouterApiKey = this.unmaskedValue(this.keyInput);
        const clearOpenRouterApiKey = this.clearKeyInput.checked;
        const model = this.modelInput.value.trim();
        if (!model) {
            this.setStatus('Choose an OpenCode model.', 'error');
            return;
        }
        this.saveButton.disabled = true;
        this.setStatus('Saving settings…');
        try {
            const settings = await window.electronAPI.invoke('opencode-terminal-save-settings', {
                model,
                ...(this.unmaskedValue(this.entrimKeyInput) ? { entrimApiKey: this.unmaskedValue(this.entrimKeyInput) } : {}),
                ...(this.entrimClear?.checked ? { clearEntrimApiKey: true } : {}),
                ...(openRouterApiKey ? { openRouterApiKey } : {}),
                ...(clearOpenRouterApiKey ? { clearOpenRouterApiKey: true } : {})
            });
            this.clearKeyInput.checked = false;
            this.setKeyStatus(settings || {});
            this.applySavedMask(this.keyInput, !!settings?.openRouterKeyConfigured);
            this.applySavedMask(this.entrimKeyInput, !!settings?.entrimKeyConfigured);
            const subtitlesApiKey = this.unmaskedValue(this.subtitlesKeyInput);
            const clearSubtitlesKey = this.subtitlesClear?.checked || false;
            let castSettings = null;
            if (subtitlesApiKey || clearSubtitlesKey) {
                castSettings = await window.electronAPI.invoke('cast-save-settings', {
                    ...(subtitlesApiKey ? { openSubtitlesApiKey: subtitlesApiKey } : {}),
                    ...(clearSubtitlesKey ? { clearOpenSubtitlesApiKey: true } : {})
                });
            }
            if (this.subtitlesClear) this.subtitlesClear.checked = false;
            this.setSubtitlesKeyStatus(castSettings || {});
            this.applySavedMask(this.subtitlesKeyInput, !!(castSettings || {}).openSubtitlesKeyConfigured);
            this.setStatus('Saved. Start a new OpenCode session to use the updated provider and model.', 'success');
            const settingsEvent = document.createEvent('Event');
            settingsEvent.initEvent('opencode-settings-saved', false, false);
            Object.defineProperty(settingsEvent, 'detail', { value: settings || {} });
            window.dispatchEvent(settingsEvent);
        } catch (error) {
            this.setStatus(errorMessage(error), 'error');
        } finally {
            this.saveButton.disabled = false;
        }
    }
}
