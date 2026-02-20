document.addEventListener('DOMContentLoaded', () => {
  const TOAST_DISPLAY_DURATION_MS = 3000;
  const TOAST_FADE_OUT_DURATION_MS = 300;
  const FINAL_RESULT_DELAY_MS = 500;
  const DEFAULT_PROCESSING_TEXT = 'Processing...';

  const converter = new showdown.Converter();
  const analyzeBtn = document.getElementById('analyze-btn');
  const exportBtn = document.getElementById('export-btn');

  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  const tabConfig = {
    summary: {
      contentKey: 'summary',
      fallbackKey: 'translated_text',
      loadingView: document.getElementById('st-loading-state-summary'),
      resultView: document.getElementById('st-result-state-summary'),
      errorView: document.getElementById('st-error-state-summary'),
      errorMessageEl: document.getElementById('st-error-message-summary'),
      contentEl: document.getElementById('st-summary')
    },
    full: {
      contentKey: 'translated_text',
      fallbackKey: 'summary',
      loadingView: document.getElementById('st-loading-state-full'),
      resultView: document.getElementById('st-result-state-full'),
      errorView: document.getElementById('st-error-state-full'),
      errorMessageEl: document.getElementById('st-error-message-full'),
      contentEl: document.getElementById('st-translation')
    }
  };

  let currentTab = 'summary';

  const tabState = {
    summary: createInitialTabState(),
    full: createInitialTabState()
  };

  const tabResults = {
    summary: '',
    full: ''
  };

  function createInitialTabState() {
    return {
      isStreaming: false,
      textBuffer: '',
      parsedText: '',
      timer: null
    };
  }

  function resolveMode(mode) {
    return mode === 'full' ? 'full' : 'summary';
  }

  function setActiveTab(targetTab) {
    currentTab = targetTab;

    tabBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === targetTab);
    });

    tabContents.forEach((content) => {
      content.classList.toggle('active', content.id === `${targetTab}-tab`);
    });
  }

  function setView(mode, view) {
    const config = tabConfig[mode];

    config.loadingView.style.display = view === 'loading' ? 'block' : 'none';
    config.resultView.style.display = view === 'result' ? 'block' : 'none';
    config.errorView.style.display = view === 'error' ? 'block' : 'none';
  }

  function renderTabContent(mode, text, options = {}) {
    const { withCursor = false, asMarkdown = false } = options;
    const config = tabConfig[mode];

    if (asMarkdown) {
      config.contentEl.innerHTML = converter.makeHtml(text || '');
    } else {
      config.contentEl.textContent = text || '';
    }

    if (withCursor) {
      const cursor = document.createElement('span');
      cursor.className = 'streaming-cursor';
      cursor.textContent = '|';
      config.contentEl.appendChild(cursor);
    }

    config.contentEl.scrollTop = config.contentEl.scrollHeight;
  }

  function clearTabTimer(mode) {
    const state = tabState[mode];
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
  }

  function resetStreamState(mode) {
    const state = tabState[mode];
    clearTabTimer(mode);

    state.isStreaming = false;
    state.textBuffer = '';
    state.parsedText = '';
  }

  function updateExportButtonVisibility() {
    const hasExportableData = Boolean(tabResults.summary || tabResults.full);
    exportBtn.style.display = hasExportableData ? 'inline-flex' : 'none';
  }

  function withActiveTab(callback) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs || !tabs[0]) {
        showToast('활성 탭을 찾을 수 없습니다.', 'error');
        return;
      }

      callback(tabs[0]);
    });
  }

  function unescapeJsonString(value) {
    return value
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }

  function extractJsonField(streamedText, fieldName) {
    const jsonBlockMatch = streamedText.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
    const source = jsonBlockMatch ? jsonBlockMatch[1] : streamedText;

    const keyToken = `"${fieldName}"`;
    const keyIndex = source.indexOf(keyToken);
    if (keyIndex === -1) {
      return '';
    }

    const colonIndex = source.indexOf(':', keyIndex + keyToken.length);
    if (colonIndex === -1) {
      return '';
    }

    const openingQuoteIndex = source.indexOf('"', colonIndex + 1);
    if (openingQuoteIndex === -1) {
      return '';
    }

    let value = '';
    let escaped = false;

    for (let i = openingQuoteIndex + 1; i < source.length; i += 1) {
      const ch = source[i];

      if (escaped) {
        value += ch;
        escaped = false;
        continue;
      }

      if (ch === '\\') {
        value += ch;
        escaped = true;
        continue;
      }

      if (ch === '"') {
        break;
      }

      value += ch;
    }

    return unescapeJsonString(value);
  }

  function requestAnalysis(mode) {
    const resolvedMode = resolveMode(mode);

    resetStreamState(resolvedMode);
    setView(resolvedMode, 'loading');
    renderTabContent(resolvedMode, '');
    exportBtn.style.display = 'none';

    withActiveTab((activeTab) => {
      chrome.tabs.sendMessage(activeTab.id, {
        type: 'ANALYZE_PAGE',
        mode: resolvedMode
      });
    });
  }

  function appendChunkTranslation(fullChunkText) {
    if (!fullChunkText) {
      return;
    }

    const fullState = tabState.full;

    if (!fullState.parsedText) {
      fullState.parsedText = fullChunkText;
      return;
    }

    fullState.parsedText += `\n\n${fullChunkText}`;
  }

  function showToast(message, type = 'success') {
    const toastContainer = document.getElementById('toast-container');
    const toastMessage = document.getElementById('toast-message');
    const toastIcon = document.getElementById('toast-icon');
    const toastText = document.getElementById('toast-text');

    if (type === 'success') {
      toastIcon.textContent = '✅';
      toastMessage.className = 'success';
    } else if (type === 'error') {
      toastIcon.textContent = '❌';
      toastMessage.className = 'error';
    }

    toastText.textContent = message;
    toastContainer.style.display = 'block';

    setTimeout(() => {
      toastMessage.style.animation = 'toast-fade-out 0.3s ease-out';
      setTimeout(() => {
        toastContainer.style.display = 'none';
        toastMessage.style.animation = 'toast-slide-up 0.3s ease-out';
      }, TOAST_FADE_OUT_DURATION_MS);
    }, TOAST_DISPLAY_DURATION_MS);
  }

  function handleStreamingStart(mode) {
    const resolvedMode = resolveMode(mode);
    const state = tabState[resolvedMode];

    state.isStreaming = true;
    state.textBuffer = '';
    state.parsedText = '';

    setView(resolvedMode, 'result');
    renderTabContent(resolvedMode, '', { withCursor: true });
  }

  function handleStreamChunk(mode, chunkText) {
    const resolvedMode = resolveMode(mode);
    const state = tabState[resolvedMode];

    if (!state.isStreaming) {
      return;
    }

    state.textBuffer += chunkText;

    const extracted = extractJsonField(state.textBuffer, tabConfig[resolvedMode].contentKey);
    if (extracted) {
      state.parsedText = extracted;
    }

    const displayText = state.parsedText || DEFAULT_PROCESSING_TEXT;
    renderTabContent(resolvedMode, displayText, { withCursor: true });
  }

  function handleChunkProgress(mode, payload) {
    const resolvedMode = resolveMode(mode);
    if (resolvedMode !== 'full') {
      return;
    }

    const { current, total, text } = payload;
    appendChunkTranslation(text);

    const progressText = Number.isFinite(current) && Number.isFinite(total)
      ? `Processing chunk ${current}/${total}...`
      : DEFAULT_PROCESSING_TEXT;

    const contentText = tabState.full.parsedText
      ? `${tabState.full.parsedText}\n\n${progressText}`
      : progressText;

    renderTabContent('full', contentText, { withCursor: true });
  }

  function handleStreamingEnd(mode) {
    const resolvedMode = resolveMode(mode);
    const state = tabState[resolvedMode];

    state.isStreaming = false;

    const finalStreamingText = state.parsedText || state.textBuffer;
    if (finalStreamingText) {
      renderTabContent(resolvedMode, finalStreamingText);
    }

    updateExportButtonVisibility();
  }

  function handleDisplayResults(mode, payload) {
    const resolvedMode = resolveMode(mode);
    const config = tabConfig[resolvedMode];

    resetStreamState(resolvedMode);
    setView(resolvedMode, 'result');

    tabResults[resolvedMode] = payload[config.contentKey] || payload[config.fallbackKey] || '';

    updateExportButtonVisibility();

    tabState[resolvedMode].timer = setTimeout(() => {
      renderTabContent(resolvedMode, tabResults[resolvedMode], { asMarkdown: true });
      tabState[resolvedMode].timer = null;
    }, FINAL_RESULT_DELAY_MS);
  }

  function handleError(mode, message) {
    const resolvedMode = resolveMode(mode);

    resetStreamState(resolvedMode);
    setView(resolvedMode, 'error');
    tabConfig[resolvedMode].errorMessageEl.textContent = message || 'Unknown error occurred';
  }

  function loadCachedResults() {
    withActiveTab((activeTab) => {
      const tabId = activeTab.id;
      const tabUrl = activeTab.url;

      if (!tabUrl) {
        return;
      }

      const cacheKeySummary = `cachedResult-${tabId}-${tabUrl}-summary`;
      const cacheKeyFull = `cachedResult-${tabId}-${tabUrl}-full`;

      chrome.storage.local.get([cacheKeySummary, cacheKeyFull], (result) => {
        const summaryCache = result[cacheKeySummary];
        const fullCache = result[cacheKeyFull];

        if (summaryCache) {
          tabResults.summary = summaryCache.summary || summaryCache.translated_text || '';
          setView('summary', 'result');
          renderTabContent('summary', tabResults.summary, { asMarkdown: true });
        }

        if (fullCache) {
          tabResults.full = fullCache.translated_text || fullCache.summary || '';
          setView('full', 'result');
          renderTabContent('full', tabResults.full, { asMarkdown: true });
        }

        updateExportButtonVisibility();
      });
    });
  }

  tabBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetTab = resolveMode(btn.dataset.tab);
      setActiveTab(targetTab);

      if (!tabResults[targetTab] && !tabState[targetTab].isStreaming) {
        requestAnalysis(targetTab);
      }
    });
  });

  analyzeBtn.addEventListener('click', () => {
    requestAnalysis(currentTab);
  });

  document.getElementById('close-sidebar-btn').addEventListener('click', () => {
    window.parent.postMessage({ type: 'CLOSE_SIDEKICK_SIDEBAR' }, '*');
  });

  document.querySelectorAll('.width-controls button').forEach((button) => {
    button.addEventListener('click', () => {
      const width = button.dataset.width ? `${button.dataset.width}px` : '600px';
      window.parent.postMessage({ type: 'RESIZE_SIDEBAR', width }, '*');
    });
  });

  exportBtn.addEventListener('click', () => {
    if (!tabResults.summary && !tabResults.full) {
      showToast('저장할 내용이 없습니다. 먼저 페이지를 분석해주세요.', 'error');
      return;
    }

    withActiveTab((activeTab) => {
      chrome.tabs.sendMessage(activeTab.id, {
        type: 'EXPORT_CONTENT',
        payload: {
          summary: tabResults.summary,
          translation: tabResults.full,
          url: activeTab.url,
          title: activeTab.title
        }
      });
    });
  });

  const messageHandlers = {
    STREAMING_START: (message) => {
      handleStreamingStart(message.mode);
    },
    DISPLAY_STREAM_CHUNK: (message) => {
      const text = message.payload && message.payload.text ? message.payload.text : '';
      handleStreamChunk(message.mode, text);
    },
    CHUNK_PROGRESS: (message) => {
      handleChunkProgress(message.mode, message.payload || {});
    },
    STREAMING_END: (message) => {
      handleStreamingEnd(message.mode);
    },
    DISPLAY_RESULTS: (message) => {
      handleDisplayResults(message.mode, message.payload || {});
    },
    DISPLAY_ERROR: (message) => {
      const errorMessage = message.error || (message.payload && message.payload.message);
      handleError(message.mode, errorMessage);
    },
    ANALYSIS_ERROR: (message) => {
      const errorMessage = message.error || (message.payload && message.payload.message);
      handleError(message.mode, errorMessage);
    },
    EXPORT_SUCCESS: (message) => {
      showToast(message.message || '내보내기에 성공했습니다.', 'success');
    },
    EXPORT_ERROR: (message) => {
      showToast(`Export 오류: ${message.error || '알 수 없는 오류'}`, 'error');
    }
  };

  chrome.runtime.onMessage.addListener((message) => {
    const handler = messageHandlers[message.type];
    if (handler) {
      handler(message);
    }
  });

  loadCachedResults();
});
