console.log('[background.js] Service worker loaded');

// 툴바 아이콘 클릭 이벤트 처리
chrome.action.onClicked.addListener(async (tab) => {
  console.log('[background.js] Extension icon clicked for tab:', tab.id);
  
  try {
    // content script 주입
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scripts/readability.js']
    });
    
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['scripts/content_script.js']
    });
    
    console.log('[background.js] Content scripts injected successfully');
    
    // 사이드바 토글 메시지 전송
    await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
    console.log('[background.js] Sidebar toggle message sent');
    
  } catch (error) {
    console.error('[background.js] Error:', error);
    
    // content script가 이미 주입되어 있는 경우, 바로 사이드바 토글 시도
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_SIDEBAR' });
      console.log('[background.js] Sidebar toggle message sent (fallback)');
    } catch (fallbackError) {
      console.error('[background.js] Fallback error:', fallbackError);
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get(null, (items) => {
    for (let key in items) {
      if (key.startsWith(`cachedResult-${tabId}-`)) {
        chrome.storage.local.remove(key);
      }
    }
  });
  chrome.storage.local.remove(`isSidebarOpen-${tabId}`);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab.id;

  // Export 요청 처리
  if (message.type === 'EXPORT_TO_FILE') {
    handleFileExport(message.payload, tabId);
    sendResponse({ status: "export_processing" });
    return true;
  }

  if (message.type === 'ANALYZE_TEXT') {
    (async () => {
      const tabUrl = sender.tab.url;
      const cacheKey = `cachedResult-${tabId}-${tabUrl}`;
      console.log(`[background.js] Received ${message.type} for tab ${tabId}. URL: ${tabUrl}`);

      try {
        const cached = await chrome.storage.local.get([cacheKey]);
        if (!message.force && cached[cacheKey]) {
          console.log('[background.js] Serving from cache:', cacheKey);
          chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: cached[cacheKey] });
          return;
        }

        const { geminiApiKey } = await chrome.storage.sync.get('geminiApiKey');
        if (!geminiApiKey) {
          throw new Error('Gemini API 키가 설정되지 않았습니다. 확장 프로그램 옵션에서 설정해주세요.');
        }

        // 텍스트 청킹 로직 - 5000자 단위로 분할
        const chunkSize = 5000;
        const textChunks = [];
        const originalText = message.text;
        
        console.log(`[background.js] Original text length: ${originalText.length}`);
        
        if (originalText.length <= chunkSize) {
          textChunks.push(originalText);
        } else {
          for (let i = 0; i < originalText.length; i += chunkSize) {
            let chunk = originalText.substring(i, i + chunkSize);
            
            if (i + chunkSize < originalText.length) {
              const lastSpaceIndex = chunk.lastIndexOf(' ');
              const lastNewlineIndex = chunk.lastIndexOf('\n');
              const lastBoundary = Math.max(lastSpaceIndex, lastNewlineIndex);
              
              if (lastBoundary > chunkSize * 0.8) {
                chunk = chunk.substring(0, lastBoundary + 1);
                i = i + lastBoundary + 1 - chunkSize;
              }
            }
            
            textChunks.push(chunk);
          }
        }
        
        console.log(`[background.js] Split into ${textChunks.length} chunks`);
        
        if (textChunks.length === 1) {
          await processSingleChunk(textChunks[0], tabId, geminiApiKey, cacheKey);
        } else {
          await processMultipleChunks(textChunks, tabId, geminiApiKey, cacheKey);
        }

      } catch (error) {
        console.error('[background.js] Error in ANALYZE_TEXT:', error);
        chrome.tabs.sendMessage(tabId, { type: 'ANALYSIS_ERROR', error: error.message });
      }
    })();
    
    sendResponse(true);
    return true;
  }
});

