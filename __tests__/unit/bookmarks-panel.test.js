const fs = require('node:fs');
const path = require('node:path');

function loadBookmarksPanel() {
  const source = fs.readFileSync(path.join(__dirname, '../../bookmarks-panel.js'), 'utf8');
  const transformed = source.replace('export default class BookmarksPanel', 'class BookmarksPanel').concat('\nmodule.exports = BookmarksPanel;\n');
  const module = { exports: {} };
  new Function('module', 'exports', transformed)(module, module.exports);
  return module.exports;
}

describe('BookmarksPanel', () => {
  let panel;
  let tabManager;

  beforeEach(() => {
    document.getElementById = Document.prototype.getElementById.bind(document);
    document.createElement = Document.prototype.createElement.bind(document);
    document.body.innerHTML = `
      <button id="bookmarks-btn"></button>
      <aside id="bookmarks-panel" hidden>
        <button id="bookmarks-close-btn"></button>
        <button id="bookmarks-refresh-btn"></button>
        <div id="bookmarks-status"></div>
        <form id="bookmarks-search-form"><input id="bookmarks-search-input"><button id="bookmarks-search-btn"></button></form>
        <div id="bookmarks-list"></div>
      </aside>
    `;
    window.electronAPI = { invoke: jest.fn() };
    tabManager = { createTab: jest.fn() };
    const historyManager = {
      getHistory: jest.fn(() => [
        { url: 'https://example.com/article', title: 'Example article', bookmarked: true, lastOpened: 1_700_000_000_000 },
        { url: 'https://example.com/not-saved', title: 'Not saved', bookmarked: false, lastOpened: 1_700_000_000_001 }
      ])
    };
    const BookmarksPanel = loadBookmarksPanel();
    panel = new BookmarksPanel({ historyManager, tabManager });
  });

  test('lists only saved pages and opens the chosen bookmark in a new tab', async () => {
    await panel.show();

    expect(document.getElementById('bookmarks-list').textContent).toContain('Example article');
    expect(document.getElementById('bookmarks-list').textContent).not.toContain('Not saved');
    document.querySelector('[data-bookmark-url="https://example.com/article"]').click();

    expect(tabManager.createTab).toHaveBeenCalledWith('https://example.com/article');
    expect(document.getElementById('bookmarks-panel').hidden).toBe(true);
  });

  test('uses AI search results and shows why a saved page matched', async () => {
    window.electronAPI.invoke.mockResolvedValue({
      searchedCount: 4,
      matches: [{
        url: 'https://example.com/article',
        title: 'Example article',
        lastOpened: 1_700_000_000_000,
        bookmarkDefinition: 'An introduction to reliable browser automation.',
        reason: 'It explains the browser automation approach you asked about.'
      }]
    });
    document.getElementById('bookmarks-search-input').value = 'browser automation';

    await panel.search();

    expect(window.electronAPI.invoke).toHaveBeenCalledWith('bookmark-search', { query: 'browser automation' });
    expect(document.getElementById('bookmarks-list').textContent).toContain('reliable browser automation');
    expect(document.getElementById('bookmarks-list').textContent).toContain('explains the browser automation approach');
  });
});
