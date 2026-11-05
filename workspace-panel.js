// Named workspaces are stored by the browser process; page scripts cannot access them.
export default class WorkspacePanel {
  constructor(tabs) {
    this.tabs = tabs;
    this.expandedSessions = new Set();
    this.sessions = [];
    this.currentSession = null;
    this.ready = false;
    this.transitioning = false;
    this.saveState = 'Starting session…';
    this.groupsDialog = document.getElementById('groups-dialog');
    this.screen = 'sessions';
    this.bindSidebarResize();
    this.bindTabSearch();
    this.dialog = document.getElementById('workspace-dialog');
    const layout = document.getElementById('tab-layout-btn');
    const setLayout = vertical => {
      document.body.classList.toggle('vertical-tabs', vertical);
      layout.setAttribute('aria-pressed', String(vertical));
      layout.title = `Switch to ${vertical ? 'horizontal' : 'vertical'} tabs`;
      layout.setAttribute('aria-label', layout.title);
      localStorage.setItem('orbit.verticalTabs', String(vertical));
    };
    setLayout(localStorage.getItem('orbit.verticalTabs') === 'true');
    layout.addEventListener('click', () => setLayout(!document.body.classList.contains('vertical-tabs')));
    document.getElementById('sessions-btn').addEventListener('click', () => this.open());
    document.getElementById('workspace-close').addEventListener('click', () => this.dialog.close());
    document.getElementById('groups-btn').addEventListener('click', () => this.openGroups());
    document.getElementById('groups-close').addEventListener('click', () => this.groupsDialog.close());
    window.addEventListener('tab-groups-changed', () => { if (this.groupsDialog.open) this.renderGroups(); });
    document.getElementById('session-new-btn').addEventListener('click', () => this.run(() => this.switchSession()));
    document.getElementById('session-rename-form').addEventListener('submit', event => {
      event.preventDefault();
      void this.run(async () => {
        if (!this.ready || this.transitioning) return;
        const record = await window.electronAPI.invoke('workspace-rename', {name: document.getElementById('session-name').value});
        this.setCurrentSession(record);
        await this.render();
        this.status('Session renamed. Changes are saved automatically.');
      });
    });
    window.addEventListener('tab-group-request', event => {
      this.openGroups(event.detail.tabId);
      document.getElementById('tab-group-name').focus();
    });
    document.getElementById('tab-group-form').addEventListener('submit', event => {
      event.preventDefault();
      const name = document.getElementById('tab-group-name').value.trim();
      if (!name) return;
      tabs.setTabGroup(this.groupTabId, name);
      document.getElementById('tab-group-name').value = '';
      this.renderGroups();
      this.status('Tab group updated.');
    });
    document.getElementById('tab-ungroup').addEventListener('click', () => {
      tabs.setTabGroup(this.groupTabId, '');
      this.renderGroups();
      this.status('Tab removed from its group.');
    });
  }
  status(message) { document.getElementById(this.screen === 'groups' ? 'groups-status' : 'workspace-status').textContent = message; }
  async run(action) {
    try { await action(); } catch (error) { this.status(error.message || 'Could not update workspace.'); }
  }
  open() {
    this.screen = 'sessions';
    if (this.groupsDialog.open) this.groupsDialog.close();
    if (!this.dialog.open) this.dialog.showModal();
    this.status('');
    void this.run(() => this.render());
  }
  openGroups(tabId = this.tabs.activeTabId) {
    this.screen = 'groups';
    this.groupTabId = tabId;
    if (this.dialog.open) this.dialog.close();
    const tab = this.tabs.getTabById(tabId);
    document.getElementById('group-selected-tab').textContent = tab ? `Selected tab: ${tab.title}` : 'Open a tab to create or join a group.';
    document.getElementById('tab-group-form').hidden = !tab;
    document.getElementById('tab-ungroup').disabled = !tab?.group;
    this.status('');
    this.renderGroups();
    if (!this.groupsDialog.open) this.groupsDialog.showModal();
  }
  renderGroups() {
    const container = document.getElementById('workspace-groups');
    container.replaceChildren();
    for (const group of this.tabs.getTabGroups()) {
      const row = document.createElement('div'); row.className = 'workspace-group';
      const label = document.createElement('button');
      label.type = 'button'; label.className = 'workspace-group-name';
      label.textContent = group;
      label.title = `Add selected tab to ${group}`;
      const count = document.createElement('small');
      count.textContent = `${this.tabs.tabs.filter(tab => tab.group === group).length} tabs`;
      label.append(count);
      label.addEventListener('click', () => {
        this.tabs.setTabGroup(this.groupTabId, group);
        this.status(`Selected tab added to ${group}.`);
      });
      const toggle = document.createElement('button'); toggle.className = 'toolbar-btn';
      const isCollapsed = this.tabs.collapsedGroups.has(group);
      toggle.textContent = isCollapsed ? 'Expand' : 'Collapse';
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.addEventListener('click', () => this.tabs.toggleTabGroup(group));
      row.append(label, toggle); container.append(row);
    }
    document.getElementById('tab-ungroup').disabled = !this.tabs.getTabById(this.groupTabId)?.group;
    if (!this.tabs.getTabGroups().length) container.textContent = 'No groups yet. Create a group for the selected tab below.';
  }
  bindTabSearch() {
    const button = document.getElementById('tab-search-btn');
    const field = document.getElementById('tab-search');
    const input = document.getElementById('tab-search-input');
    const clear = () => {
      input.value = '';
      this.tabs.setTabSearchQuery('');
    };
    const setOpen = open => {
      field.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      document.body.classList.toggle('tab-search-open', open);
      if (open) input.focus();
      else { clear(); button.focus(); }
    };
    button.addEventListener('click', () => setOpen(field.hidden));
    input.addEventListener('input', () => this.tabs.setTabSearchQuery(input.value));
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      } else if (event.key === 'Enter' && input.value.trim()) {
        event.preventDefault();
        const match = this.tabs.tabs.find(tab => !tab.hidden && tab.element && !tab.element.hidden);
        if (match) {
          this.tabs.switchToTab(match.id);
          setOpen(false);
        }
      }
    });
    document.getElementById('tab-search-clear').addEventListener('click', () => { clear(); input.focus(); });
  }
  bindSidebarResize() {
    const handle = document.getElementById('tab-sidebar-resizer');
    const maximum = () => Math.max(180, Math.min(560, window.innerWidth - 360));
    const setWidth = value => {
      this.sidebarWidth = Math.round(Math.min(maximum(), Math.max(180, value)));
      document.documentElement.style.setProperty('--orbit-sidebar', `${this.sidebarWidth}px`);
      document.body.classList.toggle('narrow-tab-sidebar', this.sidebarWidth < 215);
      handle.setAttribute('aria-valuemax', String(maximum()));
      handle.setAttribute('aria-valuenow', String(this.sidebarWidth));
    };
    const save = () => localStorage.setItem('orbit.sidebarWidth', String(this.sidebarWidth));
    setWidth(Number(localStorage.getItem('orbit.sidebarWidth')) || 230);
    let pointerId = null;
    const finish = event => {
      if (pointerId === null || event.pointerId !== pointerId) return;
      pointerId = null;
      document.body.classList.remove('resizing-tab-sidebar');
      save();
    };
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.preventDefault();
      pointerId = event.pointerId;
      handle.setPointerCapture(pointerId);
      document.body.classList.add('resizing-tab-sidebar');
    });
    handle.addEventListener('pointermove', event => {
      if (event.pointerId === pointerId) setWidth(event.clientX);
    });
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);
    handle.addEventListener('lostpointercapture', finish);
    handle.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      setWidth(event.key === 'Home' ? 180 : event.key === 'End' ? maximum() : this.sidebarWidth + (event.key === 'ArrowRight' ? 10 : -10));
      save();
    });
    handle.addEventListener('dblclick', () => { setWidth(230); save(); });
    window.addEventListener('resize', () => setWidth(this.sidebarWidth));
  }
  initialize(record) {
    if (!record?.id) throw new Error('Could not start a saved session. Reopen the browser to retry.');
    this.ready = true;
    this.setCurrentSession(record);
  }
  setCurrentSession(record) {
    const changed = this.currentSession?.id !== record.id;
    this.currentSession = record;
    if (changed || document.activeElement !== document.getElementById('session-name')) {
      document.getElementById('session-name').value = record.name;
    }
    this.saveState = 'All changes saved automatically';
    this.updateSessionStatus();
  }
  updateSessionStatus() {
    document.getElementById('session-autosave-status').textContent = this.saveState;
    const button = document.getElementById('sessions-btn');
    button.title = this.currentSession ? `Sessions · ${this.currentSession.name} · ${this.saveState}` : 'Sessions';
    document.getElementById('session-new-btn').disabled = !this.ready || this.transitioning;
    document.getElementById('session-rename-btn').disabled = !this.ready || this.transitioning;
  }
  getCurrentSnapshot() {
    return {...this.tabs.getSessionSnapshot(), sessionId: this.currentSession?.id};
  }
  async autosave() {
    if (!this.ready || this.transitioning) return;
    const id = this.currentSession.id;
    this.saveState = 'Saving changes…';
    this.updateSessionStatus();
    try {
      const record = await window.electronAPI.invoke('workspace-autosave', this.getCurrentSnapshot());
      if (this.transitioning || this.currentSession.id !== id) return;
      if (!record) throw new Error('The active session changed. Reopen the browser to retry.');
      this.setCurrentSession(record);
      if (this.dialog.open) await this.render();
    } catch (error) {
      if (!this.transitioning && this.currentSession.id === id) {
        this.saveState = `Could not save changes: ${error.message || error}`;
        this.updateSessionStatus();
      }
      throw error;
    }
  }
  async changeSession(operation) {
    if (!this.ready || this.transitioning) return;
    this.transitioning = true;
    document.getElementById('workspace-bar').inert = true;
    document.getElementById('controls').inert = true;
    document.getElementById('content').inert = true;
    this.updateSessionStatus();
    window.dispatchEvent(new Event('workspace-session-changing'));
    try {
      const result = await operation();
      if (result.workspace) {
        if (result.workspace.id !== this.currentSession.id) {
          document.getElementById('tab-search-input').value = '';
          this.tabs.setTabSearchQuery('');
          this.tabs.replaceSession(result.workspace.session);
        }
        this.setCurrentSession(result.workspace);
      }
      this.transitioning = false;
      await this.render();
      return result;
    } finally {
      this.transitioning = false;
      document.getElementById('workspace-bar').inert = false;
      document.getElementById('controls').inert = false;
      document.getElementById('content').inert = false;
      this.updateSessionStatus();
      window.dispatchEvent(new Event('workspace-session-ready'));
    }
  }
  async switchSession(id) {
    if (id === this.currentSession?.id) { this.dialog.close(); return; }
    const result = await this.changeSession(() => window.electronAPI.invoke('workspace-switch', {id, snapshot: this.getCurrentSnapshot()}));
    if (!result) return;
    if (result.workspace && !id) {
      this.status('New session created. Changes are saved automatically.');
      document.getElementById('session-name').focus();
      document.getElementById('session-name').select();
    } else this.dialog.close();
  }
  async deleteSession(id) {
    await this.changeSession(() => window.electronAPI.invoke('workspace-delete', {id}));
    this.expandedSessions.delete(id);
    this.status('Session deleted.');
  }
  renderSessionPages(session) {
    const pages = document.createElement('div');
    pages.className = 'saved-session-pages';
    pages.id = `session-pages-${session.id}`;
    const sections = new Map();
    for (const tab of session.session.tabs) {
      const group = tab.group || '';
      if (!sections.has(group)) sections.set(group, []);
      sections.get(group).push(tab);
    }
    for (const [group, tabs] of sections) {
      const section = document.createElement('section');
      const heading = document.createElement('h4'); heading.textContent = group || 'Ungrouped tabs';
      const list = document.createElement('ul');
      for (const tab of tabs) {
        const item = document.createElement('li');
        const title = document.createElement('span'); title.textContent = tab.title || 'Untitled page';
        const url = document.createElement('small'); url.textContent = tab.url;
        item.append(title, url); list.append(item);
      }
      section.append(heading, list); pages.append(section);
    }
    return pages;
  }
  async render() {
    const sessions = await window.electronAPI.invoke('workspace-list');
    this.sessions = sessions;
    const list = document.getElementById('saved-session-list'); list.replaceChildren();
    if (!sessions.length) list.textContent = 'Your saved sessions will appear here.';
    for (const session of sessions) {
      const row = document.createElement('article'); row.className = 'saved-session'; row.dataset.sessionId = session.id;
      const summary = document.createElement('div'); summary.className = 'saved-session-summary';
      const info = document.createElement('button'); info.type = 'button'; info.className = 'saved-session-toggle';
      const pages = this.renderSessionPages(session);
      const expanded = this.expandedSessions.has(session.id);
      pages.hidden = !expanded;
      info.setAttribute('aria-expanded', String(expanded));
      info.setAttribute('aria-controls', pages.id);
      info.addEventListener('click', () => {
        const expand = pages.hidden;
        pages.hidden = !expand;
        info.setAttribute('aria-expanded', String(expand));
        if (expand) this.expandedSessions.add(session.id); else this.expandedSessions.delete(session.id);
      });
      const name = document.createElement('strong'); name.textContent = session.name;
      const count = document.createElement('small');
      const total = session.session.tabs.length;
      count.textContent = `${total} tab${total === 1 ? '' : 's'} · ${new Date(session.updatedAt).toLocaleDateString()}`;
      const description = document.createElement('span'); description.append(name, count);
      const chevron = document.createElement('span'); chevron.className = 'saved-session-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
      info.append(chevron, description); summary.append(info);
      const actions = document.createElement('div'); actions.className = 'saved-session-actions';
      const current = session.id === this.currentSession?.id;
      row.classList.toggle('saved-session--selected', current);
      if (current) {
        const badge = document.createElement('span'); badge.className = 'session-current-badge'; badge.textContent = 'Current';
        description.append(badge);
      }
      const open = document.createElement('button'); open.type = 'button'; open.className = 'toolbar-btn';
      open.textContent = current ? 'Current session' : 'Switch to session'; open.disabled = current || this.transitioning;
      open.setAttribute('aria-label', current ? `Current session ${session.name}` : `Switch to session ${session.name}`);
      open.addEventListener('click', () => this.run(() => this.switchSession(session.id)));
      actions.append(open);
      const newWindow = document.createElement('button'); newWindow.type = 'button'; newWindow.className = 'toolbar-btn';
      newWindow.textContent = 'New window'; newWindow.disabled = current || this.transitioning;
      newWindow.addEventListener('click', () => this.run(async () => {
        await window.electronAPI.invoke('workspace-open-window', {id: session.id});
      }));
      actions.append(newWindow);
      const remove = document.createElement('button'); remove.className = 'toolbar-btn'; remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete session ${session.name}`);
      remove.disabled = this.transitioning;
      remove.addEventListener('click', () => this.run(() => this.deleteSession(session.id)));
      actions.append(remove); summary.append(actions); row.append(summary, pages); list.append(row);
    }
    this.updateSessionStatus();
  }
}
