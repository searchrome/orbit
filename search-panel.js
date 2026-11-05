// search-panel.js - Functionality for the in-page search panel

class SearchPanel {
    constructor() {
        this.panelElement = null;
        this.closeButton = null;
        this.contentArea = null; // The main webview container
        this.searchWebview = null; // The nested webview for results
        this.isVisible = false;

        this._initElements();
        this._attachEventListeners();
    }

    _initElements() {
        // Create panel elements dynamically or assume they exist in index.html
        // For now, assume they will be added to index.html
        this.panelElement = document.getElementById('search-results-panel');
        this.closeButton = document.getElementById('search-panel-close-btn');
        this.contentArea = document.getElementById('content'); // Assumes main content area has id 'content'

        if (!this.panelElement || !this.closeButton || !this.contentArea) {
            console.error("Search Panel elements not found in the DOM!");
            // Potentially create them dynamically here if needed
        }
    }

    _attachEventListeners() {
        if (this.closeButton) {
            this.closeButton.addEventListener('click', () => this.hidePanel());
        }
        // Listener for 'text-selected' will be added in renderer.js
    }

    showPanel() {
        if (!this.panelElement || !this.contentArea) return;

        this.panelElement.style.display = 'block';
        // Adjust main content margin (example: panel is 30% wide)
        this.contentArea.style.marginLeft = '30%';
        this.contentArea.style.width = '70%'; // Adjust width accordingly
        this.isVisible = true;
        console.log('Search panel shown.');
    }

    hidePanel() {
        if (!this.panelElement || !this.contentArea) return;

        this.panelElement.style.display = 'none';
        // Remove nested webview if it exists
        if (this.searchWebview) {
            this.panelElement.removeChild(this.searchWebview);
            this.searchWebview = null;
        }
        // Reset main content margin/width
        this.contentArea.style.marginLeft = '0';
        this.contentArea.style.width = '100%';
        this.isVisible = false;
        console.log('Search panel hidden.');
    }

    search(selectedText) {
        if (!this.panelElement) return;

        const trimmedText = selectedText.trim();
        if (!trimmedText) return;

        console.log(`Search panel received text: ${trimmedText}`);
        const encodedTerm = encodeURIComponent(trimmedText);
        const searchUrl = `https://duckduckgo.com/?q=${encodedTerm}`;

        // Remove existing search webview if present
        if (this.searchWebview) {
            this.panelElement.removeChild(this.searchWebview);
            this.searchWebview = null;
        }

        // Create a new webview for the search results
        this.searchWebview = document.createElement('webview');
        this.searchWebview.setAttribute('nodeintegration', 'false'); // Security
        this.searchWebview.style.width = '100%';
        this.searchWebview.style.height = 'calc(100% - 25px)'; // Adjust height for close button etc.
        this.searchWebview.style.border = 'none';
        this.searchWebview.src = searchUrl;

        // Append the new webview (ensure close button is still accessible)
        this.panelElement.appendChild(this.searchWebview);

        console.log(`Loading search results for "${trimmedText}" from ${searchUrl}`);
        this.showPanel(); // Make sure panel is visible
    }
}

// Instantiate the panel logic (or export the class if using modules)
// Ensure this runs after the DOM is ready, potentially wrap in DOMContentLoaded
// For simplicity now, assume renderer.js will instantiate it.
// const searchPanel = new SearchPanel();

// Export the class if renderer.js will import it (requires module script type)
// export default SearchPanel;
module.exports = SearchPanel; // Add this line for CommonJS compatibility
