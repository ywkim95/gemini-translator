document.addEventListener('DOMContentLoaded', () => {
  const analyzeBtn = document.getElementById('analyze-btn');
  const loadingView = document.getElementById('st-loading-state');
  const resultView = document.getElementById('st-result-state');
  const errorView = document.getElementById('st-error-state');
  const errorMessage = document.getElementById('st-error-message');
  const summaryEl = document.getElementById('st-summary');
  const translationEl = document.getElementById('st-translation');
  const converter = new showdown.Converter();
  
  // Streaming state management
  let isStreaming = false;
  let streamingText = '';
  let streamingTimer = null;
  let currentSummary = '';
  let currentTranslation = '';

  // Helper function to extract and display streaming content
  function displayStreamingText(text) {
    streamingText += text;
    
    // Try to extract summary and translated_text from the accumulated text
    try {
      // More aggressive parsing - look for partial content too
      let updatedSummary = false;
      let updatedTranslation = false;
      
      // Look for JSON structure (with or without markdown code blocks)
      let contentToSearch = streamingText;
      const jsonMatch = streamingText.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
      if (jsonMatch) {
        contentToSearch = jsonMatch[1];
      }
      
      // Try to extract summary with more flexible pattern
      const summaryMatch = contentToSearch.match(/"summary":\s*"([^]*?)(?=",?\s*"translated_text"|",?\s*}|$)/);
      if (summaryMatch) {
        const newSummary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\$/, '');
        if (newSummary !== currentSummary && newSummary.length > currentSummary.length) {
          currentSummary = newSummary;
          updatedSummary = true;
        }
      }
      
      // Try to extract translated_text with more flexible pattern
      const translatedMatch = contentToSearch.match(/"translated_text":\s*"([^]*?)(?="\s*}|$)/);
      if (translatedMatch) {
        const newTranslation = translatedMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\$/, '');
        if (newTranslation !== currentTranslation && newTranslation.length > currentTranslation.length) {
          currentTranslation = newTranslation;
          updatedTranslation = true;
        }
      }
      
      // Also try to extract content even if it's incomplete - more aggressive approach
      const partialSummaryMatch = contentToSearch.match(/"summary":\s*"([^]*?)(?="|$)/);
      if (partialSummaryMatch && partialSummaryMatch[1].length > currentSummary.length) {
        currentSummary = partialSummaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        updatedSummary = true;
      }
      
      const partialTranslatedMatch = contentToSearch.match(/"translated_text":\s*"([^]*?)(?="|$)/);
      if (partialTranslatedMatch && partialTranslatedMatch[1].length > currentTranslation.length) {
        currentTranslation = partialTranslatedMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        updatedTranslation = true;
      }
      
      // Even more aggressive - look for any meaningful text content
      if (!currentSummary && !currentTranslation) {
        // If we see any structured text, show it immediately
        const anyTextMatch = streamingText.match(/[가-힣\w\s]+/);
        if (anyTextMatch) {
          currentSummary = anyTextMatch[0];
          updatedSummary = true;
        }
      }
      
      console.log('[sidebar.js] Current summary length:', currentSummary.length, 'Translation length:', currentTranslation.length);
      
    } catch (e) {
      // If parsing fails, just continue - we'll show whatever we have
      console.log('[sidebar.js] Could not parse streaming JSON:', e);
    }
    
    // Update display immediately - always show something
    if (currentSummary || currentTranslation) {
      if (currentSummary) {
        summaryEl.innerHTML = currentSummary + '<span class="streaming-cursor">|</span>';
      }
      if (currentTranslation) {
        translationEl.innerHTML = currentTranslation + '<span class="streaming-cursor">|</span>';
      }
      if (!currentSummary) {
        summaryEl.innerHTML = 'Loading summary...<span class="streaming-cursor">|</span>';
      }
      if (!currentTranslation) {
        translationEl.innerHTML = 'Loading translation...<span class="streaming-cursor">|</span>';
      }
    } else {
      // Show that we're processing
      summaryEl.innerHTML = 'Processing...<span class="streaming-cursor">|</span>';
      translationEl.innerHTML = 'Processing...<span class="streaming-cursor">|</span>';
    }
    
    // Auto-scroll to bottom
    summaryEl.scrollTop = summaryEl.scrollHeight;
    translationEl.scrollTop = translationEl.scrollHeight;
  }

  // 분석 시작 버튼 이벤트
  analyzeBtn.addEventListener('click', () => {
    resultView.style.display = 'none';
    errorView.style.display = 'none';
    loadingView.style.display = 'block';
    summaryEl.innerHTML = ''; // Clear previous content
    translationEl.innerHTML = ''; // Clear previous content
    
    // Reset streaming state
    isStreaming = false;
    streamingText = '';
    currentSummary = '';
    currentTranslation = '';
    if (streamingTimer) {
      clearTimeout(streamingTimer);
      streamingTimer = null;
    }
    
    // content_script에 분석 요청
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      chrome.tabs.sendMessage(tabs[0].id, { type: "ANALYZE_PAGE" });
    });
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
      alert('저장할 내용이 없습니다. 먼저 페이지를 분석해주세요.');
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


  // background.js로부터 결과/에러 수신
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'STREAMING_START') {
      // Start streaming mode
      isStreaming = true;
      streamingText = '';
      currentSummary = '';
      currentTranslation = '';
      loadingView.style.display = 'none';
      resultView.style.display = 'block';
      summaryEl.innerHTML = '<span class="streaming-cursor">|</span>';
      translationEl.innerHTML = '<span class="streaming-cursor">|</span>';
      
    } else if (message.type === 'DISPLAY_STREAM_CHUNK') {
      if (isStreaming) {
        // Display streaming text in real-time
        displayStreamingText(message.payload.text);
      }
      
    } else if (message.type === 'CHUNK_PROGRESS') {
      // 청크 처리 진행 상황 표시
      const { current, total, text } = message.payload;
      summaryEl.innerHTML = `Processing chunk ${current}/${total}...<span class="streaming-cursor">|</span>`;
      
      // 번역된 텍스트를 누적하여 표시
      if (text) {
        if (!currentTranslation) {
          currentTranslation = text;
        } else {
          currentTranslation += '\n\n' + text;
        }
        translationEl.innerHTML = currentTranslation + '<span class="streaming-cursor">|</span>';
        translationEl.scrollTop = translationEl.scrollHeight;
      }
      
    } else if (message.type === 'STREAMING_END') {
      // End streaming mode and remove cursor
      if (isStreaming) {
        isStreaming = false;
        // Remove cursor from the display and show final extracted content
        summaryEl.innerHTML = currentSummary || streamingText;
        translationEl.innerHTML = currentTranslation || streamingText;
      }
      
    } else if (message.type === 'DISPLAY_RESULTS') {
      // Final results - replace streaming text with properly formatted content
      isStreaming = false;
      if (streamingTimer) {
        clearTimeout(streamingTimer);
        streamingTimer = null;
      }
      
      loadingView.style.display = 'none';
      resultView.style.display = 'block';
      
      // Add a small delay for better UX transition
      setTimeout(() => {
        summaryEl.innerHTML = converter.makeHtml(message.payload.summary);
        translationEl.innerHTML = converter.makeHtml(message.payload.translated_text);
      }, 500);
      
    } else if (message.type === 'DISPLAY_ERROR' || message.type === 'ANALYSIS_ERROR') {
      isStreaming = false;
      streamingText = '';
      currentSummary = '';
      currentTranslation = '';
      if (streamingTimer) {
        clearTimeout(streamingTimer);
        streamingTimer = null;
      }
      
      loadingView.style.display = 'none';
      errorView.style.display = 'block';
      errorMessage.textContent = message.error || (message.payload && message.payload.message) || 'Unknown error occurred';
      
    } else if (message.type === 'EXPORT_SUCCESS') {
      alert(message.message);
      
    } else if (message.type === 'EXPORT_ERROR') {
      alert('Export 오류: ' + message.error);
    }
  });
});