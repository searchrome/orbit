const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const WorkspaceStore = require('../../workspace-store');
const AutomaticSessions = require('../../automatic-sessions');

describe('automatic session lifecycle', () => {
  let directory, store, service;
  const snapshot = (id, url = 'https://example.com') => ({sessionId: id, tabs: [{id: 'a', title: 'Example', url, group: 'Work'}], activeTabId: 'a', collapsedGroups: ['Work']});
  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-auto-sessions-'));
    store = new WorkspaceStore(path.join(directory, 'sessions.json'), value => JSON.parse(JSON.stringify(value)));
    service = new AutomaticSessions(store);
  });
  afterEach(async () => { await fs.rm(directory, {recursive: true, force: true}); });

  test('first launch creates a named session and persists every tab/group change without manual saving', async () => {
    const {workspace} = await service.start(1);
    expect(workspace.name).toMatch(/^Session [a-f0-9]{8}$/);
    expect(workspace.session.tabs[0].url).toBe('about:blank');
    await service.save(1, snapshot(workspace.id));
    const reopened = new AutomaticSessions(new WorkspaceStore(store.filePath, value => value));
    const restored = await reopened.start(2);
    expect(restored.workspace).toMatchObject({id: workspace.id, session: snapshot(workspace.id)});
    expect(await store.list()).toHaveLength(1);
  });
  test('switching saves the old workspace and startup restores the last-used session even if an older one saves later', async () => {
    const first = (await service.start(1)).workspace;
    const second = (await service.change(1, {snapshot: snapshot(first.id)})).workspace;
    await service.save(1, snapshot(second.id, 'https://second.example.com'));
    await service.change(1, {id: first.id, snapshot: snapshot(second.id, 'https://second.example.com')});
    await store.save({id: second.id, name: second.name, session: snapshot(second.id, 'https://background.example.com')});
    const restored = await new AutomaticSessions(store).start(2);
    expect(restored.workspace.id).toBe(first.id);
    expect((await store.list()).find(item => item.id === second.id).session.tabs[0].url).toBe('https://background.example.com');
  });
  test('late saves after switching cannot change either session', async () => {
    const first = (await service.start(1)).workspace;
    const second = (await service.change(1, {snapshot: snapshot(first.id)})).workspace;
    const before = await store.list();
    expect(await service.save(1, snapshot(first.id, 'https://stale.example.com'))).toBeNull();
    expect(await store.list()).toEqual(before);
    expect((await service.current(1)).id).toBe(second.id);
  });
  test('renaming retains identity and an autosave cannot revert the new name', async () => {
    const first = (await service.start(1)).workspace;
    await service.rename(1, 'xxx');
    await service.save(1, snapshot(first.id));
    expect(await service.current(1)).toMatchObject({id: first.id, name: 'xxx'});
  });
  test('deleting inactive sessions leaves the active workspace intact; deleting the active one creates a replacement', async () => {
    const first = (await service.start(1)).workspace;
    const second = (await service.change(1, {snapshot: snapshot(first.id)})).workspace;
    await service.delete(1, first.id);
    expect((await service.current(1)).id).toBe(second.id);
    const result = await service.delete(1, second.id);
    expect(result.workspace.id).not.toBe(second.id);
    expect(await store.list()).toHaveLength(1);
    expect(await service.save(1, snapshot(second.id))).toBeNull();
    expect((await new AutomaticSessions(store).start(2)).workspace.id).toBe(result.workspace.id);
  });
  test('keeps already open sessions in their owning window and keeps last-focused identity', async () => {
    const first = (await service.start(1)).workspace;
    expect(await service.start(2, {id: first.id})).toEqual({focusWindowId: 1});
    const second = (await service.start(2)).workspace;
    await expect(service.delete(1, second.id)).rejects.toThrow('another window');
    expect(await service.change(1, {id: second.id, snapshot: snapshot(first.id)})).toEqual({focusWindowId: 2});
    await service.focus(1);
    expect((await new AutomaticSessions(store).start(3)).workspace.id).toBe(first.id);
  });
  test('migrates the legacy journal once without overwriting existing manually saved sessions', async () => {
    const saved = (await store.save({name: 'Keep me', session: snapshot('legacy')}))[0];
    const legacy = snapshot(undefined, 'https://legacy.example.com');
    const restored = await service.start(1, {fallback: legacy, interrupted: true});
    expect(restored.interrupted).toBe(true);
    expect(restored.workspace.id).not.toBe(saved.id);
    expect(restored.workspace.session.tabs[0].url).toBe('https://legacy.example.com');
    service.release(1);
    expect((await service.start(2, {fallback: legacy})).workspace.id).toBe(restored.workspace.id);
    expect(await store.list()).toHaveLength(2);
  });
  test('recovers a journal into its own session without changing the last-used workspace', async () => {
    const first = (await service.start(1)).workspace;
    const second = (await service.change(1, {snapshot: snapshot(first.id)})).workspace;
    const restarted = new AutomaticSessions(store);
    const result = await restarted.start(2, {interrupted: true, fallback: snapshot(first.id, 'https://recover.example.com')});
    expect(result.workspace.id).toBe(second.id);
    expect((await store.list()).find(item => item.id === first.id).session.tabs[0].url).toBe('https://recover.example.com');
  });
  test('disk failures during switching keep the old session bound and do not drop its tabs', async () => {
    const first = (await service.start(1)).workspace;
    const save = jest.spyOn(store, 'save').mockRejectedValueOnce(new Error('Disk full'));
    await expect(service.change(1, {snapshot: snapshot(first.id)})).rejects.toThrow('Disk full');
    expect((await service.current(1)).id).toBe(first.id);
    save.mockRestore();
    await service.save(1, snapshot(first.id));
    expect((await service.current(1)).session.tabs).toHaveLength(1);
  });
});
