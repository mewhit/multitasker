(() => {
  const HOST_ID = 'multitasker-text-assistant-root';
  const DEFAULT_INSTRUCTION = 'Améliore ce texte pour qu’il soit clair, naturel et prêt à envoyer. Conserve sa langue, son sens, son ton et ses détails factuels.';
  const SUPPORTED_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel']);

  let lastEditableTarget = null;
  let modalSession = null;

  document.addEventListener('contextmenu', event => {
    lastEditableTarget = findEditableTarget(event.composedPath());
  }, true);

  chrome.runtime.onMessage.addListener(message => {
    if (message?.type !== 'MULTITASKER_OPEN_TEXT_ASSISTANT') return;
    openAssistant(lastEditableTarget, {
      googleDocs: message.mode === 'google-docs',
      sourceText: typeof message.sourceText === 'string' ? message.sourceText : '',
    });
  });

  function openAssistant(candidate, options = {}) {
    closeAssistant();

    const googleDocs = options.googleDocs === true;
    const target = googleDocs
      ? null
      : (isUsableTarget(candidate) ? candidate : findActiveEditableTarget());
    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.cssText = 'all: initial; position: fixed; inset: 0; z-index: 2147483647;';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = modalMarkup();
    (document.documentElement || document.body).appendChild(host);

    const elements = {
      overlay: shadow.querySelector('.overlay'),
      dialog: shadow.querySelector('.dialog'),
      close: shadow.querySelector('[data-action="close"]'),
      title: shadow.querySelector('#mt-title'),
      sourceLabel: shadow.querySelector('label[for="mt-source"]'),
      source: shadow.querySelector('#mt-source'),
      instruction: shadow.querySelector('#mt-instruction'),
      generate: shadow.querySelector('[data-action="generate"]'),
      history: shadow.querySelector('#mt-history'),
      result: shadow.querySelector('#mt-result'),
      followup: shadow.querySelector('#mt-followup'),
      refine: shadow.querySelector('[data-action="refine"]'),
      use: shadow.querySelector('[data-action="use"]'),
      copy: shadow.querySelector('[data-action="copy"]'),
      error: shadow.querySelector('#mt-error'),
      loading: shadow.querySelector('#mt-loading'),
      targetNotice: shadow.querySelector('#mt-target-notice'),
      docsHelp: shadow.querySelector('#mt-docs-help'),
    };

    const session = {
      host,
      target,
      elements,
      messages: [],
      turns: [],
      loading: false,
      destroyed: false,
      googleDocs,
    };
    modalSession = session;

    elements.instruction.value = DEFAULT_INSTRUCTION;
    elements.source.value = options.sourceText || (target ? readEditableText(target) : readSelectedPageText());
    bindModalEvents(session);

    if (!target && !googleDocs) {
      showError(session, 'Aucun champ de texte modifiable n’a été trouvé. Refaites un clic droit directement dans le champ.');
      elements.targetNotice.textContent = 'Champ introuvable';
      elements.generate.disabled = true;
      elements.use.disabled = true;
      elements.instruction.focus();
      return;
    }

    if (isSensitiveTarget(target)) {
      showError(session, 'Les champs de mot de passe sont volontairement exclus pour protéger vos données.');
      elements.targetNotice.textContent = 'Champ protégé';
      elements.generate.disabled = true;
      elements.use.disabled = true;
      elements.source.value = '';
      elements.close.focus();
      return;
    }

    if (googleDocs) {
      elements.title.textContent = 'Assistant pour Google Docs';
      elements.sourceLabel.textContent = 'Texte sélectionné ou texte à retravailler';
      elements.targetNotice.textContent = elements.source.value
        ? 'Sélection Google Docs récupérée'
        : 'Mode Google Docs local';
      elements.docsHelp.classList.remove('hidden');
      elements.use.textContent = 'Copier pour Google Docs';
      elements.instruction.focus();
      elements.instruction.select();
      elements.dialog.addEventListener('keydown', event => handleModalKeyDown(event, session));
      return;
    }

    elements.targetNotice.textContent = describeEditableTarget(target);
    elements.dialog.addEventListener('keydown', event => handleModalKeyDown(event, session));
    elements.instruction.focus();
    elements.instruction.select();
  }

  function bindModalEvents(session) {
    const { elements } = session;
    elements.close.addEventListener('click', closeAssistant);
    elements.overlay.addEventListener('mousedown', event => {
      if (event.target === elements.overlay) closeAssistant();
    });
    elements.generate.addEventListener('click', () => {
      void generateSuggestion(
        session,
        elements.instruction.value.trim(),
        elements.source.value,
        true,
      );
    });
    elements.refine.addEventListener('click', () => {
      void refineSuggestion(session);
    });
    elements.use.addEventListener('click', () => {
      void useSuggestion(session);
    });
    elements.copy.addEventListener('click', () => {
      void copySuggestion(session);
    });
    elements.result.addEventListener('input', () => syncLatestResult(session));
  }

  function handleModalKeyDown(event, session) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeAssistant();
      return;
    }
    if (event.key !== 'Enter' || (!event.ctrlKey && !event.metaKey)) return;
    event.preventDefault();
    if (event.target === session.elements.followup) {
      void refineSuggestion(session);
    } else {
      void generateSuggestion(
        session,
        session.elements.instruction.value.trim(),
        session.elements.source.value,
        true,
      );
    }
  }

  async function generateSuggestion(session, instruction, text, reset) {
    if (session.loading || session.destroyed) return;
    if (!instruction) {
      showError(session, 'Ajoutez une instruction pour guider la suggestion.');
      session.elements.instruction.focus();
      return;
    }

    if (reset) {
      session.messages = [];
      session.turns = [];
      renderHistory(session);
    }

    const context = [...session.messages];
    const userMessage = {
      role: 'user',
      text: text ? `${instruction}\n\nText:\n${text}` : instruction,
    };
    const pendingTurn = { instruction, result: '' };
    session.messages.push(userMessage);
    session.turns.push(pendingTurn);
    setLoading(session, true);
    showError(session, '');

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'MULTITASKER_TEXT_REQUEST',
        payload: { instruction, text, context },
      });
      if (!response?.ok || typeof response.text !== 'string') {
        throw new Error(response?.error || 'Multitasker n’a pas retourné de suggestion.');
      }
      if (session.destroyed) return;
      pendingTurn.result = response.text;
      session.messages.push({ role: 'assistant', text: response.text });
      session.elements.result.value = response.text;
      session.elements.followup.value = '';
      renderHistory(session);
      session.elements.result.focus();
      session.elements.result.setSelectionRange(response.text.length, response.text.length);
    } catch (error) {
      if (session.destroyed) return;
      session.messages = context;
      session.turns.pop();
      renderHistory(session);
      showError(session, errorMessage(error));
    } finally {
      if (!session.destroyed) setLoading(session, false);
    }
  }

  async function refineSuggestion(session) {
    if (session.loading) return;
    const instruction = session.elements.followup.value.trim();
    if (!instruction) {
      showError(session, 'Décrivez la modification à faire, par exemple « plus court ».');
      session.elements.followup.focus();
      return;
    }
    syncLatestResult(session);
    const text = session.elements.result.value;
    await generateSuggestion(session, instruction, text, false);
  }

  function syncLatestResult(session) {
    const latestTurn = session.turns.at(-1);
    if (!latestTurn?.result) return;
    latestTurn.result = session.elements.result.value;
    const latestAssistant = [...session.messages].reverse().find(message => message.role === 'assistant');
    if (latestAssistant) latestAssistant.text = session.elements.result.value;
  }

  async function useSuggestion(session) {
    syncLatestResult(session);
    const value = session.elements.result.value;
    if (!value) return;
    if (session.googleDocs) {
      const copied = await copySuggestion(session);
      if (copied && !session.destroyed) {
        session.elements.docsHelp.textContent = 'Résultat copié. Fermez cette fenêtre, replacez le curseur dans Google Docs, puis faites Ctrl+V (ou Cmd+V).';
        session.elements.use.textContent = 'Copié — prêt à coller';
      }
      return;
    }
    if (!isUsableTarget(session.target)) {
      showError(session, 'Le champ d’origine n’est plus disponible. Copiez le résultat, puis collez-le manuellement.');
      return;
    }
    writeEditableText(session.target, value);
    closeAssistant();
  }

  async function copySuggestion(session) {
    const value = session.elements.result.value;
    if (!value) return false;
    try {
      await navigator.clipboard.writeText(value);
      const originalText = session.elements.copy.textContent;
      session.elements.copy.textContent = 'Copié';
      setTimeout(() => {
        if (!session.destroyed) session.elements.copy.textContent = originalText;
      }, 1200);
      return true;
    } catch {
      session.elements.result.focus();
      session.elements.result.select();
      showError(session, 'Copie automatique refusée. Le texte a été sélectionné.');
      return false;
    }
  }

  function renderHistory(session) {
    const { history, result, refine, use, copy } = session.elements;
    history.replaceChildren();

    session.turns.slice(0, -1).forEach(turn => {
      const instruction = document.createElement('div');
      instruction.className = 'message user';
      instruction.textContent = turn.instruction;
      const answer = document.createElement('div');
      answer.className = 'message assistant';
      answer.textContent = turn.result;
      history.append(instruction, answer);
    });

    const latestTurn = session.turns.at(-1);
    const hasResult = Boolean(latestTurn?.result);
    result.closest('.result-block').classList.toggle('hidden', !hasResult);
    session.elements.followup.closest('.followup-block').classList.toggle('hidden', !hasResult);
    refine.disabled = !hasResult || session.loading;
    use.disabled = !hasResult || session.loading || (!session.googleDocs && !isUsableTarget(session.target));
    copy.disabled = !hasResult;
  }

  function setLoading(session, loading) {
    session.loading = loading;
    const { loading: loadingElement, generate, refine, use, source, instruction, followup } = session.elements;
    loadingElement.classList.toggle('hidden', !loading);
    generate.disabled = loading;
    refine.disabled = loading || !session.turns.at(-1)?.result;
    use.disabled = loading || !session.turns.at(-1)?.result ||
      (!session.googleDocs && !isUsableTarget(session.target));
    source.disabled = loading;
    instruction.disabled = loading;
    followup.disabled = loading;
  }

  function showError(session, message) {
    session.elements.error.textContent = message;
    session.elements.error.classList.toggle('hidden', !message);
  }

  function closeAssistant() {
    if (!modalSession) {
      document.getElementById(HOST_ID)?.remove();
      return;
    }
    modalSession.destroyed = true;
    modalSession.host.remove();
    modalSession = null;
  }

  function findEditableTarget(path) {
    for (const value of path) {
      if (!(value instanceof HTMLElement)) continue;
      if (value instanceof HTMLTextAreaElement) return value;
      if (value instanceof HTMLInputElement && (SUPPORTED_INPUT_TYPES.has(value.type) || value.type === 'password')) {
        return value;
      }
      if (value.matches('[contenteditable]:not([contenteditable="false"])')) return value;
    }
    return null;
  }

  function findActiveEditableTarget() {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement)) return null;
    if (active instanceof HTMLTextAreaElement) return active;
    if (active instanceof HTMLInputElement && (SUPPORTED_INPUT_TYPES.has(active.type) || active.type === 'password')) {
      return active;
    }
    if (active.isContentEditable) {
      return active.closest('[contenteditable]:not([contenteditable="false"])') || active;
    }
    return null;
  }

  function isUsableTarget(target) {
    return target instanceof HTMLElement && target.isConnected;
  }

  function isSensitiveTarget(target) {
    return target instanceof HTMLInputElement && target.type === 'password';
  }

  function readEditableText(target) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      return target.value;
    }
    return target.innerText || target.textContent || '';
  }

  function readSelectedPageText() {
    const selection = window.getSelection();
    return selection?.toString().trim() || '';
  }

  function writeEditableText(target, value) {
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      const prototype = target instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(target, value);
      else target.value = value;
      target.dispatchEvent(createInputEvent(value));
      target.dispatchEvent(new Event('change', { bubbles: true }));
      target.focus();
      target.setSelectionRange(value.length, value.length);
      return;
    }

    target.focus();
    const selection = target.ownerDocument.getSelection();
    const range = target.ownerDocument.createRange();
    range.selectNodeContents(target);
    selection?.removeAllRanges();
    selection?.addRange(range);

    let inserted = false;
    try {
      inserted = target.ownerDocument.execCommand('insertText', false, value);
    } catch {
      inserted = false;
    }
    if (!inserted) {
      target.replaceChildren(target.ownerDocument.createTextNode(value));
      target.dispatchEvent(createInputEvent(value));
    }
    selection?.collapseToEnd();
  }

  function createInputEvent(value) {
    try {
      return new InputEvent('input', {
        bubbles: true,
        composed: true,
        inputType: 'insertReplacementText',
        data: value,
      });
    } catch {
      return new Event('input', { bubbles: true, composed: true });
    }
  }

  function describeEditableTarget(target) {
    if (target instanceof HTMLTextAreaElement) return 'Zone de texte détectée';
    if (target instanceof HTMLInputElement) return 'Champ de texte détecté';
    return 'Éditeur de texte détecté';
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
  }

  function modalMarkup() {
    return `
      <style>
        :host {
          color-scheme: dark;
          font-family: "Segoe UI", system-ui, sans-serif;
        }
        * { box-sizing: border-box; }
        button, textarea, input { font: inherit; }
        .overlay {
          position: fixed;
          inset: 0;
          display: grid;
          place-items: center;
          padding: 20px;
          background: rgba(3, 7, 18, .72);
          backdrop-filter: blur(3px);
        }
        .dialog {
          width: min(720px, 96vw);
          max-height: min(860px, 92vh);
          display: flex;
          flex-direction: column;
          overflow: hidden;
          color: #e6edf3;
          background: #101722;
          border: 1px solid #344052;
          border-radius: 14px;
          box-shadow: 0 24px 80px rgba(0, 0, 0, .55);
        }
        .header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 18px 20px 15px;
          border-bottom: 1px solid #283445;
        }
        .eyebrow {
          margin: 0 0 3px;
          color: #79c0ff;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: .08em;
          text-transform: uppercase;
        }
        h2 { margin: 0; font-size: 18px; }
        #mt-target-notice { margin: 5px 0 0; color: #8b949e; font-size: 11px; }
        .body { padding: 16px 20px 20px; overflow-y: auto; }
        label {
          display: block;
          margin-bottom: 6px;
          color: #aab6c5;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: .04em;
          text-transform: uppercase;
        }
        textarea, input {
          width: 100%;
          color: #e6edf3;
          background: #0b111a;
          border: 1px solid #344052;
          border-radius: 8px;
          outline: none;
        }
        textarea:focus, input:focus { border-color: #58a6ff; box-shadow: 0 0 0 2px rgba(88, 166, 255, .14); }
        textarea { min-height: 78px; padding: 10px 11px; resize: vertical; line-height: 1.45; }
        input { padding: 10px 11px; }
        .source { max-height: 150px; }
        .prompt { min-height: 74px; max-height: 160px; }
        .instruction-row { display: grid; grid-template-columns: 1fr auto; align-items: end; gap: 9px; margin-top: 13px; }
        .history { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
        .message {
          max-width: 88%;
          padding: 9px 11px;
          border-radius: 9px;
          line-height: 1.45;
          white-space: pre-wrap;
        }
        .message.user { align-self: flex-end; background: rgba(88, 166, 255, .13); border: 1px solid rgba(88, 166, 255, .3); }
        .message.assistant { align-self: flex-start; background: #182130; border: 1px solid #344052; }
        .result-block, .followup-block { margin-top: 14px; }
        .result { min-height: 150px; background: #131d2a; border-color: #4a6585; }
        .actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 10px; }
        button {
          min-height: 36px;
          padding: 7px 12px;
          color: #d5dde7;
          background: #202b3a;
          border: 1px solid #3b4859;
          border-radius: 7px;
          cursor: pointer;
        }
        button:hover:not(:disabled) { background: #2b394b; }
        button.primary { color: #07111d; background: #79c0ff; border-color: #79c0ff; font-weight: 700; }
        button.primary:hover:not(:disabled) { background: #9bd0ff; }
        button:disabled { opacity: .48; cursor: default; }
        button.icon { width: 34px; min-height: 34px; padding: 0; border-radius: 50%; font-size: 18px; }
        .loading { margin-top: 14px; color: #aab6c5; font-size: 12px; }
        .loading::before {
          content: "";
          display: inline-block;
          width: 9px;
          height: 9px;
          margin-right: 8px;
          border: 2px solid #344052;
          border-top-color: #79c0ff;
          border-radius: 50%;
          animation: spin .75s linear infinite;
        }
        .error {
          margin-top: 12px;
          padding: 9px 10px;
          color: #ffb4ad;
          background: rgba(248, 81, 73, .1);
          border: 1px solid rgba(248, 81, 73, .35);
          border-radius: 7px;
          font-size: 12px;
        }
        .docs-help {
          margin-bottom: 14px;
          padding: 10px 11px;
          color: #b6d7f5;
          background: rgba(88, 166, 255, .1);
          border: 1px solid rgba(88, 166, 255, .3);
          border-radius: 7px;
          font-size: 12px;
          line-height: 1.45;
        }
        .hidden { display: none !important; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 560px) {
          .overlay { padding: 8px; }
          .dialog { max-height: 96vh; }
          .body { padding: 14px; }
          .instruction-row { grid-template-columns: 1fr; }
          .instruction-row button { width: 100%; }
        }
      </style>
      <div class="overlay">
        <section class="dialog" role="dialog" aria-modal="true" aria-labelledby="mt-title">
          <header class="header">
            <div>
              <p class="eyebrow">Multitasker AI</p>
              <h2 id="mt-title">Suggérer une meilleure version</h2>
              <p id="mt-target-notice"></p>
            </div>
            <button class="icon" data-action="close" type="button" aria-label="Fermer">×</button>
          </header>
          <div class="body">
            <div id="mt-docs-help" class="docs-help hidden">
              Google Docs utilise un éditeur canvas. Si la sélection n’apparaît pas ci-dessous, copiez-la avec Ctrl+C puis collez-la dans ce champ. Après la génération, copiez le résultat et recollez-le dans le document.
            </div>
            <label for="mt-source">Texte du champ</label>
            <textarea class="source" id="mt-source"></textarea>
            <div class="instruction-row">
              <div>
                <label for="mt-instruction">Votre prompt</label>
                <textarea class="prompt" id="mt-instruction" placeholder="Ex. Réponds de façon chaleureuse, en trois phrases, sans jargon."></textarea>
              </div>
              <button class="primary" data-action="generate" type="button">Générer</button>
            </div>
            <div id="mt-history" class="history" aria-live="polite"></div>
            <div id="mt-loading" class="loading hidden">Multitasker prépare une suggestion…</div>
            <div id="mt-error" class="error hidden" role="alert"></div>
            <div class="result-block hidden">
              <label for="mt-result">Résultat modifiable</label>
              <textarea class="result" id="mt-result"></textarea>
              <div class="actions">
                <button data-action="copy" type="button">Copier</button>
                <button class="primary" data-action="use" type="button">Remplacer dans le champ</button>
              </div>
            </div>
            <div class="followup-block hidden">
              <label for="mt-followup">Demander une autre modification</label>
              <textarea id="mt-followup" placeholder="Ex. Plus court, plus chaleureux, ou traduis en anglais…"></textarea>
              <div class="actions">
                <button data-action="refine" type="button">Améliorer encore</button>
              </div>
            </div>
          </div>
        </section>
      </div>
    `;
  }
})();
