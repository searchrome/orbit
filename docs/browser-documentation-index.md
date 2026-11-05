# Browser Application Documentation

## Overview

This documentation provides a comprehensive overview of the browser application, its architecture, functionality, and future development plans. The browser is an Electron-based application that offers unique features for content control, AI-powered summarization and cleanup, privacy-focused browsing, and an emerging browser-native AI agent workspace.

## Documentation Index

### Core Documentation

1. [**Functionality Document**](browser-functionality-document.md)
   - Comprehensive overview of the browser's architecture, components, and functionality
   - Detailed explanation of core features and their implementation
   - Security considerations and performance optimizations

2. [**Architecture Diagram**](browser-architecture-diagram.md)
   - Visual representation of the application's architecture
   - Component interaction diagrams
   - Data flow sequences
   - Class structure diagrams

3. [**API and Event Flow**](browser-api-and-events.md)
   - Detailed documentation of IPC communication channels
   - Main and renderer process APIs
   - Custom events and webview events
   - External API integrations
   - Event flow examples

4. [**Unique Features**](browser-unique-features.md)
   - Detailed explanation of the browser's differentiating features
   - User experience benefits
   - Comparison with standard browsers
   - Feature implementation details

5. [**Development Roadmap**](browser-development-roadmap.md)
   - Short, medium, and long-term development plans
   - Technical debt and refactoring priorities
   - Performance optimization opportunities
   - Security enhancement proposals
   - User experience refinements

6. [**AI Agent Workspace**](browser-ai-agent-workspace.md)
   - Product spec for an AI-first browser entry page
   - Chat-based browsing workflow
   - Tab control and page interaction tool design
   - Safety limits, UX requirements, and phased implementation plan

7. [**Remote LLM Browser Control**](browser-remote-llm-control.md)
   - Practical guide for driving the browser through the planner IPC contract
   - Request and response shapes for remote model calls
   - Browser tool surface, safety limits, and host loop expectations

## Key Features

The browser application includes several unique features that differentiate it from standard browsers:

### Content Control
- Per-tab network control
- Global JavaScript control with automatic behavior
- Domain blocking via customizable blocklist
- Cache control with automatic clearing

### AI-Enhanced Browsing
- Content summarization using the OpenRouter-backed AI service (including YouTube video transcripts)
- Content cleanup for distraction-free reading
- Related content extraction and presentation
- AI workspace for chat-driven browsing across real tabs and live pages
- Evolving browser-native agent target: clarify, browse, compare, and recommend

### Interaction-Based Behavior
- Automatic network and JavaScript control based on scrolling
- Automatic network and JavaScript restoration based on clicking
- Intuitive behavior that adapts to reading vs. interactive modes

### Search Enhancements
- DuckDuckGo integration for privacy-focused search
- Instant search with "word!" syntax for quick navigation
- In-page search with side panel results

## Architecture Overview

The application follows Electron's main-renderer architecture pattern:

- **Main Process (main.js)**: Handles application lifecycle, window management, IPC, network monitoring, and AI integration
- **Renderer Process (renderer.js)**: Manages UI, user interactions, and webview instances
- **Preload Script (preload.js)**: Provides secure bridge between renderer and Electron APIs

Core components include:
- TabManager: Handles tab creation, switching, and state management
- Summarizer: Extracts content and communicates with the AI backend
- SearchPanel: Provides in-page search functionality
- OpenRouterService: Interfaces with the OpenRouter-backed model runtime

## Development Status

The application is currently functional with all core features implemented. The development roadmap outlines plans for future enhancements, including:

- Per-tab JavaScript control
- Bookmark and history management
- Extension framework
- User profiles
- Advanced content filtering
- Offline reading mode
- Cross-device synchronization
- Advanced AI integration
- Browser-native general agent behavior

## Getting Started

To run the browser application:

1. Ensure Node.js and npm are installed
2. Clone the repository
3. Install dependencies with `npm install`
4. Start the application with `npm start`

## Contributing

Contributions to the browser application are welcome. Please refer to the development roadmap for priority areas and planned enhancements.

## License

The browser application is licensed under the ISC license as specified in the package.json file.
