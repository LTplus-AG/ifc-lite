/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { assertToolActive } from '../cancellation';
import { getPdfDocument } from '@/lib/appearance/pdf/documents';
import { pdfCalibrationFrame } from '@/lib/appearance/pdf/calibration';
import { imageCalibrationFrame, rasterLandmarkAt, completeRasterCalibration } from '@/lib/appearance/raster-calibration';
const outputSchema = {
  type: 'object',
  properties: { native_json: { type: 'string' } },
  required: ['native_json'],
  additionalProperties: false,
};
const out = (value: unknown) => ({ native_json: JSON.stringify(value ?? null) });
const meta = (id: string, description: string, write = false) => ({
  id,
  owner: 'appearance',
  description,
  effects: write ? (['configuration'] as const) : (['read'] as const),
  capability: write ? ('commands-and-edits' as const) : ('read' as const),
  implementation: 'native-store' as const,
  outputSchema,
});
function source(id: string) {
  const value = useViewerStore.getState().appearanceSources.find((item) => item.id === id);
  if (!value) throw new Error('Unknown registered appearance source.');
  return value;
}
export const appearanceSourceOperations = [
  viewerOperation<{ source_id: string }>(
    meta(
      'appearance.source.inspect',
      'Inspect an existing registered source, native PDF recipe/page count and calibration frame. Browser file selection and encrypted-PDF password entry remain explicit native input boundaries.',
    ),
    {
      type: 'object',
      properties: { source_id: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['source_id'],
      additionalProperties: false,
    },
    async (i, c) => {
      assertToolActive(c);
      const value = source(i.source_id);
      return out({
        source: value,
        expected_source: JSON.stringify(value),
        pageCount: value.pdf ? (getPdfDocument(value.pdf.documentKey)?.pageCount ?? null) : null,
        frame:
          value.calibrationFrame ??
          (value.pdf ? pdfCalibrationFrame(value.pdf.recipe) : imageCalibrationFrame(value.width, value.height)),
      });
    },
  ),
  viewerOperation<{
    source_id: string;
    expected_source: string;
    page: number;
    rotation: 0 | 90 | 180 | 270;
    crop_points: number[];
    dpi: number;
  }>(
    meta(
      'appearance.pdf.raster',
      'Rasterize a registered retained PDF with explicit page/quarter-turn/crop/DPI through the exact native PDF document service. Empty crop_points selects the complete rotated page. Publishes only if source and handle remain current; native worker bounds, PDF errors and ownership cleanup are preserved.',
      true,
    ),
    {
      type: 'object',
      properties: {
        source_id: { type: 'string', minLength: 1, maxLength: 200 },
        expected_source: { type: 'string', maxLength: 1000000 },
        page: { type: 'integer', minimum: 1, maximum: 1000000 },
        rotation: { type: 'integer', enum: [0, 90, 180, 270] },
        crop_points: { type: 'array', maxItems: 4, items: { type: 'number', minimum: -1e9, maximum: 1e9 } },
        dpi: { type: 'number', minimum: 1, maximum: 2400 },
      },
      required: ['source_id', 'expected_source', 'page', 'rotation', 'crop_points', 'dpi'],
      additionalProperties: false,
    },
    async (i, c) => {
      const { rasterNativePdfSource } = await import('@/lib/appearance/appearance-native-pdf');
      assertToolActive(c);
      const value = source(i.source_id);
      if (JSON.stringify(value) !== i.expected_source || !value.pdf)
        throw new Error('The native PDF source changed or is unavailable.');
      if (i.crop_points.length !== 0 && i.crop_points.length !== 4)
        throw new Error('crop_points must be empty or [left,top,width,height].');
      if (!c.signal) throw new Error('A live cancellation signal is required.');
      const result = await rasterNativePdfSource(
        value.pdf.documentKey,
        {
          pageNumber: i.page,
          rotation: i.rotation,
          dpi: i.dpi,
          ...(i.crop_points.length ? { cropPoints: i.crop_points as [number, number, number, number] } : {}),
        },
        { signal: c.signal, isCurrent: () => source(i.source_id) === value, commit: (write) => c.commit(write) },
      );
      return out({ source: result, expected_source: JSON.stringify(result) });
    },
  ),
  viewerOperation<{
    source_id: string;
    expected_source: string;
    fractions: [[number, number], [number, number]];
    distance_metres: number;
  }>(
    meta(
      'appearance.source.calibrate',
      'Set a complete two-landmark metric calibration on a registered image/PDF using the same native raster-coordinate conversion and complete-edit reducer as AppearanceCalibrationFields. Fractions refer to the current raster image; source coordinates remain stable across PDF crop/rotation.',
      true,
    ),
    {
      type: 'object',
      properties: {
        source_id: { type: 'string', minLength: 1, maxLength: 200 },
        expected_source: { type: 'string', maxLength: 1000000 },
        fractions: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: [
            {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: [
                { type: 'number', minimum: 0, maximum: 1 },
                { type: 'number', minimum: 0, maximum: 1 },
              ],
            },
            {
              type: 'array',
              minItems: 2,
              maxItems: 2,
              items: [
                { type: 'number', minimum: 0, maximum: 1 },
                { type: 'number', minimum: 0, maximum: 1 },
              ],
            },
          ],
        },
        distance_metres: { type: 'number', exclusiveMinimum: 0, maximum: 1e9 },
      },
      required: ['source_id', 'expected_source', 'fractions', 'distance_metres'],
      additionalProperties: false,
    },
    async (i, c) => {
      assertToolActive(c);
      const value = source(i.source_id);
      if (JSON.stringify(value) !== i.expected_source) throw new Error('The native source changed. Inspect again.');
      const frame =
        value.calibrationFrame ??
        (value.pdf ? pdfCalibrationFrame(value.pdf.recipe) : imageCalibrationFrame(value.width, value.height));
      const calibration = completeRasterCalibration(
        i.fractions.map((fraction) => rasterLandmarkAt(frame, fraction)),
        i.distance_metres,
      );
      if (!calibration) throw new Error('Choose two distinct source landmarks and a positive metric distance.');
      return out(
        c.commit(() => {
          if (source(i.source_id) !== value) throw new Error('The native source changed.');
          useViewerStore.getState().updateAppearanceSource({ ...value, calibration });
          return { calibration, expected_source: JSON.stringify(source(i.source_id)) };
        }),
      );
    },
  ),
];
