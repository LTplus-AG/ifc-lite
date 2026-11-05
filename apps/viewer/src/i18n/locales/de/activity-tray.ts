/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const activityTrayDe = {
  "activityTray.button": "Aktivität",
  "activityTray.buttonRunning": {
    "one": "Aktivität: {count} Aufgabe läuft",
    "other": "Aktivität: {count} Aufgaben laufen"
  },
  "activityTray.title": "Aktivität",
  "activityTray.empty": "Noch keine Aufgaben in dieser Sitzung.",
  "activityTray.list": "Aufgaben",
  "activityTray.cancel": "Abbrechen",
  "activityTray.cancelLabel": "{title} abbrechen",
  "activityTray.open": "Öffnen",
  "activityTray.openLabel": "{title} öffnen",
  "activityTray.clearFinished": "Abgeschlossene entfernen",
  "activityTray.persistent": "Bleibt beim Neuladen erhalten",
  "activityTray.interruptedHint": "Die Seite wurde während der Ausführung geschlossen. Die Aufgabe wurde nicht abgeschlossen; starten Sie sie erneut.",
  "activityTray.failureNoDetail": "Die Aufgabe ist fehlgeschlagen, ohne dass die Quelle einen Grund angegeben hat.",
  "activityTray.publication.empty": "Keine Serveraktionen eingereiht.",
  "activityTray.progress": "{done} von {total}",
  "activityTray.announce": "{title}: {status}",
  "activityTray.announceSubject": "{title} ({subject}): {status}",
  "activityTray.job.load": "Modell laden",
  "activityTray.job.sourceDownload": "Quelldateien herunterladen",
  "activityTray.job.extensionExport": "Erweiterung exportieren",
  "activityTray.sourceDownload.partialCancelled": {
    "one": "Abgebrochen, nachdem {count} Datei zum Laden übergeben wurde. Übergebene Dateien bleiben verfügbar.",
    "other": "Abgebrochen, nachdem {count} Dateien zum Laden übergeben wurden. Übergebene Dateien bleiben verfügbar."
  },
  "activityTray.sourceDownload.partialFailed": {
    "one": "{count} Datei zum Laden übergeben; einige Downloads sind fehlgeschlagen. Übergebene Dateien bleiben verfügbar.",
    "other": "{count} Dateien zum Laden übergeben; einige Downloads sind fehlgeschlagen. Übergebene Dateien bleiben verfügbar."
  },
  "activityTray.sourceDownload.failed": {
    "one": "{count} Download fehlgeschlagen; keine Dateien zum Laden übergeben.",
    "other": "{count} Downloads fehlgeschlagen; keine Dateien zum Laden übergeben."
  },
  "activityTray.job.clash": "Kollisionsprüfung",
  "activityTray.job.validation": "Datenprüfung",
  "activityTray.job.list": "Liste ausführen",
  "activityTray.job.bulk": "Eigenschaften gesammelt aktualisieren",
  "activityTray.bulk.cancelledWithChanges": {
    "one": "Nach Änderung von {count} Entität abgebrochen. Übernommene Änderungen können weiterhin rückgängig gemacht werden.",
    "other": "Nach Änderung von {count} Entitäten abgebrochen. Übernommene Änderungen können weiterhin rückgängig gemacht werden."
  },
  "activityTray.bulk.failedWithChanges": {
    "one": "{count} Entität geändert; einige Aktualisierungen sind fehlgeschlagen. Übernommene Änderungen können weiterhin rückgängig gemacht werden.",
    "other": "{count} Entitäten geändert; einige Aktualisierungen sind fehlgeschlagen. Übernommene Änderungen können weiterhin rückgängig gemacht werden."
  },
  "activityTray.job.flow": "Flow ausführen",
  "activityTray.job.ai": "Assistentenanfrage",
  "activityTray.job.export": "Export",
  "activityTray.job.csvEntities": "Modellentitäten als CSV exportieren",
  "activityTray.job.csvProperties": "Modelleigenschaften als CSV exportieren",
  "activityTray.job.csvQuantities": "Modellmengen als CSV exportieren",
  "activityTray.job.csvSpatial": "Räumliche Modellhierarchie als CSV exportieren",
  "activityTray.job.zoneGeometry": "Zonengeometrie exportieren",
  "activityTray.job.zoneTable": "Zonenmengen exportieren",
  "activityTray.zone.geometryPartial": "{whole} ganze und {cut} geschnittene Bauteile veröffentlicht; {refused} abgelehnt und {missing} ohne Geometrie.",
  "activityTray.zone.tablePartial": {
    "one": "Tabelle mit {count} nicht gemessenen Mengenzeile veröffentlicht; der Grund bleibt in der Tabelle erhalten.",
    "other": "Tabelle mit {count} nicht gemessenen Mengenzeilen veröffentlicht; die Gründe bleiben in der Tabelle erhalten."
  },
  "activityTray.job.bcfArchive": "BCF-Archiv exportieren",
  "activityTray.job.validationBcf": "Prüfbericht als BCF exportieren",
  "activityTray.job.publication": "BCF-Veröffentlichung",
  "activityTray.publication.effects": "{done} von {total} Serveraktionen abgeschlossen",
  "activityTray.publication.attention": {
    "one": "{count} Aktion erfordert eine Serverprüfung",
    "other": "{count} Aktionen erfordern eine Serverprüfung"
  },
  "activityTray.publication.failed": {
    "one": "{count} Aktion fehlgeschlagen",
    "other": "{count} Aktionen fehlgeschlagen"
  },
  "activityTray.ai.timeout": "Zeitüberschreitung",
  "activityTray.ai.truncated": "Am Ausgabelimit angehalten"
} satisfies Catalogue;
