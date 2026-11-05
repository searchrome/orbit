const {describe, test, before, after, beforeEach} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {_electron: electron} = require('playwright');

describe('Orbit desktop navigation and sessions', {timeout: 60000}, () => {
  let app, page, profile, server, baseUrl;
  const root = path.resolve(__dirname, '../..');

  async function launch() {
    app = await electron.launch({
      args: [root], cwd: root, timeout: 30000,
      env: {...process.env, ORBIT_USER_DATA_DIR: profile, OPENCODE_TERMINAL_ENABLED: 'false'}
    });
    page = await app.firstWindow();
    page.setDefaultTimeout(10000);
    await page.waitForFunction(() => window.workspacePanel?.ready);
  }

  before(async () => {
    profile = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-desktop-test-'));
    server = http.createServer((request, response) => {
      const title = request.url === '/second' ? 'Second page' : 'First page';
      response.writeHead(200, {'Content-Type': 'text/html'});
      response.end(`<title>${title}</title><h1>${title}</h1><a href="/second">Next page</a>`);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    await launch();
  });

  after(async () => {
    try { if (app) await app.close(); }
    finally {
      if (server) await new Promise(resolve => server.close(resolve));
      if (profile) await fs.rm(profile, {recursive: true, force: true});
    }
  });

  beforeEach(async () => {
    await page.evaluate(() => window.workspacePanel.switchSession());
    if (await page.locator('#workspace-dialog').evaluate(dialog => dialog.open)) {
      await page.getByRole('button', {name: 'Close', exact: true}).click();
    }
  });

  test('starts with a visible window and an automatically saved session', async () => {
    assert.equal(await page.title(), 'Orbit Browser');
    assert.equal(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    assert.equal(await page.locator('.tab').count(), 1);
    const saved = await page.evaluate(async () => {
      await window.workspacePanel.autosave();
      return (await window.electronAPI.invoke('workspace-list')).find(item => item.id === window.workspacePanel.currentSession.id);
    });
    assert.match(saved.name, /^Session /);
    assert.equal(saved.session.tabs[0].url, 'about:blank');
  });

  test('navigates pages and goes back using the real guest webview', async () => {
    for (const pathname of ['/first', '/second']) {
      await page.locator('#url-input').fill(baseUrl + pathname);
      await page.locator('#url-input').press('Enter');
      await page.waitForFunction(url => window.tabManager.getActiveTab()?.url === url, baseUrl + pathname);
      await page.waitForFunction(() => window.tabManager.getActiveTab()?.loadState === 'idle');
    }
    await page.waitForFunction(() => !document.getElementById('back-btn').disabled);
    await page.locator('#back-btn').click();
    await page.waitForFunction(url => window.tabManager.getActiveTab()?.url === url, baseUrl + '/first');
    assert.equal(await page.locator('#url-input').inputValue(), baseUrl + '/first');
  });

  test('creates, switches, and closes tabs', async () => {
    await page.getByRole('button', {name: 'New tab', exact: true}).click();
    assert.equal(await page.locator('.tab').count(), 2);
    assert.equal(await page.locator('webview').count(), 2);
    await page.locator('.tab').first().click();
    assert.equal(await page.locator('.tab').first().evaluate(tab => tab.classList.contains('active')), true);
    await page.locator('.tab-close-btn').last().click();
    assert.equal(await page.locator('.tab').count(), 1);
    assert.equal(await page.locator('.tab.active').count(), 1);
  });

  test('toggles per-tab network and global JavaScript controls independently', async () => {
    for (const selector of ['#toggle-network-btn', '#toggle-js-btn']) {
      const button = page.locator(selector);
      const original = await button.getAttribute('class');
      await button.click();
      assert.notEqual(await button.getAttribute('class'), original);
      await button.click();
      assert.equal(await button.getAttribute('class'), original);
    }
  });

  test('toggles cache from the overflow menu', async () => {
    await page.locator('#toolbar-more-menu > summary').click();
    const button = page.locator('#toggle-cache-btn');
    const original = await button.getAttribute('class');
    await button.click();
    await page.waitForFunction(({selector, original}) => document.querySelector(selector).className !== original, {selector: '#toggle-cache-btn', original});
    assert.notEqual(await button.getAttribute('class'), original);
    await page.locator('#toolbar-more-menu > summary').click();
    await button.click();
    await page.waitForFunction(({selector, original}) => document.querySelector(selector).className === original, {selector: '#toggle-cache-btn', original});
    assert.equal(await button.getAttribute('class'), original);
  });

  test('finds unloaded tabs by title and website in both layouts without loading them', async () => {
    await page.evaluate(() => {
      for (const [title, url] of [['Orbit release', 'https://github.com/searchrome/orbit'], ['Notes', 'https://example.org']]) {
        const id = window.tabManager.createTab(url, {title, activate: false, deferLoad: true});
        window.tabManager.setTabGroup(id, 'Later');
      }
      window.tabManager.toggleTabGroup('Later');
    });
    await page.getByRole('button', {name: 'Search tabs', exact: true}).click();
    await page.locator('#tab-search-input').fill('github release');
    assert.equal(await page.locator('.tab:visible').count(), 1);
    assert.equal(await page.locator('.tab:visible .tab-title').textContent(), 'Orbit release');
    const unloaded = await page.evaluate(() => window.tabManager.tabs.filter(tab => tab.group === 'Later').every(tab => tab.webview === null));
    assert.equal(unloaded, true);
    await page.locator('#tab-layout-btn').click();
    const search = await page.locator('#tab-search').boundingBox();
    const tabs = await page.locator('#tab-bar').boundingBox();
    assert.ok(search.y + search.height <= tabs.y);
    await page.locator('#tab-search-input').press('Escape');
    await page.locator('#tab-layout-btn').click();
  });

  test('renames and restores the last session after a clean desktop restart', async () => {
    await page.getByRole('button', {name: 'New tab', exact: true}).click();
    await page.evaluate(() => window.tabManager.setTabGroup(window.tabManager.activeTabId, 'Work'));
    await page.getByRole('button', {name: 'Sessions', exact: true}).click();
    await page.locator('#session-name').fill('Persistent workspace');
    await page.getByRole('button', {name: 'Rename', exact: true}).click();
    try {
      await page.waitForFunction(() => window.workspacePanel.currentSession.name === 'Persistent workspace');
    } catch (error) {
      console.error(await page.evaluate(() => ({current: window.workspacePanel.currentSession.name, input: document.getElementById('session-name').value, status: document.getElementById('workspace-status').textContent, saving: window.workspacePanel.saveState})));
      throw error;
    }
    const id = await page.evaluate(async () => {
      await window.workspacePanel.autosave();
      return window.workspacePanel.currentSession.id;
    });
    await app.close();
    app = null;
    await launch();
    const restored = await page.evaluate(() => ({id: window.workspacePanel.currentSession.id, name: window.workspacePanel.currentSession.name, tabs: window.tabManager.getSessionSnapshot().tabs}));
    assert.equal(restored.id, id);
    assert.equal(restored.name, 'Persistent workspace');
    assert.equal(restored.tabs.length, 2);
    assert.equal(restored.tabs[1].group, 'Work');
  });
});
