/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costPanelDe = {
  "costPanel.title": "Kosten",
  "costPanel.close": "Schließen",
  "costPanel.exportCsv": "CSV exportieren",
  "costPanel.noModelsLoaded": "Keine Modelle geladen.",
  "costPanel.dataUnavailable": "Kostendaten nicht verfügbar — laden Sie die IFC-Quelle, um Kosten zu prüfen.",
  "costPanel.dataUnavailableWithError": "Kostendaten nicht verfügbar: {message}",
  "costPanel.empty": "Keine Kostendaten in diesem Modell.",
  "costPanel.noItemsInModel": "Keine Kostenpositionen in diesem Modell.",
  "costPanel.noItemsInSchedule": "Keine Kostenpositionen zugewiesen.",
  "costPanel.unassignedItems": "Nicht zugewiesene Kostenpositionen",
  "costPanel.cyclicBadge": "Verschachtelungszyklus erkannt",
  "costPanel.mixedCurrencyBadge": "Gemischte Währungen",
  "costPanel.selectPrompt": "Wählen Sie eine Kostenposition zur Prüfung aus.",
  "costPanel.itemUnavailable": "Diese Kostenposition ist nicht mehr verfügbar.",
  "costPanel.resolvedValue": "Ermittelter Wert",
  "costPanel.unresolvedValue": "Konnte aus der geladenen Quelle nicht ausgewertet werden.",
  "costPanel.schedule": "Kostenplan",
  "costPanel.quantities": "Mengen",
  "costPanel.assignedTargets": "Zugewiesene Bauteile / Aufgaben",
  "costPanel.selectInViewport": "In 3D auswählen",
  "costPanel.noAssignedTargets": "Keine Bauteile oder Aufgaben zugewiesen.",
  "costPanel.collapse": "Einklappen",
  "costPanel.expand": "Ausklappen",
  "costPanel.itemFallbackName": "Kostenposition #{id}",
  "costPanel.scheduleFallbackName": "Kostenplan #{id}",
  "costPanel.identification": "ID {value}"
} satisfies Catalogue;