// 단일 청크 처리 함수
async function processSingleChunk(text, tabId, geminiApiKey, cacheKey) {
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

${text}`;

  const requestBody = {
    contents: [{
      parts: [{ text: masterPrompt }]
    }]
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json();
    
    // 429 에러 (할당량 초과)에 대한 특별 처리
    if (response.status === 429) {
      throw new Error(`🚫 API 사용량 제한에 도달했습니다\n\nGemini API의 무료 할당량을 모두 사용했습니다.\n• 일일 할당량이 재설정될 때까지 기다려주세요\n• 또는 Google AI Studio에서 유료 플랜을 확인해보세요\n\n자세한 정보: https://ai.google.dev/gemini-api/docs/rate-limits`);
    }
    
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorData.error.message}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedTextContent = '';
  let buffer = '';
  let done = false;
  let chunkCount = 0;

  console.log('[background.js] Starting stream processing...');
  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_START' });

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;
    chunkCount++;

    console.log(`[background.js] Chunk ${chunkCount}: ${chunk.substring(0, 100)}...`);
    
    try {
      const lines = buffer.split('\n').filter(line => line.trim());
      
      for (const line of lines) {
        if (line.startsWith('{') && line.endsWith('}')) {
          try {
            const responseObj = JSON.parse(line);
            
            if (responseObj.candidates && responseObj.candidates[0] && 
                responseObj.candidates[0].content && responseObj.candidates[0].content.parts && 
                responseObj.candidates[0].content.parts[0]) {
              
              const newText = responseObj.candidates[0].content.parts[0].text;
              accumulatedTextContent += newText;
              
              chrome.tabs.sendMessage(tabId, { 
                type: 'DISPLAY_STREAM_CHUNK', 
                payload: { text: newText } 
              });
              
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          } catch (parseError) {
            continue;
          }
        }
      }
    } catch (e) {
      console.log('[background.js] Real-time parsing failed, continuing...');
    }
  }

  console.log('[background.js] Stream complete. Processing final result...');

  // 최종 결과 파싱
  let result;
  try {
    const jsonMatch = accumulatedTextContent.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
    const jsonContent = jsonMatch ? jsonMatch[1] : accumulatedTextContent;
    result = JSON.parse(jsonContent);
  } catch (jsonError) {
    console.error('[background.js] JSON parsing error:', jsonError);
    throw new Error(`응답 처리 오류: ${jsonError.message}`);
  }

  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_END' });
  await chrome.storage.local.set({ [cacheKey]: result });
  chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: result });
}

// 여러 청크 처리 함수
async function processMultipleChunks(textChunks, tabId, geminiApiKey, cacheKey) {
  console.log(`[background.js] Processing ${textChunks.length} chunks`);
  
  const chunkPrompt = (chunkIndex, totalChunks, chunkText) => `# 페르소나 (Persona)
당신은 고도로 숙련된 정보 분석가이자 전문 번역가입니다.

# 지시사항 (Instruction)
이것은 긴 텍스트의 일부분입니다 (${chunkIndex + 1}/${totalChunks}번째 청크).
아래 텍스트를 자연스러운 한국어로 번역해주세요.
당신의 응답은 반드시 지정된 JSON 형식만을 포함해야 합니다.

## 최종 출력 JSON 형식
{
  "chunk_index": ${chunkIndex},
  "translated_text": "이곳에는 제공된 텍스트를 자연스러운 한국어로 번역한 결과를 마크다운 형식으로 넣어주세요."
}

# 처리할 텍스트 (Text to Process)

${chunkText}`;

  const chunkResults = [];
  
  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_START' });
  
  for (let i = 0; i < textChunks.length; i++) {
    console.log(`[background.js] Processing chunk ${i + 1}/${textChunks.length}`);
    
    const prompt = chunkPrompt(i, textChunks.length, textChunks[i]);
    
    try {
      const chunkResult = await processChunkWithAPI(prompt, geminiApiKey, tabId, i);
      chunkResults.push(chunkResult);
      
      chrome.tabs.sendMessage(tabId, { 
        type: 'CHUNK_PROGRESS', 
        payload: { 
          current: i + 1, 
          total: textChunks.length,
          text: chunkResult.translated_text 
        } 
      });
      
    } catch (error) {
      console.error(`[background.js] Error processing chunk ${i + 1}:`, error);
      throw error;
    }
  }
  
  const combinedResult = {
    summary: `이 문서는 ${textChunks.length}개 섹션으로 나뉘어 번역되었습니다.`,
    translated_text: chunkResults.map(chunk => chunk.translated_text).join('\n\n')
  };
  
  await chrome.storage.local.set({ [cacheKey]: combinedResult });
  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_END' });
  chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: combinedResult });
}

