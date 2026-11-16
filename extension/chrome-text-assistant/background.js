const BACKEND_BASE_URL = 'http://127.0.0.1:39017';
const CONTEXT_MENU_ID = 'multitasker-suggest-text';
const GOOGLE_DOCS_MENU_ID = 'multitasker-google-docs';
const REQUEST_TIMEOUT_MS = 190_000;

chrome.runtime.onInstalled.addListener(createContextMenu);
chrome.runtime.onStartup.addListener(createContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.id) return;
  const isStandardRequest = info.menuItemId === CONTEXT_MENU_ID;
  const isGoogleDocsRequest = info.menuItemId === GOOGLE_DOCS_MENU_ID;
  if (!isStandardRequest && !isGoogleDocsRequest) return;
  const message = isGoogleDocsRequest
    ? {
        type: 'MULTITASKER_OPEN_TEXT_ASSISTANT',
        mode: 'google-docs',
        sourceText: typeof info.selectionText === 'string' ? info.selectionText : '',
      }
    : { type: 'MULTITASKER_OPEN_TEXT_ASSISTANT' };
  const options = Number.isInteger(info.frameId) ? { frameId: info.frameId } : undefined;
  chrome.tabs.sendMessage(
    tab.id,
    message,
    options,
    () => {
      // Reading lastError prevents a noisy service-worker warning on restricted pages.
      void chrome.runtime.lastError;
    },
  );
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'MULTITASKER_TEXT_REQUEST') {
    void requestTextSuggestion(message.payload)
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  if (message?.type === 'MULTITASKER_BACKEND_STATUS') {
    void getBackendStatus()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, online: false, error: errorMessage(error) }));
    return true;
  }

  if (message?.type === 'MULTITASKER_OPEN_GOOGLE_DOCS') {
    void openGoogleDocsAssistant()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: errorMessage(error) }));
    return true;
  }

  return false;
});

function createContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: CONTEXT_MENU_ID,
      title: 'Suggérer avec Multitasker',
      contexts: ['editable'],
      documentUrlPatterns: ['http://*/*', 'https://*/*', 'file:///*'],
    });
    chrome.contextMenus.create({
      id: GOOGLE_DOCS_MENU_ID,
      title: 'Suggérer avec Multitasker dans Google Docs',
      contexts: ['page', 'selection'],
      documentUrlPatterns: ['https://docs.google.com/document/*'],
    });
  });
}

async function openGoogleDocsAssistant() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://docs.google.com/document/')) {
    return { ok: false, error: 'Ouvrez d’abord un document Google Docs.' };
  }
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: 'MULTITASKER_OPEN_TEXT_ASSISTANT',
      mode: 'google-docs',
    });
  } catch {
    throw new Error('Actualisez l’onglet Google Docs après avoir chargé ou rechargé l’extension.');
  }
  return { ok: true };
}

async function requestTextSuggestion(payload) {
  const instruction = typeof payload?.instruction === 'string' ? payload.instruction : '';
  const text = typeof payload?.text === 'string' ? payload.text : '';
  const context = Array.isArray(payload?.context) ? payload.context : [];
  const response = await fetchWithTimeout(`${BACKEND_BASE_URL}/text`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ instruction, text, context }),
  });
  const responsePayload = await readJson(response);
  if (!response.ok || responsePayload?.ok !== true || typeof responsePayload.text !== 'string') {
    throw new Error(responsePayload?.error || `La suggestion a échoué (HTTP ${response.status}).`);
  }
  return { ok: true, text: responsePayload.text };
}

async function getBackendStatus() {
  const [healthResponse, settingsResponse] = await Promise.all([
    fetchWithTimeout(`${BACKEND_BASE_URL}/api/health`, {}, 4_000),
    fetchWithTimeout(`${BACKEND_BASE_URL}/api/settings`, {}, 4_000),
  ]);
  const health = await readJson(healthResponse);
  const settings = await readJson(settingsResponse);
  const online = healthResponse.ok && health?.ok === true;
  const installedPlugins = settings?.settings?.installedPlugins;
  return {
    ok: online,
    online,
    aiInstalled: Array.isArray(installedPlugins) && installedPlugins.includes('ai'),
  };
}

async function fetchWithTimeout(url, options, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error('Multitasker a pris trop de temps à répondre.');
    }
    throw new Error('Impossible de joindre Multitasker sur http://127.0.0.1:39017.');
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
