const SUGGESTION_API_BASE_URL = 'https://mike-codex.fly.dev';
const SUGGESTION_API_PROMPT_URL = SUGGESTION_API_BASE_URL + '/api/suggestion/prompt';
const SUGGESTION_API_MODELS_URL = SUGGESTION_API_BASE_URL + '/api/models';
const DEFAULT_SUGGESTION_MODEL = 'gpt-5.6-sol';
const DEFAULT_REASONING_EFFORT = 'low';
const FALLBACK_MODELS = [
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.2',
];
const FALLBACK_REASONING_EFFORTS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
];
const API_TOKEN_PROPERTY = 'SUGGESTION_API_AUTH_TOKEN';
const API_MODEL_PROPERTY = 'SUGGESTION_API_MODEL';
const API_REASONING_EFFORT_PROPERTY = 'SUGGESTION_API_REASONING_EFFORT';
const EDIT_WITH_AI_RANGE_NAME = 'edit-with-ai-selection';
const MAX_TEXT_LENGTH = 100000;
const MAX_CONTEXT_MESSAGES = 20;
const MAX_API_REQUEST_BYTES = 65000;

function onOpen() {
  DocumentApp.getUi()
    .createMenu('Edit with AI')
    .addItem('Edit selected text', 'editSelectedTextWithAi')
    .addItem('Open assistant', 'showEditWithAiSidebar')
    .addSeparator()
    .addItem('Configure API', 'showEditWithAiSidebar')
    .addToUi();
}

function onInstall() {
  onOpen();
}

function editSelectedTextWithAi() {
  const ui = DocumentApp.getUi();
  if (!getSuggestionApiToken_()) {
    showEditWithAiSidebar();
    ui.alert(
      'Configuration requise',
      'Ajoutez le token de votre API dans la sidebar, puis réessayez.',
      ui.ButtonSet.OK
    );
    return;
  }

  const snapshot = captureSelection();
  if (!snapshot.rangeId) {
    ui.alert('Edit with AI', snapshot.notice, ui.ButtonSet.OK);
    return;
  }

  const promptResponse = ui.prompt(
    'Edit with AI',
    'Comment l’IA doit-elle modifier le texte sélectionné?',
    ui.ButtonSet.OK_CANCEL
  );
  if (promptResponse.getSelectedButton() !== ui.Button.OK) {
    removeNamedRangeById_(snapshot.rangeId);
    return;
  }

  const instruction = promptResponse.getResponseText().trim();
  if (!instruction) {
    removeNamedRangeById_(snapshot.rangeId);
    ui.alert('Edit with AI', 'Entrez un prompt avant de continuer.', ui.ButtonSet.OK);
    return;
  }

  try {
    const result = editTextWithSuggestionApi(instruction, snapshot.text, []);
    replaceCapturedSelection(snapshot.rangeId, result.text);
  } catch (error) {
    removeNamedRangeById_(snapshot.rangeId);
    ui.alert('Edit with AI — erreur', errorMessage_(error), ui.ButtonSet.OK);
  }
}

function showEditWithAiSidebar() {
  const output = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Edit with AI');
  DocumentApp.getUi().showSidebar(output);
}

function getSuggestionApiSettings() {
  const properties = PropertiesService.getUserProperties();
  const token = properties.getProperty(API_TOKEN_PROPERTY) || '';
  const settings = {
    configured: Boolean(token),
    apiBaseUrl: SUGGESTION_API_BASE_URL,
    model: properties.getProperty(API_MODEL_PROPERTY) || DEFAULT_SUGGESTION_MODEL,
    reasoningEffort: properties.getProperty(API_REASONING_EFFORT_PROPERTY) || DEFAULT_REASONING_EFFORT,
    models: FALLBACK_MODELS.slice(),
    reasoningEfforts: FALLBACK_REASONING_EFFORTS.slice(),
    optionsError: '',
  };
  if (!token) return settings;

  try {
    const options = fetchSuggestionApiOptions_(token);
    settings.models = options.models;
    settings.reasoningEfforts = options.reasoningEfforts;
  } catch (error) {
    settings.optionsError = errorMessage_(error);
  }
  return settings;
}

function saveSuggestionApiSettings(apiToken, model, reasoningEffort) {
  const normalizedToken = normalizeText_(apiToken).trim();
  const normalizedModel = normalizeText_(model).trim() || DEFAULT_SUGGESTION_MODEL;
  const normalizedEffort = normalizeText_(reasoningEffort).trim() || DEFAULT_REASONING_EFFORT;
  if (!normalizedToken && !getSuggestionApiToken_()) {
    throw new Error('Entrez le token Bearer de votre API.');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(normalizedModel)) {
    throw new Error('Le nom du modèle contient des caractères invalides.');
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(normalizedEffort)) {
    throw new Error('Le niveau d’effort contient des caractères invalides.');
  }

  const properties = PropertiesService.getUserProperties();
  if (normalizedToken) properties.setProperty(API_TOKEN_PROPERTY, normalizedToken);
  properties.setProperty(API_MODEL_PROPERTY, normalizedModel);
  properties.setProperty(API_REASONING_EFFORT_PROPERTY, normalizedEffort);
  return getSuggestionApiSettings();
}

