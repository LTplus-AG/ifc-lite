/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const newIfcDe = {
  "newIfc.title": "Neue IFC-Datei prüfen",
  "newIfc.scope": "Erstellt nur ein neues Projekt, natives Grundstück/Gebäude und die angegebenen Geschosse. Einheiten und Höhen müssen angegeben werden; Bauteilgeometrie und Entwurfsanforderungen werden nicht abgeleitet.",
  "newIfc.noUndo": "Dies erstellt eine separate Datei. Dateidownload und Ersetzen einer Viewer-Sitzung sind keine Modellbearbeitungen und können nicht über die Modellbearbeitung rückgängig gemacht werden.",
  "newIfc.prepare": "Neue IFC-Datei vorbereiten",
  "newIfc.preparing": "Native Datei wird vorbereitet…",
  "newIfc.preview": "{name}: {bytes} Bytes, {count} native Datensätze; {schema}, {unit}.",
  "newIfc.defaults": "Native Identitäten, Namen und Standardwerte",
  "newIfc.content": "Exakter vorbereiteter IFC-Inhalt",
  "newIfc.download": "Geprüfte IFC herunterladen",
  "newIfc.downloaded": "Die genehmigten Bytes wurden über die native Download-Aktion bereitgestellt.",
  "newIfc.loadWarning": "Das Anfordern eines primären Ladevorgangs ersetzt die aktuelle Viewer-Sitzung. Speichern Sie zuerst aktuelle Änderungen. Das native Laden kann weiterhin fehlschlagen oder abgebrochen werden.",
  "newIfc.requestLoad": "Laden im Viewer anfordern (Sitzung ersetzen)",
  "newIfc.requested": "Laden angefordert, nicht bestätigt. Verfolgen Sie die tatsächlichen Ergebnisse in der nativen Aktivitätsanzeige und den Ladeberichten.",
  "newIfc.modelsTitle": "Modelle und neue IFC-Dateien",
  "newIfc.modelsDescription": "Tatsächliche Modellladeberichte besprechen oder ein eigenständiges natives IFC-Grundgerüst aus angegebenem Schema, Einheiten und Geschossen vorbereiten.",
  "newIfc.capabilityReady": "Natives Grundgerüst für neue Dateien verfügbar; keine Fakten zu geladenen Modellen",
  "newIfc.suggest": "Ein neues natives IFC-Projekt mit Geschossen anhand meines Schemas, meiner Einheiten und Höhen vorbereiten; fehlende Eingaben erfragen."
} satisfies Catalogue;
