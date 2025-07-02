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

        chrome.storage.sync.set({ geminiApiKey: apiKey }, () => {
            statusDiv.textContent = 'API 키가 성공적으로 저장되었습니다.';
            statusDiv.className = 'success';
        });
    });
});
