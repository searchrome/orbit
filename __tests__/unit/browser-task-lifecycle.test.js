const BrowserTaskLifecycle = require('../../browser-task-lifecycle');

describe('OpenCode task boundaries', () => {
  test('tags only task-opened tabs and rotates ownership after completion', async () => {
    const bridge = jest.fn().mockResolvedValue({ok: true});
    const tasks = new BrowserTaskLifecycle(bridge);
    await tasks.begin();
    await tasks.open({url: 'https://example.com'});
    const first = bridge.mock.calls[0][1]._taskId;
    await tasks.complete({keepTabIds: ['result']});
    expect(bridge).toHaveBeenCalledWith('cleanup_task_tabs', {taskId: first, keepTabIds: ['result']});
    await tasks.open({url: 'https://example.org'});
    expect(bridge.mock.calls[2][1]._taskId).not.toBe(first);
  });
  test('completion waits for pending opens and failed cleanup can be retried', async () => {
    let finishOpen;
    const bridge = jest.fn()
      .mockImplementationOnce(() => new Promise(resolve => {finishOpen = resolve;}))
      .mockResolvedValueOnce({ok: false})
      .mockResolvedValueOnce({ok: true});
    const tasks = new BrowserTaskLifecycle(bridge);
    const opening = tasks.open({url: 'https://example.com'});
    const completing = tasks.complete();
    await Promise.resolve();
    expect(bridge).toHaveBeenCalledTimes(1);
    finishOpen({ok: true}); await opening; await completing;
    const taskId = bridge.mock.calls[1][1].taskId;
    await tasks.complete();
    expect(bridge.mock.calls[2][1].taskId).toBe(taskId);
  });
  test('starting a second task does not abandon unfinished tabs and repeated completion is harmless', async () => {
    const bridge = jest.fn().mockResolvedValue({ok: true});
    const tasks = new BrowserTaskLifecycle(bridge);
    await tasks.begin();
    expect((await tasks.begin()).error.code).toBe('task_already_active');
    await tasks.complete();
    await tasks.complete();
    expect(bridge).toHaveBeenCalledTimes(1);
  });
});
