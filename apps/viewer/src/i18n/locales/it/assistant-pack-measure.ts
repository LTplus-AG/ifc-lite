/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { Catalogue } from '../../registry';

export const assistantPackMeasureIt = {
  "assistantSources.measurements.description": "Distanze 3D, polilinee, angoli e raggi interpolati completati, ciascuno con il proprio tipo e la propria unità.",
  "assistantSources.measurements.rows": "Le righe rappresentano misure completate. Tipi e unità non vengono mai sommati tra loro; le righe obsolete risalgono a prima di uno spostamento del modello.",
  "assistantSources.measurements.unavailable": "Al momento dell'acquisizione non c'erano misure completate. Misura nel visualizzatore e aggiorna le evidenze.",
  "assistantSources.measurements.ready": { one: "{count} misura", other: "{count} misure", many: "{count} misure" },
  "assistantSources.measurements.none": "Nessuna misura completata",
  "assistantSources.measurements.suggestExplain": "Riassumi queste misure per tipo",
  "assistantSources.measurements.suggestStale": "Quali misure sono obsolete e perché?",
  "assistantSources.drawingMeasurements.title": "Misure sul disegno",
  "assistantSources.drawingMeasurements.description": "Distanze e aree misurate sul disegno 2D, in metri e metri quadrati.",
  "assistantSources.drawingMeasurements.rows": "Le righe rappresentano annotazioni di distanza e di area sul disegno. Le righe non sono collegate alla sezione su cui sono state disegnate.",
  "assistantSources.drawingMeasurements.unavailable": "Al momento dell'acquisizione non c'erano misure sul disegno. Misura sul disegno 2D e aggiorna le evidenze.",
  "assistantSources.drawingMeasurements.ready": { one: "{count} misura sul disegno", other: "{count} misure sul disegno", many: "{count} misure sul disegno" },
  "assistantSources.drawingMeasurements.none": "Nessuna misura sul disegno",
  "assistantSources.drawingMeasurements.suggestExplain": "Riassumi le distanze e le aree misurate",
  "assistantSources.deviation.title": "Scostamento dalla scansione",
  "assistantSources.deviation.description": "Statistiche dello scostamento tra BIM e scansione per ogni risorsa di scansione, in metri.",
  "assistantSources.deviation.rows": "Le righe rappresentano risorse di scansione con le relative statistiche di scostamento. I valori aggregati coprono tutti i punti, non sono una media delle righe.",
  "assistantSources.deviation.unavailable": "Al momento dell'acquisizione non erano disponibili statistiche di scostamento. Calcola lo scostamento in Nuvole di punti e aggiorna le evidenze.",
  "assistantSources.deviation.ready": { one: "{count} risorsa di scansione", other: "{count} risorse di scansione", many: "{count} risorse di scansione" },
  "assistantSources.deviation.reading": "Lettura delle statistiche di scostamento",
  "assistantSources.deviation.none": "Scostamento non calcolato",
  "assistantSources.deviation.suggestExplain": "Spiega quanto la scansione si discosta dal modello",
  "assistantSources.deviation.suggestTolerance": "Quali risorse di scansione sono fuori tolleranza?",
} satisfies Catalogue;
