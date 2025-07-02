document.addEventListener('DOMContentLoaded', () => {
  const analyzeBtn = document.getElementById('analyze-btn');
  const loadingView = document.getElementById('st-loading-state');
  const resultView = document.getElementById('st-result-state');
  const errorView = document.getElementById('st-error-state');
  const errorMessage = document.getElementById('st-error-message');
  const summaryEl = document.getElementById('st-summary');
  const translationEl = document.getElementById('st-translation');
  const converter = new showdown.Converter();

  // 분석 시작 버튼 이벤트
  analyzeBtn.addEventListener('click', () => {
    resultView.style.display = 'none';
    errorView.style.display = 'none';
    loadingView.style.display = 'block';
    summaryEl.innerHTML = ''; // Clear previous content
    translationEl.innerHTML = ''; // Clear previous content
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
    if (message.type === 'DISPLAY_STREAM_CHUNK') {
      summaryEl.innerHTML += message.payload.text;
      translationEl.innerHTML += message.payload.text;
    } else if (message.type === 'DISPLAY_RESULTS') {
      loadingView.style.display = 'none';
      resultView.style.display = 'block';
      summaryEl.innerHTML = converter.makeHtml(message.payload.summary);
      translationEl.innerHTML = converter.makeHtml(message.payload.translated_text);
    } else if (message.type === 'DISPLAY_ERROR') {
      loadingView.style.display = 'none';
      errorView.style.display = 'block';
      errorMessage.textContent = message.payload.message;
    }
  });
});