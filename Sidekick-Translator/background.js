console.log('[background.js] Service worker loaded');

// Constants - 모델별 최적 청크 크기
const MODEL_CHUNK_SIZES = {
  gemini: 15000,    // Gemini 2.0 Flash는 큰 컨텍스트 처리 가능
  openai: 12000,    // GPT-4o-mini 최적화
  claude: 10000,    // Claude Sonnet 최적화
  grok: 10000       // Grok-beta 최적화
};
const CHUNK_BOUNDARY_THRESHOLD = 0.85;  // 경계 찾기 임계값 증가
const STREAMING_DELAY_MS = 10;
const MAX_RETRY_ATTEMPTS = 2;  // 부분 완성 시 재시도 횟수
const RATE_LIMIT_ERROR_MESSAGE = `🚫 API 사용량 제한에 도달했습니다

API의 무료 할당량을 모두 사용했습니다.
• 일일 할당량이 재설정될 때까지 기다려주세요
• 또는 유료 플랜을 확인해보세요`;

// ===== Robust JSON Parsing System =====

/**
 * Robust JSON 파싱 - 실패 시 여러 복구 전략 시도
 * @param {string} textContent - 파싱할 텍스트
 * @param {string} fallbackType - 'full' | 'summary' | 'chunk'
 * @returns {Object} 파싱된 객체
 */
function robustJsonParse(textContent, fallbackType = 'full') {
  try {
    // 1차: 정상 JSON 파싱
    const jsonMatch = textContent.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
    const jsonContent = jsonMatch ? jsonMatch[1] : textContent;
    return JSON.parse(jsonContent.trim());
  } catch (parseError) {
    console.warn('[robustJsonParse] Primary parsing failed, attempting recovery:', parseError.message);

    try {
      // 2차: JSON 복구 시도 (불완전한 끝부분 처리)
      const repairedJson = attemptJsonRepair(textContent);
      if (repairedJson) {
        console.log('[robustJsonParse] Successfully repaired JSON');
        return repairedJson;
      }
    } catch (repairError) {
      console.warn('[robustJsonParse] Repair failed, extracting fields:', repairError.message);
    }

    // 3차: 필드별 추출 (정규표현식)
    const extracted = extractFieldsFromText(textContent, fallbackType);
    console.log('[robustJsonParse] Field extraction result:', Object.keys(extracted));
    return extracted;
  }
}

/**
 * 불완전한 JSON 복구 시도
 * @param {string} text - 복구할 텍스트
 * @returns {Object|null} 복구된 JSON 객체 또는 null
 */
