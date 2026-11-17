/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costPanelFr = {
  "costPanel.title": "Coûts",
  "costPanel.close": "Fermer",
  "costPanel.exportCsv": "Exporter en CSV",
  "costPanel.noModelsLoaded": "Aucun modèle chargé.",
  "costPanel.dataUnavailable": "Données de coûts indisponibles — chargez la source IFC pour examiner les coûts.",
  "costPanel.dataUnavailableWithError": "Données de coûts indisponibles : {message}",
  "costPanel.empty": "Aucune donnée de coût dans ce modèle.",
  "costPanel.noItemsInModel": "Aucun poste de coût dans ce modèle.",
  "costPanel.noItemsInSchedule": "Aucun poste de coût affecté.",
  "costPanel.unassignedItems": "Postes de coût non affectés",
  "costPanel.cyclicBadge": "Cycle d’imbrication détecté",
  "costPanel.mixedCurrencyBadge": "Devises multiples",
  "costPanel.selectPrompt": "Sélectionnez un poste de coût pour l’examiner.",
  "costPanel.itemUnavailable": "Ce poste de coût n’est plus disponible.",
  "costPanel.resolvedValue": "Valeur calculée",
  "costPanel.unresolvedValue": "Impossible à évaluer à partir de la source chargée.",
  "costPanel.schedule": "Bordereau",
  "costPanel.quantities": "Quantités",
  "costPanel.assignedTargets": "Éléments / tâches affectés",
  "costPanel.selectInViewport": "Sélectionner en 3D",
  "costPanel.noAssignedTargets": "Aucun élément ni tâche affecté.",
  "costPanel.collapse": "Réduire",
  "costPanel.expand": "Développer",
  "costPanel.itemFallbackName": "Poste de coût #{id}",
  "costPanel.scheduleFallbackName": "Bordereau #{id}",
  "costPanel.identification": "ID {value}",
} satisfies Catalogue;
