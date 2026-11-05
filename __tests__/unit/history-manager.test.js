describe('HistoryManager', () => {
  let HistoryManager;

  beforeEach(() => {
    window.electronAPI = {
      send: jest.fn(),
      invoke: jest.fn().mockResolvedValue([])
    };
    HistoryManager = require('../../history-manager.js');
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  test('preserves custom schemes and bookmark state when adding entries', async () => {
    const historyManager = new HistoryManager();
    await historyManager.loadHistory();

    await historyManager.addOrUpdateEntry('browser://assistant', 'AI Workspace', 'open', null, true);

    expect(historyManager.getHistory()).toHaveLength(1);
    expect(historyManager.getHistory()[0].url).toBe('browser://assistant');
    expect(historyManager.getHistory()[0].bookmarked).toBe(true);
    expect(historyManager.isBookmarked('browser://assistant')).toBe(true);
  });

  test('deduplicates the assistant workspace route correctly', async () => {
    const historyManager = new HistoryManager();
    await historyManager.loadHistory();

    await historyManager.addOrUpdateEntry('browser://assistant', 'AI Workspace', 'open');
    await historyManager.addOrUpdateEntry('browser://assistant', 'AI Workspace', 'closed');

    expect(historyManager.getHistory()).toHaveLength(1);
    expect(historyManager.getHistory()[0].state).toBe('closed');
  });
});
