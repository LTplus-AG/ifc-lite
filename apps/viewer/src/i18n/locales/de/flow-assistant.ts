/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const flowAssistantDe = {
  "flowAssistant.suggestDebug": "Warum ist der letzte Lauf fehlgeschlagen und wie lässt sich der Graph korrigieren?",
  "flowAssistant.suggestCreate": "Einen neuen Flow-Graphen erstellen, der die Wände je Geschoss zählt",
  "flowAssistant.pickCreate": "Kein Graph geöffnet · neuen Graphen beschreiben",
  "flowAssistant.proposalCreate": "Vorschlag für neuen Flow-Graphen",
  "flowAssistant.proposalCreateSummary": {
    "one": "{count} Knoten",
    "other": "{count} Knoten"
  },
  "flowAssistant.createTitle": "Neuen Flow-Graphen prüfen",
  "flowAssistant.createHint": "Beim Erstellen wird ein neuer Graph gespeichert und in Flow geöffnet. Ein vorhandener Graph wird niemals ersetzt, und der neue Graph wird nicht ausgeführt.",
  "flowAssistant.reviewCreate": "Neuen Graphen prüfen",
  "flowAssistant.createName": "Neuer Graph: {name}",
  "flowAssistant.createSize": "{nodes} Knoten · {edges} Kanten",
  "flowAssistant.createOrder": "Knoten in Ausführungsreihenfolge",
  "flowAssistant.createInputs": "Ausführungseingaben",
  "flowAssistant.inputRequired": "erforderlich",
  "flowAssistant.inputOptional": "optional",
  "flowAssistant.inputMultiple": "mehrere Dateien",
  "flowAssistant.inputSingle": "eine Datei",
  "flowAssistant.createCapabilities": "Vom Graphen deklarierte Fähigkeiten: {capabilities}",
  "flowAssistant.createWriters": "Knoten, die bei Ausführung das Modell bearbeiten: {nodes}",
  "flowAssistant.createUnavailable": "In diesem Viewer nicht ausführbar: {nodes}",
  "flowAssistant.createApproved": "Ich habe den neuen Graphen, seine Fähigkeiten und die bei Ausführung von ihm verwalteten Bauteile geprüft.",
  "flowAssistant.createApply": "Graph erstellen und öffnen",
  "flowAssistant.created": "„{name}“ als neuen gespeicherten Graphen erstellt und in Flow geöffnet. Es wurde nichts ausgeführt.",
  "flowAssistant.openFlow": "In Flow öffnen",
  "flowAssistant.blockedRunning": "Ein Ablauf läuft. Warten Sie auf dessen Ende oder brechen Sie ihn ab, bevor Sie den Graphen erstellen.",
  "flowAssistant.blockedUnsaved": "Der geöffnete Graph hat ungespeicherte Änderungen. Speichern oder verwerfen Sie diese in Flow, bevor Sie den Graphen erstellen.",
  "flowAssistant.removeCreated": "Erstellten Graphen entfernen",
  "flowAssistant.diagnosisTitle": "Diagnose des letzten Laufs",
  "flowAssistant.diagnosisNode": "{node}: {status} · Spurfehler: {count}",
  "flowAssistant.codeTitle": "Durch diese Änderung gesetzter Skriptcode",
  "flowAssistant.codeHint": "Dieser Code wurde vom Assistenten geschrieben. Er läuft beim nächsten Ausführen in der Sandbox; lesen Sie ihn vor dem Übernehmen.",
  "flowAssistant.codeParam": "{node} · {param} ({language})",
  "flowAssistant.trackingTitle": "Betroffene nachverfolgte Bauteile",
  "flowAssistant.trackingOwnership": "Von einem nachverfolgten Knoten erstellte Bauteile gehören unter seinem Nachverfolgungsschlüssel diesem Graphen: Erneute Läufe aktualisieren dieselben GlobalIds; beansprucht kein Knoten den Schlüssel mehr, entfernt der Graph die Bauteile.",
  "flowAssistant.owned": {
    "one": "{count} verwaltetes Bauteil",
    "other": "{count} verwaltete Bauteile"
  },
  "flowAssistant.ownedUnknown": "verwaltete Bauteile (für das aktive Modell keine erfasst)",
  "flowAssistant.trackingRemoved": "{node} wird entfernt: {owned} unter „{key}“ werden beim nächsten Ausführen aus dem Modell gelöscht.",
  "flowAssistant.trackingRekeyed": "{node} ändert den Nachverfolgungsschlüssel von „{key}“ zu „{next}“: {owned} werden beim nächsten Ausführen gelöscht und neue Bauteile erstellt.",
  "flowAssistant.trackingMode": "{node} wechselt zur Nachverfolgung „{mode}“: {owned} unter „{key}“ folgen beim nächsten Ausführen dem neuen Modus.",
  "flowAssistant.trackingBranch": "{node} oder seine Eingaben ändern sich: {owned} unter „{key}“ werden beim nächsten Ausführen aktualisiert.",
  "flowAssistant.trackingAdded": "{node} wird unter „{key}“ Bauteile erstellen, die von diesem Graphen verwaltet werden.",
  "flowAssistant.trackingAcknowledge": "Ich verstehe, welche nachverfolgten Bauteile diese Änderung beim nächsten Ausführen aktualisiert oder entfernt.",
  "flowAssistant.preflight": "Vorprüfung",
  "flowAssistant.preflightRunning": "Graph wird geprüft…",
  "flowAssistant.preflightOk": "Vorprüfung für „{name}“ bestanden. Es wurde nichts ausgeführt; starten Sie ihn bei Bedarf in Flow.",
  "flowAssistant.preflightFailed": "Die Vorprüfung hat Probleme gefunden. Es wurde nichts ausgeführt.",
  "flowAssistant.preflightRunningWorkflow": "Ein Ablauf läuft; warten Sie zuerst oder brechen Sie ihn ab",
  "flowAssistant.preflightNoModel": "Laden Sie ein Modell, bevor Sie diesen Graphen ausführen",
  "flowAssistant.preflightDeniedWorkflow": "{nodes} bearbeitet das Modell: Warten Sie auf den Abschluss der Ablaufprüfung oder PDF-Erfassung oder brechen Sie den Ablauf ab",
  "flowAssistant.preflightDeniedEditMode": "{nodes} bearbeitet das Modell: Aktivieren Sie vor Modelländerungen den Bearbeitungsmodus",
  "flowAssistant.preflightDeniedRole": "{nodes} bearbeitet das Modell: Ihre Rolle in dieser gemeinsamen Sitzung erlaubt keine Bearbeitung",
  "flowAssistant.preflightDeniedModel": "{nodes} bearbeitet das Modell: Dieses Modell hat keine bearbeitbaren IFC-Daten",
  "flowAssistant.preflightSecrets": "Geheimnisse sind im Viewer niemals verfügbar: {names}",
  "flowAssistant.preflightNative": "{message}",
  "flowAssistant.preflightStale": "Der Graph wurde nach dieser Vorprüfung geändert; prüfen Sie ihn erneut.",
  "flowAssistant.openFlowToRun": "Flow zum Ausführen öffnen"
} satisfies Catalogue;
