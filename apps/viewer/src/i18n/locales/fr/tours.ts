/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const toursFr = {
  'tours.learnTab.description':
    'Des visites guidées interactives s’exécutent sur votre modèle ou sur le projet de démonstration fourni. Chaque étape peut être ignorée.',
  'tours.learnTab.completedAriaLabel': 'Terminée',
  'tours.learnTab.replay': 'Revoir',
  'tours.learnTab.start': 'Commencer',
  'tours.learnTab.minutes': '{count} min',
  'tours.panelTourButton.startAriaLabel': 'Commencer la visite guidée : {title}',
  'tours.panelTourButton.tooltip': '{title} (visite guidée de {count} min)',
  'tours.tourHost.prereqAriaLabel': '{title} : prérequis',
  'tours.tourHost.prereqLayerStack': 'Cette visite guidée nécessite une pile de couches composée. Chargez la pile de démonstration (trois petites couches) pour la suivre.',
  'tours.tourHost.prereqSecondModel': 'Cette visite guidée nécessite deux révisions chargées d’un modèle. Chargez le projet de démonstration pour la suivre.',
  'tours.tourHost.prereqModel': 'Cette visite guidée nécessite un modèle chargé. Chargez le projet de démonstration pour la suivre, ou ouvrez d’abord votre propre fichier IFC.',
  'tours.tourHost.cancel': 'Annuler',
  'tours.tourHost.loadDemoStack': 'Charger la pile de démonstration',
  'tours.tourHost.loadDemoProject': 'Charger le projet de démonstration',
  'tours.tourInvite.start': 'Suivre la visite guidée de deux minutes',
  'tours.tourInvite.dismissAriaLabel': 'Ignorer l’invitation à la visite guidée',
  'tours.tourStepCard.ariaLabel': 'Étape {step} sur {total} de la visite guidée : {title}',
  'tours.tourStepCard.endTourAriaLabel': 'Terminer la visite guidée',
  'tours.tourStepCard.redockedNotice': 'Le panneau a été réancré dans la barre latérale pour cette étape.',
  'tours.tourStepCard.stuckHint': 'Bloqué ? Ignorez cette étape et continuez.',
  'tours.tourStepCard.skipStep': 'Ignorer l’étape',
  'tours.tourStepCard.skipUseDemo': 'Ignorer (utiliser la démo)',
  'tours.tourStepCard.done': 'Terminé',
  'tours.tourStepCard.next': 'Suivant',
} satisfies Catalogue;
