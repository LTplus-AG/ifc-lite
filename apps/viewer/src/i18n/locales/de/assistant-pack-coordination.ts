/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackCoordinationDe = {
  "assistantSources.changes.description": "Änderungen im Rückgängig-Verlauf dieser Sitzung, pro Vorgang und Modell.",
  "assistantSources.changes.rows": "Zeilen stellen einzelne Bearbeitungen der aktiven Vorgänge dar, der neueste Vorgang zuerst.",
  "assistantSources.changes.unavailable": "Es ist kein Modell geladen, daher ist kein Bearbeitungsverlauf zum Anhängen vorhanden.",
  "assistantSources.changes.ready": {"one": "{count} Änderung", "other": "{count} Änderungen"},
  "assistantSources.changes.none": "Noch keine Änderungen",
  "assistantSources.changes.suggestSummary": "Fassen Sie zusammen, was in welchen Modellen bearbeitet wurde",
  "assistantSources.changes.suggestReview": "Welche Änderungen sollte ich vor dem Exportieren überprüfen?",
  "assistantSources.changeSets.description": "Benannte Bearbeitungsgruppen: ihre Größen, Modelle und Bearbeitungsarten.",
  "assistantSources.changeSets.rows": "Zeilen stellen Änderungssätze dar (nur Metadaten, keine Bearbeitungswerte oder Dateiinhalte).",
  "assistantSources.changeSets.unavailable": "Es ist kein Änderungssatz vorhanden. Erstellen Sie eine im Bereich „Änderungssätze“.",
  "assistantSources.changeSets.ready": {"one": "{count} Änderungssatz", "other": "{count} Änderungssätze"},
  "assistantSources.changeSets.none": "Keine Änderungssätze",
  "assistantSources.changeSets.suggestSummary": "Fassen Sie zusammen, was jeder Änderungssatz enthält",
  "assistantSources.schedule.description": "Aufgaben des 4D-Terminplans mit Terminen, Meilensteinen und zugeordneten Bauteilen.",
  "assistantSources.schedule.rows": "Zeilen repräsentieren Zeitplanaufgaben. Fehlende Daten sind null, nicht erraten.",
  "assistantSources.schedule.unavailable": "Es ist kein Zeitplan geladen. Öffnen Sie das Fenster „Zeitplan“, um IfcTask-Daten zu lesen oder einen Zeitplan zu generieren oder zu importieren.",
  "assistantSources.schedule.ready": {"one": "{count} Aufgabe", "other": "{count} Aufgaben"},
  "assistantSources.schedule.none": "Kein Zeitplan",
  "assistantSources.schedule.suggestSummary": "Fassen Sie den Zeitplan zusammen: Phasen, Meilensteine und Gesamtdauer",
  "assistantSources.schedule.suggestGaps": "Welche Aufgaben haben keine Termine oder keine zugewiesenen Bauteile?",
  "assistantSources.semantic.description": "Verknüpfte Datensätze, wie sie zu Bauteilen, Validierungsergebnissen und angehängten Spezifikationstexten aufgelöst werden.",
  "assistantSources.semantic.rows": "Zeilen stellen angehängte Textpassagen mit genauen Offsets dar, dann verknüpfte Datensätze mit ihrer Auflösung und dann Validierungsergebnisse.",
  "assistantSources.semantic.unavailable": "Es werden keine verknüpften Datensätze geladen oder Texte angehängt. Laden Sie Datensätze oder hängen Sie einen Text im Bereich „Verknüpfte Datensätze“ an.",
  "assistantSources.semantic.ready": {"one": "{count} Datensatz · {findings} Befunde", "other": "{count} Datensätze · {findings} Befunde"},
  "assistantSources.semantic.none": "Keine Datensätze geladen",
  "assistantSources.semantic.suggestUnresolved": "Welche Datensätze werden nicht in ein Bauteil aufgelöst und warum?",
  "assistantSources.semantic.suggestFindings": "Erläutern Sie die Validierungsergebnisse",
  "assistantSources.review.description": "Eine Koordinationskarte aus dem Review-Arbeitsbereich: Ergebnisse aus mehreren Analysen zu denselben validierten Bauteilen.",
  "assistantSources.review.rows": "Zeilen stellen die Ergebnisse auf der Karte dar, jede mit ihrer Quellenanalyse, ihrem nativen Status und der Angabe, ob die Ausführung aktuell, historisch oder teilweise ist.",
  "assistantSources.review.unavailable": "Keine Karte angeheftet. Wählen Sie „Zu dieser Karte fragen“ auf einer Karte im Arbeitsbereich „Prüfung“.",
  "assistantSources.review.ready": {"one": "{count} Befund in der angehefteten Karte", "other": "{count} Befunde in der angehefteten Karte"},
  "assistantSources.review.none": "Keine Karte angepinnt",
  "assistantSources.review.suggestExplain": "Warum deuten diese Ergebnisse auf dieselben Bauteile hin?",
  "assistantSources.review.suggestNext": "Was würde ein Koordinator als nächstes auf dieser Karte überprüfen?",
} satisfies Catalogue;
