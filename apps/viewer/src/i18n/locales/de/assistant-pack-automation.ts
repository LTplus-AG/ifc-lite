/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackAutomationDe = {
  "assistantSources.flowRun.title": "Flow-Lauf",
  "assistantSources.flowRun.description": "Der letzte Lauf des geöffneten Graphen: Knotenergebnisse, Warnungen, Ausgaben und Artefakte.",
  "assistantSources.flowRun.rows": "Zeilen sind zuerst die Ergebnisse fehlerhafter Knoten (mit eingehenden Kanten und Parametern nur für fehlerhafte Knoten und die Knoten, die sie versorgen, Skriptquelle zurückgehalten und Anmeldeinformationen geschwärzt), Laufwarnungen, Artefakte (nur Metadaten), Graph-Ausgaben, andere Knotenergebnisse und Protokolleinträge.",
  "assistantSources.flowRun.unavailable": "Zum Zeitpunkt der Erfassung war kein Flow-Laufergebnis verfügbar. Führen Sie das Diagramm in Flow aus und aktualisieren Sie die Belege.",
  "assistantSources.flowRun.discussRun": "Lauf mit KI besprechen",
  "assistantSources.flowRun.suggestExplain": "Erklären Sie, was dieser Lauf bewirkte und was er hervorbrachte",
  "assistantSources.flowRun.suggestFix": "Warum sind Knoten fehlgeschlagen oder haben Warnungen ausgegeben, und wie behebe ich das?",
  "assistantSources.flowRun.statusRunning": "Wird ausgeführt…",
  "assistantSources.flowRun.statusOk": {"one": "Erfolgreich · {count} Knoten", "other": "Erfolgreich · {count} Knoten"},
  "assistantSources.flowRun.statusFailed": {"one": "Fehlgeschlagen · {count} Knoten", "other": "Fehlgeschlagen · {count} Knoten"},
  "assistantSources.flowRun.statusError": "Der Lauf ist fehlgeschlagen, bevor ein Ergebnis erzeugt wurde",
  "assistantSources.flowRun.statusNone": "Noch kein Lauf",
  "assistantSources.script.description": "Die letzte Skriptausführung: Rückgabewert, Diagnose und Konsolenausgabe.",
  "assistantSources.script.rows": "Zeilen sind der zurückgegebene Wert, Diagnose- und Protokolleinträge. Die Skriptquelle ist ausgeschlossen.",
  "assistantSources.script.unavailable": "Bei der Erfassung war keine Skriptausführung verfügbar. Führen Sie ein Skript im Skripteditor aus und aktualisieren Sie die Belege.",
  "assistantSources.script.suggestExplain": "Erklären Sie, was dieser Skriptlauf zurückgegeben und protokolliert hat",
  "assistantSources.script.suggestFix": "Warum ist dieses Skript fehlgeschlagen und wie kann ich es beheben?",
  "assistantSources.script.statusRunning": "Wird ausgeführt…",
  "assistantSources.script.statusError": "Der letzte Lauf ist fehlgeschlagen",
  "assistantSources.script.statusResult": {"one": "Letzter Lauf · {count} Protokolleintrag", "other": "Letzter Lauf · {count} Protokolleinträge"},
  "assistantSources.script.statusDiagnostics": {"one": "{count} Diagnose", "other": "{count} Diagnosen"},
  "assistantSources.script.statusNone": "Noch kein Lauf",
  "assistantSources.document.description": "Die Blöcke, Bindungen und Seiteneinstellungen des geöffneten Dokuments.",
  "assistantSources.document.rows": "Jede Zeile ist ein Dokumentblock in Dokumentreihenfolge. Texte enthalten die noch nicht aufgelöste Vorlage; Bilder und Diagramme nur Metadaten.",
  "assistantSources.document.unavailable": "Zum Zeitpunkt der Erfassung war kein Dokument geöffnet. Öffnen Sie ein Dokument und aktualisieren Sie die Belege.",
  "assistantSources.document.suggestReview": "Überprüfen Sie die Struktur dieses Dokuments und schlagen Sie Verbesserungen vor",
  "assistantSources.document.suggestBindings": "Auf welche Modellfelder verweist dieses Dokument?",
  "assistantSources.document.status": {"one": "{name} · {count} Block", "other": "{name} · {count} Blöcke"},
  "assistantSources.document.statusNone": "Kein offenes Dokument",
} satisfies Catalogue;
