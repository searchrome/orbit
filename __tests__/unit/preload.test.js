const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const hostUrl = 'file:///app/index.html';
const hostArgs = ['--browser-host-renderer', `--browser-host-url=${hostUrl}`];
function loadPreload({file = 'preload.js', href = hostUrl, argv = hostArgs, isMainFrame = true} = {}) {
  const ipcRenderer = {send: jest.fn(), sendToHost: jest.fn(), on: jest.fn(), invoke: jest.fn().mockResolvedValue('result')};
  const document = {addEventListener: jest.fn()};
  const window = {location: new URL(href), document, scrollY: 0, addEventListener: jest.fn()};
  const contextBridge = {exposeInMainWorld: jest.fn((name, api) => {window[name] = api;})};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../', file), 'utf8'), {
    window, document, URL, setTimeout, clearTimeout, process: {argv, isMainFrame},
    console: {log: jest.fn(), error: jest.fn()},
    require: name => {
      if (name === 'electron') return {ipcRenderer, contextBridge};
      throw new Error(`Unexpected module ${name}`);
    }
  }, {filename: file});
  return {window, document, ipcRenderer};
}

describe('host and guest preload separation', () => {
  test.each(['workspace-autosave', 'workspace-switch', 'workspace-rename', 'workspace-delete', 'assistant-next-action', 'cast-extract-video'])(
    'allows %s only in the trusted application document', async channel => {
      const host = loadPreload();
      await expect(host.window.electronAPI.invoke(channel, {})).resolves.toBe('result');
      expect(host.ipcRenderer.invoke).toHaveBeenCalledWith(channel, {});
    }
  );
  test.each([
    {href: 'https://attacker.example/index.html'},
    {href: 'file:///other/index.html'},
    {argv: []},
    {isMainFrame: false}
  ])('does not expose host APIs for an untrusted document or frame: %j', options => {
    const {window, ipcRenderer} = loadPreload(options);
    expect(window.electronAPI).toBeUndefined();
    expect(ipcRenderer.invoke).not.toHaveBeenCalled();
  });
  test('remote pages get no Electron or transformed-view API, even with a matching page filename', () => {
    const {window} = loadPreload({file: 'guest-preload.js', href: 'https://attacker.example/index.html'});
    expect(window.electronAPI).toBeUndefined();
    expect(window.transformedViewAPI).toBeUndefined();
  });
  test.each(['https://example.com/report', 'file:///private/data', 'javascript:alert(1)', 'data:text/html,test'])(
    'guest modified-click opens only HTTP(S) links: %s', href => {
      const {document, ipcRenderer} = loadPreload({file: 'guest-preload.js', href: 'https://example.com'});
      const handler = document.addEventListener.mock.calls.find(([name]) => name === 'click')[1];
      handler({isTrusted: true, button: 0, ctrlKey: true, defaultPrevented: false, composedPath: () => [{tagName: 'A', href}], preventDefault: jest.fn(), stopImmediatePropagation: jest.fn()});
      expect(ipcRenderer.sendToHost).toHaveBeenCalledTimes(href.startsWith('https:') ? 1 : 0);
    }
  );
  test('the transformed-page bridge permits only its three fixed messages', () => {
    const {window, ipcRenderer} = loadPreload({file: 'transformed-preload.js', href: 'file:///app/transformed-view.html?viewId=example', argv: ['--browser-guest-page-url=file:///app/transformed-view.html']});
    expect(window.electronAPI).toBeUndefined();
    window.transformedViewAPI.send('toggle-js');
    expect(ipcRenderer.sendToHost).not.toHaveBeenCalled();
    window.transformedViewAPI.send('transformed-view-refresh');
    expect(ipcRenderer.sendToHost).toHaveBeenCalledWith('transformed-view-refresh');
  });
  test('the recovery-page bridge offers only recover and close', () => {
    const {window, ipcRenderer} = loadPreload({file: 'tab-crashed-preload.js', href: 'file:///app/tab-crashed.html', argv: ['--browser-guest-page-url=file:///app/tab-crashed.html']});
    expect(Object.keys(window.crashedTabAPI)).toEqual(['recover', 'close']);
    expect(window.electronAPI).toBeUndefined();
    window.crashedTabAPI.recover(); window.crashedTabAPI.close();
    expect(ipcRenderer.sendToHost.mock.calls).toEqual([['recover-crashed-tab'], ['close-crashed-tab']]);
  });
  test.each(['transformed-preload.js', 'tab-crashed-preload.js'])(
    'a narrow preload exposes nothing after navigation to a remote page: %s', file => {
      const {window} = loadPreload({file, href: 'https://attacker.example/index.html', argv: ['--browser-guest-page-url=file:///app/transformed-view.html']});
      expect(window.electronAPI).toBeUndefined();
      expect(window.transformedViewAPI).toBeUndefined();
      expect(window.crashedTabAPI).toBeUndefined();
    }
  );
});
