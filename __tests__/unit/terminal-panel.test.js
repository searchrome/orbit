jest.unmock('fs');
jest.unmock('path');

const fs = require('node:fs');
const path = require('node:path');

function loadTerminalPanel() {
  const source = fs.readFileSync(path.join(__dirname, '../../terminal-panel.js'), 'utf8')
    .replace('export default class TerminalPanel', 'class TerminalPanel')
    .concat('\nmodule.exports = TerminalPanel;');
  const module = { exports: {} };
  new Function('module', 'exports', 'document', 'window', 'ResizeObserver', source)(
    module,
    module.exports,
    document,
    window,
    global.ResizeObserver
  );
  return module.exports;
}

describe('TerminalPanel model session handling', () => {
  beforeEach(() => {
    document.getElementById = Document.prototype.getElementById.bind(document);
    document.createElement = Document.prototype.createElement.bind(document);
    document.body.innerHTML = `
      <section id="terminal-panel" hidden><div id="opencode-terminal"></div></section>
      <span id="terminal-status"></span>
      <span id="terminal-model-display">provider/old-model</span>
      <button id="terminal-new-session-btn"></button>
      <button id="terminal-stop-btn"></button>
      <button id="terminal-close-btn"></button>
      <div id="terminal-resizer"></div>
      <button id="terminal-dock-bottom-btn"></button>
      <button id="terminal-dock-left-btn"></button>
    `;
    global.ResizeObserver = class {
      observe() {}
    };
    window.Terminal = class {
      constructor() {
        this.cols = 120;
        this.rows = 28;
      }
      loadAddon() {}
      open() {}
      writeln() {}
      write() {}
      focus() {}
      onData() {}
    };
    window.FitAddon = { FitAddon: class { fit() {} } };
  });

  afterEach(() => {
    delete global.ResizeObserver;
    delete window.Terminal;
    delete window.FitAddon;
    delete window.electronAPI;
  });

  test('restarts with the settings-selected model despite stale stop status', async () => {
    const invocations = [];
    window.electronAPI = {
      on: jest.fn(),
      send: jest.fn(),
      invoke: jest.fn(async (channel, payload) => {
        invocations.push([channel, payload]);
        if (channel === 'opencode-terminal-get-settings') {
          return { model: 'provider/old-model', drawerHeight: 340, drawerWidth: 420, dock: 'bottom' };
        }
        if (channel === 'opencode-terminal-save-settings') return payload;
        if (channel === 'opencode-terminal-stop') return { stopped: true };
        if (channel === 'opencode-terminal-start') {
          return { running: true, session: { model: payload.model } };
        }
        throw new Error(`Unexpected invoke: ${channel}`);
      })
    };

    const TerminalPanel = loadTerminalPanel();
    expect(document.getElementById('terminal-model-display')).not.toBeNull();
    const panel = new TerminalPanel();
    await panel.settingsReady;
    panel.state = 'running';
    panel.setModel('provider/new-model');

    await panel.startNewSession();
    panel.handleStatus({ state: 'stopping', model: 'provider/old-model' });
    panel.handleStatus({ state: 'stopped', model: 'provider/old-model' });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const start = invocations.find(([channel]) => channel === 'opencode-terminal-start');
    expect(start[1].model).toBe('provider/new-model');
    expect(panel.modelDisplay.textContent).toBe('provider/new-model');
  });

  test('can persistently dock on the left and return to the bottom', async () => {
    window.electronAPI = {
      on: jest.fn(),
      send: jest.fn(),
      invoke: jest.fn(async (channel, payload) => {
        if (channel === 'opencode-terminal-get-settings') {
          return { model: 'provider/model', drawerHeight: 340, drawerWidth: 460, dock: 'left' };
        }
        if (channel === 'opencode-terminal-save-settings') return payload;
        throw new Error(`Unexpected invoke: ${channel}`);
      })
    };

    const TerminalPanel = loadTerminalPanel();
    const panel = new TerminalPanel();
    await panel.settingsReady;

    expect(document.body.classList.contains('terminal-docked-left')).toBe(true);
    expect(document.documentElement.style.getPropertyValue('--terminal-drawer-width')).toBe('460px');
    expect(document.getElementById('terminal-dock-left-btn').getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('terminal-resizer').getAttribute('aria-orientation')).toBe('vertical');

    panel.setDock('bottom', false);
    expect(document.body.classList.contains('terminal-docked-left')).toBe(false);
    expect(document.getElementById('terminal-dock-bottom-btn').getAttribute('aria-pressed')).toBe('true');
    expect(document.getElementById('terminal-resizer').getAttribute('aria-orientation')).toBe('horizontal');
  });
});
