/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { isToolAvailable } from '@/lib/features/tools';
import { centerDxfPlacement } from '@/lib/drawing/center-dxf';
import { drawnSectionPlane } from '@/lib/drawing/drawn-section-plane';
import { resolveDxfExportGeoreference, buildDxfMapToWorldTransform } from '@/hooks/dxfExportGeoref';
import { captureDxfReferenceFrame } from '@/hooks/dxfReferencePlane';
import { ingestDxfFile } from '@/hooks/ingest/dxfIngest';
import { viewerOperation } from './contract';
import { metadata, checkpoint, idSchema } from './analytics-common';
import { disabled, internal, invalidInput, stale, unavailable, parseJsonInput } from './refusals';
const applied = { type: 'object', properties: { applied: { type: 'boolean' } }, required: ['applied'], additionalProperties: false };
const color = { type: 'string' as const, pattern: '^#[0-9a-fA-F]{6}$' };
export const analyticsDrawingControlOperations = [
  viewerOperation<{ id: string }>(metadata('drawing.centerDxf', 'drawing', 'Center a DXF on the actual generated model drawing using the native underlay/georeference/reference-plane transforms. Refuse unusable bounds, edge-on references or nonfinite coordinates.', ['view', 'configuration'], applied), idSchema, (i, c) => {
    const s = useViewerStore.getState(); const drawing = s.drawing2D; const entry = s.dxfUnderlays.find(row => row.id === i.id);
    if (!drawing || !entry) throw unavailable('Generate a drawing and register this DXF first.');
    const plane = drawnSectionPlane(s);
    const georef = resolveDxfExportGeoreference({ models: s.models, legacyDataStore: s.ifcDataStore, legacyCoordinateInfo: s.geometryResult?.coordinateInfo, anchorModelIdOverride: s.anchorModelIdOverride, georefMutations: s.georefMutations });
    const result = centerDxfPlacement(entry, drawing, drawing, s.geometryResult?.coordinateInfo, plane.flipped && plane.custom === undefined, { transform: buildDxfMapToWorldTransform(georef), available: georef !== null }, s);
    if (result.error) throw invalidInput('refused', `Native DXF Center refused: ${result.error}`);
    checkpoint(c); c.commit(() => s.updateDxfUnderlayPlacement(i.id, result.placement)); return { applied: true };
  }),
  viewerOperation<{ filename: string; content: string; units: 'm' | 'mm' | 'cm' | 'ft' | 'in'; register_to_drawing_plane: boolean }>(metadata('drawing.importDxf', 'drawing', 'Import DXF text through the exact native ingest service with explicit source units and optional frozen current drawing-plane registration. Await actual newly registered underlay; native parsing/empty/reference-unit failure returns an error.', ['configuration', 'view'], { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false }), {
    type: 'object', properties: { filename: { type: 'string', minLength: 5, maxLength: 200, pattern: '\\.dxf$' }, content: { type: 'string', minLength: 1, maxLength: 10000000 }, units: { type: 'string', enum: ['m', 'mm', 'cm', 'ft', 'in'] }, register_to_drawing_plane: { type: 'boolean' } }, required: ['filename', 'content', 'units', 'register_to_drawing_plane'], additionalProperties: false,
  } satisfies JSONSchemaType<{ filename: string; content: string; units: 'm' | 'mm' | 'cm' | 'ft' | 'in'; register_to_drawing_plane: boolean }>, async (i, c) => {
    const s = useViewerStore.getState(); const plane = s.drawing2D?.config.plane; if (i.register_to_drawing_plane && !plane) throw unavailable('Generate a cardinal drawing plane before importing a registered reference.');
    const referenceFrame = i.register_to_drawing_plane && plane ? captureDxfReferenceFrame(s, plane) : undefined;
    checkpoint(c);
    const id = await c.commitAsync(() => ingestDxfFile(new File([i.content], i.filename, { type: 'application/dxf' }), { units: i.units, referenceFrame }), result => result !== null);
    if (!id) throw internal('Native DXF ingest did not register one drawable reference.'); return { id };
  }),
  viewerOperation<{ id: string; expected_json: string; font_size: number; color: string; background: string; border: string }>(metadata('drawing.styleText', 'drawing', 'Edit existing native text typography through the same annotation setter as the editor; preserve content/position and check the complete previous annotation.', ['view', 'configuration'], applied), {
    type: 'object', properties: { id: idSchema.properties.id, expected_json: { type: 'string', minLength: 2, maxLength: 100000 }, font_size: { type: 'number', minimum: 6, maximum: 96 }, color, background: color, border: color }, required: ['id', 'expected_json', 'font_size', 'color', 'background', 'border'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_json: string; font_size: number; color: string; background: string; border: string }>, (i, c) => {
    if (!isToolAvailable('annotate')) throw disabled('Annotation tools are disabled by the host.');
    const s = useViewerStore.getState(); const row = s.textAnnotations2D.find(value => value.id === i.id);
    if (!row || JSON.stringify(row) !== JSON.stringify(parseJsonInput(i.expected_json, 'expected_json'))) throw stale('Native text annotation changed since inspection.');
    checkpoint(c); c.commit(() => s.updateTextAnnotation2D(i.id, { fontSize: i.font_size, color: i.color, backgroundColor: i.background, borderColor: i.border })); return { applied: true };
  }),
];
