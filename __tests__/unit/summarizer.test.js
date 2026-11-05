// Unit tests for Summarizer

describe('Summarizer', () => {
  let Summarizer;
  let summarizer;
  let mockWebview;
  let mockSummarizeButton;

  // Set up the DOM environment before each test
  beforeEach(() => {
    // Reset the document body
    document.body.innerHTML = `
      <div id="content">
        <webview id="test-webview"></webview>
      </div>
      <button id="summarize-btn">Summarize</button>
    `;

    // Mock the webview element
    mockWebview = document.getElementById('test-webview');
    mockWebview.executeJavaScript = jest.fn().mockResolvedValue('Mock page content');
    mockWebview.getWebContentsId = jest.fn().mockReturnValue(1);
    
    // Mock the summarize button
    mockSummarizeButton = document.getElementById('summarize-btn');
    
    // Import the Summarizer class
    // Note: In a real test, you would use ES modules or require
    // Here we're assuming the Summarizer class is globally available
    Summarizer = require('../../summarizer.js');
    
    // Create a new Summarizer instance
    summarizer = new Summarizer(mockWebview, mockSummarizeButton);
    
    // Mock window.electronAPI
    window.electronAPI = {
      send: jest.fn(),
      on: jest.fn(),
      invoke: jest.fn().mockResolvedValue({})
    };

    // Mock window.tabManager
    window.tabManager = {
      getActiveWebview: jest.fn().mockReturnValue(mockWebview),
      getActiveTab: jest.fn().mockReturnValue({
        id: 'tab-1',
        webview: mockWebview
      })
    };
  });

  // Clean up after each test
  afterEach(() => {
    jest.clearAllMocks();
  });

  test('should initialize with webview and button', () => {
    // Assert
    expect(summarizer.webview).toBe(mockWebview);
    expect(summarizer.summarizeButton).toBe(mockSummarizeButton);
    expect(summarizer.summaryDiv).toBeNull();
    
    // Check if the click event listener was added to the button
    expect(mockSummarizeButton.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  test('should update webview reference', () => {
    // Arrange
    const newWebview = document.createElement('webview');
    newWebview.executeJavaScript = jest.fn().mockResolvedValue('New mock content');
    
    // Act
    summarizer.updateWebview(newWebview);
    
    // Assert
    expect(summarizer.webview).toBe(newWebview);
    
    // Check if the click event listener was re-added
    expect(mockSummarizeButton.removeEventListener).toHaveBeenCalled();
    expect(mockSummarizeButton.addEventListener).toHaveBeenCalledWith('click', expect.any(Function));
  });

  test('should handle summarize button click', async () => {
    // Arrange
    const mockPageContent = 'This is the page content to summarize';
    mockWebview.executeJavaScript.mockResolvedValue(mockPageContent);
    
    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];
    
    // Act
    await clickHandler();
    
    // Assert
    expect(mockWebview.executeJavaScript).toHaveBeenCalledWith('document.body.innerText');
    expect(window.electronAPI.send).toHaveBeenCalledWith('summarize-content', mockPageContent);
  });

  test('should handle empty page content', async () => {
    // Arrange
    mockWebview.executeJavaScript.mockResolvedValue('');
    
    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];
    
    // Act
    await clickHandler();
    
    // Assert
    expect(mockWebview.executeJavaScript).toHaveBeenCalledWith('document.body.innerText');
    expect(window.electronAPI.send).not.toHaveBeenCalledWith('summarize-content', expect.any(String));
    
    // Check if displayResults was called with an error message
    // We need to mock the displayResults method
    const displayResultsSpy = jest.spyOn(summarizer, 'displayResults');
    await clickHandler();
    expect(displayResultsSpy).toHaveBeenCalledWith(expect.stringContaining('Could not extract content'));
  });

  test('should display results', () => {
    // Arrange
    const htmlContent = '<p>This is the summary</p>';
    
    // Mock the executeJavaScript method to simulate successful injection
    mockWebview.executeJavaScript.mockResolvedValue(true);
    
    // Act
    summarizer.displayResults(htmlContent);
    
    // Assert
    expect(mockWebview.executeJavaScript).toHaveBeenCalled();
    
    // Check that the executeJavaScript call includes the HTML content
    const executeJSCall = mockWebview.executeJavaScript.mock.calls[0][0];
    expect(executeJSCall).toContain('function');
    expect(executeJSCall).toContain(JSON.stringify(htmlContent));
  });

  test('should remove summary div', () => {
    // Arrange
    const removeScript = `
      (function() {
        try {
          const element = document.getElementById('summary-results-overlay');
          if (element) {
            element.remove();
            console.log('Summary div removed successfully');
          }
          return true;
        } catch (error) {
          console.error('Error removing summary div:', error);
          return false;
        }
      })();
    `;
    
    // Act
    summarizer.removeSummaryDiv();
    
    // Assert
    expect(mockWebview.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('summary-results-overlay'));
  });

  test('should handle errors when getting page content', async () => {
    // Arrange
    mockWebview.executeJavaScript.mockRejectedValue(new Error('Failed to execute JavaScript'));
    
    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];
    
    // Act & Assert
    await expect(clickHandler()).resolves.not.toThrow();
    expect(mockWebview.executeJavaScript).toHaveBeenCalledWith('document.body.innerText');
    expect(window.electronAPI.send).not.toHaveBeenCalled();
  });

  test('should use tabManager to get active webview if available', async () => {
    // Arrange
    const activeWebview = document.createElement('webview');
    activeWebview.executeJavaScript = jest.fn().mockResolvedValue('Active webview content');
    window.tabManager.getActiveWebview.mockReturnValue(activeWebview);
    
    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];
    
    // Act
    await clickHandler();
    
    // Assert
    expect(window.tabManager.getActiveWebview).toHaveBeenCalled();
    expect(activeWebview.executeJavaScript).toHaveBeenCalledWith('document.body.innerText');
    expect(window.electronAPI.send).toHaveBeenCalledWith('summarize-content', 'Active webview content');
  });

  test('should fall back to instance webview if tabManager is not available', async () => {
    // Arrange
    window.tabManager = null;
    
    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];
    
    // Act
    await clickHandler();
    
    // Assert
    expect(mockWebview.executeJavaScript).toHaveBeenCalledWith('document.body.innerText');
    expect(window.electronAPI.send).toHaveBeenCalledWith('summarize-content', 'Mock page content');
  });

  // --- Tests for YouTube Summarization ---

  test('should detect YouTube URL and call handleGetTranscript', async () => {
    // Arrange
    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const videoId = 'dQw4w9WgXcQ';
    mockWebview.getURL = jest.fn().mockReturnValue(youtubeUrl); // Mock getURL
    window.electronAPI.handleGetTranscript = jest.fn().mockResolvedValue({ transcript: 'Mock transcript' }); // Mock IPC call

    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];

    // Act
    await clickHandler();

    // Assert
    expect(mockWebview.getURL).toHaveBeenCalled();
    expect(window.electronAPI.handleGetTranscript).toHaveBeenCalledWith(videoId);
    expect(mockWebview.executeJavaScript).not.toHaveBeenCalledWith('document.body.innerText'); // Should not get page content
    expect(window.electronAPI.send).toHaveBeenCalledWith('summarize-content', 'Mock transcript'); // Should send transcript
  });

  test('should handle non-YouTube URL correctly', async () => {
    // Arrange
    const nonYoutubeUrl = 'https://example.com';
    const mockPageContent = 'Standard page content';
    mockWebview.getURL = jest.fn().mockReturnValue(nonYoutubeUrl); // Mock getURL
    mockWebview.executeJavaScript.mockResolvedValue(mockPageContent);
    window.electronAPI.handleGetTranscript = jest.fn(); // Mock IPC call

    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];

    // Act
    await clickHandler();

    // Assert
    expect(mockWebview.getURL).toHaveBeenCalled();
    expect(window.electronAPI.handleGetTranscript).not.toHaveBeenCalled(); // Should not call transcript handler
    expect(mockWebview.executeJavaScript).toHaveBeenCalledWith('document.body.innerText'); // Should get page content
    expect(window.electronAPI.send).toHaveBeenCalledWith('summarize-content', mockPageContent); // Should send page content
  });

   test('should send error message if handleGetTranscript returns an error', async () => {
    // Arrange
    const youtubeUrl = 'https://www.youtube.com/watch?v=errorVideo';
    const videoId = 'errorVideo';
    const errorMessage = 'Transcript unavailable';
    mockWebview.getURL = jest.fn().mockReturnValue(youtubeUrl); // Mock getURL
    window.electronAPI.handleGetTranscript = jest.fn().mockResolvedValue({ error: errorMessage }); // Mock IPC call returning error

    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];

    // Act
    await clickHandler();

    // Assert
    expect(mockWebview.getURL).toHaveBeenCalled();
    expect(window.electronAPI.handleGetTranscript).toHaveBeenCalledWith(videoId);
    expect(window.electronAPI.send).toHaveBeenCalledWith('summary-result', expect.stringContaining(errorMessage)); // Check if error is sent to display
    expect(window.electronAPI.send).not.toHaveBeenCalledWith('summarize-content', expect.any(String)); // Should not send content for summarization
  });

   test('should send error message if handleGetTranscript rejects', async () => {
    // Arrange
    const youtubeUrl = 'https://www.youtube.com/watch?v=rejectVideo';
    const videoId = 'rejectVideo';
    const rejectionError = new Error('IPC Error');
    mockWebview.getURL = jest.fn().mockReturnValue(youtubeUrl); // Mock getURL
    window.electronAPI.handleGetTranscript = jest.fn().mockRejectedValue(rejectionError); // Mock IPC call rejecting

    // Get the click handler
    const clickHandler = mockSummarizeButton.addEventListener.mock.calls[0][1];

    // Act
    await clickHandler();

    // Assert
    expect(mockWebview.getURL).toHaveBeenCalled();
    expect(window.electronAPI.handleGetTranscript).toHaveBeenCalledWith(videoId);
    expect(window.electronAPI.send).toHaveBeenCalledWith('summary-result', expect.stringContaining(rejectionError.message)); // Check if error is sent to display
    expect(window.electronAPI.send).not.toHaveBeenCalledWith('summarize-content', expect.any(String)); // Should not send content for summarization
  });

});
