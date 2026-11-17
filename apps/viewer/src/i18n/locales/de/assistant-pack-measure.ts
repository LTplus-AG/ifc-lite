/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackMeasureDe = {
  "assistantSources.measurements.description": "Abgeschlossene 3D-Strecken-, Polylinien-, Winkel- und Radiusmessungen, jeweils mit eigener Art und Einheit.",
  "assistantSources.measurements.rows": "Zeilen stellen abgeschlossene Messungen dar. Arten und Einheiten werden nie zusammengezählt; veraltete Zeilen stammen aus der Zeit vor einer Modellverschiebung.",
  "assistantSources.measurements.unavailable": "Bei der Erfassung lagen keine abgeschlossenen Messungen vor. Messen Sie im Viewer und aktualisieren Sie die Nachweise.",
  "assistantSources.measurements.ready": {
    "one": "{count} Messung",
    "other": "{count} Messungen"
  },
  "assistantSources.measurements.none": "Keine abgeschlossenen Messungen",
  "assistantSources.measurements.suggestExplain": "Diese Messungen nach Art zusammenfassen",
  "assistantSources.measurements.suggestStale": "Welche Messungen sind veraltet und warum?",
  "assistantSources.drawingMeasurements.title": "Zeichnungsmessungen",
  "assistantSources.drawingMeasurements.description": "In der 2D-Zeichnung gemessene Strecken und Flächen in Metern und Quadratmetern.",
  "assistantSources.drawingMeasurements.rows": "Zeilen stellen Strecken- und Flächenmarkierungen in der Zeichnung dar. Sie sind nicht mit dem Schnitt verknüpft, in dem sie erstellt wurden.",
  "assistantSources.drawingMeasurements.unavailable": "Bei der Erfassung lagen keine Zeichnungsmessungen vor. Messen Sie in der 2D-Zeichnung und aktualisieren Sie die Nachweise.",
  "assistantSources.drawingMeasurements.ready": {
    "one": "{count} Zeichnungsmessung",
    "other": "{count} Zeichnungsmessungen"
  },
  "assistantSources.drawingMeasurements.none": "Keine Zeichnungsmessungen",
  "assistantSources.drawingMeasurements.suggestExplain": "Die gemessenen Strecken und Flächen zusammenfassen",
  "assistantSources.deviation.title": "Scanabweichung",
  "assistantSources.deviation.description": "Statistik der Abweichung zwischen BIM und Scan je Scanobjekt in Metern.",
  "assistantSources.deviation.rows": "Zeilen stellen Scanobjekte mit ihren Abweichungsstatistiken dar. Gesamtwerte berücksichtigen jeden Punkt und sind kein Mittelwert der Zeilen.",
  "assistantSources.deviation.unavailable": "Bei der Erfassung lagen keine Abweichungsstatistiken vor. Berechnen Sie die Abweichung unter Punktwolken und aktualisieren Sie die Nachweise.",
  "assistantSources.deviation.ready": {
    "one": "{count} Scanobjekt",
    "other": "{count} Scanobjekte"
  },
  "assistantSources.deviation.reading": "Abweichungsstatistiken werden gelesen",
  "assistantSources.deviation.none": "Abweichung nicht berechnet",
  "assistantSources.deviation.suggestExplain": "Erklären, wie stark der Scan vom Modell abweicht",
  "assistantSources.deviation.suggestTolerance": "Welche Scanobjekte liegen außerhalb der Toleranz?"
} satisfies Catalogue;
