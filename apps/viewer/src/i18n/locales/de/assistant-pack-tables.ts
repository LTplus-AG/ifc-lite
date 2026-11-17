/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackTablesDe = {
  'assistantSources.lists.description': 'Der letzte Listenlauf: Spalten, Einheiten, Summen und Zeilen.',
  'assistantSources.lists.rows': 'Die Zeilen sind die von der ausgeführten Liste gefundenen Bauteile mit ihren Spaltenwerten.',
  'assistantSources.lists.unavailable': 'Bei der Erfassung war kein Listenergebnis verfügbar. Führen Sie im Bereich Listen eine Liste aus und aktualisieren Sie die Belege.',
  'assistantSources.lists.suggestSummary': 'Fasse diese Liste und ihre Summen zusammen',
  'assistantSources.lists.suggestGaps': 'In welchen Zeilen fehlen Werte?',
  'assistantSources.lists.running': 'Wird ausgeführt …',
  'assistantSources.lists.ready': { one: '{count} Zeile', other: '{count} Zeilen' },
  'assistantSources.lists.notRun': 'Noch kein Listenlauf',
  'assistantSources.charts.title': 'Diagramme',
  'assistantSources.charts.description': 'Das aktive Dashboard: Klassen, Werte und nicht zuordenbare Einträge jedes Diagramms.',
  'assistantSources.charts.rows': 'Die Zeilen sind Diagrammklassen, jeweils mit Diagramm, Wert, Anzahl und Einheit.',
  'assistantSources.charts.unavailable': 'Bei der Erfassung war kein Diagramm-Dashboard verfügbar. Öffnen Sie den Bereich Diagramme und aktualisieren Sie die Belege.',
  'assistantSources.charts.suggestSummary': 'Was fällt in diesen Diagrammen auf?',
  'assistantSources.charts.suggestGaps': 'Welche Bauteile konnten nicht in Diagrammen dargestellt werden, und warum?',
  'assistantSources.charts.ready': { one: '{count} Diagramm', other: '{count} Diagramme' },
  'assistantSources.charts.noDashboard': 'Noch kein Dashboard',
  'assistantSources.charts.noCharts': 'Das Dashboard enthält keine Diagramme',
  'assistantSources.cost.description': 'Kostenpositionen aller geladenen Modelle mit berechneten Beträgen, Währungen und Diagnosen.',
  'assistantSources.cost.rows': 'Die Zeilen sind IfcCostItem-Einträge mit berechnetem Betrag, Währung und Diagnosen.',
  'assistantSources.cost.unavailable': 'Bei der Erfassung war keine Kostenquelle verfügbar. Laden Sie ein IFC-Modell, um seine Kostendaten zu lesen.',
  'assistantSources.cost.suggestSummary': 'Fasse die Kostensummen pro Währung zusammen',
  'assistantSources.cost.suggestGaps': 'Welche Kostenpositionen haben keinen Betrag, und warum?',
  'assistantSources.cost.ready': { one: '{count} Modell mit Kostenquelle', other: '{count} Modelle mit Kostenquelle' },
  'assistantSources.cost.noSource': 'Keine IFC-Quelle zum Lesen der Kosten',
} satisfies Catalogue;
