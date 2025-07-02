# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome extension called "Sidekick Translator" that uses Google Gemini 1.5 Flash API to summarize and translate web pages into Korean. The extension provides a sidebar interface that displays both a summary and full translation of the current page content.

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
- Gemini 1.5 Flash API with streaming responses
- Custom prompt template in `background.js` (lines 74-94)
- JSON response format with summary and translated_text fields

## File Structure
- `Sidekick-Translator/`: Main extension directory
- `manifest.json`: Extension configuration (v3)
- Icons in SVG format for multiple sizes
- No TypeScript - pure JavaScript implementation