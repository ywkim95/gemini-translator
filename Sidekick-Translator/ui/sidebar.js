document.addEventListener('DOMContentLoaded', () => {
  // Constants
  const TOAST_DISPLAY_DURATION_MS = 3000;
  const TOAST_FADE_OUT_DURATION_MS = 300;
  const FINAL_RESULT_DELAY_MS = 500;

  const analyzeBtn = document.getElementById('analyze-btn');
  const converter = new showdown.Converter();

  // Tab elements
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  let currentTab = 'summary'; // 'summary' | 'full'

  // Summary tab elements
  const loadingViewSummary = document.getElementById('st-loading-state-summary');
  const resultViewSummary = document.getElementById('st-result-state-summary');
  const errorViewSummary = document.getElementById('st-error-state-summary');
  const errorMessageSummary = document.getElementById('st-error-message-summary');
  const summaryEl = document.getElementById('st-summary');

  // Full translation tab elements
  const loadingViewFull = document.getElementById('st-loading-state-full');
  const resultViewFull = document.getElementById('st-result-state-full');
  const errorViewFull = document.getElementById('st-error-state-full');
  const errorMessageFull = document.getElementById('st-error-message-full');
  const translationEl = document.getElementById('st-translation');

  // Streaming state management (per tab)
  let streamingStateSummary = {
    isStreaming: false,
    text: '',
    timer: null
  };

  let streamingStateFull = {
    isStreaming: false,
    text: '',
    currentTranslation: '',
    timer: null
  };

  // Data storage
  let currentSummary = '';
  let currentTranslation = '';

  // Tab switching logic
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.dataset.tab;

      // Update active tab button
      tabBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      // Update active tab content
      tabContents.forEach(content => content.classList.remove('active'));
      document.getElementById(`${targetTab}-tab`).classList.add('active');

      // Update current tab
      currentTab = targetTab;

      // If clicking full tab and no data yet, trigger analysis
      if (targetTab === 'full' && !currentTranslation) {
        console.log('[sidebar.js] Full tab clicked, requesting full translation');
        requestAnalysis('full');
      }

      // If clicking summary tab and no data yet, trigger analysis
      if (targetTab === 'summary' && !currentSummary) {
        console.log('[sidebar.js] Summary tab clicked, requesting summary');
        requestAnalysis('summary');
      }
    });
  });

  // Toast 메시지 표시 함수
  function showToast(message, type = 'success') {
    const toastContainer = document.getElementById('toast-container');
    const toastMessage = document.getElementById('toast-message');
    const toastIcon = document.getElementById('toast-icon');
    const toastText = document.getElementById('toast-text');

    // 아이콘 설정
    if (type === 'success') {
      toastIcon.textContent = '✅';
      toastMessage.className = 'success';
    } else if (type === 'error') {
      toastIcon.textContent = '❌';
      toastMessage.className = 'error';
    }

    toastText.textContent = message;
    toastContainer.style.display = 'block';

    // TOAST_DISPLAY_DURATION_MS 후 자동으로 사라짐
    setTimeout(() => {
      toastMessage.style.animation = 'toast-fade-out 0.3s ease-out';
      setTimeout(() => {
        toastContainer.style.display = 'none';
        toastMessage.style.animation = 'toast-slide-up 0.3s ease-out';
      }, TOAST_FADE_OUT_DURATION_MS);
    }, TOAST_DISPLAY_DURATION_MS);
  }

  // Helper function to extract and display streaming content for summary
  function displayStreamingTextSummary(text) {
    streamingStateSummary.text += text;

    try {
      let contentToSearch = streamingStateSummary.text;
      const jsonMatch = streamingStateSummary.text.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
      if (jsonMatch) {
        contentToSearch = jsonMatch[1];
      }

      const summaryMatch = contentToSearch.match(/"summary":\s*"([^]*?)(?="|$)/);
      if (summaryMatch) {
        currentSummary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }

      console.log('[sidebar.js] Summary length:', currentSummary.length);
    } catch (e) {
      console.log('[sidebar.js] Could not parse streaming JSON:', e);
    }

    if (currentSummary) {
      summaryEl.innerHTML = currentSummary + '<span class="streaming-cursor">|</span>';
    } else {
      summaryEl.innerHTML = 'Processing...<span class="streaming-cursor">|</span>';
    }

    summaryEl.scrollTop = summaryEl.scrollHeight;
  }

  // Helper function for full translation streaming
  function displayStreamingTextFull(text) {
    streamingStateFull.text += text;

    try {
      let contentToSearch = streamingStateFull.text;
      const jsonMatch = streamingStateFull.text.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
      if (jsonMatch) {
        contentToSearch = jsonMatch[1];
      }

      const translatedMatch = contentToSearch.match(/"translated_text":\s*"([^]*?)(?="|$)/);
      if (translatedMatch) {
        streamingStateFull.currentTranslation = translatedMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }

      console.log('[sidebar.js] Translation length:', streamingStateFull.currentTranslation.length);
    } catch (e) {
      console.log('[sidebar.js] Could not parse streaming JSON:', e);
    }

    if (streamingStateFull.currentTranslation) {
      translationEl.innerHTML = streamingStateFull.currentTranslation + '<span class="streaming-cursor">|</span>';
    } else {
      translationEl.innerHTML = 'Processing...<span class="streaming-cursor">|</span>';
    }

    translationEl.scrollTop = translationEl.scrollHeight;
  }

  // Request analysis with mode
  function requestAnalysis(mode) {
    // Reset state based on mode
    if (mode === 'summary') {
      resultViewSummary.style.display = 'none';
      errorViewSummary.style.display = 'none';
      loadingViewSummary.style.display = 'block';
      summaryEl.innerHTML = '';
      streamingStateSummary = { isStreaming: false, text: '', timer: null };
    } else if (mode === 'full') {
      resultViewFull.style.display = 'none';
      errorViewFull.style.display = 'none';
      loadingViewFull.style.display = 'block';
      translationEl.innerHTML = '';
      streamingStateFull = { isStreaming: false, text: '', currentTranslation: '', timer: null };
    }

    // Export 버튼 숨기기
    document.getElementById('export-btn').style.display = 'none';

    // content_script에 분석 요청
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: "ANALYZE_PAGE",
        mode: mode  // 'summary' or 'full'
      });
    });
  }

  // 분석 시작 버튼 이벤트 (현재 탭에 따라 다른 모드)
  analyzeBtn.addEventListener('click', () => {
    requestAnalysis(currentTab);
  });

  // 닫기 버튼
  document.getElementById('close-sidebar-btn').addEventListener('click', () => {
    window.parent.postMessage({ type: 'CLOSE_SIDEKICK_SIDEBAR' }, '*');
  });

  // 너비 조절 버튼들
  document.getElementById('btn-width-small').addEventListener('click', () => window.parent.postMessage({ type: 'RESIZE_SIDEBAR', width: '350px' }, '*'));
  document.getElementById('btn-width-medium').addEventListener('click', () => window.parent.postMessage({ type: 'RESIZE_SIDEBAR', width: '600px' }, '*'));
  document.getElementById('btn-width-large').addEventListener('click', () => window.parent.postMessage({ type: 'RESIZE_SIDEBAR', width: '900px' }, '*'));

  // Export 버튼
  document.getElementById('export-btn').addEventListener('click', () => {
    if (!currentSummary && !currentTranslation) {
      showToast('저장할 내용이 없습니다. 먼저 페이지를 분석해주세요.', 'error');
      return;
    }

    // content_script에 export 요청
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, {
        type: "EXPORT_CONTENT",
        payload: {
          summary: currentSummary,
          translation: currentTranslation,
          url: tabs[0].url,
          title: tabs[0].title
        }
      });
    });
  });

  // 페이지 로드 시 캐시된 결과 확인 및 표시
  function loadCachedResults() {
    chrome.tabs.query({ active: true, currentWindow: true }, async (tabs) => {
      if (!tabs[0]) return;

      const tabId = tabs[0].id;
      const tabUrl = tabs[0].url;
      const cacheKeySummary = `cachedResult-${tabId}-${tabUrl}-summary`;
      const cacheKeyFull = `cachedResult-${tabId}-${tabUrl}-full`;

      chrome.storage.local.get([cacheKeySummary, cacheKeyFull], (result) => {
        // Load summary if available
        if (result[cacheKeySummary]) {
          console.log('[sidebar.js] Found cached summary, displaying');
          currentSummary = result[cacheKeySummary].summary || result[cacheKeySummary].translated_text;

          loadingViewSummary.style.display = 'none';
          errorViewSummary.style.display = 'none';
          resultViewSummary.style.display = 'block';
          summaryEl.innerHTML = converter.makeHtml(currentSummary);

          // Export 버튼 표시
          if (currentSummary) {
            document.getElementById('export-btn').style.display = 'inline-flex';
          }
        }

        // Load full translation if available
        if (result[cacheKeyFull]) {
          console.log('[sidebar.js] Found cached full translation, displaying');
          currentTranslation = result[cacheKeyFull].translated_text;

          loadingViewFull.style.display = 'none';
          errorViewFull.style.display = 'none';
          resultViewFull.style.display = 'block';
          translationEl.innerHTML = converter.makeHtml(currentTranslation);

          // Export 버튼 표시
          if (currentTranslation) {
            document.getElementById('export-btn').style.display = 'inline-flex';
          }
        }
      });
    });
  }

  // 페이지 로드 시 캐시 확인
  loadCachedResults();

  // background.js로부터 결과/에러 수신
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const mode = message.mode || 'summary'; // Default to summary for backward compatibility

    if (message.type === 'STREAMING_START') {
      if (mode === 'summary') {
        streamingStateSummary.isStreaming = true;
        streamingStateSummary.text = '';
        loadingViewSummary.style.display = 'none';
        resultViewSummary.style.display = 'block';
        summaryEl.innerHTML = '<span class="streaming-cursor">|</span>';
      } else if (mode === 'full') {
        streamingStateFull.isStreaming = true;
        streamingStateFull.text = '';
        streamingStateFull.currentTranslation = '';
        loadingViewFull.style.display = 'none';
        resultViewFull.style.display = 'block';
        translationEl.innerHTML = '<span class="streaming-cursor">|</span>';
      }

    } else if (message.type === 'DISPLAY_STREAM_CHUNK') {
      if (mode === 'summary' && streamingStateSummary.isStreaming) {
        displayStreamingTextSummary(message.payload.text);
      } else if (mode === 'full' && streamingStateFull.isStreaming) {
        displayStreamingTextFull(message.payload.text);
      }

    } else if (message.type === 'CHUNK_PROGRESS') {
      // 청크 처리 진행 상황 표시 (full translation only)
      const { current, total, text } = message.payload;

      if (mode === 'full') {
        summaryEl.innerHTML = `Processing chunk ${current}/${total}...<span class="streaming-cursor">|</span>`;

        if (text) {
          if (!streamingStateFull.currentTranslation) {
            streamingStateFull.currentTranslation = text;
          } else {
            streamingStateFull.currentTranslation += '\n\n' + text;
          }
          translationEl.innerHTML = streamingStateFull.currentTranslation + '<span class="streaming-cursor">|</span>';
          translationEl.scrollTop = translationEl.scrollHeight;
        }
      }

    } else if (message.type === 'STREAMING_END') {
      if (mode === 'summary') {
        streamingStateSummary.isStreaming = false;
        summaryEl.innerHTML = currentSummary || streamingStateSummary.text;

        if (currentSummary) {
          document.getElementById('export-btn').style.display = 'inline-flex';
        }
      } else if (mode === 'full') {
        streamingStateFull.isStreaming = false;
        translationEl.innerHTML = streamingStateFull.currentTranslation || streamingStateFull.text;

        if (streamingStateFull.currentTranslation) {
          document.getElementById('export-btn').style.display = 'inline-flex';
        }
      }

    } else if (message.type === 'DISPLAY_RESULTS') {
      if (mode === 'summary') {
        streamingStateSummary.isStreaming = false;
        if (streamingStateSummary.timer) {
          clearTimeout(streamingStateSummary.timer);
          streamingStateSummary.timer = null;
        }

        loadingViewSummary.style.display = 'none';
        resultViewSummary.style.display = 'block';

        currentSummary = message.payload.summary || message.payload.translated_text;

        document.getElementById('export-btn').style.display = 'inline-flex';

        setTimeout(() => {
          summaryEl.innerHTML = converter.makeHtml(currentSummary);
        }, FINAL_RESULT_DELAY_MS);

      } else if (mode === 'full') {
        streamingStateFull.isStreaming = false;
        if (streamingStateFull.timer) {
          clearTimeout(streamingStateFull.timer);
          streamingStateFull.timer = null;
        }

        loadingViewFull.style.display = 'none';
        resultViewFull.style.display = 'block';

        currentTranslation = message.payload.translated_text;

        document.getElementById('export-btn').style.display = 'inline-flex';

        setTimeout(() => {
          translationEl.innerHTML = converter.makeHtml(currentTranslation);
        }, FINAL_RESULT_DELAY_MS);
      }

    } else if (message.type === 'DISPLAY_ERROR' || message.type === 'ANALYSIS_ERROR') {
      if (mode === 'summary') {
        streamingStateSummary.isStreaming = false;
        streamingStateSummary.text = '';
        if (streamingStateSummary.timer) {
          clearTimeout(streamingStateSummary.timer);
          streamingStateSummary.timer = null;
        }

        loadingViewSummary.style.display = 'none';
        errorViewSummary.style.display = 'block';
        errorMessageSummary.textContent = message.error || (message.payload && message.payload.message) || 'Unknown error occurred';

      } else if (mode === 'full') {
        streamingStateFull.isStreaming = false;
        streamingStateFull.text = '';
        streamingStateFull.currentTranslation = '';
        if (streamingStateFull.timer) {
          clearTimeout(streamingStateFull.timer);
          streamingStateFull.timer = null;
        }

        loadingViewFull.style.display = 'none';
        errorViewFull.style.display = 'block';
        errorMessageFull.textContent = message.error || (message.payload && message.payload.message) || 'Unknown error occurred';
      }

    } else if (message.type === 'EXPORT_SUCCESS') {
      showToast(message.message, 'success');

    } else if (message.type === 'EXPORT_ERROR') {
      showToast('Export 오류: ' + message.error, 'error');
    }
  });
});
