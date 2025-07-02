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
    
    // Try to extract summary and translated_text from the accumulated JSON-like text
    try {
      // Look for JSON structure in the accumulated text
      const jsonMatch = streamingText.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
      if (jsonMatch) {
        const jsonContent = jsonMatch[1];
        
        // Try to extract summary
        const summaryMatch = jsonContent.match(/"summary":\s*"([^"]*(?:\\.[^"]*)*)"?/);
        if (summaryMatch) {
          currentSummary = summaryMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
        
        // Try to extract translated_text
        const translatedMatch = jsonContent.match(/"translated_text":\s*"([^"]*(?:\\.[^"]*)*)"?/);
        if (translatedMatch) {
          currentTranslation = translatedMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
      }
    } catch (e) {
      // If parsing fails, just continue - we'll show whatever we have
      console.log('[sidebar.js] Could not parse streaming JSON:', e);
    }
    
    // Update display with extracted content or fallback to raw text
    if (currentSummary || currentTranslation) {
      summaryEl.innerHTML = currentSummary + '<span class="streaming-cursor">|</span>';
      translationEl.innerHTML = currentTranslation + '<span class="streaming-cursor">|</span>';
    } else {
      // Fallback: show the raw streaming text in both areas
      summaryEl.innerHTML = streamingText + '<span class="streaming-cursor">|</span>';
      translationEl.innerHTML = streamingText + '<span class="streaming-cursor">|</span>';
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
      
    } else if (message.type === 'DISPLAY_ERROR') {
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
      errorMessage.textContent = message.payload.message;
    }
  });
});