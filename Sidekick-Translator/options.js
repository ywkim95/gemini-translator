document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('geminiApiKey');
    const saveButton = document.getElementById('saveButton');
    const statusDiv = document.getElementById('status');

    // 저장된 API 키 불러오기
    chrome.storage.sync.get(['geminiApiKey'], (result) => {
        if (result.geminiApiKey) {
            apiKeyInput.value = result.geminiApiKey;
        }
    });

    // 저장 버튼 클릭 이벤트
    saveButton.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();

        if (!apiKey) {
            statusDiv.textContent = 'API 키를 입력해주세요.';
            statusDiv.className = 'error';
            return;
        }

        // Gemini API 키 형식 검증 (AIza로 시작하고 39자)
        if (!apiKey.startsWith('AIza')) {
            statusDiv.textContent = '⚠️ API 키 형식이 올바르지 않습니다. Gemini API 키는 "AIza"로 시작해야 합니다.';
            statusDiv.className = 'error';
            return;
        }

        if (apiKey.length !== 39) {
            statusDiv.textContent = `⚠️ API 키 길이가 올바르지 않습니다. (입력: ${apiKey.length}자, 필요: 39자)`;
            statusDiv.className = 'error';
            return;
        }

        // 영숫자와 일부 특수문자만 포함하는지 검증
        if (!/^[A-Za-z0-9_-]+$/.test(apiKey)) {
            statusDiv.textContent = '⚠️ API 키에 허용되지 않는 문자가 포함되어 있습니다.';
            statusDiv.className = 'error';
            return;
        }

        chrome.storage.sync.set({ geminiApiKey: apiKey }, () => {
            statusDiv.textContent = '✅ API 키가 성공적으로 저장되었습니다.';
            statusDiv.className = 'success';
        });
    });
});
