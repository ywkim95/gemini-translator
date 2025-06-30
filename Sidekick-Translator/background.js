chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab.id;
  const { [`isSidebarOpen-${tabId}`]: isSidebarOpen } = await chrome.storage.local.get([`isSidebarOpen-${tabId}`]);
  console.log(`[background.js] Toolbar icon clicked. Current isSidebarOpen for tab ${tabId}:`, isSidebarOpen);

  if (!isSidebarOpen) {
    console.log(`[background.js] Sidebar is NOT open. Injecting content_script.js for tab ${tabId}.`);
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['scripts/readability.js', 'scripts/showdown.js', 'scripts/content_script.js'],
    });
    // content_script가 주입된 후, 해당 탭에서 showSidekickSidebar 함수를 실행
    await chrome.scripting.executeScript({
      target: { tabId },
      function: () => window.showSidekickSidebar(),
    });
    await chrome.storage.local.set({ [`isSidebarOpen-${tabId}`]: true });
    console.log(`[background.js] isSidebarOpen for tab ${tabId} set to true.`);
  } else {
    console.log(`[background.js] Sidebar IS open. Executing hideSidekickSidebar for tab ${tabId}.`);
    try {
      // content_script가 주입된 탭에서 hideSidekickSidebar 함수를 실행
      await chrome.scripting.executeScript({
        target: { tabId },
        function: () => window.hideSidekickSidebar(),
      });
      console.log(`[background.js] hideSidekickSidebar executed successfully for tab ${tabId}.`);
    } catch (error) {
      console.warn(`[background.js] Failed to execute hideSidekickSidebar for tab ${tabId}:`, error.message);
    }
    await chrome.storage.local.set({ [`isSidebarOpen-${tabId}`]: false });
    console.log(`[background.js] isSidebarOpen for tab ${tabId} set to false.`);
  }
});

// 탭 업데이트 시 캐시 지우기
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    // URL이 변경되면 해당 탭의 모든 캐시를 지움
    console.log(`[background.js] Tab ${tabId} URL updated to ${tab.url}. Clearing cache.`);
    chrome.storage.local.remove(`cachedResult-${tabId}-${tab.url}`);
    // URL 변경 시 사이드바 상태도 초기화
    chrome.storage.local.set({ [`isSidebarOpen-${tabId}`]: false });
  }
});

