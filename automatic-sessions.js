const { randomUUID } = require('node:crypto');

// Own session identity in the browser process. Serialize switches and writes so
// a late renderer snapshot cannot overwrite a different session or revive a deleted one.
class AutomaticSessions {
  constructor(store) {
    this.store = store;
    this.windows = new Map();
    this.pending = Promise.resolve();
    this.started = false;
  }
  run(operation) {
    const result = this.pending.then(operation);
    this.pending = result.catch(() => {});
    return result;
  }
  owner(id) {
    return [...this.windows].find(([, sessionId]) => sessionId === id)?.[0];
  }
  async current(windowId) {
    return (await this.store.list()).find(item => item.id === this.windows.get(windowId));
  }
  blank() {
    return {tabs: [{id: 'initial', url: 'about:blank', title: 'New Tab'}], activeTabId: 'initial', collapsedGroups: []};
  }
  async create(snapshot = this.blank()) {
    const clean = this.store.sanitize(snapshot);
    const items = await this.store.save({name: `Session ${randomUUID().slice(0, 8)}`, session: clean.tabs?.length ? clean : this.blank()});
    return items[0];
  }
  async activate(windowId, record) {
    const items = await this.store.markOpened(record.id);
    this.windows.set(windowId, record.id);
    return items.find(item => item.id === record.id);
  }
  start(windowId, {id, fallback, interrupted = false} = {}) {
    return this.run(async () => {
      const current = await this.current(windowId);
      if (current) return {workspace: current, interrupted: false};
      const items = await this.store.list();
      let record;
      let recovering = false;
      if (id) {
        record = items.find(item => item.id === id);
        if (!record) throw new Error('Session no longer exists.');
        if (this.owner(id) !== undefined) return {focusWindowId: this.owner(id)};
      } else if (!this.started && fallback?.tabs?.length && !fallback.sessionId) {
        // Preserve the legacy tab journal as its own session; never overwrite a
        // user's manually saved library during migration.
        record = await this.create(fallback);
        recovering = interrupted;
      } else {
        const available = items.filter(item => this.owner(item.id) === undefined);
        record = available.sort((a, b) => String(b.lastOpenedAt || b.updatedAt).localeCompare(String(a.lastOpenedAt || a.updatedAt)))[0];
        if (!this.started && interrupted && fallback?.sessionId) {
          const recovery = available.find(item => item.id === fallback.sessionId);
          if (recovery) {
            const saved = await this.store.save({id: recovery.id, name: recovery.name, session: fallback});
            if (record?.id === recovery.id) {
              record = saved.find(item => item.id === recovery.id);
              recovering = true;
            }
          }
        }
        if (!record) record = await this.create();
      }
      record = await this.activate(windowId, record);
      this.started = true;
      return {workspace: record, interrupted: recovering};
    });
  }
  async persist(windowId, snapshot) {
    const current = await this.current(windowId);
    if (!current || snapshot?.sessionId !== current.id) return null;
    const clean = this.store.sanitize(snapshot);
    const items = await this.store.save({id: current.id, name: current.name, session: clean.tabs?.length ? clean : this.blank()});
    return items.find(item => item.id === current.id);
  }
  save(windowId, snapshot) {
    return this.run(() => this.persist(windowId, snapshot));
  }
  change(windowId, {id, snapshot} = {}) {
    return this.run(async () => {
      if (!await this.persist(windowId, snapshot)) throw new Error('The active session changed. Reopen Sessions and try again.');
      if (id && this.owner(id) !== undefined && this.owner(id) !== windowId) return {focusWindowId: this.owner(id)};
      const record = id ? (await this.store.list()).find(item => item.id === id) : await this.create();
      if (!record) throw new Error('Session no longer exists.');
      return {workspace: await this.activate(windowId, record)};
    });
  }
  rename(windowId, name) {
    return this.run(async () => {
      const record = await this.current(windowId);
      if (!record) throw new Error('No active session.');
      const items = await this.store.rename(record.id, name);
      return items.find(item => item.id === record.id);
    });
  }
  delete(windowId, id) {
    return this.run(async () => {
      const owner = this.owner(id);
      if (owner !== undefined && owner !== windowId) throw new Error('This session is open in another window. Close that window before deleting it.');
      const wasCurrent = this.windows.get(windowId) === id;
      // Persist a replacement before deleting the active session, so every
      // window still owns a session even if a later disk write fails.
      const replacement = wasCurrent ? await this.create() : null;
      await this.store.delete(id);
      if (replacement) return {workspace: await this.activate(windowId, replacement)};
      return {workspace: await this.current(windowId)};
    });
  }
  focus(windowId) {
    return this.run(async () => {
      const record = await this.current(windowId);
      if (record) await this.store.markOpened(record.id);
    });
  }
  release(windowId) { this.windows.delete(windowId); }
}
module.exports = AutomaticSessions;
