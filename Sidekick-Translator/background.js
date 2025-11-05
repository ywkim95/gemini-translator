console.log('[background.js] Service worker loaded');

// Constants
const CHUNK_SIZE = 5000;
const CHUNK_BOUNDARY_THRESHOLD = 0.8;
const STREAMING_DELAY_MS = 10;
const RATE_LIMIT_ERROR_MESSAGE = `🚫 API 사용량 제한에 도달했습니다

API의 무료 할당량을 모두 사용했습니다.
• 일일 할당량이 재설정될 때까지 기다려주세요
• 또는 유료 플랜을 확인해보세요`;

// Helper function to handle API rate limit errors
function handleApiError(response, errorData) {
  if (response.status === 429) {
    throw new Error(RATE_LIMIT_ERROR_MESSAGE);
  }
  const errorMessage = errorData?.error?.message || errorData?.message || JSON.stringify(errorData);
  throw new Error(`API Error: ${response.status} ${response.statusText} - ${errorMessage}`);
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

        // 텍스트 청킹 로직 - CHUNK_SIZE 단위로 분할
        const textChunks = [];
        const originalText = message.text;

        console.log(`[background.js] Original text length: ${originalText.length}`);

        if (originalText.length <= CHUNK_SIZE) {
          textChunks.push(originalText);
        } else {
          for (let i = 0; i < originalText.length; i += CHUNK_SIZE) {
            let chunk = originalText.substring(i, i + CHUNK_SIZE);

            if (i + CHUNK_SIZE < originalText.length) {
              const lastSpaceIndex = chunk.lastIndexOf(' ');
              const lastNewlineIndex = chunk.lastIndexOf('\n');
              const lastBoundary = Math.max(lastSpaceIndex, lastNewlineIndex);

              if (lastBoundary > CHUNK_SIZE * CHUNK_BOUNDARY_THRESHOLD) {
                chunk = chunk.substring(0, lastBoundary + 1);
                i = i + lastBoundary + 1 - CHUNK_SIZE;
              }
            }

            textChunks.push(chunk);
          }
        }
        
        console.log(`[background.js] Split into ${textChunks.length} chunks`);

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

// 단일 청크 처리 함수
async function processSingleChunk(text, tabId, apiKey, provider, cacheKey) {
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

  console.log('[background.js] Starting stream processing...');
  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_START' });

  let result;

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

  chrome.tabs.sendMessage(tabId, { type: 'STREAMING_END' });
  await chrome.storage.local.set({ [cacheKey]: result });
  chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: result });
}

// 여러 청크 처리 함수
async function processMultipleChunks(textChunks, tabId, apiKey, provider, cacheKey) {
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
      const chunkResult = await processChunkWithAPI(prompt, apiKey, provider, tabId, i);
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
  
  // 모든 청크 번역 완료 후 전체 내용으로 요약 생성
  const fullTranslatedText = chunkResults.map(chunk => chunk.translated_text).join('\n\n');
  
  console.log('[background.js] Generating summary for combined chunks');
  
  try {
    // 요약 생성을 위한 별도 API 호출
    const summaryPrompt = `# 페르소나 (Persona)
당신은 고도로 숙련된 정보 분석가입니다.

# 지시사항 (Instruction)
아래 번역된 긴 텍스트를 읽고 핵심 내용을 간결하게 요약해주세요.
당신의 응답은 반드시 지정된 JSON 형식만을 포함해야 합니다.

## 최종 출력 JSON 형식
{
  "summary": "이곳에는 문서의 핵심 내용을 3-5줄로 간결하게 요약한 결과를 마크다운 형식으로 넣어주세요."
}

# 요약할 번역 텍스트 (Text to Summarize)

${fullTranslatedText}`;

    const summaryResult = await processChunkWithAPI(summaryPrompt, apiKey, provider, tabId, -1);
    
    const combinedResult = {
      summary: summaryResult.summary || summaryResult.translated_text || `이 문서는 ${textChunks.length}개 섹션으로 나뉘어 번역되었습니다.`,
      translated_text: fullTranslatedText
    };
    
    await chrome.storage.local.set({ [cacheKey]: combinedResult });
    chrome.tabs.sendMessage(tabId, { type: 'STREAMING_END' });
    chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: combinedResult });
    
  } catch (summaryError) {
    console.error('[background.js] Error generating summary:', summaryError);
    
    // 요약 생성 실패 시 기본 결과 사용
    const combinedResult = {
      summary: `이 문서는 ${textChunks.length}개 섹션으로 나뉘어 번역되었습니다.`,
      translated_text: fullTranslatedText
    };
    
    await chrome.storage.local.set({ [cacheKey]: combinedResult });
    chrome.tabs.sendMessage(tabId, { type: 'STREAMING_END' });
    chrome.tabs.sendMessage(tabId, { type: 'DISPLAY_RESULTS', payload: combinedResult });
  }
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

    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
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
      
      // 요약 생성용인지 번역용인지 구분하여 처리
      if (chunkIndex === -1) {
        // 요약 생성용
        const summaryMatch = textContent.match(/"summary":\s*"([^"]*(?:\\.[^"]*)*)"/) || 
                            textContent.match(/summary[:\s]*([^\n]+)/);
        
        if (summaryMatch) {
          const extractedSummary = summaryMatch[1]
            .replace(/\\n/g, '\n')
            .replace(/\\"/g, '"')
            .replace(/\\t/g, '\t')
            .replace(/\\\\/g, '\\');
          
          result = {
            summary: extractedSummary
          };
          console.log(`[background.js] Successfully extracted summary`);
        } else {
          result = {
            summary: textContent.replace(/```json|```/g, '').trim()
          };
          console.log(`[background.js] Used full text as summary fallback`);
        }
      } else {
        // 번역용
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

  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:streamGenerateContent?key=${apiKey}`, {
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

  // 최종 결과 파싱
  const jsonMatch = accumulatedTextContent.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
  const jsonContent = jsonMatch ? jsonMatch[1] : accumulatedTextContent;
  return JSON.parse(jsonContent);
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

  // 최종 결과 파싱
  const jsonMatch = accumulatedTextContent.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
  const jsonContent = jsonMatch ? jsonMatch[1] : accumulatedTextContent;
  return JSON.parse(jsonContent);
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

  // 최종 결과 파싱
  const jsonMatch = accumulatedTextContent.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
  const jsonContent = jsonMatch ? jsonMatch[1] : accumulatedTextContent;
  return JSON.parse(jsonContent);
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

  // 최종 결과 파싱
  const jsonMatch = accumulatedTextContent.match(/```json\s*\n?([\s\S]*?)(?:\n?```|$)/);
  const jsonContent = jsonMatch ? jsonMatch[1] : accumulatedTextContent;
  return JSON.parse(jsonContent);
}