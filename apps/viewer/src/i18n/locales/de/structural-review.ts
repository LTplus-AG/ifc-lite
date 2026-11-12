/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const structuralReviewDe = {
  "structuralReview.title": "Vorgegebenen analytischen Graphen prüfen",
  "structuralReview.hint": "Prüfen Sie nur die vorgegebene Geometrie, Lagerungen und Lastkomponenten. Hier werden IFC-Datensätze erstellt; es findet keine statische Berechnung oder Bemessungsprüfung statt. Wählen Sie Vorgänge und prüfen Sie vor dem Anwenden alle nativen Änderungen.",
  "structuralReview.prepare": "Ausgewählte Tragwerksvorgänge prüfen",
  "structuralReview.references": "Natives Ziel: {target} · Zugehörige Datensätze: {related}",
  "structuralReview.acknowledgement": "Ich bestätige, dass Last- und Steifigkeitswerte in den nativen Größen des Modells vorgegeben sind. Weder eine Umrechnung noch fehlende Einheitenangaben werden unterstellt.",
  "structuralReview.previewUnavailable": "Eine Vorschau der analytischen Geometrie ist hier nicht verfügbar. Überprüfen Sie die nativen IFC-Datensätze vor der Anwendung.",
  "structuralReview.population": "{records} Quelldatensätze überprüft · {created} erstellt · {modified} geändert · {deleted} gelöscht. Erstellte IFC-Identitäten werden bei Übernehmen zugewiesen.",
  "structuralReview.units": "Überprüfen Sie deklarierte native Einheiten und nicht verfügbare Deklarationen",
  "structuralReview.nativeChanges": "Überprüfen Sie native IFC-Änderungen, einschließlich gemeinsamer Verweise und Löschungen",
  "structuralReview.receiptProblem": "Die Änderungen wurden übernommen, ihre Beleg konnte jedoch nicht gespeichert werden. Der native Bearbeitungsverlauf enthält weiterhin die Änderungen.",
  "structuralReview.op.structural.analysis.create": "Erstellen Sie ein Analysemodell",
  "structuralReview.op.structural.member.create": "Analytischen Kurvenstab erstellen",
  "structuralReview.op.structural.connection.create": "Erstellen Sie eine analytische Punktverbindung",
  "structuralReview.op.structural.group.create": "Erstellen Sie eine bereitgestellte Lastgruppe",
  "structuralReview.op.structural.pointAction.create": "Vorgegebene Punktlast erstellen",
  "structuralReview.op.structural.linearAction.create": "Vorgegebene Linienlast erstellen",
  "structuralReview.op.structural.member.connect": "Stab und Verbindung verknüpfen",
  "structuralReview.op.structural.activity.connect": "Vorgegebene Einwirkung mit Bauteil verknüpfen",
  "structuralReview.op.structural.group.assign": "Vorgegebene Objekte einer Gruppe zuweisen",
} satisfies Catalogue;
