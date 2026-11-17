/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const scriptPanelFr = {
  'scriptPanel.files.export': 'Exporter le script enregistré',
  'scriptPanel.files.import': 'Importer un fichier de script',
  'scriptPanel.files.retry': 'Réessayer l’importation dans la bibliothèque actuelle',
  'scriptPanel.files.imported': 'Une copie enregistrée a été importée. Ouvrez-la depuis le sélecteur de scripts ; l’exécution reste une action distincte.',
  'scriptPanel.files.savedOnly': 'La version enregistrée a été exportée. Enregistrez d’abord les modifications de l’éditeur pour les inclure.',
  'scriptPanel.files.tooLarge': 'Le fichier de script est trop volumineux.',
  // Header
  'scriptPanel.header.defaultTitle': 'Éditeur de scripts',
  'scriptPanel.header.selectScriptAriaLabel': 'Sélectionner un script enregistré',
  'scriptPanel.header.deleteMenuItem': 'Supprimer',
  'scriptPanel.header.hideAiChat': 'Masquer la discussion IA',
  'scriptPanel.header.showAiChat': 'Afficher la discussion IA',
  'scriptPanel.chat.resizeAriaLabel': 'Redimensionner la discussion IA',
  // Post-authoring "install as tool" banner
  'scriptPanel.toolReady.title': 'Ce script est prêt',
  'scriptPanel.toolReady.description': 'Installez-le sous forme de bouton en un clic dans votre barre d’outils.',
  'scriptPanel.toolReady.installButton': 'Installer comme outil',
  'scriptPanel.toolReady.dismissAriaLabel': 'Ignorer',
  // Toolbar
  'scriptPanel.toolbar.runButton': 'Exécuter',
  'scriptPanel.toolbar.runTooltip': 'Exécuter le script ({keys})',
  'scriptPanel.toolbar.saveAriaLabel': 'Enregistrer le script',
  'scriptPanel.toolbar.saveTooltip': 'Enregistrer ({keys})',
  'scriptPanel.toolbar.saveAsToolAriaLabel': 'Enregistrer ce script comme outil permanent',
  'scriptPanel.toolbar.saveAsToolButton': 'Enregistrer comme outil',
  'scriptPanel.toolbar.saveAsToolTooltip':
    'Transformer ce script en bouton permanent en un clic dans votre barre d’outils',
  'scriptPanel.toolbar.undoAriaLabel': 'Annuler',
  'scriptPanel.toolbar.undoTooltip': 'Annuler ({keys})',
  'scriptPanel.toolbar.redoAriaLabel': 'Rétablir',
  'scriptPanel.toolbar.redoTooltip': 'Rétablir ({keys})',
  'scriptPanel.toolbar.newScript': 'Nouveau script',
  'scriptPanel.toolbar.blankScriptMenuItem': 'Script vierge',
  'scriptPanel.toolbar.resetSandbox': 'Réinitialiser le bac à sable',
  // Execution status
  'scriptPanel.status.running': 'Exécution…',
  'scriptPanel.status.error': 'Erreur',
  // Output console
  'scriptPanel.output.header': 'Sortie',
  'scriptPanel.output.sandboxHintPrefix': 'Les scripts s’exécutent dans un bac à sable QuickJS — pas de DOM, pas de',
  'scriptPanel.output.fetchCode': 'fetch',
  'scriptPanel.output.sandboxHintMiddle': ', pas de variables globales du navigateur. Utilisez les API',
  'scriptPanel.output.bimCode': 'bim.*',
  'scriptPanel.output.sandboxHintSuffix': 'pour les effets sur la visionneuse, les données et l’export.',
  'scriptPanel.output.fixWithLlmButton': 'Corriger avec le LLM',
  'scriptPanel.output.returnLabel': 'Retour :',
  'scriptPanel.output.emptyState': 'Appuyez sur Exécuter ou sur {keys} pour lancer',
  // Delete confirmation dialog
  'scriptPanel.deleteDialog.title': 'Supprimer le script',
  'scriptPanel.deleteDialog.confirmPrefix': 'Voulez-vous vraiment supprimer « ',
  'scriptPanel.deleteDialog.fallbackScriptName': 'ce script',
  'scriptPanel.deleteDialog.confirmSuffix': ' » ? Cette action est irréversible.',
  'scriptPanel.deleteDialog.cancelButton': 'Annuler',
  'scriptPanel.deleteDialog.deleteButton': 'Supprimer',
} satisfies Catalogue;
