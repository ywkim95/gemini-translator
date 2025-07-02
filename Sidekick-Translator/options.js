document.addEventListener('DOMContentLoaded', () => {
    const apiKeyInput = document.getElementById('geminiApiKey');
    const exportPathInput = document.getElementById('exportPath');
    const saveButton = document.getElementById('saveButton');
    const statusDiv = document.getElementById('status');

    // 저장된 설정 불러오기
    chrome.storage.sync.get(['geminiApiKey', 'exportPath'], (result) => {
        if (result.geminiApiKey) {
            apiKeyInput.value = result.geminiApiKey;
        }
        if (result.exportPath) {
            exportPathInput.value = result.exportPath;
        }
    });

    // 저장 버튼 클릭 이벤트
    saveButton.addEventListener('click', () => {
        const apiKey = apiKeyInput.value.trim();
        const exportPath = exportPathInput.value.trim();
        
        if (!apiKey) {
            statusDiv.textContent = 'API 키를 입력해주세요.';
            statusDiv.className = 'error';
            return;
        }

        // 설정 저장
        const settings = { geminiApiKey: apiKey };
        if (exportPath) {
            settings.exportPath = exportPath;
        }

        chrome.storage.sync.set(settings, () => {
            let message = 'API 키가 성공적으로 저장되었습니다.';
            if (exportPath) {
                message += ' Export 경로도 저장되었습니다.';
            }
            statusDiv.textContent = message;
            statusDiv.className = 'success';
        });
    });
});
