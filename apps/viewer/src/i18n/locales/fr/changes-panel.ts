/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const changesPanelFr = {
  "changesPanel.title": "Modifications",
  "changesPanel.close": "Fermer Modifications",
  "changesPanel.empty": "Aucune opération de modification enregistrée.",
  "changesPanel.rowCount": { one: "{count} modification", other: "{count} modifications", many: "{count} de modifications" },
  "changesPanel.entity": "{type} #{id}",
  "changesPanel.georeference": "Géoréférence",
  "changesPanel.modelMetadata": "Métadonnées du modèle",
  "changesPanel.jump": "Aller à {entity} dans {model}",
  "changesPanel.revert": "Inverser",
  "changesPanel.revertUnavailable": "Cette modification ne peut pas être inversée en toute sécurité tant que des modifications plus récentes en dépendent.",
  "changesPanel.revertStale": "La modification a changé. Consultez la liste actuelle et réessayez.",
  "changesPanel.revertPermission": "Activez le mode Édition ou demandez un accès en modification avant d'inverser une modification.",
  "changesPanel.revertSharedRoom": "Quittez la salle partagée avant d'inverser une modification. La salle ne peut pas encore synchroniser cette inversion.",
  "changesPanel.revertUnsupported": "Cette modification ne peut pas être inversée depuis le tiroir. Utilisez Annuler lorsqu'il s'agit de l'étape la plus récente.",
} satisfies Catalogue;
