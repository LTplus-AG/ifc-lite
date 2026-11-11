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
  "structuralReview.derive.title": "Statisches Analysemodell ableiten",
  "structuralReview.derive.hint": "Träger, Stützen und Stäbe werden zu Stabelementen, Decken und Wände zu Flächenelementen in ihrer Mittelebene; zusammentreffende Stabenden teilen einen Knoten; Fundamente tragen Auflager. Jedes abgeleitete Element ist mit seinem physischen Bauteil verknüpft. Hier werden IFC-Datensätze erstellt; die Bemessung wird nicht geprüft.",
  "structuralReview.derive.prepare": "Ableiten und prüfen",
  "structuralReview.derive.acknowledgement": "Ich habe die übersprungenen Bauteile und die angenommenen Auflager geprüft.",
  "structuralReview.derive.counts": "{curveMembers} Stabelemente · {surfaceMembers} Flächenelemente · {nodes} Knoten · {supports} Auflager, davon {guessedSupports} angenommen · {created} zu erstellende IFC-Datensätze",
  "structuralReview.derive.assumed": "{count} Bauteile haben keinen LoadBearing-Wert und gelten als tragend.",
  "structuralReview.derive.skipped": "Übersprungene Bauteile ({count})",
  "structuralReview.derive.guessed": "Angenommene Auflager an den tiefsten Knoten, da kein Fundament einen trägt ({count})",
  "structuralReview.derive.unconnected": "Knoten, die einen Stab oder eine Fläche berühren, ohne verbunden zu sein ({count})",
  "structuralReview.derive.existing": "Dieses Modell hat bereits ein abgeleitetes Analysemodell (#{id}). Es wird nicht ein zweites Mal abgeleitet.",
  "structuralReview.derive.nothing": "Nichts abzuleiten: Kein tragendes Bauteil ließ sich idealisieren, oder jedes hat bereits ein statisches Gegenstück.",
  "structuralReview.derive.noModel": "Laden Sie ein Modell, um sein statisches Analysemodell abzuleiten.",
  "structuralReview.derive.nodeAt": "Knoten {node}: {position} m",
  "structuralReview.derive.endAt": "Knoten {node}: {position} m, {landsOn} #{element}",
  "structuralReview.derive.more": "{count} weitere nicht abgebildet",
} satisfies Catalogue;
