document.addEventListener('DOMContentLoaded', () => {
  const providerSelect = document.getElementById('apiProvider');
  const apiKeyInput = document.getElementById('apiKey');
  const apiKeyHint = document.getElementById('apiKeyHint');
  const saveButton = document.getElementById('saveButton');
  const statusDiv = document.getElementById('status');

  const DEFAULT_PROVIDER = 'gemini';

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

  const allStorageKeys = [
    'apiProvider',
    providerInfo.gemini.storageKey,
    providerInfo.openai.storageKey,
    providerInfo.claude.storageKey,
    providerInfo.grok.storageKey
  ];

  function setStatus(message, type = '') {
    statusDiv.textContent = message;
    statusDiv.className = type;
  }

  function clearStatus() {
    setStatus('', '');
  }

  function getProviderConfig(provider) {
    return providerInfo[provider] || providerInfo[DEFAULT_PROVIDER];
  }

  function getStorage(keys) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.get(keys, (result) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve(result);
      });
    });
  }

  function setStorage(payload) {
    return new Promise((resolve, reject) => {
      chrome.storage.sync.set(payload, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }

        resolve();
      });
    });
  }

  function updateHint(provider) {
    const config = getProviderConfig(provider);

    apiKeyHint.textContent = config.hint;
    apiKeyInput.placeholder = `YOUR_${provider.toUpperCase()}_API_KEY`;
  }

  async function restoreProviderApiKey(provider) {
    const storageKey = getProviderConfig(provider).storageKey;

    try {
      const result = await getStorage([storageKey]);
      apiKeyInput.value = result[storageKey] || '';
    } catch (error) {
      console.error('[options.js] Failed to load API key:', error);
      setStatus(`설정 로드 실패: ${error.message}`, 'error');
    }
  }

  async function loadInitialSettings() {
    try {
      const result = await getStorage(allStorageKeys);
      const provider = result.apiProvider || DEFAULT_PROVIDER;

      providerSelect.value = provider;

      const storageKey = getProviderConfig(provider).storageKey;
      apiKeyInput.value = result[storageKey] || '';

      updateHint(provider);
      clearStatus();
    } catch (error) {
      console.error('[options.js] Failed to load settings:', error);
      setStatus(`설정 로드 실패: ${error.message}`, 'error');
      updateHint(DEFAULT_PROVIDER);
    }
  }

  providerSelect.addEventListener('change', async () => {
    const provider = providerSelect.value;

    apiKeyInput.value = '';
    clearStatus();
    updateHint(provider);

    await restoreProviderApiKey(provider);
  });

  saveButton.addEventListener('click', async () => {
    const provider = providerSelect.value;
    const apiKey = apiKeyInput.value.trim();
    const config = getProviderConfig(provider);

    if (!apiKey) {
      setStatus('API 키를 입력해주세요.', 'error');
      return;
    }

    const validationError = config.validate(apiKey);
    if (validationError) {
      setStatus(validationError, 'error');
      return;
    }

    try {
      await setStorage({
        apiProvider: provider,
        [config.storageKey]: apiKey
      });

      setStatus(`✅ ${provider.toUpperCase()} API 키가 성공적으로 저장되었습니다.`, 'success');
    } catch (error) {
      console.error('[options.js] Failed to save settings:', error);
      setStatus(`저장 실패: ${error.message}`, 'error');
    }
  });

  loadInitialSettings();
});
