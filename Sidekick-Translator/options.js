document.addEventListener('DOMContentLoaded', () => {
    const providerSelect = document.getElementById('apiProvider');
    const apiKeyInput = document.getElementById('apiKey');
    const apiKeyHint = document.getElementById('apiKeyHint');
    const saveButton = document.getElementById('saveButton');
    const statusDiv = document.getElementById('status');

    // API 제공자별 힌트 및 검증 규칙
    const providerInfo = {
        gemini: {
            hint: '예: AIzaSyD... (39자, "AIza"로 시작)',
            storageKey: 'geminiApiKey',
            validate: (key) => {
                if (!key.startsWith('AIza')) {
                    return '⚠️ Gemini API 키는 "AIza"로 시작해야 합니다.';
                }
                if (key.length !== 39) {
                    return `⚠️ Gemini API 키는 39자여야 합니다. (현재: ${key.length}자)`;
                }
                if (!/^[A-Za-z0-9_-]+$/.test(key)) {
                    return '⚠️ API 키에 허용되지 않는 문자가 포함되어 있습니다.';
                }
                return null;
            }
        },
        openai: {
            hint: '예: sk-proj-... 또는 sk-... (OpenAI API 키)',
            storageKey: 'openaiApiKey',
            validate: (key) => {
                if (!key.startsWith('sk-')) {
                    return '⚠️ OpenAI API 키는 "sk-"로 시작해야 합니다.';
                }
                if (key.length < 20) {
                    return '⚠️ API 키가 너무 짧습니다.';
                }
                return null;
            }
        },
        claude: {
            hint: '예: sk-ant-... (Anthropic API 키)',
            storageKey: 'claudeApiKey',
            validate: (key) => {
                if (!key.startsWith('sk-ant-')) {
                    return '⚠️ Claude API 키는 "sk-ant-"로 시작해야 합니다.';
                }
                if (key.length < 20) {
                    return '⚠️ API 키가 너무 짧습니다.';
                }
                return null;
            }
        },
        grok: {
            hint: '예: xai-... (xAI API 키)',
            storageKey: 'grokApiKey',
            validate: (key) => {
                if (!key.startsWith('xai-')) {
                    return '⚠️ Grok API 키는 "xai-"로 시작해야 합니다.';
                }
                if (key.length < 20) {
                    return '⚠️ API 키가 너무 짧습니다.';
                }
                return null;
            }
        }
    };

    // 제공자 변경 시 힌트 업데이트
    function updateHint() {
        const provider = providerSelect.value;
        apiKeyHint.textContent = providerInfo[provider].hint;
        apiKeyInput.placeholder = `YOUR_${provider.toUpperCase()}_API_KEY`;
    }

    // 저장된 설정 불러오기
    chrome.storage.sync.get(['apiProvider', 'geminiApiKey', 'openaiApiKey', 'claudeApiKey', 'grokApiKey'], (result) => {
        // 선택된 제공자 복원
        if (result.apiProvider) {
            providerSelect.value = result.apiProvider;
        }

        // 현재 선택된 제공자의 API 키 복원
        const currentProvider = providerSelect.value;
        const storageKey = providerInfo[currentProvider].storageKey;
        if (result[storageKey]) {
            apiKeyInput.value = result[storageKey];
        }

        updateHint();
    });

    // 제공자 변경 이벤트
    providerSelect.addEventListener('change', () => {
        const provider = providerSelect.value;
        const storageKey = providerInfo[provider].storageKey;

        // 기존 입력 필드 초기화
        apiKeyInput.value = '';
        statusDiv.textContent = '';

        // 선택된 제공자의 저장된 API 키 불러오기
        chrome.storage.sync.get([storageKey], (result) => {
            if (result[storageKey]) {
                apiKeyInput.value = result[storageKey];
            }
        });

        updateHint();
    });

    // 저장 버튼 클릭 이벤트
    saveButton.addEventListener('click', () => {
        const provider = providerSelect.value;
        const apiKey = apiKeyInput.value.trim();

        if (!apiKey) {
            statusDiv.textContent = 'API 키를 입력해주세요.';
            statusDiv.className = 'error';
            return;
        }

        // API 키 검증
        const validationError = providerInfo[provider].validate(apiKey);
        if (validationError) {
            statusDiv.textContent = validationError;
            statusDiv.className = 'error';
            return;
        }

        // API 제공자와 API 키 저장
        const storageKey = providerInfo[provider].storageKey;
        chrome.storage.sync.set({
            apiProvider: provider,
            [storageKey]: apiKey
        }, () => {
            statusDiv.textContent = `✅ ${provider.toUpperCase()} API 키가 성공적으로 저장되었습니다.`;
            statusDiv.className = 'success';
        });
    });
});
