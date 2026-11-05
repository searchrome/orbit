// Import Jest DOM extensions for DOM element assertions
require('@testing-library/jest-dom');

// Mock Electron
jest.mock('electron', () => {
  const mockIpcMain = {
    on: jest.fn(),
    once: jest.fn(),
    handle: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn()
  };

  const mockIpcRenderer = {
    on: jest.fn(),
    once: jest.fn(),
    send: jest.fn(),
    sendSync: jest.fn(),
    sendToHost: jest.fn(),
    invoke: jest.fn(),
    removeListener: jest.fn(),
    removeAllListeners: jest.fn()
  };

  const mockWebContents = {
    on: jest.fn(),
    send: jest.fn(),
    openDevTools: jest.fn(),
    closeDevTools: jest.fn()
  };

  const mockBrowserWindow = jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    once: jest.fn(),
    webContents: mockWebContents,
    loadURL: jest.fn(),
    loadFile: jest.fn(),
    show: jest.fn(),
    close: jest.fn(),
    destroy: jest.fn(),
    isDestroyed: jest.fn().mockReturnValue(false),
    isVisible: jest.fn().mockReturnValue(true),
    isFocused: jest.fn().mockReturnValue(true),
    focus: jest.fn(),
    maximize: jest.fn(),
    unmaximize: jest.fn(),
    isMaximized: jest.fn().mockReturnValue(false),
    minimize: jest.fn(),
    restore: jest.fn(),
    isMinimized: jest.fn().mockReturnValue(false),
    setFullScreen: jest.fn(),
    isFullScreen: jest.fn().mockReturnValue(false),
    getBounds: jest.fn().mockReturnValue({ x: 0, y: 0, width: 800, height: 600 }),
    setBounds: jest.fn()
  }));

  const mockSession = {
    defaultSession: {
      webRequest: {
        onBeforeRequest: jest.fn(),
        onHeadersReceived: jest.fn()
      },
      clearCache: jest.fn().mockResolvedValue(undefined),
      clearStorageData: jest.fn().mockResolvedValue(undefined)
    }
  };

  return {
    app: {
      on: jest.fn(),
      once: jest.fn(),
      whenReady: jest.fn().mockResolvedValue({}),
      quit: jest.fn(),
      exit: jest.fn(),
      getPath: jest.fn().mockReturnValue('/mock/path')
    },
    BrowserWindow: mockBrowserWindow,
    ipcMain: mockIpcMain,
    ipcRenderer: mockIpcRenderer,
    session: mockSession,
    webContents: {
      fromId: jest.fn().mockImplementation((id) => {
        if (id === undefined) return null;
        return {
          id,
          executeJavaScript: jest.fn().mockResolvedValue(''),
          getURL: jest.fn().mockReturnValue('https://example.com')
        };
      })
    },
    contextBridge: {
      exposeInMainWorld: jest.fn()
    }
  };
});

// Mock the fs.promises module
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readFile: jest.fn().mockResolvedValue('mock file content'),
      writeFile: jest.fn().mockResolvedValue(undefined)
    }
  };
});

// Mock the path module
jest.mock('path', () => {
  const actual = jest.requireActual('path');
  return {
    ...actual,
    join: jest.fn((...args) => args.join('/')),
    resolve: jest.fn((...args) => args.join('/')),
    dirname: jest.fn((path) => path.split('/').slice(0, -1).join('/'))
  };
});

// Mock the axios module
jest.mock('axios', () => {
  return {
    get: jest.fn().mockResolvedValue({ data: {} }),
    post: jest.fn().mockResolvedValue({ data: {} }),
    create: jest.fn().mockReturnValue({
      get: jest.fn().mockResolvedValue({ data: {} }),
      post: jest.fn().mockResolvedValue({ data: {} })
    }),
    isAxiosError: jest.fn().mockReturnValue(true)
  };
});

// Mock the cheerio module
jest.mock('cheerio', () => {
  return {
    load: jest.fn().mockReturnValue({
      $: jest.fn(),
      first: jest.fn().mockReturnThis(),
      attr: jest.fn().mockReturnValue('https://example.com')
    })
  };
});

// Mock the jsdom module
jest.mock('jsdom', () => {
  return {
    JSDOM: jest.fn().mockImplementation(() => {
      return {
        window: {
          document: {
            querySelector: jest.fn().mockReturnValue({
              innerHTML: 'mock content',
              querySelectorAll: jest.fn().mockReturnValue([]),
              getAttribute: jest.fn().mockReturnValue(''),
              remove: jest.fn(),
              parentNode: {
                replaceChild: jest.fn()
              }
            }),
            createElement: jest.fn().mockReturnValue({
              appendChild: jest.fn(),
              setAttribute: jest.fn(),
              style: {}
            }),
            createTextNode: jest.fn().mockReturnValue({})
          }
        }
      };
    })
  };
});

// Mock the @google/generative-ai module
jest.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => {
      return {
        getGenerativeModel: jest.fn().mockReturnValue({
          generateContent: jest.fn().mockResolvedValue({
            response: {
              text: jest.fn().mockReturnValue('Mock Gemini response')
            }
          })
        })
      };
    })
  };
});

// Set up global mocks for DOM elements that might be used in tests
global.document.getElementById = jest.fn().mockImplementation((id) => {
  if (id === 'tab-bar' || id === 'content' || id === 'new-tab-btn' || id === 'test-webview' || id === 'summarize-btn' || id === 'toggle-network-btn' || id === 'search-results-panel' || id === 'search-panel-close-btn' || id === 'url-input' || id === 'assistant-btn') {
    return {
      appendChild: jest.fn(),
      insertBefore: jest.fn(),
      querySelector: jest.fn(),
      querySelectorAll: jest.fn().mockReturnValue([]),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      classList: {
        add: jest.fn(),
        remove: jest.fn(),
        contains: jest.fn()
      },
      style: {}
    };
  }
  return null;
});

// Mock createElement for webview
global.document.createElement = jest.fn().mockImplementation((tag) => {
  if (tag === 'webview') {
    return {
      id: '',
      className: '',
      setAttribute: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      executeJavaScript: jest.fn().mockResolvedValue(''),
      loadURL: jest.fn(),
      send: jest.fn(),
      reload: jest.fn(),
      goBack: jest.fn(),
      canGoBack: jest.fn().mockReturnValue(false),
      isLoading: jest.fn().mockReturnValue(false),
      getWebContentsId: jest.fn().mockReturnValue(1),
      style: {},
      remove: jest.fn()
    };
  }
  return {
    id: '',
    className: '',
    innerHTML: '',
    appendChild: jest.fn(),
    addEventListener: jest.fn(),
    setAttribute: jest.fn(),
    style: {},
    remove: jest.fn()
  };
});

// Set up console mocks to avoid cluttering test output
global.console = {
  ...console,
  log: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
};

// Set up a mock for CustomEvent
global.CustomEvent = class CustomEvent {
  constructor(event, options) {
    this.type = event;
    this.detail = options?.detail || {};
  }
};

// Set up a mock for window.electronAPI
global.window = {
  ...global.window,
  electronAPI: {
    send: jest.fn(),
    on: jest.fn(),
    invoke: jest.fn().mockResolvedValue({
      javascriptDisabled: false,
      cacheEnabled: true,
      domainBlockingEnabled: true
    }),
    sendToHost: jest.fn()
  },
  addEventListener: jest.fn(),
  removeEventListener: jest.fn(),
  dispatchEvent: jest.fn()
};
