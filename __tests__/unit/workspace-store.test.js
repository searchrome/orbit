const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WorkspaceStore = require('../../workspace-store');

describe('named browser sessions', () => {
  let directory, store;
  const snapshot = { tabs: [{ id: 'a', url: 'https://example.com', title: 'Example', group: 'Research' }, { id: 'b', url: 'about:blank', title: 'Notes' }], activeTabId: 'b' };
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-sessions-'));
    store = new WorkspaceStore(path.join(directory, 'sessions.json'), value => value);
  });
  afterEach(async () => { await fs.rm(directory, { recursive: true, force: true }); });
  test('retains tab order, groups and active tab after reopening the store', async () => {
    await store.save({ name: 'Research', session: snapshot });
    const reopened = new WorkspaceStore(store.filePath, value => value);
    expect((await reopened.list())[0]).toMatchObject({ name: 'Research', session: snapshot });
  });
  test('serializes simultaneous saves and deletes only the selected session', async () => {
    await Promise.all(['One', 'Two'].map(name => store.save({ name, session: snapshot })));
    const items = await store.list();
    expect(items).toHaveLength(2);
    await store.delete(items[0].id);
    expect(await store.list()).toEqual([items[1]]);
  });
  test('rejects empty names and empty sessions', () => {
    expect(() => store.save({ name: ' ', session: snapshot })).toThrow('name');
    expect(() => store.save({ name: 'Empty', session: { tabs: [] } })).toThrow('Open a tab');
  });
  test('updates only the selected session and retains its ID without creating a duplicate', async () => {
    await store.save({name: 'First', session: snapshot});
    await store.save({name: 'Second', session: snapshot});
    const before = await store.list();
    const selected = before[1];
    const replacement = {tabs: [{id: 'new', url: 'https://example.com/new', title: 'New page', group: 'Work'}], activeTabId: 'new', collapsedGroups: ['Work']};
    await store.save({id: selected.id, name: selected.name, session: replacement});
    const after = await store.list();
    expect(after).toHaveLength(2);
    expect(after[0]).toEqual(before[0]);
    expect(after[1]).toMatchObject({id: selected.id, name: selected.name, session: replacement});
  });
  test('rejects updating a deleted session without changing the library', async () => {
    await store.save({name: 'Keep', session: snapshot});
    const before = await store.list();
    await expect(store.save({id: 'missing', name: 'Missing', session: snapshot})).rejects.toThrow('no longer exists');
    expect(await store.list()).toEqual(before);
  });

});
