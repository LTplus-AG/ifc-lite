/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackMeasureFr = {
  "assistantSources.measurements.description": "Distances 3D, polylignes, angles et ajustements de rayon terminés, chacun avec son propre type et sa propre unité.",
  "assistantSources.measurements.rows": "Les lignes représentent les mesures terminées. Les types et les unités ne sont jamais additionnés ; les lignes obsolètes sont antérieures à un déplacement du modèle.",
  "assistantSources.measurements.unavailable": "Aucune mesure terminée n'existait lors de la capture. Mesurez dans la visionneuse et actualisez les données.",
  "assistantSources.measurements.ready": { one: "{count} mesure", other: "{count} mesures", many: "{count} de mesures" },
  "assistantSources.measurements.none": "Aucune mesure terminée",
  "assistantSources.measurements.suggestExplain": "Résume ces mesures par type",
  "assistantSources.measurements.suggestStale": "Quelles mesures sont obsolètes, et pourquoi ?",
  "assistantSources.drawingMeasurements.title": "Mesures sur le dessin",
  "assistantSources.drawingMeasurements.description": "Distances et surfaces mesurées sur le dessin 2D, en mètres et en mètres carrés.",
  "assistantSources.drawingMeasurements.rows": "Les lignes représentent les annotations de distance et de surface sur le dessin. Elles ne sont pas liées à la coupe sur laquelle elles ont été tracées.",
  "assistantSources.drawingMeasurements.unavailable": "Aucune mesure sur le dessin n'existait lors de la capture. Mesurez sur le dessin 2D et actualisez les données.",
  "assistantSources.drawingMeasurements.ready": { one: "{count} mesure sur le dessin", other: "{count} mesures sur le dessin", many: "{count} de mesures sur le dessin" },
  "assistantSources.drawingMeasurements.none": "Aucune mesure sur le dessin",
  "assistantSources.drawingMeasurements.suggestExplain": "Résume les distances et surfaces mesurées",
  "assistantSources.deviation.title": "Écart par rapport au scan",
  "assistantSources.deviation.description": "Statistiques d'écart entre le BIM et le scan pour chaque ressource de scan, en mètres.",
  "assistantSources.deviation.rows": "Les lignes représentent les ressources de scan avec leurs statistiques d'écart. Les valeurs globales couvrent tous les points ; ce n'est pas une moyenne des lignes.",
  "assistantSources.deviation.unavailable": "Aucune statistique d'écart n'était disponible lors de la capture. Calculez l'écart dans Nuages de points et actualisez les données.",
  "assistantSources.deviation.ready": { one: "{count} ressource de scan", other: "{count} ressources de scan", many: "{count} de ressources de scan" },
  "assistantSources.deviation.reading": "Lecture des statistiques d'écart",
  "assistantSources.deviation.none": "Écart non calculé",
  "assistantSources.deviation.suggestExplain": "Explique dans quelle mesure le scan s'écarte du modèle",
  "assistantSources.deviation.suggestTolerance": "Quelles ressources de scan sont hors tolérance ?",
} satisfies Catalogue;