function clearSuggestionApiToken() {
  PropertiesService.getUserProperties().deleteProperty(API_TOKEN_PROPERTY);
  return getSuggestionApiSettings();
}

function captureSelection() {
  const document = DocumentApp.getActiveDocument();
  const selection = document.getSelection();
  removePreviousSelectionMarkers_(document);

  if (!selection) {
    return {
      ok: true,
      rangeId: '',
      text: '',
      notice: 'Sélectionnez du texte dans le document, puis réessayez.',
    };
  }

  const text = readRangeText_(selection);
  if (!text) {
    return {
      ok: true,
      rangeId: '',
      text: '',
      notice: 'La sélection ne contient pas de texte modifiable.',
    };
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return {
      ok: true,
      rangeId: '',
      text: '',
      notice: 'La sélection dépasse 100 000 caractères.',
    };
  }

  const namedRange = document.addNamedRange(EDIT_WITH_AI_RANGE_NAME, selection);
  return {
    ok: true,
    rangeId: namedRange.getId(),
    text,
    notice: 'Sélection chargée et prête à modifier.',
  };
}

function editTextWithSuggestionApi(instruction, text, context) {
  const normalizedInstruction = normalizeRequiredText_(instruction, 'Un prompt est requis.');
  const normalizedText = normalizeText_(text);
  if (normalizedInstruction.length > MAX_TEXT_LENGTH || normalizedText.length > MAX_TEXT_LENGTH) {
    throw new Error('Le prompt ou le texte sélectionné dépasse 100 000 caractères.');
  }

  const token = getSuggestionApiToken_();
  if (!token) throw new Error('Configurez d’abord le token de votre API.');

  const properties = PropertiesService.getUserProperties();
  const model = properties.getProperty(API_MODEL_PROPERTY) || DEFAULT_SUGGESTION_MODEL;
  const reasoningEffort = properties.getProperty(API_REASONING_EFFORT_PROPERTY) || DEFAULT_REASONING_EFFORT;
  const apiPrompt = buildSuggestionPrompt_(normalizedInstruction, normalizedText, context);
  const requestBody = JSON.stringify({
    prompt: apiPrompt,
    model,
    reasoningEffort,
  });
  if (Utilities.newBlob(requestBody).getBytes().length > MAX_API_REQUEST_BYTES) {
    throw new Error('La requête dépasse la limite de 65 536 octets de l’API. Réduisez la sélection ou le contexte.');
  }

  const response = UrlFetchApp.fetch(SUGGESTION_API_PROMPT_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + token,
    },
    payload: requestBody,
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const parsed = parseJson_(response.getContentText());
  if (status < 200 || status >= 300) {
    throw new Error(readSuggestionApiError_(status, parsed));
  }

  const outputText = parsed && typeof parsed.result === 'string'
    ? parsed.result.trim()
    : '';
  if (!outputText) throw new Error('L’API a retourné une réponse vide.');
  return {
    ok: true,
    text: outputText,
    model,
    reasoningEffort,
  };
}

function replaceCapturedSelection(rangeId, replacement) {
  if (typeof rangeId !== 'string' || !rangeId) {
    throw new Error('Chargez une sélection avant de la remplacer.');
  }
  const normalizedReplacement = normalizeText_(replacement);
  if (normalizedReplacement.length > MAX_TEXT_LENGTH) {
    throw new Error('Le remplacement dépasse 100 000 caractères.');
  }

  const document = DocumentApp.getActiveDocument();
  const namedRange = document.getNamedRangeById(rangeId);
  if (!namedRange) {
    throw new Error('La sélection sauvegardée n’existe plus. Sélectionnez le texte de nouveau.');
  }

  const textRanges = getEditableTextRanges_(namedRange.getRange());
  if (textRanges.length === 0) {
    namedRange.remove();
    throw new Error('La sélection sauvegardée ne contient pas de texte modifiable.');
  }

  const firstRange = textRanges[0];
  const attributes = readInsertionAttributes_(firstRange);
  namedRange.remove();
  for (let index = textRanges.length - 1; index >= 0; index -= 1) {
    const item = textRanges[index];
    if (item.end >= item.start) item.text.deleteText(item.start, item.end);
  }

  if (normalizedReplacement) {
    firstRange.text.insertText(firstRange.start, normalizedReplacement);
    if (attributes) {
      firstRange.text.setAttributes(
        firstRange.start,
        firstRange.start + normalizedReplacement.length - 1,
        attributes
      );
    }
  }

  try {
    document.setCursor(DocumentApp.newPosition(
      firstRange.text,
      firstRange.start + normalizedReplacement.length
    ));
  } catch (error) {
    console.warn('Could not restore the cursor: ' + String(error));
  }

  return {
    ok: true,
    insertedCharacters: normalizedReplacement.length,
    message: 'Le texte sélectionné a été remplacé.',
  };
}

