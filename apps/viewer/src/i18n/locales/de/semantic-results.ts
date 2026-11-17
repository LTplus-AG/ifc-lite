/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const semanticResultsDe = {
  "semantic.resultsSelectAll": "Alle zugeordneten Ergebnisse auswählen",
  "semantic.resultsClear": "Auswahl leeren",
  "semantic.resultsSelection": "Auswahl",
  "semantic.resultsToggle": "Ergebniszeile {row} umschalten",
  "semantic.resultsSelectionHelp": "Kontrollkästchen fügen zugeordnete Entitäten hinzu oder entfernen sie. „Alle auswählen“ umfasst alle Seiten und überspringt nicht aufgelöste oder mehrdeutige Zeilen. Ctrl/Cmd-Klick auf eine Zuordnung fügt einen Kandidaten hinzu oder entfernt ihn.",
  "semantic.resultsTitle": "SPARQL-Ergebnisse",
  "semantic.resultsPrevious": "Vorherige Zeilen",
  "semantic.resultsNext": "Nächste Zeilen",
  "semantic.resultsPage": "Zeilen {start}–{end} von {count}",
  "semantic.resultsUnbound": "Nicht gebunden",
  "semantic.resultsSelect": "Zugeordnete Zeile auswählen",
  "semantic.resultsCandidates": "Modellkandidaten wählen",
  "semantic.resultsChoose": "{model}, Entität {id} auswählen",
  "semantic.resultsStatus": "IFC-Zuordnung",
  "semantic.resultsResolved": "Aufgelöst",
  "semantic.resultsAmbiguous": "Mehrdeutig",
  "semantic.resultsUnmatched": "Nicht zugeordnet",
  "semantic.resultsUnscoped": "Nicht zugeordnete Revision",
  "semantic.resultsExternal": "Keine IFC-Identität",
  "semantic.resultsInvalid": "Ungültige Identität",
  "semantic.resultsStale": "Kandidat nicht mehr verfügbar; Zeile erneut auflösen"
} satisfies Catalogue;
