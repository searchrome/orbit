# Browser Application Functionality Document

## Overview

This document provides a comprehensive overview of the browser application's architecture, components, and functionality. The application is built using Electron, providing a customizable browsing experience with unique features for content control, summarization, and cleanup.

## Table of Contents

1. [Architecture](#architecture)
2. [Core Components](#core-components)
3. [User Interface](#user-interface)
4. [Tab Management](#tab-management)
5. [Network Control](#network-control)
6. [Content Controls](#content-controls)
7. [AI-Powered Features](#ai-powered-features)
8. [Search Functionality](#search-functionality)
9. [Security Features](#security-features)
10. [Performance Considerations](#performance-considerations)
11. [Future Enhancements](#future-enhancements)

## Architecture

The application follows Electron's main-renderer architecture pattern:

### Main Process (main.js)
- Entry point for the Electron application
- Manages application lifecycle
- Handles IPC (Inter-Process Communication) with renderer processes
- Controls browser window creation and management
- Implements network request monitoring and filtering
- Integrates with external services (Gemini AI)

### Renderer Process (renderer.js)
- Manages the browser UI
- Handles user interactions
- Communicates with the main process via IPC
- Controls webview instances for content display

### Preload Script (preload.js)
- Securely bridges the renderer process and Electron APIs
- Provides a controlled API surface for webview content
- Implements security measures via contextBridge

## Core Components

### TabManager (tab-manager.js)
- Creates and manages browser tabs
- Handles tab switching, closing, and state management
- Manages webview instances for each tab
- Tracks tab metadata (title, URL, favicon)

### Summarizer (summarizer.js)
- Extracts content from web pages
- Communicates with Gemini AI for summarization
- Displays summarized content in an overlay

### SearchPanel (search-panel.js)
- Provides in-page search functionality
- Creates a side panel for search results
- Integrates with DuckDuckGo for web searches

### GeminiService (gemini-service.js)
- Interfaces with Google's Generative AI (Gemini)
- Provides content summarization
- Identifies main content elements for cleanup
- Extracts related story links

## User Interface

The application features a clean, functional UI with the following elements:

### Tab Bar
- Displays open tabs with favicons and titles
- Allows tab switching and closing
- Includes a "+" button for creating new tabs

### Control Bar
- URL input field for navigation
- Back button for navigation history
- Toggle buttons for network, JavaScript, cache, and blocklist
- Summarize and Cleanup buttons for content processing

### Network Activity Indicator
- Visual representation of network activity
- Shows data transfer size for requests

### Content Area
- Displays web content in webview elements
- One webview per tab, with only the active tab visible
- Error overlay for displaying connection issues

## Tab Management

### Tab Creation
- Tabs can be created via the "+" button
- Each tab has its own webview instance
- New tabs start with "about:blank" by default

### Tab Navigation
- URL input field for direct navigation
- Support for both URLs and search terms
- Back button for navigation history

### Tab State
- Each tab maintains its own URL, title, and favicon
- Network blocking state is tracked per tab
- JavaScript and cache settings are global

## Network Control

### Per-Tab Network Blocking
- Each tab can have network access toggled independently
- Network is automatically enabled when typing in the URL bar
- Network is automatically disabled on scroll down
- Network is automatically enabled on user click

### Request Monitoring
- All HTTP/HTTPS requests are monitored
- Request sizes are tracked and visualized
- Headers can be modified for cache control

### Domain Blocking
- Domains listed in block.list are blocked
- Domain blocking can be toggled globally
- Blocked domains are logged for debugging

## Content Controls

### JavaScript Control
- JavaScript can be toggled globally
- State is persisted across application sessions
- Automatically disabled on scroll down
- Automatically enabled on user click

### Cache Control
- Browser cache can be toggled globally
- When disabled, cache-bypassing headers are added to requests
- Cache storage is cleared when disabled

## AI-Powered Features

### Content Summarization
- **Standard Pages:** Extracts text content from the active page.
- **YouTube Videos:** Detects YouTube video pages, fetches the video transcript (if available), and uses the transcript text for summarization.
- Sends content (page text or transcript) to Gemini AI for summarization.
- Displays the summary in a dedicated panel within the browser UI.
- Summaries are concise and focus on key information.

### Content Cleanup
- Analyzes page structure using Gemini AI
- Identifies and extracts main content
- Removes ads, navigation, and other distractions
- Creates a clean three-column layout:
  - Left column: Extracted images
  - Middle column: Clean text content
  - Right column: Related story links
- Opens cleaned content in a new tab

### Related Content Extraction
- Identifies related story links on the page
- Extracts titles and URLs
- Displays in the right column of cleaned content

## Search Functionality

### URL Bar Search
- Non-URL inputs are treated as search queries
- Searches are performed using DuckDuckGo
- Special syntax "word!" performs an "I'm Feeling Lucky" style search

### In-Page Search
- Allows searching for selected text
- Opens results in a side panel
- Uses DuckDuckGo for search results

## Security Features

### Content Security Policy
- Restricts resource loading to trusted sources
- Prevents XSS attacks
- Controls script execution

### Context Isolation
- Separates Electron APIs from webview content
- Prevents privilege escalation
- Provides controlled API access via preload script

### Node Integration
- Disabled in renderer process for security
- Functionality exposed through contextBridge
- Prevents malicious code from accessing Node.js APIs

## Performance Considerations

### Memory Management
- Tabs maintain their own state
- Cleanup of resources when tabs are closed
- Efficient handling of webview instances

### Network Optimization
- Optional cache control for reduced bandwidth
- Domain blocking for unwanted content
- Network activity visualization

## Future Enhancements

Potential areas for future development:

1. **User Profiles**: Support for multiple user profiles with separate settings
2. **Extension Support**: Framework for browser extensions
3. **Bookmark Management**: Save and organize favorite websites
4. **History Tracking**: Browse and search browsing history
5. **Advanced Privacy Features**: Tracking prevention, fingerprint protection
6. **Offline Mode**: Support for reading cached content offline
7. **Mobile Synchronization**: Sync tabs and settings with mobile devices
8. **Performance Metrics**: Detailed analytics on page load times and resource usage
9. **Advanced Content Filtering**: AI-powered ad and tracker blocking
10. **Voice Commands**: Integration with speech recognition for hands-free browsing
