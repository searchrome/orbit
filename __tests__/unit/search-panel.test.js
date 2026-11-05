// Unit tests for SearchPanel

describe('SearchPanel', () => {
  let SearchPanel;
  let searchPanel;
  let mockPanelElement;
  let mockCloseButton;
  let mockContentArea;

  // Set up the DOM environment before each test
  beforeEach(() => {
    // Reset the document body
    document.body.innerHTML = `
      <div id="search-results-panel"></div>
      <button id="search-panel-close-btn">×</button>
      <div id="content"></div>
    `;

    // Helper for style object that allows property assignment
    function createStyleMock() {
      return new Proxy({}, {
        get: (target, prop) => target[prop],
        set: (target, prop, value) => { target[prop] = value; return true; }
      });
    }

    // Mock the panel elements and their methods
    mockPanelElement = document.getElementById('search-results-panel');
    mockPanelElement.style = createStyleMock();
    mockPanelElement.appendChild = jest.fn();
    mockPanelElement.removeChild = jest.fn();
    mockPanelElement.classList = { add: jest.fn(), remove: jest.fn(), contains: jest.fn() };
    mockPanelElement.insertBefore = jest.fn();
    mockPanelElement.querySelector = jest.fn();
    mockPanelElement.querySelectorAll = jest.fn();

    mockCloseButton = document.getElementById('search-panel-close-btn');
    mockCloseButton.addEventListener = jest.fn();
    mockCloseButton.removeEventListener = jest.fn();

    mockContentArea = document.getElementById('content');
    mockContentArea.style = createStyleMock();

    // Mock document.createElement to always return a webview mock
    const originalCreateElement = document.createElement;
    global.mockWebview = {
      setAttribute: jest.fn(),
      style: createStyleMock(),
      src: '',
      tagName: 'WEBVIEW'
    };
    document.createElement = jest.fn().mockImplementation((tag) => {
      if (tag === 'webview') {
        // Return a new mock webview each time
        return {
          setAttribute: jest.fn(),
          style: createStyleMock(),
          src: '',
          tagName: 'WEBVIEW'
        };
      }
      return originalCreateElement.call(document, tag);
    });

    // Import the SearchPanel class
    SearchPanel = require('../../search-panel.js');
    
    // Create a new SearchPanel instance
    searchPanel = new SearchPanel();

    // Store for cleanup
    global._originalCreateElement = originalCreateElement;
  });

  // Clean up after each test
  afterEach(() => {
    jest.clearAllMocks();
    // Restore document.createElement
    if (global._originalCreateElement) {
      document.createElement = global._originalCreateElement;
      delete global._originalCreateElement;
    }
  });

  test('should initialize with panel elements', () => {
    // Assert
    expect(searchPanel.panelElement).toBe(mockPanelElement);
    expect(searchPanel.closeButton).toBe(mockCloseButton);
    expect(searchPanel.contentArea).toBe(mockContentArea);
    expect(searchPanel.searchWebview).toBeNull();
    expect(searchPanel.isVisible).toBe(false);
    
    // Check if the click event listener was added to the close button
    expect(mockCloseButton.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  test('should show the panel', () => {
    // Act
    searchPanel.showPanel();
    
    // Assert
    expect(mockPanelElement.style.display).toBe('block');
    expect(mockContentArea.style.marginLeft).toBe('30%');
    expect(mockContentArea.style.width).toBe('70%');
    expect(searchPanel.isVisible).toBe(true);
  });

  test('should hide the panel', () => {
    // Arrange
    // First show the panel
    searchPanel.showPanel();
    
    // Create a mock webview
    const mockWebview = document.createElement('webview');
    searchPanel.searchWebview = mockWebview;
    
    // Act
    searchPanel.hidePanel();
    
    // Assert
    expect(mockPanelElement.style.display).toBe('none');
    expect(mockContentArea.style.marginLeft).toBe('0');
    expect(mockContentArea.style.width).toBe('100%');
    expect(searchPanel.isVisible).toBe(false);
    expect(searchPanel.searchWebview).toBeNull();
    // Check that removeChild was called
    expect(mockPanelElement.removeChild).toHaveBeenCalledWith(mockWebview);
  });

  test('should search for selected text', () => {
    // Arrange
    const selectedText = 'test search query';
    const encodedTerm = encodeURIComponent(selectedText);
    const expectedSearchUrl = `https://duckduckgo.com/?q=${encodedTerm}`;
    
    // Mock document.createElement to track webview creation
    const originalCreateElement = document.createElement;
    const mockWebview = {
      setAttribute: jest.fn(),
      style: {},
      src: ''
    };
    document.createElement = jest.fn().mockImplementation((tag) => {
      if (tag === 'webview') {
        return mockWebview;
      }
      return originalCreateElement.call(document, tag);
    });
    
    // Mock the showPanel method
    const showPanelSpy = jest.spyOn(searchPanel, 'showPanel');
    
    // Act
    searchPanel.search(selectedText);
    
    // Assert
    expect(document.createElement).toHaveBeenCalledWith('webview');
    expect(mockWebview.setAttribute).toHaveBeenCalledWith('nodeintegration', 'false');
    expect(mockWebview.style.width).toBe('100%');
    expect(mockWebview.style.height).toBe('calc(100% - 25px)');
    expect(mockWebview.style.border).toBe('none');
    expect(mockWebview.src).toBe(expectedSearchUrl);
    expect(searchPanel.searchWebview).toBe(mockWebview);
    expect(showPanelSpy).toHaveBeenCalled();
    
    // Restore original createElement
    document.createElement = originalCreateElement;
  });

  test('should not search for empty text', () => {
    // Arrange
    const emptyText = '   ';
    
    // Mock the showPanel method
    const showPanelSpy = jest.spyOn(searchPanel, 'showPanel');
    
    // Act
    searchPanel.search(emptyText);
    
    // Assert
    expect(showPanelSpy).not.toHaveBeenCalled();
    expect(searchPanel.searchWebview).toBeNull();
  });

  test('should replace existing webview when searching again', () => {
    // Arrange
    const firstSearchText = 'first search';
    const secondSearchText = 'second search';
    
    // Create a mock for the first webview
    const firstWebview = document.createElement('webview');
    searchPanel.searchWebview = firstWebview;
    
    // Act - First search (should remove old webview)
    searchPanel.search(secondSearchText);
    
    // Assert
    expect(mockPanelElement.removeChild).toHaveBeenCalledWith(firstWebview);
    expect(searchPanel.searchWebview).not.toBe(firstWebview);
  });

  test('should handle close button click', () => {
    // Arrange
    // Find the click handler
    let clickHandler = null;
    for (const call of mockCloseButton.addEventListener.mock.calls) {
      if (call[0] === 'click') {
        clickHandler = call[1];
        break;
      }
    }
    // Mock the hidePanel method
    const hidePanelSpy = jest.spyOn(searchPanel, 'hidePanel');
    
    // Act
    if (clickHandler) clickHandler();
    
    // Assert
    expect(hidePanelSpy).toHaveBeenCalled();
  });

  test('should handle missing DOM elements gracefully', () => {
    // Arrange
    document.body.innerHTML = ''; // Clear the DOM

    // Mock getElementById to return null
    const originalGetElementById = document.getElementById;
    document.getElementById = jest.fn(() => null);

    // Act
    const newSearchPanel = new SearchPanel();

    // Assert
    expect(newSearchPanel.panelElement).toBeNull();
    expect(newSearchPanel.closeButton).toBeNull();
    expect(newSearchPanel.contentArea).toBeNull();

    // These methods should not throw errors even with null elements
    expect(() => newSearchPanel.showPanel()).not.toThrow();
    expect(() => newSearchPanel.hidePanel()).not.toThrow();
    expect(() => newSearchPanel.search('test')).not.toThrow();

    // Restore original getElementById
    document.getElementById = originalGetElementById;
  });
});
