/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantSourcesDe = {
  "assistantSources.groupChecks": "Prüfungen",
  "assistantSources.groupCoordination": "Koordination",
  "assistantSources.groupQuantities": "Mengen",
  "assistantSources.groupModel": "Modell",
  "assistantSources.groupAutomation": "Automatisierung",
  "assistantSources.unsupportedTitle": "Nicht diskutierbar",
  "assistantSources.unsupportedHint": "Diese Panels haben kein natives Analyseergebnis zum Anhängen.",
  "assistantSources.boundaryAppearance": "Einstellungen für die Darstellung, kein Analyseergebnis.",
  "assistantSources.boundaryModel": "Modellierungswerkzeuge. Besprechen Sie Bearbeitungen über „Änderungen“ oder „Änderungssätze“.",
  "assistantSources.boundaryExtensions": "Installierte Erweiterungen und deren Berechtigungen. Besprechen Sie die Ausgabe einer Erweiterung in dem Panel, in dem sie angezeigt wird.",
  "assistantSources.boundaryCollab": "Live-Sitzungsliste und Berechtigungen; es liegt kein Analyseergebnis vor.",
  "assistantSources.boundarySources": "Cloud-Verbindungen und Datenabruf. Zugangsdaten und Endpunktfreigaben werden niemals als Belege angehängt.",
  "assistantSources.boundaryPresentation": "Gespeicherte Kameraansichten für die Präsentation; es liegt kein Analyseergebnis vor.",
  "assistantSources.boundaryAssistant": "Der Assistent selbst. Gespeicherte Gespräche werden wieder geöffnet und nicht als Belege angehängt.",
  "assistantSources.boundaryEnvironment": "Anzeigeeinstellungen für Himmel, Beleuchtung und Sonnenzeit. Es wird keine Sonnenanalyse aufgezeichnet und die Anzeigeeinstellungen beziehen sich nicht auf die Tageslichtleistung.",
  "assistantSources.boundaryIdsStudio": "IDS-Erstellung. Das Bearbeiten eines Anforderungsdokuments führt zu keinem Analyseergebnis; Führen Sie es in der Validierung aus, um zu besprechen, was es findet.",
  "assistantSources.boundaryInflux": "Experimentelle InfluxDB-Telemetrie. Die Messwerte werden mit einem reinen Sitzungstoken abgerufen und nicht mit dem Assistenten geteilt.",
} satisfies Catalogue;
