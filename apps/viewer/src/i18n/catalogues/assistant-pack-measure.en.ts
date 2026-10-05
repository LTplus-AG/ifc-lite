/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { TranslationValue } from '../types';

/** Assistant evidence adapters in `lib/assistant/adapters/pack-measure.ts` (#6833). */
export const assistantPackMeasureEn = {
  'assistantSources.measurements.description': 'Finished 3D distances, polylines, angles and radius fits, each in its own kind and unit.',
  'assistantSources.measurements.rows': 'Rows represent finished measurements. Kinds and units are never added together; stale rows predate a model move.',
  'assistantSources.measurements.unavailable': 'There were no finished measurements at capture. Measure in the viewer and refresh the evidence.',
  'assistantSources.measurements.ready': { one: '{count} measurement', other: '{count} measurements' },
  'assistantSources.measurements.none': 'No finished measurements',
  'assistantSources.measurements.suggestExplain': 'Summarise these measurements by kind',
  'assistantSources.measurements.suggestStale': 'Which measurements are stale, and why?',
  'assistantSources.drawingMeasurements.title': 'Drawing measurements',
  'assistantSources.drawingMeasurements.description': 'Distances and areas measured on the 2D drawing, in metres and square metres.',
  'assistantSources.drawingMeasurements.rows': 'Rows represent distance and area markup on the drawing. Rows are not linked to the section they were drawn on.',
  'assistantSources.drawingMeasurements.unavailable': 'There were no drawing measurements at capture. Measure on the 2D drawing and refresh the evidence.',
  'assistantSources.drawingMeasurements.ready': { one: '{count} drawing measurement', other: '{count} drawing measurements' },
  'assistantSources.drawingMeasurements.none': 'No drawing measurements',
  'assistantSources.drawingMeasurements.suggestExplain': 'Summarise the measured distances and areas',
  'assistantSources.deviation.title': 'Scan deviation',
  'assistantSources.deviation.description': 'BIM to scan deviation statistics per scan asset, in metres.',
  'assistantSources.deviation.rows': 'Rows represent scan assets with their deviation statistics. Pooled figures cover every point, not an average of the rows.',
  'assistantSources.deviation.unavailable': 'No deviation statistics were available at capture. Compute deviation in Point clouds and refresh the evidence.',
  'assistantSources.deviation.ready': { one: '{count} scan asset', other: '{count} scan assets' },
  'assistantSources.deviation.reading': 'Reading deviation statistics',
  'assistantSources.deviation.none': 'Deviation not computed',
  'assistantSources.deviation.suggestExplain': 'Explain how far the scan deviates from the model',
  'assistantSources.deviation.suggestTolerance': 'Which scan assets fall outside the tolerance?',
} as const satisfies Record<string, TranslationValue>;
