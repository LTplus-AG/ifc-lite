/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackSiteDe = {
  'assistantSources.zones.description': 'In welcher Zone jedes Bauteil liegt, mit seinem Netzvolumen pro Zone und dem Grund, wenn ein Volumen fehlt',
  'assistantSources.zones.rows': 'Jede Zeile ist ein Bauteil in einer Zone, die es berührt, mit seinem Volumenanteil',
  'assistantSources.zones.unavailable': 'Keine Zonenzuordnung verfügbar. Erstellen Sie zuerst einen Zonensatz und lassen Sie die Bauteile zuordnen.',
  'assistantSources.zones.suggestSummary': 'Fasse zusammen, wie sich die Bauteile auf die Zonen verteilen',
  'assistantSources.zones.suggestUnmeasured': 'Welche Bauteile haben kein gemessenes Volumen, und warum?',
  'assistantSources.zones.noSets': 'Keine Zonensätze',
  'assistantSources.zones.notAssigned': 'Bauteile noch nicht zugeordnet',
  'assistantSources.zones.ready': { one: '{count} Zonensatz', other: '{count} Zonensätze' },
  'assistantSources.placement.description': 'Verschiebung und Ausrichtung jedes Modells im Arbeitsbereich, seine Georeferenz und eine etwaige doppelte Georeferenz',
  'assistantSources.placement.rows': 'Jede Zeile ist ein geladenes Modell mit seiner Platzierung und Georeferenz',
  'assistantSources.placement.unavailable': 'Es ist kein Modell geladen, daher gibt es keine Platzierung zu besprechen.',
  'assistantSources.placement.suggestAlignment': 'Sind die geladenen Modelle zueinander konsistent platziert?',
  'assistantSources.placement.suggestGeoref': 'Erkläre die Georeferenz jedes Modells und alles, was falsch aussieht',
  'assistantSources.layerDiff.title': 'Ebenenänderungen',
  'assistantSources.layerDiff.description': 'Was eine IFCX-Ebene im zusammengesetzten Stapel hinzufügt, ändert und löscht',
  'assistantSources.layerDiff.rows': 'Jede Zeile ist ein Pfad, den die Ebene hinzugefügt, geändert oder gelöscht hat',
  'assistantSources.layerDiff.unavailable': 'Es wurde kein Ebenenvergleich berechnet. Öffnen Sie zuerst die Änderungen einer Ebene im Bereich Ebenen.',
  'assistantSources.layerDiff.suggestSummary': 'Fasse zusammen, was diese Ebene ändert',
  'assistantSources.layerDiff.suggestReview': 'Was sollte ein Prüfer kontrollieren, bevor er diese Ebene übernimmt?',
  'assistantSources.layerDiff.noStack': 'Kein Ebenenstapel geladen',
  'assistantSources.layerDiff.running': 'Ebenenänderungen werden berechnet',
  'assistantSources.layerDiff.notRun': 'Keine Ebenenänderungen geöffnet',
  'assistantSources.layerDiff.ready': { one: '{count} Änderung', other: '{count} Änderungen' },
  'assistantSources.selection.title': 'Auswahl',
  'assistantSources.selection.description': 'Die ausgewählten Bauteile mit ihren Attributen, Eigenschaftssätzen und Mengen, einschließlich Bearbeitungen',
  'assistantSources.selection.rows': 'Jede Zeile ist ein ausgewähltes Bauteil, wie es im Bereich Eigenschaften angezeigt wird',
  'assistantSources.selection.unavailable': 'Nichts ausgewählt. Wählen Sie zuerst ein oder mehrere Bauteile aus.',
  'assistantSources.selection.suggestExplain': 'Erkläre, was ausgewählt ist und was daran auffällt',
  'assistantSources.selection.suggestCompare': 'Wie unterscheiden sich die ausgewählten Bauteile voneinander?',
  'assistantSources.selection.none': 'Nichts ausgewählt',
  'assistantSources.selection.ready': { one: '{count} Bauteil ausgewählt', other: '{count} Bauteile ausgewählt' },
} satisfies Catalogue;
