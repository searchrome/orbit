const fs = require('node:fs');
const path = require('node:path');

function loadSettingsPanel() {
  const source = fs.readFileSync(path.join(__dirname, '../../settings-panel.js'), 'utf8');
  const transformed = source.replace('export default class SettingsPanel', 'class SettingsPanel').concat('\nmodule.exports = SettingsPanel;\n');
  const module = { exports: {} };
  new Function('module', 'exports', transformed)(module, module.exports);
  return module.exports;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('SettingsPanel', () => {
  let SettingsPanel;
  let panel;

  beforeEach(() => {
    document.getElementById = Document.prototype.getElementById.bind(document);
    document.createElement = Document.prototype.createElement.bind(document);
    document.body.innerHTML = `
      <button id="settings-btn"></button>
      <aside id="settings-panel" hidden>
        <button id="settings-close-btn"></button>
        <form id="settings-form">
          <input id="settings-openrouter-api-key" />
          <input id="settings-clear-openrouter-key" type="checkbox" />
          <input id="settings-model-input" value="openrouter/default-model" />
          <div id="settings-openrouter-key-status"></div>
          <div id="settings-status"></div>
          <button id="settings-cancel-btn" type="button"></button>
          <button id="settings-save-btn" type="submit"></button>
        </form>
      </aside>
    `;
    window.electronAPI = { invoke: jest.fn() };
    SettingsPanel = loadSettingsPanel();
    panel = new SettingsPanel();
  });

  test('saves an API key without rendering it back into the page', async () => {
    window.electronAPI.invoke
      .mockResolvedValueOnce({ model: 'openrouter/default-model', openRouterKeyConfigured: false, openRouterKeySource: 'none', secureCredentialStorageAvailable: true })
      .mockResolvedValueOnce({ model: 'openrouter/default-model', openRouterKeyConfigured: true, openRouterKeySource: 'saved', secureCredentialStorageAvailable: true });

    await panel.show();
    const keyInput = document.getElementById('settings-openrouter-api-key');
    keyInput.value = 'sk-or-v1-secret';
    document.getElementById('settings-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(window.electronAPI.invoke).toHaveBeenLastCalledWith('opencode-terminal-save-settings', {
      model: 'openrouter/default-model',
      openRouterApiKey: 'sk-or-v1-secret'
    });
    // The plaintext key must never render back; a configured field shows the
    // saved-mask indicator instead of the blank it used to be.
    expect(keyInput.value).toBe('••••••••••••');
    expect(document.body.innerHTML).not.toContain('sk-or-v1-secret');
    expect(document.getElementById('settings-openrouter-key-status').textContent).toContain('saved securely');
    expect(document.getElementById('settings-status').textContent).toContain('Start a new OpenCode session');
  });

  test('keeps version settings accessible when OpenCode is disabled', async () => {
    panel.setEnabled(false);
    await panel.show();
    expect(document.getElementById('settings-btn').hidden).toBe(false);
    expect(document.getElementById('settings-panel').hidden).toBe(false);
    expect(document.getElementById('settings-form').hidden).toBe(true);
    expect(window.electronAPI.invoke).not.toHaveBeenCalled();
    panel.setEnabled(true);
    expect(document.getElementById('settings-form').hidden).toBe(false);
  });

  test('a mask-only field is treated as unchanged and never resent', async () => {
    window.electronAPI.invoke
      .mockResolvedValueOnce({ model: 'openrouter/default-model', openRouterKeyConfigured: true, openRouterKeySource: 'saved', secureCredentialStorageAvailable: true })
      .mockResolvedValueOnce({ openSubtitlesKeyConfigured: true, secureCredentialStorageAvailable: true })
      .mockResolvedValueOnce({ model: 'openrouter/default-model', openRouterKeyConfigured: true, openRouterKeySource: 'saved', secureCredentialStorageAvailable: true });

    await panel.show();
    const keyInput = document.getElementById('settings-openrouter-api-key');
    expect(keyInput.value).toBe('••••••••••••');
    document.getElementById('settings-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    const saveCall = window.electronAPI.invoke.mock.calls.find(([channel]) => channel === 'opencode-terminal-save-settings');
    expect(saveCall[1]).toEqual({ model: 'openrouter/default-model' });
  });

  test('allows removal only for a key saved in secure storage', async () => {
    window.electronAPI.invoke
      .mockResolvedValueOnce({ model: 'openrouter/default-model', openRouterKeyConfigured: true, openRouterKeySource: 'saved', secureCredentialStorageAvailable: true })
      .mockResolvedValueOnce({ model: 'openrouter/default-model', openRouterKeyConfigured: false, openRouterKeySource: 'none', secureCredentialStorageAvailable: true });

    await panel.show();
    const clearInput = document.getElementById('settings-clear-openrouter-key');
    expect(clearInput.disabled).toBe(false);
    clearInput.checked = true;
    document.getElementById('settings-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();

    expect(window.electronAPI.invoke).toHaveBeenLastCalledWith('opencode-terminal-save-settings', {
      model: 'openrouter/default-model',
      clearOpenRouterApiKey: true
    });
  });
});
