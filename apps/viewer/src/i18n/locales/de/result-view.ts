/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const resultViewDe = {
  "resultView.region": "{source}-Ergebnisse",
  "resultView.source": "Quelle",
  "resultView.models": {
    "one": "Modell: {names}",
    "other": "Modelle ({count}): {names}"
  },
  "resultView.population": "Grundgesamtheit",
  "resultView.coverage": "Abdeckung",
  "resultView.incomplete": "Unvollständig",
  "resultView.actions": "Ergebnisaktionen",
  "resultView.evidence": "Nachweisdetails",
  "resultStatus.complete": "Abgeschlossen",
  "resultStatus.partial": "Teilweise",
  "resultStatus.failed": "Fehlgeschlagen",
  "resultStatus.running": "Läuft",
  "resultStatus.stale": "Veraltet",
  "resultStatus.cancelled": "Abgebrochen",
  "resultStatus.interrupted": "Unterbrochen",
  "resultStatus.queued": "Eingereiht",
  "resultStatus.uncertain": "Ergebnis unbekannt",
  "resultStatus.blocked": "Blockiert",
  "resultStatus.unsupported": "Nicht unterstützt",
  "resultStatus.draft": "Entwurf",
  "resultStatus.ready": "Bereit zur Prüfung",
  "resultStatus.applying": "Wird angewendet",
  "resultStatus.applied": "Angewendet",
  "resultState.noPopulation": "Keine zutreffenden Bauteile",
  "resultState.noFindings": "Keine Befunde",
  "resultState.failed": "Der Lauf ist fehlgeschlagen",
  "resultState.unsupported": "Hier nicht unterstützt",
  "resultState.partial": "Teilergebnis",
  "resultState.filtered": "Keine Filtertreffer",
  "resultScope.label": "Umfang",
  "resultScope.selected": "Ausgewählt ({count})",
  "resultScope.filtered": "Gefiltert ({count})",
  "resultScope.all": "Alle ({count})",
  "resultSelection.selectPage": {
    "one": "Das {countDisplay} Ergebnis auf dieser Seite auswählen",
    "other": "Alle {countDisplay} auf dieser Seite auswählen"
  },
  "resultSelection.selectEverything": {
    "one": "Das {countDisplay} passende Ergebnis auswählen",
    "other": "Alle {countDisplay} passenden Ergebnisse auswählen"
  },
  "resultSelection.pageSelected": {
    "one": "{countDisplay} Ergebnis auf dieser Seite ausgewählt.",
    "other": "Alle {countDisplay} auf dieser Seite ausgewählt."
  },
  "resultSelection.selectPopulation": {
    "one": "Das {countDisplay} passende Ergebnis auswählen",
    "other": "Alle {countDisplay} passenden Ergebnisse auswählen"
  },
  "resultSelection.resolving": {
    "one": "Das {countDisplay} passende Ergebnis wird abgerufen…",
    "other": "Alle {countDisplay} passenden Ergebnisse werden abgerufen…"
  },
  "resultSelection.populationSelected": {
    "one": "Das {countDisplay} passende Ergebnis ist ausgewählt.",
    "other": "Alle {countDisplay} passenden Ergebnisse sind ausgewählt."
  },
  "resultSelection.failed": "Die passenden Ergebnisse konnten nicht abgerufen werden.",
  "resultSelection.retry": "Erneut versuchen",
  "resultSelection.clear": "Auswahl leeren",
  "resultSelection.highlighted": "1 im Fokus",
  "resultSelection.selected": {
    "one": "{countDisplay} ausgewählt",
    "other": "{countDisplay} ausgewählt"
  },
  "resultSelection.included": {
    "one": "{countDisplay} im Stapel",
    "other": "{countDisplay} im Stapel"
  },
  "artifactHeader.region": "Artefakt {name}"
} satisfies Catalogue;
