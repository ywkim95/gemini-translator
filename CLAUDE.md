# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome extension called "Sidekick Translator" that uses Google Gemini 2.0 Flash API to summarize and translate web pages into Korean. The extension provides a sidebar interface that displays both a summary and full translation of the current page content.

## Development Commands

- `npm install`: Install dependencies (sharp package for image processing)
- Chrome extension testing: Load unpacked extension from `Sidekick-Translator` directory in `chrome://extensions`
- No build process required - direct file loading

## Architecture

### Core Components
- `background.js`: Service worker handling API communication, caching, and tab management
- `scripts/content_script.js`: Injected into web pages to manage sidebar and extract content
- `ui/sidebar.html/css/js`: The main UI displayed to users
- `scripts/readability.js`: Mozilla's Readability library for content extraction
- `scripts/showdown.js`: Markdown to HTML converter
- `options.html/js`: Extension settings page for API key management

### Key Features
- Streaming API responses from Gemini API
- Result caching per tab/URL
- Sidebar width adjustment (Small/Medium/Large)
- PDF text extraction support
- Tab lifecycle management for cache cleanup
- **Optimized text processing for long documents:**
  - Adaptive chunk sizing based on AI model capabilities
  - Semantic chunking at paragraph/sentence boundaries
  - Hierarchical summarization for efficient processing
  - Model-specific optimization (Gemini: 15K, OpenAI: 12K, Claude/Grok: 10K chars)

### Data Flow
1. User clicks extension icon → `background.js` injects content script
2. Content script creates sidebar iframe → loads `ui/sidebar.html`
3. User clicks analyze → content script extracts text with Readability.js
4. Background script calls Gemini API with streaming
5. Results displayed in sidebar with markdown rendering

### Storage
- `chrome.storage.sync`: API key storage
- `chrome.storage.local`: Response caching and sidebar state

### API Integration
- Gemini 2.0 Flash (Experimental) API with streaming responses
- Optimized prompt templates for efficiency (concise, JSON-focused)
- JSON response format with summary and translated_text fields
- Supports multiple AI providers: Gemini, OpenAI, Claude, Grok
- **Long document handling:**
  - Smart chunking with semantic boundaries
  - Each chunk extracts translation + key points
  - Hierarchical summarization: aggregates key points into final summary
  - Significantly reduces token usage vs. full-text re-summarization

## File Structure
- `Sidekick-Translator/`: Main extension directory
- `manifest.json`: Extension configuration (v3)
- Icons in SVG format for multiple sizes
- No TypeScript - pure JavaScript implementation