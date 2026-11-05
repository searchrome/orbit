const { EventEmitter } = require('node:events');
const DesktopQuitController = require('../../desktop-quit-controller');

function createApp(windowCount = 1, shutdownOverride) {
  const app = new EventEmitter();
  const events = [];
  const windows = [];
  let exited = false;
  app.quit = jest.fn(() => {
    let prevented = false;
    app.emit('before-quit', {preventDefault() { prevented = true; }});
    if (!prevented) {
      if (windows.length) throw new Error('Native quit attempted before windows saved and closed');
      exited = true;
      events.push('exited');
    }
  });
  for (let index = 0; index < windowCount; index++) {
    const window = {isDestroyed: () => !windows.includes(window)};
    window.close = jest.fn(() => events.push(`save-request-${index}`));
    window.saved = () => {
      events.push(`saved-${index}`);
      windows.splice(windows.indexOf(window), 1);
      if (!windows.length) app.emit('window-all-closed');
      controller.onWindowsChanged();
    };
    windows.push(window);
  }
  const shutdown = jest.fn(shutdownOverride || (() => { events.push('cleanup'); }));
  const logger = {warn: jest.fn()};
  const controller = new DesktopQuitController({app, getWindows: () => windows, shutdown, logger});
  return {app, controller, windows, shutdown, events, logger, exited: () => exited};
}

describe('macOS menu Quit', () => {
  test('waits for saved tabs and groups, then fully exits instead of staying in the Dock', async () => {
    const state = createApp();
    const window = state.windows[0];
    state.app.quit();
    expect(state.exited()).toBe(false);
    expect(window.close).toHaveBeenCalledTimes(1);
    expect(state.shutdown).not.toHaveBeenCalled();
    window.saved();
    await state.controller.finishing;
    expect(state.exited()).toBe(true);
    expect(state.events).toEqual(['save-request-0', 'saved-0', 'cleanup', 'exited']);
    expect(state.app.quit).toHaveBeenCalledTimes(2);
  });
  test('explicit Quit exits even after the last window was already closed', async () => {
    const state = createApp(0);
    state.app.quit();
    await state.controller.finishing;
    expect(state.exited()).toBe(true);
  });
  test('closing a window normally keeps the macOS app running', () => {
    const state = createApp();
    state.windows[0].saved();
    expect(state.app.quit).not.toHaveBeenCalled();
    expect(state.shutdown).not.toHaveBeenCalled();
  });
  test('repeated Quit clicks wait for every window without duplicate close requests', async () => {
    const state = createApp(2);
    const [first, second] = state.windows;
    state.app.quit(); state.app.quit();
    first.saved();
    expect(state.shutdown).not.toHaveBeenCalled();
    expect(state.exited()).toBe(false);
    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    second.saved();
    await state.controller.finishing;
    expect(state.exited()).toBe(true);
    expect(state.shutdown).toHaveBeenCalledTimes(1);
  });
  test('a background cleanup failure does not cancel Quit', async () => {
    const state = createApp(0, () => Promise.reject(new Error('cleanup failed')));
    state.app.quit();
    await state.controller.finishing;
    expect(state.exited()).toBe(true);
    expect(state.logger.warn).toHaveBeenCalled();
  });
  test('a stalled background service cannot keep the saved, windowless app alive forever', async () => {
    jest.useFakeTimers();
    try {
      const state = createApp(0, () => new Promise(() => {}));
      state.app.quit();
      await jest.advanceTimersByTimeAsync(5000);
      await state.controller.finishing;
      expect(state.exited()).toBe(true);
      expect(state.logger.warn).toHaveBeenCalled();
    } finally { jest.useRealTimers(); }
  });
});
