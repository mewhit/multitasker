const statusElement = document.querySelector('#status');
const statusTextElement = document.querySelector('#status-text');
const retryButton = document.querySelector('#retry');
const openDocsButton = document.querySelector('#open-docs');
const actionError = document.querySelector('#action-error');

retryButton.addEventListener('click', checkStatus);
openDocsButton.addEventListener('click', openGoogleDocs);
void checkStatus();

async function openGoogleDocs() {
  actionError.hidden = true;
  openDocsButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'MULTITASKER_OPEN_GOOGLE_DOCS' });
    if (!result?.ok) throw new Error(result?.error || 'Impossible d’ouvrir l’assistant.');
    window.close();
  } catch (error) {
    actionError.textContent = error instanceof Error ? error.message : String(error);
    actionError.hidden = false;
  } finally {
    openDocsButton.disabled = false;
  }
}

async function checkStatus() {
  setStatus('loading', 'Vérification du backend…');
  retryButton.disabled = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'MULTITASKER_BACKEND_STATUS' });
    if (!result?.online) {
      setStatus('error', 'Multitasker n’est pas démarré.');
    } else if (!result.aiInstalled) {
      setStatus('warning', 'Backend prêt — plugin AI requis.');
    } else {
      setStatus('ready', 'Prêt à suggérer du texte.');
    }
  } catch {
    setStatus('error', 'Impossible de joindre Multitasker.');
  } finally {
    retryButton.disabled = false;
  }
}

function setStatus(className, text) {
  statusElement.className = `status ${className}`;
  statusTextElement.textContent = text;
}
