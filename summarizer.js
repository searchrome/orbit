class Summarizer {
    constructor(webviewElement, summarizeButton) {
        this.webview = webviewElement;
        this.summarizeButton = summarizeButton;
        this.summaryDiv = null; // To hold the injected div element
        
        // Bind the handler function ONCE and store the reference
        this.boundHandleClick = this.handleSummarizeClick.bind(this);

        // Remove any existing click listeners (using the potentially incorrect old reference, just in case)
        // Note: This might not remove listeners added with previous incorrect bindings,
        // but subsequent updates will use the correct bound reference.
        this.summarizeButton.removeEventListener('click', this.handleSummarizeClick); // Attempt removal with unbound ref
        // Ensure no listeners using the *correct* bound reference exist before adding
        this.summarizeButton.removeEventListener('click', this.boundHandleClick); 
        
        // Add the listener using the stored bound reference
        this.summarizeButton.addEventListener('click', this.boundHandleClick);
    }

    // Update the webview reference (used when switching tabs)
    updateWebview(webviewElement) {
        if (!webviewElement) {
            console.error('Cannot update summarizer: webview element is null');
            return;
        }
        
        // Store the new webview reference
        this.webview = webviewElement;
        
        // Remove the listener using the stored bound reference
        this.summarizeButton.removeEventListener('click', this.boundHandleClick);
        
        // Re-add the listener using the stored bound reference
        this.summarizeButton.addEventListener('click', this.boundHandleClick);
        
        console.log('Summarizer webview reference updated and event listeners rebound correctly');
    }

    async handleSummarizeClick() {
        console.log('Summarize button clicked');
        this.showLoadingState();
        
        // Get the active webview from TabManager if available
        let activeWebview = null;
        if (window.tabManager && typeof window.tabManager.getActiveWebview === 'function') {
            activeWebview = window.tabManager.getActiveWebview();
            console.log('Got active webview from tabManager:', activeWebview ? 'found' : 'not found');
        }

        // Fallback to this.webview if tabManager didn't provide one
        if (!activeWebview) {
            activeWebview = this.webview;
            console.log('Using fallback webview reference');
        }

        if (!activeWebview) {
            console.error('Webview element not available.');
            this.displayResults('<p>Error: Could not find the active page.</p>');
            return;
        }

        const currentUrl = activeWebview.getURL();
        console.log('Current URL for summarization:', currentUrl);

        // YouTube URL Regex (handles www. and non-www.)
        const youtubeRegex = /^https?:\/\/(?:www\.)?youtube\.com\/watch\?v=([\w-]+)/;
        const youtubeMatch = currentUrl.match(youtubeRegex);

        try {
            if (youtubeMatch && youtubeMatch[1]) {
                // --- YouTube Video Summarization ---
                const videoId = youtubeMatch[1];
                console.log(`Detected YouTube video ID: ${videoId}`);
                // this.displayResults('<p>Fetching YouTube transcript...</p>'); // Removed temporary message

                // Call the IPC handler in main.js via preload.js
                const result = await window.electronAPI.handleGetTranscript(videoId);

                if (result.error) {
                    console.error('Error fetching transcript:', result.error);
                    // Display error in the main UI panel via renderer.js
                    window.electronAPI.send('summary-result', `<p>Error fetching transcript: ${result.error}</p>`);
                } else if (result.transcript) {
                    console.log(`Transcript fetched (length: ${result.transcript.length}). Sending for summarization...`);
                    // this.displayResults('<p>Summarizing transcript...</p>'); // Removed temporary message
                    // Send the transcript content for summarization using the existing channel
                    window.electronAPI.send('summarize-content', result.transcript);
                } else {
                    console.error('Received unexpected result from handleGetTranscript:', result);
                     // Display error in the main UI panel via renderer.js
                    window.electronAPI.send('summary-result', '<p>Error: Failed to get transcript data.</p>');
                }

            } else {
                // --- Standard Page Summarization ---
                console.log('Not a YouTube video URL. Proceeding with standard page summarization.');
                // this.displayResults('<p>Extracting page content...</p>'); // Removed temporary message

                // Get the main text content of the page from the webview
                const pageContent = await activeWebview.executeJavaScript('document.body.innerText');
                console.log('Extracted page content length:', pageContent?.length);

                if (!pageContent || pageContent.trim().length === 0) {
                    console.warn('Could not get page content or content is empty.');
                     // Display error in the main UI panel via renderer.js
                    window.electronAPI.send('summary-result', '<p>Could not extract content from the page to summarize.</p>');
                    return;
                }

                // Send the content to the main process to perform the summary
                window.electronAPI.send('summarize-content', pageContent);
                console.log('Sent summarize-content request for standard page.');
                // this.displayResults('<p>Requesting summary from Gemini...</p>'); // Removed temporary message
            }

            // The summary (either from transcript or page content) will be received
            // via the 'summary-result' IPC listener in renderer.js, which now updates the summary panel.

        } catch (error) {
            console.error('Error during summarize process:', error);
             // Display error in the main UI panel via renderer.js
            window.electronAPI.send('summary-result', `<p>An error occurred: ${error.message}</p>`);
        }
    }

    showLoadingState() {
        const panel = document.getElementById('summary-panel');
        const content = document.getElementById('summary-content');
        if (!panel || !content) return;

        content.innerHTML = `
            <div class="summary-loading" role="status" aria-live="polite">
                <span class="summary-loading__dots" aria-hidden="true"><i></i><i></i><i></i></span>
                <div>
                    <strong>Preparing your summary</strong>
                    <p>Reading the page and asking OpenRouter…</p>
                </div>
            </div>
        `;
        panel.dataset.state = 'loading';
        panel.classList.remove('hidden');
    }

    // REMOVED displayResults method as it's now handled in renderer.js

    // REMOVED removeSummaryDiv method as it's no longer needed
}

// Export the class if using modules (optional, depends on renderer.js setup)
// export default Summarizer; // Uncomment if renderer.js uses import
export default Summarizer;
