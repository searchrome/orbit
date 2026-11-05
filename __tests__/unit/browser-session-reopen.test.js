const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../main.js'), 'utf8');
function productionFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  return source.slice(start, source.indexOf('\n}\n', start) + 2);
}
function loadLifecycle() {
  const host = {};
  const window = {webContents: host, isDestroyed: () => false};
  const old = {tabs: [{id: 'old', url: 'https://example.com/old', group: 'Old group'}], activeTabId: 'old'};
  const context = {
    mainWindow: window, windowStartupSessions: new Map(),
    startupCleanSession: old, startupRecoverySession: old,
    BROWSER_SESSION_VERSION: 1,
    isHostBrowserEvent: event => event.sender === host,
    queueBrowserSessionWrite: jest.fn().mockResolvedValue(undefined), console,
    ipcMain: {handle: (channel, handler) => { context.getStartup = handler; }}
  };
  vm.createContext(context);
  vm.runInContext(['sanitizeSessionTab', 'sanitizeBrowserSession', 'markBrowserSessionClean'].map(productionFunction).join('\n'), context);
  const start = source.indexOf("ipcMain.handle('get-startup-session'");
  const end = source.indexOf("ipcMain.on('browser-session-state'", start);
  vm.runInContext(source.slice(start, end), context);
  return {context, host};
}
describe('closing a window and reopening from the macOS Dock', () => {
  test('restores the last closed tabs and groups instead of the process startup session', async () => {
    const {context, host} = loadLifecycle();
    const latest = {tabs: [{id: 'latest', title: 'Latest page', url: 'https://example.com/latest', group: 'Research'}], activeTabId: 'latest', collapsedGroups: ['Research']};
    await context.markBrowserSessionClean(latest);
    const restored = context.getStartup({sender: host});
    expect(restored.interrupted).toBe(false);
    expect(restored.session.tabs).toHaveLength(1);
    expect(restored.session.tabs[0]).toMatchObject(latest.tabs[0]);
    expect(restored.session.activeTabId).toBe('latest');
    expect(restored.session.collapsedGroups).toEqual(['Research']);
    expect(context.queueBrowserSessionWrite).toHaveBeenCalledWith(expect.objectContaining({status: 'clean', session: restored.session}));
  });
  test('uses the most recently closed window on repeated close and reopen cycles', async () => {
    const {context, host} = loadLifecycle();
    for (const group of ['First', 'Second', 'Third']) {
      await context.markBrowserSessionClean({tabs: [{id: group, url: `https://example.com/${group}`, group}], activeTabId: group});
      expect(context.getStartup({sender: host}).session.tabs[0].group).toBe(group);
    }
  });
  test('does not silently discard tabs after the first fifty', () => {
    const {context} = loadLifecycle();
    const session = context.sanitizeBrowserSession({tabs: Array.from({length: 75}, (_, index) => ({id: `tab-${index}`, url: `https://example.com/${index}`, group: 'Work'})), activeTabId: 'tab-74'});
    expect(session.tabs).toHaveLength(75);
    expect(session.activeTabId).toBe('tab-74');
  });
  test('restores collapsed state only for groups that still exist', () => {
    const {context} = loadLifecycle();
    const session = context.sanitizeBrowserSession({tabs: [{id: 'a', url: 'https://example.com', group: 'Work'}], collapsedGroups: ['Work', 'Missing', 'Work']});
    expect(session.collapsedGroups).toEqual(['Work']);
  });
  test('simultaneous Quit acknowledgements save the actual last window before destruction', async () => {
    const events = [];
    const windows = new Set();
    const first = {webContents: {id: 1}, isDestroyed: () => !windows.has(first)};
    const second = {webContents: {id: 2}, isDestroyed: () => !windows.has(second)};
    windows.add(first); windows.add(second);
    const context = {
      console, browserWindows: windows, mainWindow: first, browserWindowCloseWrite: Promise.resolve(),
      windowSessionSnapshots: new Map([[2, {tabs: [{group: 'Second'}]}]]),
      isHostBrowserEvent: () => true,
      sanitizeBrowserSession: snapshot => snapshot,
      BrowserWindow: {fromWebContents: sender => sender.id === 1 ? first : second},
      saveRunningBrowserSession: async snapshot => { await Promise.resolve(); events.push(`running:${snapshot.tabs[0].group}`); },
      markBrowserSessionClean: async snapshot => { events.push(`clean:${snapshot.tabs[0].group}`); },
      ipcMain: {on: (channel, handler) => { context.acknowledge = handler; }}
    };
    for (const window of windows) window.destroy = () => {
      events.push(`destroy:${window.webContents.id}`);
      windows.delete(window);
      context.mainWindow = [...windows][0] || null;
    };
    vm.createContext(context);
    const start = source.indexOf("ipcMain.on('open-tabs-saved'");
    const end = source.indexOf("app.on('render-process-gone'", start);
    vm.runInContext(source.slice(start, end), context);
    await Promise.all([
      context.acknowledge({sender: first.webContents}, {tabs: [{group: 'First'}]}),
      context.acknowledge({sender: second.webContents}, {tabs: [{group: 'Second'}]})
    ]);
    expect(events).toEqual(['running:Second', 'destroy:1', 'clean:Second', 'destroy:2']);
    expect(windows.size).toBe(0);
  });

});
