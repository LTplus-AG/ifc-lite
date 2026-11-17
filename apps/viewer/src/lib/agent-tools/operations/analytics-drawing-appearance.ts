/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { requireDrawingRuntime } from '@/lib/drawing/drawing-runtime';
import { isToolAvailable } from '@/lib/features/tools';
import { viewerOperation, emptySchema } from './contract';
import { metadata, idSchema, artifactSchema, removedSchema, checkpoint } from './analytics-common';
function drawingState() {
  const s = useViewerStore.getState();
  return { status: s.drawing2DStatus, progress: s.drawing2DProgress, phase: s.drawing2DPhase, error: s.drawing2DError,
    plane: s.drawing2DPlane, display: s.drawing2DDisplayOptions, hasDrawing: s.drawing2D !== null, hasSvg: Boolean(s.drawing2DSvgContent),
    preset: s.activePresetId, overrides: s.getActiveOverrideRules(), overridesEnabled: s.overridesEnabled,
    measurements: s.measure2DResults, polygons: s.polygonArea2DResults, text: s.textAnnotations2D, clouds: s.cloudAnnotations2D, tags: s.tagAnnotations2D };
}
const stateSchema = { type: 'object', properties: { status: { type: 'string' }, progress: { type: 'number' }, phase: { type: 'string' }, error: { type: ['string', 'null'] }, plane: { type: ['object', 'null'] }, display: { type: 'object' }, hasDrawing: { type: 'boolean' }, hasSvg: { type: 'boolean' }, preset: { type: ['string', 'null'] }, overrides: { type: 'array' }, overridesEnabled: { type: 'boolean' }, measurements: { type: 'array' }, polygons: { type: 'array' }, text: { type: 'array' }, clouds: { type: 'array' }, tags: { type: 'array' } }, required: ['status', 'progress', 'phase', 'error', 'plane', 'display', 'hasDrawing', 'hasSvg', 'preset', 'overrides', 'overridesEnabled', 'measurements', 'polygons', 'text', 'clouds', 'tags'], additionalProperties: false };
export const analyticsDrawingAppearanceOperations = [
  viewerOperation(metadata('drawing.state', 'drawing', 'Read native generation completion/error/progress, drawing plane, display options, graphic overrides and numerical markups.', ['read'], stateSchema), emptySchema, drawingState),
  viewerOperation<{ regenerate: boolean }>(metadata('drawing.generate', 'drawing', 'Await the native drawing request queue for the current numerical section plane. The admitted native cut is non-cancellable; terminal ready/error state is verified before reporting completion.', ['view', 'configuration'], stateSchema), {
    type: 'object', properties: { regenerate: { type: 'boolean' } }, required: ['regenerate'], additionalProperties: false,
  } satisfies JSONSchemaType<{ regenerate: boolean }>, async (i, c) => {
    if (!isToolAvailable('section')) throw new Error('Section tools are disabled by the host.');
    const runtime = requireDrawingRuntime();
    if (useViewerStore.getState().drawing2DStatus === 'generating' || runtime.isRegenerating) throw new Error('A native drawing generation is already running.');
    checkpoint(c); await c.commitAsync(() => runtime.generateDrawing(i.regenerate));
    const state = useViewerStore.getState();
    if (state.drawing2DStatus !== 'ready' || !state.drawing2D) throw new Error(state.drawing2DError ?? 'The native drawing queue completed without a drawing.');
    return drawingState();
  }),
  viewerOperation<{ hidden_lines: boolean; hatching: boolean; annotations: boolean; overlay_3d: boolean; scale: number; symbolic: boolean; ifc_annotations: boolean }>(metadata('drawing.configureDisplay', 'drawing', 'Configure native drawing visibility, scale and IFC/symbolic annotation settings used by the drawing runtime.', ['configuration', 'view'], stateSchema), {
    type: 'object', properties: { hidden_lines: { type: 'boolean' }, hatching: { type: 'boolean' }, annotations: { type: 'boolean' }, overlay_3d: { type: 'boolean' }, scale: { type: 'number', minimum: 1, maximum: 10000 }, symbolic: { type: 'boolean' }, ifc_annotations: { type: 'boolean' } }, required: ['hidden_lines', 'hatching', 'annotations', 'overlay_3d', 'scale', 'symbolic', 'ifc_annotations'], additionalProperties: false,
  } satisfies JSONSchemaType<{ hidden_lines: boolean; hatching: boolean; annotations: boolean; overlay_3d: boolean; scale: number; symbolic: boolean; ifc_annotations: boolean }>, (i, c) => {
    if (!isToolAvailable('section')) throw new Error('Section tools are disabled by the host.');
    checkpoint(c); c.commit(() => useViewerStore.getState().updateDrawing2DDisplayOptions({ showHiddenLines: i.hidden_lines, showHatching: i.hatching, showAnnotations: i.annotations, show3DOverlay: i.overlay_3d, scale: i.scale, useSymbolicRepresentations: i.symbolic, showIfcAnnotations: i.ifc_annotations })); return drawingState();
  }),
  viewerOperation<{ start: [number, number]; end: [number, number] }>(metadata('drawing.measure', 'drawing', 'Complete a numerical 2D distance with native calculation in current drawing metres.', ['view'], {
    type: 'object', properties: { id: { type: 'string' }, start: { type: 'object' }, end: { type: 'object' }, distance: { type: 'number' } }, required: ['id', 'start', 'end', 'distance'], additionalProperties: false,
  }), {
    type: 'object', properties: {
      start: { type: 'array', items: [{ type: 'number', minimum: -1e9, maximum: 1e9 }, { type: 'number', minimum: -1e9, maximum: 1e9 }], minItems: 2, maxItems: 2 },
      end: { type: 'array', items: [{ type: 'number', minimum: -1e9, maximum: 1e9 }, { type: 'number', minimum: -1e9, maximum: 1e9 }], minItems: 2, maxItems: 2 },
    }, required: ['start', 'end'], additionalProperties: false,
  } satisfies JSONSchemaType<{ start: [number, number]; end: [number, number] }>, (i, c) => {
    if (!isToolAvailable('measure')) throw new Error('Measurement tools are disabled by the host.');
    const s = useViewerStore.getState(); if (!s.drawing2D) throw new Error('Generate a native drawing first.');
    if (s.measure2DStart) throw new Error('Complete or cancel the current interactive 2D measurement.');
    if (i.start[0] === i.end[0] && i.start[1] === i.end[1]) throw new Error('A distance needs distinct points.');
    checkpoint(c); c.commit(() => { s.setMeasure2DStart({ x: i.start[0], y: i.start[1] }); s.setMeasure2DCurrent({ x: i.end[0], y: i.end[1] }); s.completeMeasure2D(); });
    const result = useViewerStore.getState().measure2DResults.at(-1); if (!result) throw new Error('Native 2D completion failed.'); return result;
  }),
  viewerOperation(metadata('drawing.exportGeneratedSvg', 'drawing', 'Return the current native generated SVG cache as a real artifact. This cache does not include panel-composed sheets, references or live markup overlays.', ['read', 'artifact'], artifactSchema), emptySchema, async (_, c) => {
    const s = useViewerStore.getState(); if (s.drawing2DStatus !== 'ready' || !s.drawing2DSvgContent) throw new Error('No completed native SVG drawing is available.'); checkpoint(c);
    return c.artifacts.create({ filename: 'generated-drawing.svg', mimeType: 'image/svg+xml', data: s.drawing2DSvgContent });
  }),
  viewerOperation(metadata('appearance.state', 'appearance', 'Read native appearance sources, saved draft and committed assignment recipe; omit host-owned thumbnail URLs.', ['read'], {
    type: 'object', properties: { sources: { type: 'array' }, draft: { type: ['object', 'null'] }, assignments: { type: ['object', 'null'] } }, required: ['sources', 'draft', 'assignments'], additionalProperties: false,
  }), emptySchema, () => { const s = useViewerStore.getState(); return { sources: s.appearanceSources.map(({ thumbnailUrl: _url, ...source }) => source), draft: s.appearanceDraft, assignments: s.appearanceAssignments }; }),
  viewerOperation<{ id: string }>(metadata('appearance.removeSource', 'appearance', 'Remove one registered native appearance source and release its asset ownership.', ['configuration'], removedSchema), idSchema, (i, c) => {
    if (!useViewerStore.getState().appearanceSources.some(row => row.id === i.id)) throw new Error('Unknown native appearance source.');
    checkpoint(c); c.commit(() => useViewerStore.getState().removeAppearanceSource(i.id)); return { removed: i.id };
  }),
];
