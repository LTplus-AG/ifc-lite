/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const costReviewDe = {
  "costReview.title": "Überprüfen Sie die bereitgestellten Kosten",
  "costReview.hint": "Prüfen Sie nur die vorgegebenen Beträge und Einheiten des Modells. Preis, Kostensatz und Währung werden nicht abgeleitet. Wählen Sie Vorgänge und prüfen Sie vor dem Anwenden alle Änderungen an den IFC-Datensätzen.",
  "costReview.prepare": "Überprüfen Sie ausgewählte Kostenvorgänge",
  "costReview.references": "Natives Ziel: {target} · Zugehörige Datensätze: {related}",
  "costReview.detach": "Trennen Sie gemeinsam genutzte Referenzen mithilfe der nativen Entfernungsregeln. Überprüfen Sie unten alle geänderten und gelöschten Datensätze.",
  "costReview.population": "{records} Quelldatensätze überprüft · {created} erstellt · {modified} geändert · {deleted} gelöscht. Erstellte IFC-Identitäten werden bei Übernehmen zugewiesen.",
  "costReview.nativeChanges": "Überprüfen Sie native IFC-Änderungen, einschließlich gemeinsamer Verweise und Löschungen",
  "costReview.receiptProblem": "Die Änderungen wurden übernommen, ihre Beleg konnte jedoch nicht gespeichert werden. Der native Bearbeitungsverlauf enthält weiterhin die Änderungen.",
  "costReview.op.cost.schedule.create": "Kostenplan erstellen",
  "costReview.op.cost.item.create": "Kostenposition anlegen",
  "costReview.op.cost.value.create": "Erstellen Sie einen bereitgestellten Kostenwert",
  "costReview.op.cost.quantity.create": "Vorgegebene Menge erstellen",
  "costReview.op.cost.items.nest": "Kostenpositionen verschachteln",
  "costReview.op.cost.schedule.assign": "Positionen dem Kostenplan zuweisen",
  "costReview.op.cost.item.assign": "Ordnen Sie Objekte einer Kostenposition zu",
  "costReview.op.cost.item.values": "Kostenwerte der Position ersetzen",
  "costReview.op.cost.remove": "Kostendatensatz entfernen",
} satisfies Catalogue;
