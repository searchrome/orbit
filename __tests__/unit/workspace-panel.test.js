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
      getTabById: id => tabs.tabs.find(tab => tab.id === id), setTabGroup: jest.fn(), toggleTabGroup: jest.fn()
    };
    window.electronAPI = { invoke: jest.fn().mockResolvedValue([]) };
    panel = new WorkspacePanel(tabs);
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

  test('selects an existing session and saves current tabs to its ID', async () => {
    const snapshot = {tabs: [{id: 'new', url: 'https://example.com/new', group: 'Work'}], activeTabId: 'new'};
    tabs.getSessionSnapshot = jest.fn().mockReturnValue(snapshot);
    const sessions = [{id: 'saved-1', name: 'Daily work', updatedAt: new Date().toISOString(), session: {tabs: []}}];
    window.electronAPI.invoke.mockResolvedValue(sessions);
    await panel.render();
    const target = document.getElementById('session-save-target');
    target.value = 'saved-1'; target.dispatchEvent(new Event('change'));
    expect(document.getElementById('session-name').value).toBe('Daily work');
    expect(document.getElementById('session-save-btn').textContent).toBe('Update session');
    document.getElementById('session-save-form').dispatchEvent(new Event('submit', {cancelable: true}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(window.electronAPI.invoke).toHaveBeenCalledWith('workspace-save', {id: 'saved-1', name: 'Daily work', session: snapshot});
    expect(target.value).toBe('saved-1');
    expect(document.getElementById('workspace-status').textContent).toContain('updated');
  });
  test('clicking a session selects it; choosing New session clears the update target', async () => {
    window.electronAPI.invoke.mockResolvedValue([{id: 'saved-1', name: 'Daily work', updatedAt: new Date().toISOString(), session: {tabs: []}}]);
    await panel.render();
    document.querySelector('.saved-session-toggle').click();
    const target = document.getElementById('session-save-target');
    expect(target.value).toBe('saved-1');
    target.value = ''; target.dispatchEvent(new Event('change'));
    expect(document.getElementById('session-name').value).toBe('');
    expect(document.getElementById('session-save-btn').textContent).toBe('Create session');
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

});
