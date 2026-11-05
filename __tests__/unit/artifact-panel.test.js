const fs = require('node:fs');
const path = require('node:path');

function loadArtifactPanel() {
  const source = fs.readFileSync(path.join(__dirname, '../../artifact-panel.js'), 'utf8');
  const transformed = source.replace('export default class ArtifactPanel', 'class ArtifactPanel').concat('\nmodule.exports = ArtifactPanel;\n');
  const module = { exports: {} };
  new Function('module', 'exports', transformed)(module, module.exports);
  return module.exports;
}

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ArtifactPanel', () => {
  let ArtifactPanel;
  let panel;

  beforeEach(() => {
    document.createElement = Document.prototype.createElement.bind(document);
    document.getElementById = Document.prototype.getElementById.bind(document);
    document.body.innerHTML = `
      <button id="artifacts-btn"></button>
      <aside id="artifact-panel" hidden>
        <button id="artifact-close-btn"></button>
        <button id="artifact-refresh-btn"></button>
        <div id="artifact-status"></div>
        <div id="artifact-list"></div>
      </aside>
    `;
    window.electronAPI = { invoke: jest.fn() };
    window.confirm = jest.fn(() => true);
    window.alert = jest.fn();
    ArtifactPanel = loadArtifactPanel();
    panel = new ArtifactPanel();
  });

  test('lists created artifacts with open and download actions for each one', async () => {
    window.electronAPI.invoke.mockResolvedValueOnce({
      ok: true,
      artifacts: [
        { id: '123e4567-e89b-12d3-a456-426614174000', name: 'report.html', contentType: 'text/html', size: 12, createdAt: '2026-01-01T12:00:00.000Z', html: true },
        { id: '123e4567-e89b-12d3-a456-426614174001', name: 'notes.txt', contentType: 'text/plain', size: 5, createdAt: '2026-01-01T12:00:00.000Z', html: false }
      ]
    });

    await panel.show();

    expect(document.getElementById('artifact-panel').hidden).toBe(false);
    expect(document.getElementById('artifact-list').textContent).toContain('report.html');
    expect(document.getElementById('artifact-list').textContent).toContain('notes.txt');
    expect(document.querySelectorAll('[data-artifact-action="open"]')).toHaveLength(2);
    expect(document.querySelectorAll('[data-artifact-action="download"]')).toHaveLength(2);

    window.electronAPI.invoke.mockResolvedValueOnce({ ok: true });
    document.querySelector('[data-artifact-action="open"]').click();
    await flush();

    expect(window.electronAPI.invoke).toHaveBeenLastCalledWith('opencode-artifacts-open', { id: '123e4567-e89b-12d3-a456-426614174000' });
    expect(document.getElementById('artifact-panel').hidden).toBe(true);
  });

  test('uses an explicit user click to start a download', async () => {
    window.electronAPI.invoke.mockResolvedValueOnce({
      ok: true,
      artifacts: [{ id: '123e4567-e89b-12d3-a456-426614174001', name: 'notes.txt', contentType: 'text/plain', size: 5, createdAt: '2026-01-01T12:00:00.000Z', html: false }]
    });
    await panel.show();

    window.electronAPI.invoke.mockResolvedValueOnce({ ok: true });
    document.querySelector('[data-artifact-action="download"]').click();
    await flush();

    expect(window.electronAPI.invoke).toHaveBeenLastCalledWith('opencode-artifacts-download', { id: '123e4567-e89b-12d3-a456-426614174001' });
    expect(document.getElementById('artifact-status').textContent).toMatch(/Download started/);
  });

  test('confirms then deletes an artifact from the library', async () => {
    window.electronAPI.invoke.mockResolvedValueOnce({
      ok: true,
      artifacts: [{ id: '123e4567-e89b-12d3-a456-426614174001', name: 'notes.txt', contentType: 'text/plain', size: 5, createdAt: '2026-01-01T12:00:00.000Z', html: false }]
    });
    await panel.show();

    window.electronAPI.invoke.mockResolvedValueOnce({ ok: true });
    window.electronAPI.invoke.mockResolvedValueOnce({ ok: true, artifacts: [] });
    document.querySelector('[data-artifact-action="delete"]').click();
    await flush();

    expect(window.confirm).toHaveBeenCalledWith('Delete this artifact? This cannot be undone.');
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('opencode-artifacts-delete', { id: '123e4567-e89b-12d3-a456-426614174001' });
    expect(document.getElementById('artifact-list').textContent).toContain('No artifacts yet');
  });

  test('warns on opening when artifact storage has reached its limit', async () => {
    window.electronAPI.invoke.mockResolvedValueOnce({ ok: true, artifacts: [], storage: { usedBytes: 1_000_000_000, limitBytes: 1_000_000_000, atLimit: true } });

    await panel.show();

    expect(window.alert).toHaveBeenCalledWith('Artifact storage is full (1 GB). Delete artifacts before creating more files.');
  });
});
