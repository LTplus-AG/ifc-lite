/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costPanelIt = {
  "costPanel.title": "Costi",
  "costPanel.close": "Chiudi",
  "costPanel.exportCsv": "Esporta CSV",
  "costPanel.noModelsLoaded": "Nessun modello caricato.",
  "costPanel.dataUnavailable": "Dati di costo non disponibili: carica l'origine IFC per esaminare i costi.",
  "costPanel.dataUnavailableWithError": "Dati di costo non disponibili: {message}",
  "costPanel.empty": "Nessun dato di costo in questo modello.",
  "costPanel.noItemsInModel": "Nessuna voce di costo in questo modello.",
  "costPanel.noItemsInSchedule": "Nessuna voce di costo assegnata.",
  "costPanel.unassignedItems": "Voci di costo non assegnate",
  "costPanel.cyclicBadge": "Rilevato ciclo di annidamento",
  "costPanel.mixedCurrencyBadge": "Valute miste",
  "costPanel.selectPrompt": "Seleziona una voce di costo per esaminarla.",
  "costPanel.itemUnavailable": "Questa voce di costo non è più disponibile.",
  "costPanel.resolvedValue": "Valore risolto",
  "costPanel.unresolvedValue": "Impossibile valutare dall'origine caricata.",
  "costPanel.schedule": "Programma",
  "costPanel.quantities": "Quantità",
  "costPanel.assignedTargets": "Elementi / attività assegnati",
  "costPanel.selectInViewport": "Seleziona in 3D",
  "costPanel.noAssignedTargets": "Nessun elemento o attività assegnato.",
  "costPanel.collapse": "Comprimi",
  "costPanel.expand": "Espandi",
  "costPanel.itemFallbackName": "Voce di costo #{id}",
  "costPanel.scheduleFallbackName": "Programma #{id}",
  "costPanel.identification": "ID {value}"
} satisfies Catalogue;
