const fs = require('node:fs/promises');
const { randomUUID } = require('node:crypto');

class WorkspaceStore {
  constructor(filePath, sanitize) {
    this.filePath = filePath;
    this.sanitize = sanitize;
    this.pending = Promise.resolve();
  }
  async list() {
    try {
      const data = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid session library.');
      return data;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }
  update(change) {
    const operation = this.pending.then(async () => {
      const items = await change(await this.list());
      const temporary = `${this.filePath}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(items, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.filePath);
      return items;
    });
    this.pending = operation.catch(() => {});
    return operation;
  }
  save(payload) {
    const name = String(payload?.name || '').trim().slice(0, 80);
    if (!name) throw new Error('Give your session a name.');
    const session = this.sanitize(payload?.session);
    if (!session.tabs.length) throw new Error('Open a tab before saving a session.');
    const id = typeof payload?.id === 'string' ? payload.id : '';
    return this.update(items => {
      const updatedAt = new Date().toISOString();
      if (!id) return [{ id: randomUUID(), name, updatedAt, session }, ...items];
      const index = items.findIndex(item => item.id === id);
      if (index === -1) throw new Error('The selected session no longer exists. Select another session or create a new one.');
      items[index] = { ...items[index], name, updatedAt, session };
      return items;
    });
  }
  delete(id) { return this.update(items => items.filter(item => item.id !== id)); }
}
module.exports = WorkspaceStore;
