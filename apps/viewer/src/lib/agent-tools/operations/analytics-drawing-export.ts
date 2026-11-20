/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { exportNativeDrawing } from '@/lib/drawing/export-native-drawing';
import { exportableDimensions } from '@/store/slices/drawing2DDimensions';
import { useViewerStore } from '@/store';
import { viewerOperation } from './contract';
import { metadata, artifactSchema, checkpoint } from './analytics-common';
export const analyticsDrawingExportOperations = [
  viewerOperation<{ format: 'svg' | 'dxf' | 'pdf'; use_display_scale: boolean; scale: number }>(metadata('drawing.export', 'drawing', 'Await the real native composed drawing SVG/DXF/PDF producers shared with the toolbar, including native sheet/raw behavior, references, dimensions, markups, scan outlines, style and DXF CRS/encoding. Works with the panel closed; returns actual artifact bytes and explicit format limitations/warnings.', ['read', 'artifact'], {
    type: 'object', properties: { artifact: artifactSchema, warnings: { type: 'array', items: { type: 'string' } }, omitted_other_cut_dimensions: { type: 'integer', minimum: 0 } }, required: ['artifact', 'warnings', 'omitted_other_cut_dimensions'], additionalProperties: false,
  }), {
    type: 'object', properties: { format: { type: 'string', enum: ['svg', 'dxf', 'pdf'] }, use_display_scale: { type: 'boolean' }, scale: { type: 'number', exclusiveMinimum: 0, maximum: 1000000 } }, required: ['format', 'use_display_scale', 'scale'], additionalProperties: false,
  } satisfies JSONSchemaType<{ format: 'svg' | 'dxf' | 'pdf'; use_display_scale: boolean; scale: number }>, async (i, c) => {
    const s = useViewerStore.getState();
    const omitted = s.dimensions2D.length - exportableDimensions(s.dimensions2D, s.drawing2DPlane).length;
    const result = await exportNativeDrawing(i.format, { signal: c.signal, checkpoint: c.checkpoint, ...(i.use_display_scale ? {} : { scale: i.scale }) }); checkpoint(c);
    const warnings = [...result.warnings];
    if (omitted) warnings.push(`${omitted} dimensions from other cuts were left out by the native export.`);
    if (i.format === 'dxf') warnings.push('Native DXF exports model-space vectors; drawing-sheet frames and raster references are not DXF layers.');
    if (i.format === 'pdf' && s.sheetEnabled) warnings.push('The native sheet PDF rasterizes its composed SVG at the bounded native print resolution.');
    if (i.format === 'pdf' && !s.sheetEnabled) warnings.push('The native raw PDF includes cut geometry, references, tags and dimensions; text/cloud annotations and scan dots are not part of that native format.');
    return { artifact: await c.artifacts.create({ filename: result.filename, mimeType: result.blob.type, data: result.blob }), warnings, omitted_other_cut_dimensions: omitted };
  }),
];
