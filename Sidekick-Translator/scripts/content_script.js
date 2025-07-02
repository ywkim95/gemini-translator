(() => {
  // 중복 주입 방지
  if (window.isSidekickInjected) {
    return;
  }
  window.isSidekickInjected = true;

  let sidebarIframe = null;

  const createSidebar = () => {
    sidebarIframe = document.createElement('iframe');
    sidebarIframe.id = 'sidekick-translator-iframe';
    sidebarIframe.src = chrome.runtime.getURL('ui/sidebar.html');
    sidebarIframe.style.cssText = `
      position: fixed !important;
      top: 0 !important;
      right: 0 !important;
      height: 100% !important;
      width: 600px !important; /* 기본 너비 */
      min-width: 300px !important;
      max-width: 90vw !important;
      border: none !important;
      z-index: 2147483647 !important;
      box-shadow: -2px 0 15px rgba(0,0,0,0.2) !important;
      transition: width 0.2s ease-in-out !important;
    `;
    document.body.appendChild(sidebarIframe);
  };

  const toggleSidebar = () => {
    if (sidebarIframe && document.body.contains(sidebarIframe)) {
      sidebarIframe.remove();
    } else {
      createSidebar();
    }
  };

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'TOGGLE_SIDEBAR') {
      toggleSidebar();
      sendResponse({ status: "toggled" });
      return true;
    } 
    
    // "ANALYZE_PAGE" 요청을 받으면 Readability.js로 본문을 추출하여 background.js로 보냄
    if (message.type === 'ANALYZE_PAGE') {
        console.log("[content_script.js] Received ANALYZE_PAGE request.");
        try {
            if (typeof Readability === 'undefined') {
                throw new Error('Readability library not available.');
            }
            const documentClone = document.cloneNode(true);
            const article = new Readability(documentClone).parse();
            const textContent = article ? article.textContent : document.body.innerText;

            if (!textContent || textContent.trim().length < 100) {
                 throw new Error('Could not extract meaningful text from the page.');
            }
            
            // background.js로 추출한 텍스트를 보내 분석 요청
            chrome.runtime.sendMessage({ type: "ANALYZE_TEXT", text: textContent });
            sendResponse({ status: "analysis_started" });

        } catch (error) {
            console.error("[content_script.js] Error extracting text:", error);
            // 에러를 sidebar.js로 다시 보냄
            if (sidebarIframe && sidebarIframe.contentWindow) {
                sidebarIframe.contentWindow.postMessage({ type: 'DISPLAY_ERROR', payload: { message: error.message } }, '*');
            }
            sendResponse({ status: "error", error: error.message });
        }
        return true; // 비동기 응답
    }
  });

  // sidebar.js로부터 메시지 수신 (iframe 내부)
  window.addEventListener('message', (event) => {
    // 메시지 소스가 현재 페이지에 추가된 iframe인지 확인
    if (!sidebarIframe || event.source !== sidebarIframe.contentWindow) {
      return;
    }

    if (event.data.type === 'CLOSE_SIDEKICK_SIDEBAR') {
      toggleSidebar();
    } else if (event.data.type === 'RESIZE_SIDEBAR') {
      if (sidebarIframe) {
        sidebarIframe.style.width = event.data.width;
      }
    }
  });

})();