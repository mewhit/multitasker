# Edit with AI — Google Docs add-on

Add-on Apps Script non publié et indépendant de l'extension Chrome. Il utilise
l'API privée suivante :

- base : `https://mike-codex.fly.dev`
- génération : `POST /api/suggestion/prompt`
- options : `GET /api/models`
- authentification : `Authorization: Bearer <API_AUTH_TOKEN>`

## Installation sans Marketplace

1. Ouvrir le document Google Docs cible.
2. Ouvrir **Extensions → Apps Script**.
3. Remplacer `Code.gs` par le fichier de ce dossier.
4. Ajouter un fichier HTML nommé `Sidebar` et y copier `Sidebar.html`.
5. Dans les paramètres Apps Script, activer **Show "appsscript.json" manifest
   file in editor**, puis remplacer ce manifeste par celui de ce dossier.
6. Enregistrer et exécuter `onOpen` une première fois.
7. Autoriser l'accès au document et les requêtes externes.
8. Actualiser Google Docs.

Le menu **Edit with AI** apparaît dans le document.

## Configurer l'API

1. Ouvrir **Edit with AI → Configure API**.
2. Entrer la valeur de `API_AUTH_TOKEN`.
3. Choisir le modèle et le niveau d'effort.
4. Cliquer **Enregistrer**.

Le token est enregistré dans `PropertiesService.getUserProperties()`. Il est
privé à l'utilisateur courant, n'est jamais écrit dans le document et n'est
jamais renvoyé à la sidebar après son enregistrement.

Après l'enregistrement, l'add-on appelle `/api/models` pour récupérer les choix
actuels. Si l'API est temporairement indisponible, les valeurs documentées sont
utilisées comme secours :

- modèles : `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`,
  `gpt-5.2`;
- efforts : `low`, `medium`, `high`, `xhigh`, `max`, `ultra`.

## Utilisation directe

1. Sélectionner le texte.
2. Cliquer **Edit with AI → Edit selected text**.
3. Écrire le prompt.
4. Cliquer **OK**.

La sélection est conservée temporairement avec une plage nommée Google Docs,
envoyée à l'API avec le prompt, puis remplacée par le champ `result` retourné.

## Utilisation avec prévisualisation

1. Ouvrir **Edit with AI → Open assistant**.
2. Sélectionner du texte puis cliquer **Recharger la sélection**.
3. Écrire le prompt et cliquer **Générer**.
4. Modifier le résultat ou utiliser **Améliorer encore**.
5. Cliquer **Remplacer la sélection**.

## Sécurité et limites

- Ne jamais placer le token directement dans `Code.gs` ou `Sidebar.html`.
- Tout éditeur du projet Apps Script peut modifier le code. Utiliser ce projet
  avec des collaborateurs de confiance.
- Le texte sélectionné, le prompt, le modèle et l'effort sont envoyés à
  `mike-codex.fly.dev`.
- Le code limite le JSON envoyé à 65 000 octets pour rester sous la limite
  documentée de 65 536 octets.
- Les réponses HTTP 400, 401, 413 et 500 sont transformées en messages lisibles.
- Pour utiliser l'add-on dans plusieurs documents sans Marketplace, copier le
  script lié dans chaque document ou créer un déploiement de test Editor add-on.
