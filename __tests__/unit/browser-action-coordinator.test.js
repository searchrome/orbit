jest.unmock('fs');
jest.unmock('path');

const fs = require('node:fs');
const path = require('node:path');

function loadCoordinator() {
  const source = fs.readFileSync(path.join(__dirname, '../../browser-action-coordinator.js'), 'utf8')
    .replace('export const MUTATING_BROWSER_TOOLS', 'const MUTATING_BROWSER_TOOLS')
    .replace('export default class BrowserActionCoordinator', 'class BrowserActionCoordinator')
    .replace('export { cancellationResult as browserActionCancellationResult };', 'module.exports = { BrowserActionCoordinator, MUTATING_BROWSER_TOOLS, browserActionCancellationResult: cancellationResult };');
  const module = { exports: {} };
  new Function('module', 'exports', source)(module, module.exports);
  return module.exports;
}

describe('BrowserActionCoordinator', () => {
  test('treats press-and-hold as a mutation', () => {
    const { MUTATING_BROWSER_TOOLS } = loadCoordinator();
    expect(MUTATING_BROWSER_TOOLS).toContain('press_and_hold');
  });

  test('serializes mutations for one tab and cancels work before dispatch', async () => {
    const { BrowserActionCoordinator } = loadCoordinator();
    const coordinator = new BrowserActionCoordinator();
    let releaseFirst;
    const firstStarted = jest.fn();
    const secondOperation = jest.fn();
    const first = coordinator.execute(
      { owner: 'opencode', toolName: 'click_element', tabId: 'tab-1', onStart: firstStarted },
      () => new Promise((resolve) => { releaseFirst = () => resolve({ ok: true }); })
    );
    const controller = new AbortController();
    const second = coordinator.execute(
      { owner: 'opencode', toolName: 'click_element', tabId: 'tab-1', signal: controller.signal },
      secondOperation
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(firstStarted).toHaveBeenCalledTimes(1);
    expect(secondOperation).not.toHaveBeenCalled();

    controller.abort('Stopped by user.');
    releaseFirst();
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toMatchObject({
      ok: false,
      error: { code: 'browser_action_cancelled', retryable: false },
      actionMayHaveCompleted: false
    });
    expect(secondOperation).not.toHaveBeenCalled();
  });

  test('runs independent reads concurrently only up to the configured cap', async () => {
    const { BrowserActionCoordinator } = loadCoordinator();
    const coordinator = new BrowserActionCoordinator({ maxConcurrentReads: 2 });
    const releases = [];
    let active = 0;
    let peak = 0;
    const operation = () => new Promise((resolve) => {
      active += 1;
      peak = Math.max(peak, active);
      releases.push(() => {
        active -= 1;
        resolve({ ok: true });
      });
    });

    const reads = ['tab-1', 'tab-2', 'tab-3'].map((tabId) => coordinator.execute(
      { owner: 'opencode', toolName: 'read_page_text', tabId },
      operation
    ));

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    expect(peak).toBe(2);
    releases.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(active).toBe(2);
    releases.forEach((release) => release());
    await expect(Promise.all(reads)).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(peak).toBe(2);
  });

  test('blocks the legacy assistant while OpenCode holds browser control', async () => {
    const { BrowserActionCoordinator } = loadCoordinator();
    const coordinator = new BrowserActionCoordinator();
    coordinator.setExclusiveOwner('opencode');

    await expect(coordinator.execute(
      { owner: 'assistant', toolName: 'read_page_text', tabId: 'tab-1' },
      () => ({ ok: true })
    )).resolves.toMatchObject({
      ok: false,
      error: { code: 'browser_control_locked' }
    });
  });
});
