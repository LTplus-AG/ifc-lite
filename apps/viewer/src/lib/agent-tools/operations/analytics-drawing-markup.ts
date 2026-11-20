/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import type { SelectedAnnotation2D } from '@/store/slices/drawing2DSlice';
import { isDegenerateArea, isDegenerateCloud } from '@/store/slices/drawing2DDegenerateGuards';
import { isToolAvailable } from '@/lib/features/tools';
import { computePolygonArea, computePolygonPerimeter } from '@/components/viewer/tools/computePolygonArea';
import { operation, viewerOperation, emptySchema } from './contract';
import { entityExists } from '../refs';
import { metadata, idSchema, checkpoint } from './analytics-common';
import { disabled, internal, invalidInput, stale, unavailable } from './refusals';
const point: JSONSchemaType<[number, number]> = { type: 'array', items: [{ type: 'number', minimum: -1e9, maximum: 1e9 }, { type: 'number', minimum: -1e9, maximum: 1e9 }], minItems: 2, maxItems: 2 };
const xy = ([x, y]: [number, number]) => ({ x, y });
const created = { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false };
const kind = { type: 'string' as const, enum: ['measure', 'polygon', 'text', 'cloud', 'tag', 'dimension'] as const };
function gate() { if (!isToolAvailable('annotate')) throw disabled('Annotation tools are disabled by the host.'); }
function has(selection: SelectedAnnotation2D): boolean {
  const s = useViewerStore.getState();
  const rows = selection.type === 'measure' ? s.measure2DResults : selection.type === 'polygon' ? s.polygonArea2DResults : selection.type === 'text' ? s.textAnnotations2D : selection.type === 'cloud' ? s.cloudAnnotations2D : selection.type === 'tag' ? s.tagAnnotations2D : s.dimensions2D;
  return rows.some(row => row.id === selection.id);
}
export const analyticsDrawingMarkupOperations = [
  viewerOperation(metadata('drawing.markups', 'drawing', 'Read exact native drawing-metre markup coordinates, dimensions, plane stamps and dimension undo/redo sizes.', ['read'], { type: 'object', properties: { measures: { type: 'array' }, polygons: { type: 'array' }, text: { type: 'array' }, clouds: { type: 'array' }, tags: { type: 'array' }, dimensions: { type: 'array' }, undo: { type: 'integer' }, redo: { type: 'integer' } }, required: ['measures', 'polygons', 'text', 'clouds', 'tags', 'dimensions', 'undo', 'redo'], additionalProperties: false }), emptySchema, () => { const s = useViewerStore.getState(); return { measures: s.measure2DResults, polygons: s.polygonArea2DResults, text: s.textAnnotations2D, clouds: s.cloudAnnotations2D, tags: s.tagAnnotations2D, dimensions: s.dimensions2D, undo: s.dimension2DUndo.length, redo: s.dimension2DRedo.length }; }),
  viewerOperation<{ points: [number, number][] }>(metadata('drawing.addPolygon', 'drawing', 'Complete a native polygon area/perimeter from drawing-metre points using the same geometry and completion as the pointer tool.', ['view', 'configuration'], created), {
    type: 'object', properties: { points: { type: 'array', items: point, minItems: 3, maxItems: 1000 } }, required: ['points'], additionalProperties: false,
  } satisfies JSONSchemaType<{ points: [number, number][] }>, (i, c) => {
    gate(); const s = useViewerStore.getState(); if (s.polygonArea2DPoints.length) throw unavailable('Finish or cancel the interactive polygon first.');
    const points = i.points.map(xy); const area = computePolygonArea(points); const perimeter = computePolygonPerimeter(points);
    if (isDegenerateArea(area)) throw invalidInput('invalid-value', 'The native polygon needs a nondegenerate area.'); checkpoint(c);
    c.commit(() => { for (const p of points) s.addPolygonArea2DPoint(p); s.completePolygonArea2D(area, perimeter); });
    const id = useViewerStore.getState().polygonArea2DResults.at(-1)?.id; if (!id) throw internal('Native polygon completion failed.'); return { id };
  }),
  viewerOperation<{ start: [number, number]; end: [number, number]; label: string }>(metadata('drawing.addCloud', 'drawing', 'Complete a native revision cloud from two drawing-metre bounding corners and its label.', ['view', 'configuration'], created), {
    type: 'object', properties: { start: point, end: point, label: { type: 'string', maxLength: 10000 } }, required: ['start', 'end', 'label'], additionalProperties: false,
  } satisfies JSONSchemaType<{ start: [number, number]; end: [number, number]; label: string }>, (i, c) => {
    gate(); const s = useViewerStore.getState(); if (s.cloudAnnotation2DPoints.length) throw unavailable('Finish or cancel the interactive cloud first.');
    if (isDegenerateCloud([xy(i.start), xy(i.end)])) throw invalidInput('invalid-value', 'The native cloud bounds are degenerate.'); checkpoint(c);
    c.commit(() => { s.addCloudAnnotation2DPoint(xy(i.start)); s.addCloudAnnotation2DPoint(xy(i.end)); s.completeCloudAnnotation2D(i.label); });
    const id = useViewerStore.getState().cloudAnnotations2D.at(-1)?.id; if (!id) throw internal('Native cloud completion failed.'); return { id };
  }),
  viewerOperation<{ position: [number, number]; text: string; font_size: number; color: string; background: string; border: string }>(metadata('drawing.addText', 'drawing', 'Add a native text annotation at drawing-metre coordinates with explicit pixel typography and colors.', ['view', 'configuration'], created), {
    type: 'object', properties: { position: point, text: { type: 'string', maxLength: 50000 }, font_size: { type: 'number', minimum: 6, maximum: 96 }, color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, background: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' }, border: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' } }, required: ['position', 'text', 'font_size', 'color', 'background', 'border'], additionalProperties: false,
  } satisfies JSONSchemaType<{ position: [number, number]; text: string; font_size: number; color: string; background: string; border: string }>, (i, c) => {
    gate(); const id = crypto.randomUUID(); checkpoint(c); c.commit(() => useViewerStore.getState().addTextAnnotation2D({ id, position: xy(i.position), text: i.text, fontSize: i.font_size, color: i.color, backgroundColor: i.background, borderColor: i.border })); return { id };
  }),
  viewerOperation<{ id: string; expected_text: string; text: string }>(metadata('drawing.editText', 'drawing', 'Edit native annotation text after verifying the exact previously inspected text.', ['view', 'configuration'], created), {
    type: 'object', properties: { id: idSchema.properties.id, expected_text: { type: 'string', maxLength: 50000 }, text: { type: 'string', maxLength: 50000 } }, required: ['id', 'expected_text', 'text'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; expected_text: string; text: string }>, (i, c) => {
    gate(); const s = useViewerStore.getState(); const row = s.textAnnotations2D.find(item => item.id === i.id); if (!row || row.text !== i.expected_text) throw stale('Text annotation changed since inspection.'); checkpoint(c); c.commit(() => s.updateTextAnnotation2D(i.id, { text: i.text })); return { id: i.id };
  }),
  operation<{ express_id: number; anchor: [number, number]; offset: [number, number] }>(metadata('drawing.addTag', 'drawing', 'Add a native live IFC element tag using an exact model-qualified product and drawing-metre anchor/offset.', ['read', 'view', 'configuration'], created), {
    type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, anchor: point, offset: point }, required: ['express_id', 'anchor', 'offset'], additionalProperties: false,
  } satisfies JSONSchemaType<{ express_id: number; anchor: [number, number]; offset: [number, number] }>, (i, c) => { gate(); if (!entityExists(c.model, i.express_id)) throw invalidInput('unknown-target', 'Unknown IFC tag target in this model.'); const id = crypto.randomUUID(); checkpoint(c); c.commit(() => useViewerStore.getState().addTagAnnotation2D({ id, modelId: c.model.id, entityId: i.express_id, anchor: xy(i.anchor), offset: xy(i.offset), template: 'auto' })); return { id }; }),
  viewerOperation<{ a: [number, number]; b: [number, number]; offset: number; orientation: 'aligned' | 'horizontal' | 'vertical'; text: string }>(metadata('drawing.addDimension', 'drawing', 'Place a native dimension from two drawing-metre points with numerical line offset, orientation and optional <> text override; uses native plane stamps and undo.', ['view', 'configuration'], created), {
    type: 'object', properties: { a: point, b: point, offset: { type: 'number', minimum: -1e9, maximum: 1e9 }, orientation: { type: 'string', enum: ['aligned', 'horizontal', 'vertical'] }, text: { type: 'string', maxLength: 10000 } }, required: ['a', 'b', 'offset', 'orientation', 'text'], additionalProperties: false,
  } satisfies JSONSchemaType<{ a: [number, number]; b: [number, number]; offset: number; orientation: 'aligned' | 'horizontal' | 'vertical'; text: string }>, (i, c) => {
    gate(); const s = useViewerStore.getState(); if (s.dimension2DPoints.length) throw unavailable('Finish or cancel the interactive dimension first.'); checkpoint(c);
    const id = c.commit(() => { s.addDimension2DPoint(xy(i.a)); s.addDimension2DPoint(xy(i.b)); return s.completeDimension2D({ offset: i.offset, orientation: i.orientation, ...(i.text ? { text: i.text } : {}), ...(s.drawing2DPlane ? { plane: s.drawing2DPlane } : {}) }); });
    if (!id) throw invalidInput('refused', 'Native dimension completion refused degenerate points.'); return { id };
  }),
  viewerOperation<{ id: string; kind: SelectedAnnotation2D['type']; position: [number, number] }>(metadata('drawing.moveMarkup', 'drawing', 'Move an existing native markup using its same drag-origin handler in drawing metres.', ['view', 'configuration'], created), {
    type: 'object', properties: { id: idSchema.properties.id, kind, position: point }, required: ['id', 'kind', 'position'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; kind: SelectedAnnotation2D['type']; position: [number, number] }>, (i, c) => { gate(); const selected = { id: i.id, type: i.kind }; if (!has(selected)) throw invalidInput('unknown-target', 'Unknown native markup.'); checkpoint(c); c.commit(() => { const s = useViewerStore.getState(); const before = s.dimensions2D; s.moveAnnotation2D(selected, xy(i.position)); if (i.kind === 'dimension') s.commitDimension2DMove(before); }); return { id: i.id }; }),
  viewerOperation<{ id: string; kind: SelectedAnnotation2D['type'] }>(metadata('drawing.deleteMarkup', 'drawing', 'Delete an existing native markup through the same selected-annotation handler as the UI.', ['view', 'configuration'], created), {
    type: 'object', properties: { id: idSchema.properties.id, kind }, required: ['id', 'kind'], additionalProperties: false,
  } satisfies JSONSchemaType<{ id: string; kind: SelectedAnnotation2D['type'] }>, (i, c) => { gate(); const selected = { id: i.id, type: i.kind }; if (!has(selected)) throw invalidInput('unknown-target', 'Unknown native markup.'); checkpoint(c); c.commit(() => { const s = useViewerStore.getState(); s.setSelectedAnnotation2D(selected); s.deleteSelectedAnnotation2D(); }); return { id: i.id }; }),
  viewerOperation<{ action: 'undo' | 'redo' }>(metadata('drawing.dimensionHistory', 'drawing', 'Undo or redo one native dimension create/edit/move/delete transaction.', ['view', 'configuration'], { type: 'object', properties: { undo: { type: 'integer' }, redo: { type: 'integer' } }, required: ['undo', 'redo'], additionalProperties: false }), {
    type: 'object', properties: { action: { type: 'string', enum: ['undo', 'redo'] } }, required: ['action'], additionalProperties: false,
  } satisfies JSONSchemaType<{ action: 'undo' | 'redo' }>, (i, c) => { gate(); const s = useViewerStore.getState(); if (!(i.action === 'undo' ? s.dimension2DUndo : s.dimension2DRedo).length) throw unavailable('Native dimension history is empty.'); checkpoint(c); c.commit(() => { if (i.action === 'undo') s.undoDimension2D(); else s.redoDimension2D(); }); const now = useViewerStore.getState(); return { undo: now.dimension2DUndo.length, redo: now.dimension2DRedo.length }; }),

];
