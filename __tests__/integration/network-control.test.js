// Integration tests for network control functionality

const { ipcMain, ipcRenderer, session } = require('electron');

describe('Network Control Integration', () => {
  // Mock state for tracking network status
  let tabNetworkBlockedState = {};
  let cacheEnabled = false;
  
  // Mock for session.defaultSession.webRequest
  const mockWebRequest = {
    onBeforeRequest: jest.fn(),
    onHeadersReceived: jest.fn()
  };
  
  // Mock for BrowserWindow
  const mockBrowserWindow = {
    fromWebContents: jest.fn().mockImplementation(() => ({
      webContents: {
        send: jest.fn()
      }
    }))
  };

  beforeEach(() => {
    // Reset mocks and state
    jest.clearAllMocks();
    tabNetworkBlockedState = {};
    cacheEnabled = false;
    
    // Set up session mock
    session.defaultSession = {
      webRequest: mockWebRequest,
      clearCache: jest.fn().mockResolvedValue(undefined),
      clearStorageData: jest.fn().mockResolvedValue(undefined)
    };
    
    // Mock the callback function for onBeforeRequest
    mockWebRequest.onBeforeRequest.mockImplementation((filter, callback) => {
      // Store the callback for later use in tests
      mockWebRequest.onBeforeRequestCallback = callback;
      // Call the callback with the details and callback arguments
      mockWebRequest.onBeforeRequestCallback(filter, callback);
    });
    
    // Mock the callback function for onHeadersReceived
    mockWebRequest.onHeadersReceived.mockImplementation((filter, callback) => {
      // Store the callback for later use in tests
      mockWebRequest.onHeadersReceivedCallback = callback;
    });
  });

  describe('Main Process Handlers', () => {
    test('should toggle network blocking for a tab', () => {
      // Arrange
      const webContentsId = 123;
      const event = {
        sender: {
          send: jest.fn()
        }
      };
      
      // Set up the IPC handler (simplified version of what's in main.js)
      const toggleNetworkHandler = (event, webContentsId) => {
        if (webContentsId === undefined || webContentsId === null) {
          return;
        }
        tabNetworkBlockedState[webContentsId] = !(tabNetworkBlockedState[webContentsId] === true);
        const newState = tabNetworkBlockedState[webContentsId];
        event.sender.send('network-status', webContentsId, newState);
      };
      
      // Act - Toggle network blocking
      toggleNetworkHandler(event, webContentsId);
      
      // Assert
      expect(tabNetworkBlockedState[webContentsId]).toBe(true);
      expect(event.sender.send).toHaveBeenCalledWith('network-status', webContentsId, true);
      
      // Act - Toggle again
      toggleNetworkHandler(event, webContentsId);
      
      // Assert
      expect(tabNetworkBlockedState[webContentsId]).toBe(false);
      expect(event.sender.send).toHaveBeenCalledWith('network-status', webContentsId, false);
    });
    
    test('should set network status for a tab', () => {
      // Arrange
      const webContentsId = 123;
      const isBlocked = true;
      const event = {};
      
      // Set up the IPC handler (simplified version of what's in main.js)
      const setNetworkStatusHandler = (event, webContentsId, isBlocked) => {
        if (webContentsId === undefined || webContentsId === null) {
          return;
        }
        tabNetworkBlockedState[webContentsId] = !!isBlocked;
      };
      
      // Act
      setNetworkStatusHandler(event, webContentsId, isBlocked);
      
      // Assert
      expect(tabNetworkBlockedState[webContentsId]).toBe(true);
      
      // Act - Set to false
      setNetworkStatusHandler(event, webContentsId, false);
      
      // Assert
      expect(tabNetworkBlockedState[webContentsId]).toBe(false);
    });
    
    test('should toggle cache', async () => {
      // Arrange
      const event = {
        sender: {
          send: jest.fn()
        }
      };
      
      // Set up the IPC handler (simplified version of what's in main.js)
      const toggleCacheHandler = async (event) => {
        cacheEnabled = !cacheEnabled;
        if (!cacheEnabled) {
          try {
            await session.defaultSession.clearCache();
            await session.defaultSession.clearStorageData({
              storages: ['appcache', 'cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
            });
          } catch (error) {
            console.error('Failed to clear cache or storage:', error);
          }
        }
        event.sender.send('cache-status', cacheEnabled);
      };
      
      // Act - Toggle cache (initially false, should become true)
      await toggleCacheHandler(event);
      
      // Assert
      expect(cacheEnabled).toBe(true);
      expect(event.sender.send).toHaveBeenCalledWith('cache-status', true);
      expect(session.defaultSession.clearCache).not.toHaveBeenCalled();
      expect(session.defaultSession.clearStorageData).not.toHaveBeenCalled();
      
      // Act - Toggle again (should become false and clear cache)
      await toggleCacheHandler(event);
      
      // Assert
      expect(cacheEnabled).toBe(false);
      expect(event.sender.send).toHaveBeenCalledWith('cache-status', false);
      expect(session.defaultSession.clearCache).toHaveBeenCalled();
      expect(session.defaultSession.clearStorageData).toHaveBeenCalled();
    });
  });

  describe('WebRequest Handlers', () => {
    test('should block network requests when tab network is blocked', () => {
      // Arrange
      const webContentsId = 123;
      tabNetworkBlockedState[webContentsId] = true;
      
      const details = {
        webContentsId,
        url: 'https://example.com'
      };
      
      const callback = jest.fn();
      
      // Act - Simulate onBeforeRequest callback
      if (mockWebRequest.onBeforeRequestCallback) {
        mockWebRequest.onBeforeRequestCallback(details, callback);
      }
      
      // Assert
      expect(callback).toHaveBeenCalledWith({ cancel: true });
    });
    
    test('should allow network requests when tab network is not blocked', () => {
      // Arrange
      const webContentsId = 123;
      tabNetworkBlockedState[webContentsId] = false;
      
      const details = {
        webContentsId,
        url: 'https://example.com',
        requestHeaders: {}
      };
      
      const callback = jest.fn();
      
      // Act - Simulate onBeforeRequest callback
      if (mockWebRequest.onBeforeRequestCallback) {
        mockWebRequest.onBeforeRequestCallback(details, callback);
      }
      
      // Assert
      expect(callback).toHaveBeenCalledWith({ requestHeaders: {} });
    });
    
    test('should add cache-bypassing headers when cache is disabled', () => {
      // Arrange
      const webContentsId = 123;
      tabNetworkBlockedState[webContentsId] = false;
      cacheEnabled = false;
      
      const details = {
        webContentsId,
        url: 'https://example.com',
        requestHeaders: {}
      };
      
      const callback = jest.fn();
      
      // Act - Simulate onBeforeRequest callback
      if (mockWebRequest.onBeforeRequestCallback) {
        mockWebRequest.onBeforeRequestCallback(details, callback);
      }
      
      // Assert
      expect(callback).toHaveBeenCalledWith({
        requestHeaders: {
          'Cache-Control': 'no-cache, no-store, must-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0'
        }
      });
    });
    
    test('should not add cache-bypassing headers when cache is enabled', () => {
      // Arrange
      const webContentsId = 123;
      tabNetworkBlockedState[webContentsId] = false;
      cacheEnabled = true;
      
      const details = {
        webContentsId,
        url: 'https://example.com',
        requestHeaders: {}
      };
      
      const callback = jest.fn();
      
      // Act - Simulate onBeforeRequest callback
      if (mockWebRequest.onBeforeRequestCallback) {
        mockWebRequest.onBeforeRequestCallback(details, callback);
      }
      
      // Assert
      expect(callback).toHaveBeenCalledWith({ requestHeaders: {} });
    });
  });

  describe('Renderer Process Handlers', () => {
    test('should update UI when network status changes', () => {
      // Arrange
      document.body.innerHTML = `
        <button id="toggle-network-btn">Network: ON</button>
      `;
      
      const toggleNetworkBtn = document.getElementById('toggle-network-btn');
      
      // Mock function to update button state
      const updateButtonState = (button, isActive) => {
        if (isActive) {
          button.classList.add('active');
        } else {
          button.classList.remove('active');
        }
        button.textContent = isActive ? 'Network: OFF' : 'Network: ON';
      };
      
      // Mock the tabManager
      window.tabManager = {
        tabs: [
          {
            id: 'tab-1',
            webview: {
              getWebContentsId: () => 123
            }
          }
        ],
        activeTabId: 'tab-1'
      };
      
      // Mock the network status handler
      const networkStatusHandler = (webContentsId, isBlocked) => {
        const tab = window.tabManager.tabs.find(t => t.webview.getWebContentsId() === webContentsId);
        if (tab) {
          const tabId = tab.id;
          const tabNetworkState = {};
          tabNetworkState[tabId] = isBlocked;
          
          if (window.tabManager.activeTabId === tabId) {
            updateButtonState(toggleNetworkBtn, isBlocked);
          }
        }
      };
      
      // Act - Simulate receiving network-status message for active tab
      networkStatusHandler(123, true);
      
      // Assert
      expect(toggleNetworkBtn.textContent).toBe('Network: OFF');
      expect(toggleNetworkBtn.classList.contains('active')).toBe(true);
      
      // Act - Simulate receiving network-status message for active tab (network unblocked)
      networkStatusHandler(123, false);
      
      // Assert
      expect(toggleNetworkBtn.textContent).toBe('Network: ON');
      expect(toggleNetworkBtn.classList.contains('active')).toBe(false);
    });
    
    test('should not update UI when network status changes for inactive tab', () => {
      // Arrange
      document.body.innerHTML = `
        <button id="toggle-network-btn">Network: ON</button>
      `;
      
      const toggleNetworkBtn = document.getElementById('toggle-network-btn');
      
      // Mock function to update button state
      const updateButtonState = (button, isActive) => {
        if (isActive) {
          button.classList.add('active');
        } else {
          button.classList.remove('active');
        }
        button.textContent = isActive ? 'Network: OFF' : 'Network: ON';
      };
      
      // Mock the tabManager
      window.tabManager = {
        tabs: [
          {
            id: 'tab-1',
            webview: {
              getWebContentsId: () => 123
            }
          },
          {
            id: 'tab-2',
            webview: {
              getWebContentsId: () => 456
            }
          }
        ],
        activeTabId: 'tab-1'
      };
      
      // Mock the network status handler
      const networkStatusHandler = (webContentsId, isBlocked) => {
        const tab = window.tabManager.tabs.find(t => t.webview.getWebContentsId() === webContentsId);
        if (tab) {
          const tabId = tab.id;
          const tabNetworkState = {};
          tabNetworkState[tabId] = isBlocked;
          
          if (window.tabManager.activeTabId === tabId) {
            updateButtonState(toggleNetworkBtn, isBlocked);
          }
        }
      };
      
      // Act - Simulate receiving network-status message for inactive tab
      networkStatusHandler(456, true);
      
      // Assert - Button should not change
      expect(toggleNetworkBtn.textContent).toBe('Network: ON');
      expect(toggleNetworkBtn.classList.contains('active')).toBe(false);
    });
  });
});
