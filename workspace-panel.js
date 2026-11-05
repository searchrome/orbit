// Named workspaces are stored by the browser process; page scripts cannot access them.
export default class WorkspacePanel {
  constructor(tabs) {
    this.tabs = tabs;
    this.expandedSessions = new Set();
    this.sessions = [];
    this.selectedSessionId = '';
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
    document.getElementById('session-save-target').addEventListener('change', event => this.selectSession(event.target.value));
    document.getElementById('session-save-form').addEventListener('submit', async event => {
      event.preventDefault();
      await this.run(async () => {
        const targetId = document.getElementById('session-save-target').value;
        const saved = await window.electronAPI.invoke('workspace-save', {
          ...(targetId ? { id: targetId } : {}),
          name: document.getElementById('session-name').value,
          session: tabs.getSessionSnapshot()
        });
        this.selectedSessionId = targetId || saved?.[0]?.id || '';
        if (this.selectedSessionId) this.expandedSessions.add(this.selectedSessionId);
        await this.render();
        this.status(targetId ? 'Session updated with the current tabs and groups.' : 'Session created.');
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
  selectSession(id) {
    this.selectedSessionId = this.sessions.some(session => session.id === id) ? id : '';
    const selected = this.sessions.find(session => session.id === this.selectedSessionId);
    document.getElementById('session-save-target').value = this.selectedSessionId;
    document.getElementById('session-name').value = selected?.name || '';
    document.getElementById('session-save-btn').textContent = selected ? 'Update session' : 'Create session';
    document.getElementById('session-save-hint').textContent = selected
      ? 'Replace the selected session with the current tabs and groups.'
      : 'Create a session from the current tabs and groups.';
    document.querySelectorAll('.saved-session').forEach(row => {
      row.classList.toggle('saved-session--selected', row.dataset.sessionId === this.selectedSessionId);
    });
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
    const target = document.getElementById('session-save-target');
    target.replaceChildren();
    const createNew = document.createElement('option'); createNew.value = ''; createNew.textContent = 'New session…'; target.append(createNew);
    for (const session of sessions) {
      const option = document.createElement('option'); option.value = session.id; option.textContent = session.name; target.append(option);
    }
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
        this.selectSession(session.id);
        const expand = pages.hidden;
        pages.hidden = !expand;
        info.setAttribute('aria-expanded', String(expand));
        if (expand) this.expandedSessions.add(session.id); else this.expandedSessions.delete(session.id);
      });
      const name = document.createElement('strong'); name.textContent = session.name;
      const count = document.createElement('small'); count.textContent = `${session.session.tabs.length} tabs · ${new Date(session.updatedAt).toLocaleDateString()}`;
      const description = document.createElement('span'); description.append(name, count);
      const chevron = document.createElement('span'); chevron.className = 'saved-session-chevron'; chevron.textContent = '›'; chevron.setAttribute('aria-hidden', 'true');
      info.append(chevron, description); summary.append(info);
      const actions = document.createElement('div'); actions.className = 'saved-session-actions';
      for (const [label, target] of [['Open here', 'current'], ['New window', 'new']]) {
        const button = document.createElement('button'); button.className = 'toolbar-btn'; button.textContent = label;
        button.addEventListener('click', () => this.run(async () => {
          if (target === 'new') await window.electronAPI.invoke('workspace-open-window', { id: session.id });
          else {
            let activeId;
            for (const tab of session.session.tabs) {
              const id = this.tabs.createTab(tab.url, { title: tab.title, activate: false, deferLoad: true });
              if (tab.group) this.tabs.setTabGroup(id, tab.group);
              if (tab.id === session.session.activeTabId || !activeId) activeId = id;
            }
            if (activeId) this.tabs.switchToTab(activeId);
            this.tabs.restoreCollapsedGroups(session.session.collapsedGroups || []);
          }
          this.selectSession(session.id);
          this.dialog.close();
        })); actions.append(button);
      }
      const remove = document.createElement('button'); remove.className = 'toolbar-btn'; remove.textContent = 'Delete';
      remove.setAttribute('aria-label', `Delete session ${session.name}`);
      remove.addEventListener('click', () => this.run(async () => {
        await window.electronAPI.invoke('workspace-delete', { id: session.id });
        this.expandedSessions.delete(session.id);
        await this.render();
      })); actions.append(remove); summary.append(actions); row.append(summary, pages); list.append(row);
    }
    this.selectSession(this.selectedSessionId);
  }
}
