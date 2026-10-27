# Multitasker Text Assistant

Extension Chrome Manifest V3 qui réutilise le endpoint local `POST /text` de
Multitasker. Aucune clé OpenAI n'est stockée dans Chrome.

## Installation locale

1. Démarrer Multitasker et vérifier que le backend répond sur
   `http://127.0.0.1:39017`.
2. Installer le plugin **AI** dans Multitasker. C'est le même moteur que la
   commande `/rewrite` de Slack.
3. Ouvrir `chrome://extensions`.
4. Activer **Mode développeur**.
5. Cliquer **Charger l'extension non empaquetée** et sélectionner ce dossier :
   `extension/chrome-text-assistant`.

## Utilisation

1. Faire un clic droit dans un `input`, un `textarea` ou un éditeur
   `contenteditable`.
2. Choisir **Suggérer avec Multitasker**.
3. Écrire votre prompt dans **Votre prompt** ou modifier le prompt proposé.
   L'appel IA ne démarre qu'après avoir cliqué **Générer** ou utilisé
   `Ctrl+Entrée`.
4. Demander d'autres passes dans la modale.
5. Cliquer **Remplacer dans le champ**.

Le résultat peut aussi être modifié à la main ou copié sans remplacer le
champ. `Ctrl+Entrée` (ou `Cmd+Entrée`) lance la génération depuis
l'instruction active ou la demande de suivi.

## Google Docs

Google Docs utilise un éditeur rendu sur un canvas plutôt qu'un champ HTML
standard. Le mode Google Docs utilise donc un flux copier-coller fiable :

1. Ouvrir un document sur `docs.google.com`.
2. Actualiser l'onglet une fois après avoir chargé ou rechargé l'extension.
3. Sélectionner et copier le texte à retravailler avec `Ctrl+C` si nécessaire.
4. Cliquer l'icône **Multitasker Text Assistant** dans la barre Chrome.
5. Cliquer **Ouvrir dans Google Docs**.
6. Si la sélection n'a pas été récupérée automatiquement, la coller dans
   **Texte sélectionné ou texte à retravailler**.
7. Écrire le prompt, générer, puis cliquer **Copier pour Google Docs**.
8. Replacer le curseur dans le document et utiliser `Ctrl+V`.

Un menu **Suggérer avec Multitasker dans Google Docs** est aussi disponible
quand Chrome affiche son menu contextuel natif et peut transmettre la
sélection.

## Sécurité et limites

- Les champs `password` sont volontairement refusés.
- Le texte est envoyé uniquement au backend local Multitasker, qui gère
  ensuite l'appel IA avec sa configuration existante.
- Chrome interdit les scripts de contenu sur ses pages internes
  (`chrome://...`) et sur le Chrome Web Store.
- Pour les pages `file://`, activer **Autoriser l'accès aux URL de fichier**
  dans les détails de l'extension.
- L'extension ne simule pas de frappe ou de collage dans le canvas Google Docs.
  Cette limite évite de dépendre d'éléments internes non documentés qui peuvent
  changer sans préavis.
- Certains éditeurs riches très personnalisés peuvent intercepter leur contenu
  différemment. Le bouton **Copier** reste disponible dans ce cas.