function fetchSuggestionApiOptions_(token) {
  const response = UrlFetchApp.fetch(SUGGESTION_API_MODELS_URL, {
    method: 'get',
    headers: {
      Authorization: 'Bearer ' + token,
    },
    muteHttpExceptions: true,
  });
  const status = response.getResponseCode();
  const parsed = parseJson_(response.getContentText());
  if (status < 200 || status >= 300) {
    throw new Error(readSuggestionApiError_(status, parsed));
  }

  const models = normalizeStringList_(parsed && parsed.models);
  const reasoningEfforts = normalizeStringList_(parsed && parsed.reasoningEfforts);
  if (models.length === 0 || reasoningEfforts.length === 0) {
    throw new Error('La réponse de /api/models est incomplète.');
  }
  return { models, reasoningEfforts };
}

function buildSuggestionPrompt_(instruction, text, context) {
  const transcript = normalizeContext_(context)
    .map(function(message) {
      return (message.role === 'assistant' ? 'Assistant' : 'Utilisateur') + ':\n' + message.text;
    })
    .join('\n\n');
  return [
    'Tu modifies du texte sélectionné par un utilisateur dans Google Docs.',
    'Retourne uniquement le texte final de remplacement.',
    'N’ajoute aucun commentaire, libellé, guillemet englobant ou bloc Markdown.',
    'Préserve le sens, les faits, les noms, les liens et la langue source sauf demande contraire.',
    transcript ? '\nConversation précédente:\n' + transcript : '',
    '\nPrompt actuel:\n' + instruction,
    '\nTexte sélectionné:\n' + (text || '(vide)'),
  ].filter(Boolean).join('\n');
}

function readSuggestionApiError_(status, payload) {
  const detail = payload && (
    (typeof payload.error === 'string' && payload.error) ||
    (payload.error && typeof payload.error.message === 'string' && payload.error.message) ||
    (typeof payload.message === 'string' && payload.message)
  );
  if (detail) return detail;
  if (status === 400) return 'Requête invalide: vérifiez le prompt, le modèle et le niveau d’effort.';
  if (status === 401) return 'Token API absent ou invalide.';
  if (status === 413) return 'La requête est trop volumineuse.';
  if (status === 500) return 'L’API a rencontré une erreur interne.';
  return 'L’API a retourné HTTP ' + status + '.';
}

function getSuggestionApiToken_() {
  return PropertiesService.getUserProperties().getProperty(API_TOKEN_PROPERTY) || '';
}

function normalizeContext_(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(-MAX_CONTEXT_MESSAGES).flatMap(function(item) {
    if (!item || typeof item !== 'object') return [];
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'user' ? 'user' : '';
    const text = normalizeText_(item.text).trim();
    return role && text ? [{ role, text: text.slice(0, MAX_TEXT_LENGTH) }] : [];
  });
}

function normalizeStringList_(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(function(item) { return typeof item === 'string'; })
    .map(function(item) { return item.trim(); })
    .filter(Boolean);
}

function parseJson_(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function normalizeRequiredText_(value, errorMessage) {
  const text = normalizeText_(value).trim();
  if (!text) throw new Error(errorMessage);
  return text;
}

function normalizeText_(value) {
  return typeof value === 'string' ? value : '';
}

function removePreviousSelectionMarkers_(document) {
  document.getNamedRanges(EDIT_WITH_AI_RANGE_NAME).forEach(function(namedRange) {
    namedRange.remove();
  });
}

function removeNamedRangeById_(rangeId) {
  if (!rangeId) return;
  const namedRange = DocumentApp.getActiveDocument().getNamedRangeById(rangeId);
  if (namedRange) namedRange.remove();
}

function readRangeText_(range) {
  return getEditableTextRanges_(range)
    .map(function(item) {
      return item.text.getText().slice(item.start, item.end + 1);
    })
    .join('\n');
}

function getEditableTextRanges_(range) {
  return range.getRangeElements().flatMap(function(rangeElement) {
    const element = rangeElement.getElement();
    let text;
    try {
      text = element.getType() === DocumentApp.ElementType.TEXT
        ? element.asText()
        : element.editAsText();
    } catch (error) {
      return [];
    }

    const length = text.getText().length;
    if (length === 0) return [];
    const start = rangeElement.isPartial()
      ? Math.max(0, rangeElement.getStartOffset())
      : 0;
    const end = rangeElement.isPartial()
      ? Math.min(length - 1, rangeElement.getEndOffsetInclusive())
      : length - 1;
    return end >= start ? [{ text, start, end }] : [];
  });
}

function readInsertionAttributes_(range) {
  const length = range.text.getText().length;
  if (length === 0) return null;
  try {
    return range.text.getAttributes(Math.min(range.start, length - 1));
  } catch (error) {
    return null;
  }
}

function errorMessage_(error) {
  return error && error.message ? error.message : String(error);
}
