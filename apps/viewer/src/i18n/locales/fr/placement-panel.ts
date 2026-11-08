/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const placementPanelFr = {
  'placementPanel.title': 'Placement',
  'placementPanel.headerCloseTitle': 'Fermer le panneau de placement',
  'placementPanel.tabs.local': 'Local',
  'placementPanel.tabs.georeference': 'Géoréférencement',
  'placementPanel.local.emptyTitle': 'Aucun modèle sélectionné',
  'placementPanel.local.emptyHint': 'Choisissez les modèles à déplacer, puis lancez le repositionnement.',
  'placementPanel.local.startButton': 'Lancer le repositionnement',
  'placementPanel.georeference.emptyTitle': 'Aucun modèle géoréférencé',
  'placementPanel.georeference.emptyHint': 'Chargez un modèle doté d’une conversion cartographique (IfcMapConversion) pour modifier ici l’ancrage de son site.',
  'placementPanel.georeference.editToggleOn': 'Modification en cours',
  'placementPanel.georeference.editToggleOff': 'Modifier l’ancrage',
  'placementPanel.georeference.startHint': 'Faites glisser le plan et la poignée de hauteur dans la vue 3D, ou ajustez l’ancrage ci-dessous.',
} satisfies Catalogue;
