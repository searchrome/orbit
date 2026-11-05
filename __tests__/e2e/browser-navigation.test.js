// End-to-end tests for browser navigation

const { Application } = require('spectron');
const path = require('path');
const electron = require('electron');

describe('Browser Navigation E2E', () => {
  let app;
  const appPath = path.join(__dirname, '../../main.js');

  // Start the app before each test
  beforeEach(async () => {
    app = new Application({
      path: electron,
      args: [appPath],
      startTimeout: 10000,
      waitTimeout: 10000
    });

    return app.start();
  });

  // Stop the app after each test
  afterEach(async () => {
    if (app && app.isRunning()) {
      return app.stop();
    }
  });

  test('should launch the app and show initial tab', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Check if the window is visible
    const isVisible = await app.browserWindow.isVisible();
    expect(isVisible).toBe(true);
    
    // Check if the title is correct
    const title = await app.client.getTitle();
    expect(title).toBe('Simple Electron Browser');
    
    // Check if there's a tab
    const tabCount = await app.client.$$('.tab').then(tabs => tabs.length);
    expect(tabCount).toBe(1);
    
    // Check if there's a webview
    const webviewCount = await app.client.$$('webview').then(webviews => webviews.length);
    expect(webviewCount).toBe(1);
  });

  test('should navigate to a URL', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Type a URL in the URL input
    await app.client.$('#url-input').then(input => input.setValue('https://example.com'));
    
    // Press Enter to navigate
    await app.client.$('#url-input').then(input => input.keys(['Enter']));
    
    // Wait for the navigation to complete (this is a simplified approach)
    await app.client.pause(1000);
    
    // Check if the URL input shows the correct URL
    const inputValue = await app.client.$('#url-input').then(input => input.getValue());
    expect(inputValue).toBe('https://example.com');
    
    // Check if the webview has the correct src attribute
    const webviewSrc = await app.client.$('webview').then(webview => webview.getAttribute('src'));
    expect(webviewSrc).toBe('https://example.com/');
  });

  test('should create a new tab', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Click the new tab button
    await app.client.$('#new-tab-btn').then(button => button.click());
    
    // Check if there are now two tabs
    const tabCount = await app.client.$$('.tab').then(tabs => tabs.length);
    expect(tabCount).toBe(2);
    
    // Check if there are now two webviews
    const webviewCount = await app.client.$$('webview').then(webviews => webviews.length);
    expect(webviewCount).toBe(2);
    
    // Check if the second tab is active
    const isSecondTabActive = await app.client.$$('.tab')[1].then(tab => tab.getAttribute('class')).then(classes => classes.includes('active'));
    expect(isSecondTabActive).toBe(true);
  });

  test('should switch between tabs', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Create a second tab
    await app.client.$('#new-tab-btn').then(button => button.click());
    
    // Navigate to a URL in the second tab
    await app.client.$('#url-input').then(input => input.setValue('https://example.org'));
    await app.client.$('#url-input').then(input => input.keys(['Enter']));
    
    // Wait for the navigation to complete
    await app.client.pause(1000);
    
    // Click on the first tab
    await app.client.$$('.tab')[0].then(tab => tab.click());
    
    // Check if the first tab is now active
    const isFirstTabActive = await app.client.$$('.tab')[0].then(tab => tab.getAttribute('class')).then(classes => classes.includes('active'));
    expect(isFirstTabActive).toBe(true);
    
    // Check if the URL input shows the URL of the first tab (about:blank)
    const inputValue = await app.client.$('#url-input').then(input => input.getValue());
    expect(inputValue).toBe('about:blank');
    
    // Click on the second tab
    await app.client.$$('.tab')[1].then(tab => tab.click());
    
    // Check if the second tab is now active
    const isSecondTabActive = await app.client.$$('.tab')[1].then(tab => tab.getAttribute('class')).then(classes => classes.includes('active'));
    expect(isSecondTabActive).toBe(true);
    
    // Check if the URL input shows the URL of the second tab
    const inputValue2 = await app.client.$('#url-input').then(input => input.getValue());
    expect(inputValue2).toBe('https://example.org');
  });

  test('should close a tab', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Create a second tab
    await app.client.$('#new-tab-btn').then(button => button.click());
    
    // Check if there are two tabs
    const initialTabCount = await app.client.$$('.tab').then(tabs => tabs.length);
    expect(initialTabCount).toBe(2);
    
    // Click the close button on the second tab
    await app.client.$$('.tab-close-btn')[1].then(button => button.click());
    
    // Check if there is now only one tab
    const finalTabCount = await app.client.$$('.tab').then(tabs => tabs.length);
    expect(finalTabCount).toBe(1);
    
    // Check if the first tab is active
    const isFirstTabActive = await app.client.$$('.tab')[0].then(tab => tab.getAttribute('class')).then(classes => classes.includes('active'));
    expect(isFirstTabActive).toBe(true);
  });

  test('should toggle network blocking', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Check the initial state of the network button
    const initialButtonText = await app.client.$('#toggle-network-btn').then(button => button.getText());
    expect(initialButtonText).toBe('Network: ON');
    
    // Click the network toggle button
    await app.client.$('#toggle-network-btn').then(button => button.click());
    
    // Check if the button text changed
    const updatedButtonText = await app.client.$('#toggle-network-btn').then(button => button.getText());
    expect(updatedButtonText).toBe('Network: OFF');
    
    // Check if the button has the 'active' class
    const hasActiveClass = await app.client.$('#toggle-network-btn').then(button => button.getAttribute('class')).then(classes => classes.includes('active'));
    expect(hasActiveClass).toBe(true);
    
    // Click the button again to toggle back
    await app.client.$('#toggle-network-btn').then(button => button.click());
    
    // Check if the button text changed back
    const finalButtonText = await app.client.$('#toggle-network-btn').then(button => button.getText());
    expect(finalButtonText).toBe('Network: ON');
    
    // Check if the 'active' class was removed
    const finalHasActiveClass = await app.client.$('#toggle-network-btn').then(button => button.getAttribute('class')).then(classes => classes.includes('active'));
    expect(finalHasActiveClass).toBe(false);
  });

  test('should toggle JavaScript blocking', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Check the initial state of the JS button
    const initialButtonText = await app.client.$('#toggle-js-btn').then(button => button.getText());
    expect(initialButtonText).toBe('JS: ON');
    
    // Click the JS toggle button
    await app.client.$('#toggle-js-btn').then(button => button.click());
    
    // Check if the button text changed
    const updatedButtonText = await app.client.$('#toggle-js-btn').then(button => button.getText());
    expect(updatedButtonText).toBe('JS: OFF');
    
    // Check if the button has the 'active' class
    const hasActiveClass = await app.client.$('#toggle-js-btn').then(button => button.getAttribute('class')).then(classes => classes.includes('active'));
    expect(hasActiveClass).toBe(true);
    
    // Click the button again to toggle back
    await app.client.$('#toggle-js-btn').then(button => button.click());
    
    // Check if the button text changed back
    const finalButtonText = await app.client.$('#toggle-js-btn').then(button => button.getText());
    expect(finalButtonText).toBe('JS: ON');
    
    // Check if the 'active' class was removed
    const finalHasActiveClass = await app.client.$('#toggle-js-btn').then(button => button.getAttribute('class')).then(classes => classes.includes('active'));
    expect(finalHasActiveClass).toBe(false);
  });

  test('should toggle cache', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Check the initial state of the cache button
    const initialButtonText = await app.client.$('#toggle-cache-btn').then(button => button.getText());
    expect(initialButtonText).toBe('Cache: ON');
    
    // Click the cache toggle button
    await app.client.$('#toggle-cache-btn').then(button => button.click());
    
    // Check if the button text changed
    const updatedButtonText = await app.client.$('#toggle-cache-btn').then(button => button.getText());
    expect(updatedButtonText).toBe('Cache: OFF');
    
    // Check if the button has the 'active' class
    const hasActiveClass = await app.client.$('#toggle-cache-btn').then(button => button.getAttribute('class')).then(classes => classes.includes('active'));
    expect(hasActiveClass).toBe(true);
    
    // Click the button again to toggle back
    await app.client.$('#toggle-cache-btn').then(button => button.click());
    
    // Check if the button text changed back
    const finalButtonText = await app.client.$('#toggle-cache-btn').then(button => button.getText());
    expect(finalButtonText).toBe('Cache: ON');
    
    // Check if the 'active' class was removed
    const finalHasActiveClass = await app.client.$('#toggle-cache-btn').then(button => button.getAttribute('class')).then(classes => classes.includes('active'));
    expect(finalHasActiveClass).toBe(false);
  });

  test('should use back button to navigate', async () => {
    // Wait for the app to be ready
    await app.client.waitUntilWindowLoaded();
    
    // Navigate to a URL
    await app.client.$('#url-input').then(input => input.setValue('https://example.com'));
    await app.client.$('#url-input').then(input => input.keys(['Enter']));
    
    // Wait for the navigation to complete
    await app.client.pause(1000);
    
    // Navigate to another URL
    await app.client.$('#url-input').then(input => input.setValue('https://example.org'));
    await app.client.$('#url-input').then(input => input.keys(['Enter']));
    
    // Wait for the navigation to complete
    await app.client.pause(1000);
    
    // Check if the back button is enabled
    const isBackButtonEnabled = await app.client.$('#back-btn').then(button => button.isEnabled());
    expect(isBackButtonEnabled).toBe(true);
    
    // Click the back button
    await app.client.$('#back-btn').then(button => button.click());
    
    // Wait for the navigation to complete
    await app.client.pause(1000);
    
    // Check if we navigated back to the first URL
    const inputValue = await app.client.$('#url-input').then(input => input.getValue());
    expect(inputValue).toBe('https://example.com');
  });
});
