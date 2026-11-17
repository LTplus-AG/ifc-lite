/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Catalogue } from '../../registry';

export const clashQualityDe = {
  'clashQuality.detectionExclusions': 'Ausschlüsse für Öffnungen und Trägerelemente bei der Erkennung: {value}',
  'clashQuality.enabled': 'Aktiviert',
  'clashQuality.disabled': 'Deaktiviert',
  'clashQuality.title': 'Qualitätskriterien',
  'clashQuality.configure': 'Qualitätskriterien konfigurieren',
  'clashQuality.clash': 'Kollisionsprüfungen',
  'clashQuality.duplicates': 'Duplikatprüfungen',
  'clashQuality.minimum': 'Mindestanteil unauffälliger Objekte in %',
  'clashQuality.label': 'Kategoriename',
  'clashQuality.color': 'Kategoriefarbe',
  'clashQuality.newCategory': 'Neue Kategorie',
  'clashQuality.add': 'Kategorie hinzufügen',
  'clashQuality.remove': 'Kategorie entfernen',
  'clashQuality.save': 'Schwellenwerte speichern',
  'clashQuality.saved': 'Schwellenwerte der Qualitätskriterien gespeichert',
  'clashQuality.failed': 'Schwellenwerte der Qualitätskriterien konnten nicht gespeichert werden',
  'clashQuality.invalid': 'Bei 0 % beginnen, aufsteigende Mindestwerte bis 100 % verwenden und jede Kategorie benennen.',
  'clashQuality.policy': 'Unauffällige Objekte sind geprüfte eindeutige Objekte ohne erkannte Befunde. Beide Objekte jedes Paares zählen; mehrfach betroffene Objekte zählen einmal. Ergebnisausschlüsse, Prüfstatus und Anzeigefilter ändern diesen Wert nicht. Erkennungsausschlüsse für Öffnungen und Trägerelemente gelten weiterhin. Duplikatprüfungen berücksichtigen alle beteiligten Objekte, nicht nur überzählige Kopien.',
  'clashQuality.counts': '{checked} geprüft · {affected} betroffen',
  'clashQuality.metric': 'Objekte ohne erkannte Befunde',
  'clashQuality.not-evaluated': 'Nicht ausgewertet',
  'clashQuality.unavailable': 'Prüfumfang nicht verfügbar',
  'clashQuality.incomplete': 'Unvollständiger Prüflauf',
  'clashQuality.outdated': 'Veralteter Prüflauf',
  'clashQuality.document': 'Qualitätskriterien zur Dokumentation hinzufügen',
  'clashQuality.documentFailed': 'Das Dokument der Qualitätskriterien konnte nicht gespeichert werden',
  'clashQuality.models': 'Modelle: {models}',
  'clashQuality.tolerance': 'Toleranz: {tolerance} m',
  'clashQuality.clearance': 'Mindestabstand: {clearance} m',
  'clashQuality.captured': 'Erfasst: {when}',
  'clashQuality.revision': 'Modellbearbeitungsstand: {revision}',
  'clashQuality.unknown': 'Unbekannt',
} satisfies Catalogue;
