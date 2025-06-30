const createSidebar = () => {
  const sidebarRoot = document.createElement('div');
  sidebarRoot.id = 'sidekick-translator-root';
  document.body.appendChild(sidebarRoot);

  // 초기 너비를 뷰포트 너비의 25%로 설정 (CSS의 min/max-width와 연동)
  let initialWidth = window.innerWidth * 0.25;
  if (initialWidth < 300) initialWidth = 300;
  if (initialWidth > 1000) initialWidth = 1000;
  sidebarRoot.style.width = `${initialWidth}px`;

  const iframe = document.createElement('iframe');
  iframe.id = 'st-iframe';
  iframe.style.height = '100%'; 
  iframe.style.width = '100%';
  sidebarRoot.appendChild(iframe);

  // 사이드바 크기 및 위치 설정 (화면 오른쪽 전체 높이 고정)
  sidebarRoot.style.position = 'fixed';
  sidebarRoot.style.top = '0';
  sidebarRoot.style.right = '0';
  sidebarRoot.style.height = '100%';
  sidebarRoot.style.zIndex = '2147483647';

  const iframeContent = `
    <html>
    <head><link rel="stylesheet" href="${chrome.runtime.getURL('ui/sidebar.css')}"></head>
    <body>
        <div class="container">
            <div class="header">
                Sidekick Translator
                <div class="width-controls">
                    <button id="btn-width-small" data-width="300">Small</button>
                    <button id="btn-width-medium" data-width="600">Medium</button>
                    <button id="btn-width-large" data-width="900">Large</button>
                </div>
                <button id="close-sidebar-btn" class="close-btn">&times;</button>
            </div>
            <div id="st-loading-state" class="state-view">
                <div class="spinner"></div>
                <p>Gemini가 페이지를 분석 중입니다...</p>
            </div>
            <div id="st-result-state" class="state-view" style="display:none;">
                <div class="section">
                    <h3>핵심 요약</h3>
                    <div id="st-summary"></div>
                </div>
                <div class="section">
                    <h3>전체 번역문</h3>
                    <div id="st-translation"></div>
                </div>
            </div>
            <div id="st-error-state" class="state-view" style="display:none;">
                <p id="st-error-message"></p>
            </div>
        </div>
    </body>
    </html>
  `;

  iframe.srcdoc = iframeContent;
  iframe.onload = () => {
    const doc = iframe.contentDocument;
    // 너비 조절 버튼 이벤트 리스너 추가
    doc.getElementById('btn-width-small').addEventListener('click', () => {
      sidebarRoot.style.width = '300px';
    });
    doc.getElementById('btn-width-medium').addEventListener('click', () => {
      sidebarRoot.style.width = '600px';
    });
    doc.getElementById('btn-width-large').addEventListener('click', () => {
      sidebarRoot.style.width = '900px';
    });

    // 닫기 버튼 이벤트 리스너 추가
    doc.getElementById('close-sidebar-btn').addEventListener('click', () => {
      window.hideSidekickSidebar(); // 사이드바 숨김 함수 호출
      // 사이드바 닫힘 상태를 background.js에 알림
      chrome.runtime.sendMessage({ type: 'UPDATE_SIDEBAR_STATE', isSidebarOpen: false });
    });

    const isPdf = document.contentType === 'application/pdf';
    let textContent = '';
    let errorMessage = '';

    if (isPdf) {
      textContent = document.body.innerText;
      if (!textContent || textContent.trim().length < 50) {
        errorMessage = 'PDF에서 텍스트를 추출할 수 없습니다. PDF 내용이 이미지이거나 복잡한 레이아웃일 수 있습니다.';
      }
    } else {
      const documentClone = document.cloneNode(true);
      const article = new window.Readability(documentClone).parse();
      textContent = article ? article.textContent : document.body.innerText;
      if (!textContent || textContent.trim().length < 50) {
        errorMessage = '웹페이지에서 유의미한 텍스트를 추출할 수 없습니다.';
      }
    }
    
    if (errorMessage) {
      doc.getElementById('st-loading-state').style.display = 'none';
      doc.getElementById('st-error-state').style.display = 'block';
      doc.getElementById('st-error-message').innerText = errorMessage;
    } else {
      chrome.runtime.sendMessage({ type: 'ANALYZE_PAGE', text: textContent, isPdf: isPdf });
    }
  };
};

// 전역으로 노출하여 background.js에서 호출 가능하도록 함
window.showSidekickSidebar = () => {
  if (!document.getElementById('sidekick-translator-root')) {
    createSidebar();
  }
};

window.hideSidekickSidebar = () => {
  const sidebarRoot = document.getElementById('sidekick-translator-root');
  if (sidebarRoot) {
    sidebarRoot.remove();
  }
};

// background.js로부터 메시지 수신 (DISPLAY_RESULTS, DISPLAY_ERROR)
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const iframe = document.getElementById('st-iframe');
  if (!iframe) return; // iframe이 없으면 처리하지 않음

  const doc = iframe.contentDocument;
  const converter = new showdown.Converter(); // Showdown.js 컨버터 초기화

  if (message.type === 'DISPLAY_RESULTS') {
    doc.getElementById('st-loading-state').style.display = 'none';
    doc.getElementById('st-result-state').style.display = 'block';
    
    // 마크다운을 HTML로 변환하여 삽입
    doc.getElementById('st-summary').innerHTML = converter.makeHtml(message.payload.summary);
    doc.getElementById('st-translation').innerHTML = converter.makeHtml(message.payload.translated_text);
  } else if (message.type === 'DISPLAY_ERROR') {
    doc.getElementById('st-loading-state').style.display = 'none';
    doc.getElementById('st-error-state').style.display = 'block';
    doc.getElementById('st-error-message').innerText = message.payload.message;
  }
});