// 개별 청크 API 호출 함수
async function processChunkWithAPI(prompt, geminiApiKey, tabId, chunkIndex) {
  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }]
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json();
    
    // 429 에러 (할당량 초과)에 대한 특별 처리
    if (response.status === 429) {
      throw new Error(`🚫 API 사용량 제한에 도달했습니다\n\nGemini API의 무료 할당량을 모두 사용했습니다.\n• 일일 할당량이 재설정될 때까지 기다려주세요\n• 또는 Google AI Studio에서 유료 플랜을 확인해보세요\n\n자세한 정보: https://ai.google.dev/gemini-api/docs/rate-limits`);
    }
    
    throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorData.error.message}`);
  }

  const data = await response.json();
  
  if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
    throw new Error('Invalid API response structure');
  }

  const textContent = data.candidates[0].content.parts[0].text;
  
  try {
    const jsonMatch = textContent.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
    const jsonContent = jsonMatch ? jsonMatch[1] : textContent;
    
    // JSON 파싱 시도
    let result;
    try {
      result = JSON.parse(jsonContent);
    } catch (parseError) {
      // JSON 파싱 실패 시 텍스트에서 직접 추출 시도
      console.warn(`[background.js] JSON parsing failed for chunk ${chunkIndex}, attempting text extraction:`, parseError);
      
      // 텍스트에서 직접 번역 내용 추출
      const translatedTextMatch = textContent.match(/"translated_text":\s*"([^"]*(?:\\.[^"]*)*)"/) || 
                                 textContent.match(/translated_text[:\s]*([^\n]+)/);
      
      if (translatedTextMatch) {
        const extractedText = translatedTextMatch[1]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\');
        
        result = {
          chunk_index: chunkIndex,
          translated_text: extractedText
        };
        console.log(`[background.js] Successfully extracted text from chunk ${chunkIndex}`);
      } else {
        // 마지막 수단: 전체 텍스트를 번역 결과로 사용
        result = {
          chunk_index: chunkIndex,
          translated_text: textContent.replace(/```json|```/g, '').trim()
        };
        console.log(`[background.js] Used full text as fallback for chunk ${chunkIndex}`);
      }
    }
    
    return result;
  } catch (jsonError) {
    console.error(`[background.js] JSON parsing error for chunk ${chunkIndex}:`, jsonError);
    throw new Error(`청크 ${chunkIndex + 1} 처리 오류: ${jsonError.message}`);
  }
}

// 파일 export 처리 함수
async function handleFileExport(payload, tabId) {
  console.log('[background.js] Handling file export request');
  
  try {

    // 파일명 생성 (현재 날짜와 시간 포함)
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-'); // HH-MM-SS
    const safeTitle = payload.title
      .replace(/[^a-zA-Z0-9가-힣\s\-_]/g, '') // 안전한 문자만 허용
      .replace(/\s+/g, '_') // 공백을 언더스코어로 변경
      .slice(0, 30); // 길이 제한
    const fileName = `sidekick_${dateStr}_${timeStr}_${safeTitle || 'translation'}.md`;

    // 마크다운 콘텐츠 생성
    const markdownContent = `# ${payload.title}

**URL:** ${payload.url}  
**번역 일시:** ${now.toLocaleString('ko-KR')}  
**저장 위치:** 브라우저 기본 다운로드 폴더

---

## 핵심 요약

${payload.summary}

---

## 전체 번역문

${payload.translation}

---

*Generated by Sidekick Translator*
`;

    // Data URL 방식으로 파일 다운로드
    const base64Content = btoa(unescape(encodeURIComponent(markdownContent)));
    const dataUrl = `data:text/markdown;base64,${base64Content}`;
    
    chrome.downloads.download({
      url: dataUrl,
      filename: fileName,
      conflictAction: 'uniquify' // 파일명 중복 시 자동으로 번호 추가
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[background.js] Download error:', chrome.runtime.lastError);
        chrome.tabs.sendMessage(tabId, { 
          type: 'EXPORT_ERROR', 
          error: '파일 저장 중 오류가 발생했습니다: ' + chrome.runtime.lastError.message 
        });
      } else {
        console.log('[background.js] File download started with ID:', downloadId);
        chrome.tabs.sendMessage(tabId, { 
          type: 'EXPORT_SUCCESS', 
          message: `파일이 다운로드 폴더에 저장되었습니다!\n파일명: ${fileName}` 
        });
      }
    });

  } catch (error) {
    console.error('[background.js] Export error:', error);
    chrome.tabs.sendMessage(tabId, { 
      type: 'EXPORT_ERROR', 
      error: 'Export 처리 중 오류가 발생했습니다: ' + error.message 
    });
  }
}