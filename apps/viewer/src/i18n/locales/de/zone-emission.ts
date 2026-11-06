/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const zoneEmissionDe = {
  "zoneEmission.title": "Ausgabe ausgewerteter Zonen prüfen",
  "zoneEmission.hint": "Diesen gesamten ausgewerteten Zonensatz nur in das gewählte Modell schreiben. Die Mitgliedschaft stammt aus der aktuellen nativen Auswertung.",
  "zoneEmission.limit": "Frühere Ausgaben dieser Sitzung werden ersetzt. Aus einer früheren IFC-Datei importierte Zonen bleiben erhalten. Andere Modelle bleiben unverändert. Eine Vorschau ausgegebener Volumenkörper ist nicht verfügbar.",
  "zoneEmission.prepare": "Native Zonenausgabe vorbereiten",
  "zoneEmission.apply": "Geprüfte Zonen ausgeben",
  "zoneEmission.population": "{zones} Zonen, {members} ausgewertete Bauteile, {replaced} frühere Zonen ersetzt; {imported} importierte Zonen erhalten.",
  "zoneEmission.records": "Native Ausgabedatensätze",
  "zoneEmission.frame": "Native Modelleinheiten und Koordinatenrahmen",
  "zoneEmission.receiptProblem": "Das Modell wurde geändert, aber der Beleg konnte nicht gespeichert werden. „Rückgängig“ bleibt im nativen Änderungsbereich verfügbar."
} satisfies Catalogue;
