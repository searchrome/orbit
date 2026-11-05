const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../../workspace-panel.js'), 'utf8');
const WorkspacePanel = new Function(source.replace('export default class WorkspacePanel', 'class WorkspacePanel') + '\nreturn WorkspacePanel;')();

describe('workspace screens and sidebar sizing', () => {
  let panel, tabs;
  beforeEach(() => {
    document.getElementById = Document.prototype.getElementById.bind(document);
    document.createElement = Document.prototype.createElement.bind(document);
    const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
    document.body.innerHTML = html.match(/<body>([\s\S]*)<\/body>/)[1];
    localStorage.clear();
    for (const dialog of document.querySelectorAll('dialog')) {
      dialog.showModal = () => { dialog.open = true; };
      dialog.close = () => { dialog.open = false; };
    }
    tabs = {
      activeTabId: 'a', tabs: [{ id: 'a', title: 'Selected page', group: '' }, { id: 'b', title: 'Grouped page', group: 'Research' }],
      setTabSearchQuery: jest.fn(), collapsedGroups: new Set(), getTabGroups: () => ['Research'],
      getSessionSnapshot: jest.fn(() => ({tabs: tabs.tabs, activeTabId: tabs.activeTabId})), replaceSession: jest.fn(),
      getTabById: id => tabs.tabs.find(tab => tab.id === id), setTabGroup: jest.fn(), toggleTabGroup: jest.fn()
    };
    window.electronAPI = { invoke: jest.fn().mockResolvedValue([]) };
    panel = new WorkspacePanel(tabs);
    panel.initialize({id: 'current', name: 'Session auto', session: tabs.getSessionSnapshot()});
  });
  test('opens Sessions and Groups as separate screens', async () => {
    document.getElementById('sessions-btn').click();
    expect(document.getElementById('workspace-dialog').open).toBe(true);
    expect(document.getElementById('groups-dialog').open).toBe(false);
    document.getElementById('groups-btn').click();
    expect(document.getElementById('workspace-dialog').open).toBe(false);
    expect(document.getElementById('groups-dialog').open).toBe(true);
    expect(document.getElementById('groups-dialog').querySelector('#session-save-form')).toBeNull();
  });
  test('adds the selected tab by clicking an existing group name', () => {
    panel.openGroups('a');
    document.querySelector('.workspace-group-name').click();
    expect(tabs.setTabGroup).toHaveBeenCalledWith('a', 'Research');
  });
  test('resizes the sidebar with the keyboard and saves its width', () => {
    const handle = document.getElementById('tab-sidebar-resizer');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(document.documentElement.style.getPropertyValue('--orbit-sidebar')).toBe('240px');
    expect(localStorage.getItem('orbit.sidebarWidth')).toBe('240');
    handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(handle.getAttribute('aria-valuenow')).toBe('180');
  });
  test('expands a saved session into grouped pages and retains its expansion on refresh', async () => {
    window.electronAPI.invoke.mockResolvedValue([{id: 'saved-1', name: 'My workspace', updatedAt: new Date().toISOString(), session: {tabs: [
      {title: 'A research page', url: 'https://example.com/research', group: 'Research'},
      {title: 'An ungrouped page', url: 'https://example.com/notes'}
    ]}}]);
    await panel.render();
    const toggle = document.querySelector('.saved-session-toggle');
    const pages = document.querySelector('.saved-session-pages');
    expect(pages.hidden).toBe(true);
    toggle.click();
    expect(pages.hidden).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(pages.textContent).toContain('Research');
    expect(pages.textContent).toContain('A research page');
    expect(pages.textContent).toContain('Ungrouped tabs');
    expect(pages.textContent).toContain('https://example.com/notes');
    await panel.render();
    expect(document.querySelector('.saved-session-pages').hidden).toBe(false);
    document.querySelector('.saved-session-toggle').click();
    expect(document.querySelector('.saved-session-pages').hidden).toBe(true);
  });

  test('shows the automatically created session and renames it without a save action', async () => {
    const current = {id: 'current', name: 'xxx', updatedAt: new Date().toISOString(), session: tabs.getSessionSnapshot()};
    window.electronAPI.invoke.mockImplementation(channel => Promise.resolve(channel === 'workspace-rename' ? current : [current]));
    document.getElementById('session-name').value = 'xxx';
    document.getElementById('session-rename-form').dispatchEvent(new Event('submit', {cancelable: true}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('workspace-rename', {name: 'xxx'});
    expect(panel.currentSession.id).toBe('current');
    expect(document.querySelector('.session-current-badge').textContent).toBe('Current');
    expect(document.getElementById('session-autosave-status').textContent).toContain('automatically');
  });

  test('New session saves the old workspace, replaces its tabs, and focuses the generated name', async () => {
    const next = {id: 'new', name: 'Session random', session: {tabs: [{url: 'about:blank'}]}};
    window.electronAPI.invoke.mockImplementation(channel => Promise.resolve(channel === 'workspace-switch' ? {workspace: next} : []));
    document.getElementById('session-new-btn').click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('workspace-switch', {id: undefined, snapshot: {...tabs.getSessionSnapshot(), sessionId: 'current'}});
    expect(tabs.replaceSession).toHaveBeenCalledWith(next.session);
    expect(panel.currentSession.id).toBe('new');
    expect(document.activeElement).toBe(document.getElementById('session-name'));
    expect(document.getElementById('session-name').value).toBe('Session random');
  });

  test('switches to a saved session instead of appending its tabs', async () => {
    const next = {id: 'other', name: 'Other work', session: {tabs: [{url: 'https://example.org', group: 'Work'}]}};
    window.electronAPI.invoke.mockImplementation(channel => Promise.resolve(channel === 'workspace-switch' ? {workspace: next} : []));
    await panel.switchSession('other');
    expect(tabs.replaceSession).toHaveBeenCalledTimes(1);
    expect(tabs.replaceSession).toHaveBeenCalledWith(next.session);
    expect(panel.currentSession.id).toBe('other');
  });

  test('automatically saves changed tabs with the active identity and reports write failures', async () => {
    const current = {id: 'current', name: 'Session auto', session: tabs.getSessionSnapshot()};
    window.electronAPI.invoke.mockResolvedValue(current);
    await panel.autosave();
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('workspace-autosave', {...tabs.getSessionSnapshot(), sessionId: 'current'});
    window.electronAPI.invoke.mockRejectedValueOnce(new Error('Disk full'));
    await expect(panel.autosave()).rejects.toThrow('Disk full');
    expect(document.getElementById('session-autosave-status').textContent).toContain('Could not save changes: Disk full');
  });

  test('ignores a late autosave response after a session switch', async () => {
    let finish;
    window.electronAPI.invoke.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const saving = panel.autosave();
    panel.setCurrentSession({id: 'other', name: 'Other', session: {tabs: []}});
    finish({id: 'current', name: 'Old name', session: {tabs: []}});
    await saving;
    expect(panel.currentSession.id).toBe('other');
  });

  test('restores controls and keeps the current workspace after switching fails', async () => {
    window.electronAPI.invoke.mockRejectedValueOnce(new Error('Disk full'));
    await expect(panel.switchSession('other')).rejects.toThrow('Disk full');
    expect(panel.currentSession.id).toBe('current');
    expect(tabs.replaceSession).not.toHaveBeenCalled();
    expect(panel.transitioning).toBe(false);
    expect(document.getElementById('session-new-btn').disabled).toBe(false);
  });

  test('opens tab search, filters while typing, and clears it on Escape', () => {
    const button = document.getElementById('tab-search-btn');
    const input = document.getElementById('tab-search-input');
    button.click();
    expect(document.getElementById('tab-search').hidden).toBe(false);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(input);
    input.value = 'example.com'; input.dispatchEvent(new Event('input'));
    expect(tabs.setTabSearchQuery).toHaveBeenLastCalledWith('example.com');
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    expect(document.getElementById('tab-search').hidden).toBe(true);
    expect(tabs.setTabSearchQuery).toHaveBeenLastCalledWith('');
    expect(document.activeElement).toBe(button);
  });
  test('keeps the query when switching tab layout and supports clearing without closing search', () => {
    document.getElementById('tab-search-btn').click();
    const input = document.getElementById('tab-search-input');
    input.value = 'Research'; input.dispatchEvent(new Event('input'));
    document.getElementById('tab-layout-btn').click();
    expect(document.getElementById('tab-search').hidden).toBe(false);
    expect(input.value).toBe('Research');
    document.getElementById('tab-search-clear').click();
    expect(input.value).toBe('');
    expect(tabs.setTabSearchQuery).toHaveBeenLastCalledWith('');
    expect(document.getElementById('tab-search').hidden).toBe(false);
  });

  test('Enter opens the first matching tab and closes search, while no results leave it open', () => {
    tabs.switchToTab = jest.fn();
    tabs.tabs[0].element = {hidden: true};
    tabs.tabs[1].element = {hidden: false};
    document.getElementById('tab-search-btn').click();
    const input = document.getElementById('tab-search-input');
    input.value = 'grouped';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(tabs.switchToTab).toHaveBeenCalledWith('b');
    expect(document.getElementById('tab-search').hidden).toBe(true);
    expect(tabs.setTabSearchQuery).toHaveBeenLastCalledWith('');
    document.getElementById('tab-search-btn').click();
    tabs.tabs[1].element.hidden = true;
    input.value = 'missing';
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}));
    expect(tabs.switchToTab).toHaveBeenCalledTimes(1);
    expect(document.getElementById('tab-search').hidden).toBe(false);
  });

});
