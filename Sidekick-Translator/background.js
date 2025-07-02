chrome.action.onClicked.addListener((tab) => {
  // chrome://, about: 등 특수 페이지에서는 스크립트 주입 방지
  if (tab.url?.startsWith("chrome://") || tab.url?.startsWith("about:")) {
    console.log("Sidekick-Translator: Cannot inject script on this page.");
    return;
  }

  // content_script에 메시지를 보내서 이미 주입되었는지 확인 및 토글 요청
  chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" }, (response) => {
    // 응답이 없으면 (lastError 발생) content_script가 주입되지 않은 것이므로 새로 주입
    if (chrome.runtime.lastError) {
      console.log("Sidekick-Translator: Content script not found, injecting now.", chrome.runtime.lastError.message);
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['scripts/readability.js', 'scripts/showdown.js', 'scripts/content_script.js'],
      }).then(() => {
        // 주입 후, 다시 메시지를 보내 사이드바를 열도록 함
        chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_SIDEBAR" });
      });
    } else {
      console.log("Sidekick-Translator: Content script already injected, toggled sidebar.");
    }
  });
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
  const tabId = sender.tab.id;

  if (message.type === 'ANALYZE_TEXT') {
    // 비동기 로직을 처리하기 위해 즉시 true를 반환
    (async () => {
      const tabUrl = sender.tab.url;
      const cacheKey = `cachedResult-${tabId}-${tabUrl}`;
      console.log(`[background.js] Received ${message.type} for tab ${tabId}. URL: ${tabUrl}`);

      try {
        const cached = await chrome.storage.local.get([cacheKey]);
        // force 파라미터가 true가 아니고, 캐시가 존재할 경우에만 캐시 사용
        if (!message.force && cached[cacheKey]) {
          console.log('[background.js] Serving from cache:', cacheKey);
          chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: cached[cacheKey] });
          return;
        }

        const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
        if (!geminiApiKey) {
          throw new Error('Gemini API 키가 설정되지 않았습니다. 확장 프로그램 옵션에서 설정해주세요.');
        }

        const masterPrompt = `# 페르소나 (Persona)
당신은 고도로 숙련된 정보 분석가이자 전문 번역가입니다. 당신의 임무는 사용자가 제공한 영문 텍스트의 핵심을 빠르고 정확하게 파악하여 명료한 한국어 요약문을 생성하고, 원문의 뉘앙스를 최대한 살리면서 자연스러운 한국어로 전체를 번역하는 것입니다.

# 지시사항 (Instruction)
아래 "처리할 텍스트" 부분에 제공된 내용을 분석하여, 다음 두 가지 과업을 수행해주십시오.
당신의 응답은 반드시 지정된 JSON 형식만을 포함해야 합니다. JSON 객체 외의 다른 설명, 인사, 추가 텍스트를 절대로 포함해서는 안 됩니다.

## 최종 출력 JSON 형식
모든 문자열 값은 JSON 표준에 따라 이스케이프 처리되어야 합니다 (예: 큰따옴표는 ", 줄바꿈은 \n).
{
  "summary": "이곳에는 텍스트의 핵심 주제와 결론을 담은 3~5개의 간결한 한국어 문장으로 구성된 **마크다운 형식의 글머리 기호 목록**을 넣어주세요.",
  "translated_text": "이곳에는 '처리할 텍스트'의 전체 내용을 문단 구조를 유지하며 자연스러운 한국어로 번역한 결과를 **마크다운 형식**으로 넣어주세요. 원본의 제목, 부제목, 목록 등도 마크다운 문법으로 표현해주세요."
}

# 예외 처리 규정 (Edge Case Rules)
1.  만약 "처리할 텍스트"의 내용이 3문장 미만으로 너무 짧아 유의미한 요약이 불가능할 경우, "summary" 키의 값으로 "요약하기에는 텍스트가 너무 짧습니다."를 반환하세요.
2.  만약 "처리할 텍스트"의 내용이 분석 불가능한 문자(예: 깨진 인코딩, 무작위 문자열)로 판단될 경우, "summary"와 "translated_text" 키의 값 모두에 "분석할 수 없는 콘텐츠입니다."를 반환하세요.

# 처리할 텍스트 (Text to Process)

{{사용자가 보고 있는 웹페이지에서 추출된 본문 텍스트가 이곳에 삽입됩니다.}}`;
        
        const fullPrompt = masterPrompt.replace('{{사용자가 보고 있는 웹페이지에서 추출된 본문 텍스트가 이곳에 삽입됩니다.}}', message.text);

        const requestBody = {
          contents: [{
            parts: [{ text: fullPrompt }]
          }]
        };

        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${geminiApiKey}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
          const errorData = await response.json();
          throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorData.error.message}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedTextContent = ''; // This will accumulate the actual text from parts[0].text
        let fullStreamResponse = ''; // This will accumulate the raw stream data
        let done = false;

        while (!done) {
          const { value, done: readerDone } = await reader.read();
          done = readerDone;
          const chunk = decoder.decode(value, { stream: true });
          fullStreamResponse += chunk; // Accumulate the raw stream data

          // Each chunk might contain multiple JSON objects (GenerateContentResponse)
          // Split by newline to handle multiple JSON objects in one chunk
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.trim() === '') continue;
            try {
              const parsedChunk = JSON.parse(line);
              if (parsedChunk.candidates && parsedChunk.candidates[0] && parsedChunk.candidates[0].content && parsedChunk.candidates[0].content.parts && parsedChunk.candidates[0].content.parts[0]) {
                const newText = parsedChunk.candidates[0].content.parts[0].text;
                accumulatedTextContent += newText;
                // Send partial results to sidebar.js
                chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_STREAM_CHUNK', payload: { text: newText } });
              }
            } catch (e) {
              console.warn('Could not parse stream chunk as JSON (might be partial or non-JSON data):', line, e);
            }
          }
        }

        const rawText = fullStreamResponse; // Now rawText is the full stream response for final JSON parsing
        let jsonString = rawText;

        // Check if the response is wrapped in a markdown code block
        const jsonCodeBlockMatch = rawText.match(/```json\n([\s\S]*?)\n```/);
        if (jsonCodeBlockMatch && jsonCodeBlockMatch[1]) {
          jsonString = jsonCodeBlockMatch[1];
        } else {
          // Fallback to finding the first { and last }
          const jsonStartIndex = rawText.indexOf('{');
          const jsonEndIndex = rawText.lastIndexOf('}');
          if (jsonStartIndex !== -1 && jsonEndIndex !== -1 && jsonEndIndex > jsonStartIndex) {
            jsonString = rawText.substring(jsonStartIndex, jsonEndIndex + 1);
          } else {
            throw new Error('API 응답에서 유효한 JSON 객체를 찾을 수 없습니다.');
          }
        }
        let geminiResponse;
        try {
          geminiResponse = JSON.parse(jsonString);
        } catch (parseError) {
          console.error('JSON parsing failed. Raw text:', rawText);
          console.error('Attempted JSON string:', jsonString);
          throw new Error(`JSON 파싱 오류: ${parseError.message}`);
        }

        await chrome.storage.local.set({ [cacheKey]: geminiResponse });
        console.log('[background.js] Cached result for:', cacheKey);

        chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: geminiResponse });

      } catch (error) {
        console.error('Gemini API Error:', error);
        chrome.tabs.sendMessage(tabId, {
          type: 'DISPLAY_ERROR',
          payload: { message: `API 호출에 실패했습니다: ${error.message}` },
        });
      }
    })();

    return true; // 비동기 처리를 위해 true 반환
  }
});