function attemptJsonRepair(text) {
  // JSON 블록 추출
  const jsonMatch = text.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
  let jsonText = (jsonMatch ? jsonMatch[1] : text).trim();

  // 빈 텍스트 체크
  if (!jsonText) return null;

  // 불완전한 문자열 닫기 시도
  const openBraces = (jsonText.match(/{/g) || []).length;
  const closeBraces = (jsonText.match(/}/g) || []).length;
  const openQuotes = (jsonText.match(/"/g) || []).length;

  // 괄호가 맞지 않으면 닫기
  if (openBraces > closeBraces) {
    // 홀수개의 따옴표가 있으면 하나 추가
    if (openQuotes % 2 === 1) {
      jsonText += '"';
    }
    // 열린 괄호만큼 닫기
    jsonText += '}'.repeat(openBraces - closeBraces);
  }

  // 마지막 불완전한 필드 제거 시도
  // 예: "field": "incomplete... 형태를 제거
  jsonText = jsonText.replace(/,\s*"[^"]*":\s*"[^"]*$/s, '');
  jsonText = jsonText.trim();

  // 마지막 쉼표 제거
  jsonText = jsonText.replace(/,(\s*[}\]])/, '$1');

  try {
    return JSON.parse(jsonText);
  } catch (e) {
    return null;
  }
}

/**
 * 텍스트에서 필드를 정규표현식으로 추출
 * @param {string} text - 추출할 텍스트
 * @param {string} type - 'full' | 'summary' | 'chunk'
 * @returns {Object} 추출된 필드들
 */
function extractFieldsFromText(text, type) {
  // 이스케이프 해제 함수
  const unescape = (str) => str
    .replace(/\\n/g, '\n')
    .replace(/\\"/g, '"')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');

  // 필드 추출 (다양한 패턴 시도)
  const summaryMatch = text.match(/"summary":\s*"([^"]*(?:\\.[^"]*)*)"/s) ||
                       text.match(/"summary":\s*'([^']*(?:\\.[^']*)*)'/s);
  const translatedMatch = text.match(/"translated_text":\s*"([^"]*(?:\\.[^"]*)*)"/s) ||
                          text.match(/"translated_text":\s*'([^']*(?:\\.[^']*)*)'/s);
  const keyPointsMatch = text.match(/"key_points":\s*"([^"]*(?:\\.[^"]*)*)"/s) ||
                         text.match(/"key_points":\s*'([^']*(?:\\.[^']*)*)'/s);
  const chunkIndexMatch = text.match(/"chunk_index":\s*(\d+)/);

  if (type === 'summary') {
    return {
      summary: summaryMatch ? unescape(summaryMatch[1]) :
               text.replace(/```json|```|{|}|"summary":|"translated_text":/g, '').trim() ||
               '⚠️ 요약을 완전히 생성하지 못했습니다. 아래 전체 번역을 참고해주세요.'
    };
  } else if (type === 'chunk') {
    return {
      chunk_index: chunkIndexMatch ? parseInt(chunkIndexMatch[1]) : 0,
      translated_text: translatedMatch ? unescape(translatedMatch[1]) :
                       text.replace(/```json|```|{|}|"[^"]*":/g, '').trim() ||
                       '⚠️ 이 부분의 번역이 불완전합니다.',
      key_points: keyPointsMatch ? unescape(keyPointsMatch[1]) : ''
    };
  } else {
    // type === 'full'
    return {
      summary: summaryMatch ? unescape(summaryMatch[1]) :
               '⚠️ 요약을 완전히 생성하지 못했습니다. 아래 전체 번역을 참고해주세요.',
      translated_text: translatedMatch ? unescape(translatedMatch[1]) :
                       text.replace(/```json|```|{|}|"summary":|"translated_text":|"key_points":/g, '').trim() ||
                       text.trim() ||
                       '⚠️ 번역이 불완전합니다.'
    };
  }
}

/**
 * 결과가 불완전한지 검사
 * @param {Object} result - 검사할 결과 객체
 * @param {string} type - 'full' | 'summary' | 'chunk'
 * @returns {boolean} 불완전하면 true
 */
function isIncompleteResult(result, type) {
  if (!result) return true;

  if (type === 'summary') {
    return !result.summary ||
           result.summary.includes('⚠️') ||
           result.summary.length < 10;
  } else if (type === 'chunk') {
    return !result.translated_text ||
           result.translated_text.includes('⚠️') ||
           result.translated_text.length < 10;
  } else {
    return !result.summary || !result.translated_text ||
           result.summary.includes('⚠️') ||
           result.translated_text.includes('⚠️') ||
           (result.summary.length < 10 && result.translated_text.length < 10);
  }
}

// Helper function to handle API rate limit errors
function handleApiError(response, errorData) {
  if (response.status === 429) {
    throw new Error(RATE_LIMIT_ERROR_MESSAGE);
  }
  const errorMessage = errorData?.error?.message || errorData?.message || JSON.stringify(errorData);
  throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorMessage}`);
}

// 스마트 청킹: 의미 있는 경계에서 텍스트 분할
function smartChunkText(text, maxChunkSize) {
  if (text.length <= maxChunkSize) {
    return [text];
  }

  const chunks = [];
  let currentPosition = 0;

  while (currentPosition < text.length) {
    let chunkEnd = currentPosition + maxChunkSize;

    // 마지막 청크인 경우
    if (chunkEnd >= text.length) {
      chunks.push(text.substring(currentPosition));
      break;
    }

    // 최적의 분할 지점 찾기 (우선순위: 단락 > 문장 > 단어)
    const searchStart = Math.floor(currentPosition + maxChunkSize * CHUNK_BOUNDARY_THRESHOLD);
    const searchText = text.substring(searchStart, chunkEnd + 500); // 약간 더 앞을 살펴봄

    // 1순위: 단락 경계 (\n\n)
    const paragraphBreak = searchText.indexOf('\n\n');
    if (paragraphBreak !== -1 && paragraphBreak < maxChunkSize * 0.3) {
      chunkEnd = searchStart + paragraphBreak + 2;
    } else {
      // 2순위: 문장 끝 (. ! ?)
      const sentenceEndings = ['. ', '.\n', '! ', '!\n', '? ', '?\n'];
      let bestSentenceEnd = -1;

      for (const ending of sentenceEndings) {
        const pos = searchText.lastIndexOf(ending);
        if (pos > bestSentenceEnd) {
          bestSentenceEnd = pos;
        }
      }

      if (bestSentenceEnd !== -1) {
        chunkEnd = searchStart + bestSentenceEnd + 2;
      } else {
        // 3순위: 단어 경계
        const lastSpace = searchText.lastIndexOf(' ');
        if (lastSpace !== -1) {
          chunkEnd = searchStart + lastSpace + 1;
        }
      }
    }

    chunks.push(text.substring(currentPosition, chunkEnd).trim());
    currentPosition = chunkEnd;
  }

  return chunks.filter(chunk => chunk.length > 0);
}

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

        // API 제공자 및 키 가져오기
        const settings = await chrome.storage.sync.get(['apiProvider', 'geminiApiKey', 'openaiApiKey', 'claudeApiKey', 'grokApiKey']);
        const provider = settings.apiProvider || 'gemini';

        const apiKeyMap = {
          gemini: settings.geminiApiKey,
          openai: settings.openaiApiKey,
          claude: settings.claudeApiKey,
          grok: settings.grokApiKey
        };

        const apiKey = apiKeyMap[provider];
        if (!apiKey) {
          throw new Error(`${provider.toUpperCase()} API 키가 설정되지 않았습니다. 확장 프로그램 옵션에서 설정해주세요.`);
        }

        // 모델별 최적 청크 크기 선택
        const CHUNK_SIZE = MODEL_CHUNK_SIZES[provider] || 10000;

        // 스마트 청킹: 의미 단위로 분할
        const textChunks = smartChunkText(message.text, CHUNK_SIZE);

        console.log(`[background.js] Original text length: ${message.text.length}`);
        console.log(`[background.js] Split into ${textChunks.length} chunks using ${provider} model (chunk size: ${CHUNK_SIZE})`);

        if (textChunks.length === 1) {
          await processSingleChunk(textChunks[0], tabId, apiKey, provider, cacheKey);
        } else {
          await processMultipleChunks(textChunks, tabId, apiKey, provider, cacheKey);
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

// 단일 청크 처리 함수 (재시도 로직 포함)
async function processSingleChunk(text, tabId, apiKey, provider, cacheKey) {
  console.log('[background.js] Starting stream processing...');
  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_START' });

  let result = null;
  let lastError = null;

  // 재시도 루프
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const isRetry = attempt > 0;
      const masterPrompt = `당신은 전문 번역가입니다. 아래 텍스트를 분석하여 JSON 형식으로 응답하세요.

**응답 형식 (JSON만):**
{
  "summary": "핵심 내용을 3-5개 글머리 기호로 요약 (마크다운 형식)",
  "translated_text": "전체 내용을 자연스러운 한국어로 번역 (마크다운 형식, 문단 구조 유지)"
}

**주의사항:**
- JSON 외 다른 텍스트 포함 금지
- 반드시 완전한 JSON 형식으로 응답하세요 (중괄호, 따옴표 누락 금지)
- 텍스트가 너무 짧으면 summary에 "요약하기에는 텍스트가 너무 짧습니다." 반환
- 분석 불가능한 내용이면 두 필드 모두 "분석할 수 없는 콘텐츠입니다." 반환
${isRetry ? '\n⚠️ 이전 시도에서 불완전한 응답을 받았습니다. 완전한 JSON을 생성해주세요.\n' : ''}
**텍스트:**

${text}`;

      // API 제공자에 따라 다른 처리
      if (provider === 'gemini') {
        result = await processGeminiSingleChunk(masterPrompt, apiKey, tabId);
      } else if (provider === 'openai') {
        result = await processOpenAISingleChunk(masterPrompt, apiKey, tabId);
      } else if (provider === 'claude') {
        result = await processClaudeSingleChunk(masterPrompt, apiKey, tabId);
      } else if (provider === 'grok') {
        result = await processGrokSingleChunk(masterPrompt, apiKey, tabId);
      }

      // 결과 검증
      if (!isIncompleteResult(result, 'full')) {
        console.log(`[background.js] Successfully processed on attempt ${attempt + 1}`);
        break; // 성공
      } else {
        console.warn(`[background.js] Incomplete result on attempt ${attempt + 1}:`, result);

        // 마지막 시도가 아니면 재시도
        if (attempt < MAX_RETRY_ATTEMPTS) {
          console.log(`[background.js] Retrying... (${attempt + 2}/${MAX_RETRY_ATTEMPTS + 1})`);
          await new Promise(resolve => setTimeout(resolve, 1000)); // 1초 대기
        } else {
          console.warn('[background.js] Max retry attempts reached, using partial result');
        }
      }
    } catch (error) {
      lastError = error;
      console.error(`[background.js] Error on attempt ${attempt + 1}:`, error);

      // 마지막 시도가 아니면 재시도
      if (attempt < MAX_RETRY_ATTEMPTS) {
        console.log(`[background.js] Retrying after error... (${attempt + 2}/${MAX_RETRY_ATTEMPTS + 1})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        throw error; // 마지막 시도에서도 실패하면 에러 throw
      }
    }
  }

  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_END' });

  // 결과가 있으면 저장하고 표시
  if (result) {
    await chrome.storage.local.set({ [cacheKey]: result });
    chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: result });
  } else {
    throw lastError || new Error('번역 처리 중 알 수 없는 오류가 발생했습니다.');
  }
}

// 여러 청크 처리 함수 - 계층적 요약 방식
async function processMultipleChunks(textChunks, tabId, apiKey, provider, cacheKey) {
  console.log(`[background.js] Processing ${textChunks.length} chunks with hierarchical summarization`);

  const chunkPrompt = (chunkIndex, totalChunks, chunkText, isRetry = false) => `청크 ${chunkIndex + 1}/${totalChunks}을 번역하고 핵심 포인트를 추출하세요.

**응답 형식 (JSON만):**
{
  "chunk_index": ${chunkIndex},
  "translated_text": "번역 내용 (마크다운 형식)",
  "key_points": "이 부분의 핵심 내용 2-3줄 요약"
}

**주의사항:**
- JSON 외 다른 텍스트 포함 금지
- 반드시 완전한 JSON 형식으로 응답하세요 (중괄호, 따옴표 누락 금지)
${isRetry ? '⚠️ 이전 시도에서 불완전한 응답을 받았습니다. 완전한 JSON을 생성해주세요.\n' : ''}
**텍스트:**

${chunkText}`;

  const chunkResults = [];
  
  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_START' });
  
  for (let i = 0; i < textChunks.length; i++) {
    console.log(`[background.js] Processing chunk ${i + 1}/${textChunks.length}`);

    let chunkResult = null;
    let lastError = null;

    // 각 청크별 재시도 루프
    for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
      try {
        const isRetry = attempt > 0;
        const prompt = chunkPrompt(i, textChunks.length, textChunks[i], isRetry);

        chunkResult = await processChunkWithAPI(prompt, apiKey, provider, tabId, i);

        // 결과 검증
        if (!isIncompleteResult(chunkResult, 'chunk')) {
          console.log(`[background.js] Chunk ${i + 1} processed successfully on attempt ${attempt + 1}`);
          break; // 성공
        } else {
          console.warn(`[background.js] Chunk ${i + 1} incomplete on attempt ${attempt + 1}`);

          if (attempt < MAX_RETRY_ATTEMPTS) {
            console.log(`[background.js] Retrying chunk ${i + 1}... (${attempt + 2}/${MAX_RETRY_ATTEMPTS + 1})`);
            await new Promise(resolve => setTimeout(resolve, 1000));
          } else {
            console.warn(`[background.js] Max retries for chunk ${i + 1}, using partial result`);
          }
        }
      } catch (error) {
        lastError = error;
        console.error(`[background.js] Error processing chunk ${i + 1} on attempt ${attempt + 1}:`, error);

        if (attempt < MAX_RETRY_ATTEMPTS) {
          console.log(`[background.js] Retrying chunk ${i + 1} after error... (${attempt + 2}/${MAX_RETRY_ATTEMPTS + 1})`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          throw error;
        }
      }
    }

    if (chunkResult) {
      chunkResults.push(chunkResult);

      chrome.tabs.sendMessage(tabId, {
        type: 'CHUNK_PROGRESS',
        payload: {
          current: i + 1,
          total: textChunks.length,
          text: chunkResult.translated_text
        }
      });
    } else {
      throw lastError || new Error(`청크 ${i + 1} 처리 실패`);
    }
  }
  
  // 계층적 요약: 각 청크의 key_points를 모아서 최종 요약 생성
  const fullTranslatedText = chunkResults.map(chunk => chunk.translated_text).join('\n\n');
  const allKeyPoints = chunkResults.map((chunk, idx) =>
    `**파트 ${idx + 1}:** ${chunk.key_points || ''}`
  ).filter(kp => kp.length > 15).join('\n');

  console.log('[background.js] Generating hierarchical summary from key points');

  // 최종 요약 생성 (재시도 로직 포함)
  let summaryResult = null;
  for (let attempt = 0; attempt <= MAX_RETRY_ATTEMPTS; attempt++) {
    try {
      const isRetry = attempt > 0;
      const summaryPrompt = `다음은 긴 문서의 각 부분에서 추출한 핵심 포인트입니다. 이를 종합하여 전체 문서의 요약을 작성하세요.

**응답 형식 (JSON만):**
{
  "summary": "3-5개 글머리 기호로 전체 문서 요약 (마크다운 형식)"
}

**주의사항:**
- JSON 외 다른 텍스트 포함 금지
- 반드시 완전한 JSON 형식으로 응답하세요 (중괄호, 따옴표 누락 금지)
${isRetry ? '⚠️ 이전 시도에서 불완전한 응답을 받았습니다. 완전한 JSON을 생성해주세요.\n' : ''}
**핵심 포인트들:**

${allKeyPoints}`;

      summaryResult = await processChunkWithAPI(summaryPrompt, apiKey, provider, tabId, -1);

      // 결과 검증
      if (!isIncompleteResult(summaryResult, 'summary')) {
        console.log(`[background.js] Summary generated successfully on attempt ${attempt + 1}`);
        break;
      } else {
        console.warn(`[background.js] Summary incomplete on attempt ${attempt + 1}`);

        if (attempt < MAX_RETRY_ATTEMPTS) {
          console.log(`[background.js] Retrying summary generation... (${attempt + 2}/${MAX_RETRY_ATTEMPTS + 1})`);
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else {
          console.warn('[background.js] Max retries for summary, using partial result');
        }
      }
    } catch (summaryError) {
      console.error(`[background.js] Error generating summary on attempt ${attempt + 1}:`, summaryError);

      if (attempt < MAX_RETRY_ATTEMPTS) {
        console.log(`[background.js] Retrying summary after error... (${attempt + 2}/${MAX_RETRY_ATTEMPTS + 1})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      } else {
        // 마지막 시도에서도 실패하면 key_points를 직접 사용
        console.warn('[background.js] Summary generation failed, using key points as fallback');
        summaryResult = {
          summary: allKeyPoints || `이 문서는 ${textChunks.length}개 섹션으로 나뉘어 번역되었습니다.`
        };
        break;
      }
    }
  }

  // 최종 결과 조합
  const combinedResult = {
    summary: summaryResult?.summary || allKeyPoints || `이 문서는 ${textChunks.length}개 섹션으로 구성되어 있습니다.`,
    translated_text: fullTranslatedText
  };

  await chrome.storage.local.set({ [cacheKey]: combinedResult });
  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_END' });
  chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: combinedResult });
}

// 개별 청크 API 호출 함수
async function processChunkWithAPI(prompt, apiKey, provider, tabId, chunkIndex) {
  let textContent;

  // API 제공자에 따라 다른 처리
  if (provider === 'gemini') {
    const requestBody = {
      contents: [{
        parts: [{ text: prompt }]
      }]
    };

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:generateContent?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json();
      handleApiError(response, errorData);
    }

    const data = await response.json();

    if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
      throw new Error('Invalid API response structure');
    }

    textContent = data.candidates[0].content.parts[0].text;
  } else if (provider === 'openai' || provider === 'grok') {
    const endpoint = provider === 'openai'
      ? 'https://api.openai.com/v1/chat/completions'
      : 'https://api.x.ai/v1/chat/completions';

    const requestBody = {
      model: provider === 'openai' ? 'gpt-4o-mini' : 'grok-beta',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7
    };

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json();
      handleApiError(response, errorData);
    }

    const data = await response.json();

    if (!data.choices || !data.choices[0] || !data.choices[0].message) {
      throw new Error('Invalid API response structure');
    }

    textContent = data.choices[0].message.content;
  } else if (provider === 'claude') {
    const requestBody = {
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }]
    };

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.json();
      handleApiError(response, errorData);
    }

    const data = await response.json();

    if (!data.content || !data.content[0] || !data.content[0].text) {
      throw new Error('Invalid API response structure');
    }

    textContent = data.content[0].text;
  }
  
  // Robust JSON 파싱 사용
  const fallbackType = chunkIndex === -1 ? 'summary' : 'chunk';
  const result = robustJsonParse(textContent, fallbackType);

  // chunk_index 추가 (chunk인 경우)
  if (chunkIndex >= 0 && !result.chunk_index) {
    result.chunk_index = chunkIndex;
  }

  return result;
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
          message: `파일이 저장되었습니다! (${fileName})` 
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

// ===== API 제공자별 스트리밍 처리 함수 =====

// Gemini 스트리밍 처리
async function processGeminiSingleChunk(prompt, apiKey, tabId) {
  const requestBody = {
    contents: [{
      parts: [{ text: prompt }]
    }]
  };

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash-exp:streamGenerateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json();
    handleApiError(response, errorData);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedTextContent = '';
  let buffer = '';
  let done = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    const chunk = decoder.decode(value, { stream: true });
    buffer += chunk;

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

              await new Promise(resolve => setTimeout(resolve, STREAMING_DELAY_MS));
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

  // 최종 결과 파싱 (Robust)
  return robustJsonParse(accumulatedTextContent, 'full');
}

// OpenAI 스트리밍 처리
async function processOpenAISingleChunk(prompt, apiKey, tabId) {
  const requestBody = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    stream: true
  };

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json();
    handleApiError(response, errorData);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedTextContent = '';
  let done = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    const chunk = decoder.decode(value, { stream: true });

    const lines = chunk.split('\n').filter(line => line.trim() && line.startsWith('data: '));

    for (const line of lines) {
      const data = line.replace('data: ', '');
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices[0]?.delta?.content;

        if (content) {
          accumulatedTextContent += content;

          chrome.tabs.sendMessage(tabId, {
            type: 'DISPLAY_STREAM_CHUNK',
            payload: { text: content }
          });

          await new Promise(resolve => setTimeout(resolve, STREAMING_DELAY_MS));
        }
      } catch (parseError) {
        continue;
      }
    }
  }

  // 최종 결과 파싱 (Robust)
  return robustJsonParse(accumulatedTextContent, 'full');
}

// Claude 스트리밍 처리
async function processClaudeSingleChunk(prompt, apiKey, tabId) {
  const requestBody = {
    model: 'claude-3-5-sonnet-20241022',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
    stream: true
  };

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json();
    handleApiError(response, errorData);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedTextContent = '';
  let done = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    const chunk = decoder.decode(value, { stream: true });

    const lines = chunk.split('\n').filter(line => line.trim() && line.startsWith('data: '));

    for (const line of lines) {
      const data = line.replace('data: ', '');

      try {
        const parsed = JSON.parse(data);

        if (parsed.type === 'content_block_delta' && parsed.delta?.text) {
          const content = parsed.delta.text;
          accumulatedTextContent += content;

          chrome.tabs.sendMessage(tabId, {
            type: 'DISPLAY_STREAM_CHUNK',
            payload: { text: content }
          });

          await new Promise(resolve => setTimeout(resolve, STREAMING_DELAY_MS));
        }
      } catch (parseError) {
        continue;
      }
    }
  }

  // 최종 결과 파싱 (Robust)
  return robustJsonParse(accumulatedTextContent, 'full');
}

// Grok 스트리밍 처리 (OpenAI 호환)
async function processGrokSingleChunk(prompt, apiKey, tabId) {
  const requestBody = {
    model: 'grok-beta',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
    stream: true
  };

  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const errorData = await response.json();
    handleApiError(response, errorData);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let accumulatedTextContent = '';
  let done = false;

  while (!done) {
    const { value, done: readerDone } = await reader.read();
    done = readerDone;
    const chunk = decoder.decode(value, { stream: true });

    const lines = chunk.split('\n').filter(line => line.trim() && line.startsWith('data: '));

    for (const line of lines) {
      const data = line.replace('data: ', '');
      if (data === '[DONE]') continue;

      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices[0]?.delta?.content;

        if (content) {
          accumulatedTextContent += content;

          chrome.tabs.sendMessage(tabId, {
            type: 'DISPLAY_STREAM_CHUNK',
            payload: { text: content }
          });

          await new Promise(resolve => setTimeout(resolve, STREAMING_DELAY_MS));
        }
      } catch (parseError) {
        continue;
      }
    }
  }

  // 최종 결과 파싱 (Robust)
  return robustJsonParse(accumulatedTextContent, 'full');
}