// 탭 제거 시 캐시 지우기
chrome.tabs.onRemoved.addListener((tabId) => {
  console.log(`[background.js] Tab ${tabId} removed. Clearing associated cache and sidebar state.`);
  chrome.storage.local.get(null, (items) => {
    for (let key in items) {
      if (key.startsWith(`cachedResult-${tabId}-`)) {
        chrome.storage.local.remove(key);
      }
    }
  });
  chrome.storage.local.remove(`isSidebarOpen-${tabId}`); // 탭 제거 시 isSidebarOpen 상태도 제거
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'ANALYZE_PAGE') {
    const tabId = sender.tab.id;
    const tabUrl = sender.tab.url;
    const cacheKey = `cachedResult-${tabId}-${tabUrl}`;
    console.log(`[background.js] Received ANALYZE_PAGE message from tab ${tabId}. URL: ${tabUrl}`);

    chrome.storage.local.get([cacheKey], async (cachedResult) => {
      if (cachedResult[cacheKey]) {
        // 캐시된 결과가 있으면 즉시 반환
        console.log('[background.js] Serving from cache:', cacheKey);
        chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: cachedResult[cacheKey] });
        return;
      }

      chrome.storage.sync.get(['geminiApiKey'], async (result) => {
        const GEMINI_API_KEY = result.geminiApiKey;

        if (!GEMINI_API_KEY) {
          console.error('[background.js] Gemini API Key not set.');
          chrome.tabs.sendMessage(tabId, {
            type: 'DISPLAY_ERROR',
            payload: { message: 'Gemini API 키가 설정되지 않았습니다. 확장 프로그램 옵션에서 설정해주세요.' },
          });
          return;
        }

        let masterPrompt;
        if (message.isPdf) {
          masterPrompt = `\n# 페르소나 (Persona)\n당신은 고도로 숙련된 정보 분석가입니다. 당신의 임무는 사용자에게 제공된 PDF 텍스트의 핵심을 빠르고 정확하게 파악하여 명료한 한국어 요약문을 생성하는 것입니다.\n\n# 지시사항 (Instruction)\n아래 "처리할 텍스트" 부분에 제공된 내용을 분석하여, 다음 과업을 수행해주십시오.\n당신의 응답은 반드시 지정된 JSON 형식만을 포함해야 합니다. JSON 객체 외의 다른 설명, 인사, 추가 텍스트를 절대로 포함해서는 안 됩니다.\n\n## 최종 출력 JSON 형식\n{\n  "summary": "이곳에는 텍스트의 핵심 주제와 결론을 담은 3~5개의 간결한 한국어 문장으로 구성된 **마크다운 형식의 글머리 기호 목록**을 넣어주세요.",\n  "translated_text": "PDF 문서이므로 번역을 제공하지 않습니다."\n}\n\n# 예외 처리 규정 (Edge Case Rules)\n1. 만약 "처리할 텍스트"의 내용이 3문장 미만으로 너무 짧아 유의미한 요약이 불가능할 경우, "summary" 키의 값으로 "요약하기에는 텍스트가 너무 짧습니다."를 반환하세요.\n2. 만약 "처리할 텍스트"의 내용이 분석 불가능한 문자(예: 깨진 인코딩, 무작위 문자열)로 판단될 경우, "summary"와 "translated_text" 키의 값 모두에 "분석할 수 없는 콘텐츠입니다."를 반환하세요.\n\n# 처리할 텍스트 (Text to Process)\n\n${message.text}\n          `;
        } else {
          masterPrompt = `\n# 페르소나 (Persona)\n당신은 고도로 숙련된 정보 분석가이자 전문 번역가입니다. 당신의 임무는 사용자가 제공한 영문 텍스트의 핵심을 빠르고 정확하게 파악하여 명료한 한국어 요약문을 생성하고, 원문의 뉘앙스를 최대한 살리면서 자연스러운 한국어로 전체를 번역하는 것입니다.\n\n# 지시사항 (Instruction)\n아래 "처리할 텍스트" 부분에 제공된 내용을 분석하여, 다음 두 가지 과업을 수행해주십시오.\n당신의 응답은 반드시 지정된 JSON 형식만을 포함해야 합니다. JSON 객체 외의 다른 설명, 인사, 추가 텍스트를 절대로 포함해서는 안 됩니다.\n\n## 최종 출력 JSON 형식\n{\n  "summary": "이곳에는 텍스트의 핵심 주제와 결론을 담은 3~5개의 간결한 한국어 문장으로 구성된 **마크다운 형식의 글머리 기호 목록**을 넣어주세요.",\n  "translated_text": "이곳에는 '처리할 텍스트'의 전체 내용을 문단 구조를 유지하며 자연스러운 한국어로 번역한 결과를 **마크다운 형식**으로 넣어주세요. 원본의 제목, 부제목, 목록 등도 마크다운 문법으로 표현해주세요."\n}\n\n# 예외 처리 규정 (Edge Case Rules)\n1. 만약 "처리할 텍스트"의 내용이 3문장 미만으로 너무 짧아 유의미한 요약이 불가능할 경우, "summary" 키의 값으로 "요약하기에는 텍스트가 너무 짧습니다."를 반환하세요.\n2. 만약 "처리할 텍스트"의 내용이 분석 불가능한 문자(예: 깨진 인코딩, 무작위 문자열)로 판단될 경우, "summary"와 "translated_text" 키의 값 모두에 "분석할 수 없는 콘텐츠입니다."를 반환하세요.\n\n# 처리할 텍스트 (Text to Process)\n\n${message.text}\n          `;
        }

        try {
          const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              contents: [{
                parts: [{
                  text: masterPrompt
                }]
              }],
              generationConfig: {
                responseMimeType: "application/json",
                maxOutputTokens: 8192 // 응답 길이 제한을 8192로 증가
              }
            }),
          });

          const data = await response.json();

          if (data.error) {
            throw new Error(data.error.message || 'API 호출 중 오류가 발생했습니다.');
          }
          
          let geminiResponse;
          try {
            // Gemini API 응답 구조에 따라 파싱
            // candidates[0].content.parts[0].text 경로가 유효한지 확인
            if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
              const rawText = data.candidates[0].content.parts[0].text;
              
              // 유효하지 않은 이스케이프 문자를 수정 (예: 백슬래시 뒤에 유효하지 않은 문자)
              // JSON.parse가 실패하는 주된 원인 중 하나인 `\` 뒤에 유효하지 않은 문자가 오는 경우를 처리
              const cleanedText = rawText.replace(/\\(?!["\\/bfnrtu])/g, '\\');

              // 정규 표현식을 사용하여 유효한 JSON 객체 문자열 추출
              const jsonMatch = cleanedText.match(/{[\s\S]*}/);
              
              if (jsonMatch && jsonMatch[0]) {
                const jsonString = jsonMatch[0];
                geminiResponse = JSON.parse(jsonString);
              } else {
                throw new Error('Gemini API 응답에서 유효한 JSON 객체를 찾을 수 없습니다.');
              }
            } else {
              throw new Error('Gemini API 응답 형식이 예상과 다릅니다.');
            }
          } catch (parseError) {
            console.error('JSON 파싱 오류:', parseError, '원본 응답:', data.candidates ? data.candidates[0].content.parts[0].text : data);
            throw new Error(`Gemini 응답 파싱 실패: ${parseError.message}. 원본: ${data.candidates ? data.candidates[0].content.parts[0].text.substring(0, 200) + '...' : JSON.stringify(data).substring(0, 200) + '...'}`);
          }

          // 결과를 캐시에 저장
          chrome.storage.local.set({ [cacheKey]: geminiResponse });
          console.log('[background.js] Cached result for:', cacheKey);

          chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: geminiResponse });
        } catch (error) {
          console.error('Gemini API Error:', error);
          chrome.tabs.sendMessage(tabId, {
            type: 'DISPLAY_ERROR',
            payload: { message: `API 호출에 실패했습니다: ${error.message}` },
          });
        }
      });
    });
    return true; // 비동기 응답을 위해 true 반환
  } else if (message.type === 'UPDATE_SIDEBAR_STATE') {
    // content_script에서 보낸 사이드바 상태 업데이트 메시지 처리
    console.log(`[background.js] Received UPDATE_SIDEBAR_STATE message from tab ${sender.tab.id}. Setting isSidebarOpen to ${message.isSidebarOpen}.`);
    chrome.storage.local.set({ [`isSidebarOpen-${sender.tab.id}`]: message.isSidebarOpen });
  }
});