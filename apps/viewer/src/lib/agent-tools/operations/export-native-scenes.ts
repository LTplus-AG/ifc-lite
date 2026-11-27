/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { hasRetainedShapeOnlyModel, RETAINED_SHAPE_ONLY_REASON } from '@/store/retainedGeometry';
import { modelExportFilename, sanitizeFilename, stripExtension } from '@/lib/export/download';
import { produceNativeGlb } from '@/lib/export/native-glb';
import { produceNativeUsd, produceNativeRhino } from '@/lib/export/native-scenes';
import { NoEnergyRoomsError, produceNativeEnergy } from '@/lib/export/native-energy';
import { buildKmzForModel } from '@/lib/geo/kmz-export';
import type { RhinoExportSettings } from '@/components/viewer/rhino-export-options';
import { RHINO_UNITS, RHINO_COORDINATES, RHINO_LAYER_SCHEMES, RHINO_PROPERTIES, RHINO_3DM_VERSIONS } from '@/components/viewer/rhino-export-options';
import { nativeExportBlockReason } from '@/lib/export/native-policy';
import { viewerOperation } from './contract';
import { exportMetadata } from './exports-common';
import { instancedModelRangeOf } from '@/utils/instancedExport';
import { nativeExportTarget, nativeStepTarget, nativeExportGuard, nativeArtifact, targetSchema } from './export-native-runtime';
import { invalidInput, unavailable } from './refusals';
const rhino: JSONSchemaType<RhinoExportSettings> = { type: 'object', properties: {
  units: { type: 'string', enum: RHINO_UNITS }, coordinates: { type: 'string', enum: RHINO_COORDINATES }, layerScheme: { type: 'string', enum: RHINO_LAYER_SCHEMES }, properties: { type: 'string', enum: RHINO_PROPERTIES }, instancing: { type: 'boolean' }, includeSpaces: { type: 'boolean' }, visibleOnly: { type: 'boolean' }, version: { type: 'integer', enum: RHINO_3DM_VERSIONS },
}, required: ['units', 'coordinates', 'layerScheme', 'properties', 'instancing', 'includeSpaces', 'visibleOnly', 'version'], additionalProperties: false };
export const exportNativeSceneOperations = [
  viewerOperation<{ target_model_id: string; visible_only: boolean; include_metadata: boolean; lit: boolean; color_source: 'rendering' | 'shading' }>(exportMetadata('exports.glb', 'Await the exact native GLB dialog assembler for one explicitly targeted model. Native source-versus-mesh selection, merge-layer fidelity, instanced occurrences, class/storey/Lens visibility, apparent/shading color and lit/material metadata options are preserved. Refuse retained shape-only or stale output.'), {
    type: 'object', properties: { target_model_id: targetSchema, visible_only: { type: 'boolean' }, include_metadata: { type: 'boolean' }, lit: { type: 'boolean' }, color_source: { type: 'string', enum: ['rendering', 'shading'] } }, required: ['target_model_id', 'visible_only', 'include_metadata', 'lit', 'color_source'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string; visible_only: boolean; include_metadata: boolean; lit: boolean; color_source: 'rendering' | 'shading' }>, async (i, c) => { const blocked = nativeExportBlockReason('glb', useViewerStore.getState()); if (blocked) throw unavailable(blocked);
    const model = nativeExportTarget(i.target_model_id); if (!model.geometryResult) throw unavailable('Native GLB export needs completed render geometry.');
    const check = nativeExportGuard(c, [model.id]); check(); const result = await produceNativeGlb(model.id, { geometryResult: model.geometryResult }, { visibleOnly: i.visible_only, includeMetadata: i.include_metadata, lit: i.lit, colorSource: i.color_source }, check);
    return nativeArtifact(c, result.blob, modelExportFilename(model.name, 'glb', i.visible_only ? '_visible' : ''), { model_id: model.id, from_source_bytes: result.fromSourceBytes }, check);
  }),
  viewerOperation<{ target_model_id: string }>(exportMetadata('exports.usd', 'Await native edited STEP source resolution and Rust USDA production, with deterministic WASM disposal and native retained-geometry refusal. One explicit model; return actual UTF-8 stage bytes.'), {
    type: 'object', properties: { target_model_id: targetSchema }, required: ['target_model_id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string }>, async (i, c) => { const blocked = nativeExportBlockReason('usd', useViewerStore.getState()); if (blocked) throw unavailable(blocked); const model = nativeStepTarget(i.target_model_id); const check = nativeExportGuard(c, [model.id]); check(); const blob = await produceNativeUsd(model, useViewerStore.getState().getMutationView, check); return nativeArtifact(c, blob, modelExportFilename(model.name, 'usda'), { model_id: model.id }, check); }),
  viewerOperation<{ target_model_id: string; settings: RhinoExportSettings }>(exportMetadata('exports.rhino', 'Await the exact native cancellable Rhino worker and edited STEP resolver with all existing units/coordinates/layers/instancing/property/space/version/visibility controls. Return the actual .3dm bytes and native warnings; no main-thread fallback.'), {
    type: 'object', properties: { target_model_id: targetSchema, settings: rhino }, required: ['target_model_id', 'settings'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string; settings: RhinoExportSettings }>, async (i, c) => { const blocked = nativeExportBlockReason('3dm', useViewerStore.getState()); if (blocked) throw unavailable(blocked); const model = nativeStepTarget(i.target_model_id); const check = nativeExportGuard(c, [model.id]); check(); const result = await produceNativeRhino(model, i.settings, useViewerStore.getState().getMutationView, p => { c.progress?.({ phase: p.phase, done: 'done' in p ? p.done : 0, total: 'total' in p ? p.total : 1 }); }, c.signal, check); return nativeArtifact(c, new Blob([new Uint8Array(result.bytes)], { type: 'application/vnd.rhino' }), modelExportFilename(model.name, '3dm'), { model_id: model.id, warnings: result.warnings }, check); }),
  viewerOperation<{ target_model_id: string; format: 'hbjson' | 'dfjson' }>(exportMetadata('exports.energy', 'Await native Honeybee/Dragonfly energy export from the current edited model, including Room-tool spaces. Preserve no-space/source/retained refusals and HBJSON skipped-space counts instead of reporting truncated output as unqualified success.'), {
    type: 'object', properties: { target_model_id: targetSchema, format: { type: 'string', enum: ['hbjson', 'dfjson'] } }, required: ['target_model_id', 'format'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string; format: 'hbjson' | 'dfjson' }>, async (i, c) => { const blocked = nativeExportBlockReason('energy', useViewerStore.getState()); if (blocked) throw unavailable(blocked); const model = nativeExportTarget(i.target_model_id); const check = nativeExportGuard(c, [model.id]); check(); let result: Awaited<ReturnType<typeof produceNativeEnergy>>;
    try { result = await produceNativeEnergy(model, i.format, check); }
    catch (error) {
      if (error instanceof NoEnergyRoomsError) throw invalidInput('wrong-target', error.message);
      throw error;
    }
    return nativeArtifact(c, result.blob, modelExportFilename(model.name, i.format), { model_id: model.id, stats: result.stats, skip_note: result.hbjsonSkipNote }, check); }),
  viewerOperation<{ target_model_id: string; altitude_mode: 'clampToGround' | 'absolute' }>(exportMetadata('exports.kmz', 'Await the native georeference-to-WGS84/COLLADA KMZ producer, one model including its own instanced occurrences, explicit terrain-clamped versus MSL altitude, pending georeference edits and native refusal diagnostics.'), {
    type: 'object', properties: { target_model_id: targetSchema, altitude_mode: { type: 'string', enum: ['clampToGround', 'absolute'] } }, required: ['target_model_id', 'altitude_mode'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string; altitude_mode: 'clampToGround' | 'absolute' }>, async (i, c) => { const blocked = nativeExportBlockReason('kmz', useViewerStore.getState()); if (blocked) throw unavailable(blocked);
    const model = nativeExportTarget(i.target_model_id); const s = useViewerStore.getState();
    if (hasRetainedShapeOnlyModel(s.models)) throw unavailable(RETAINED_SHAPE_ONLY_REASON);
    if (!model.geometryResult || !model.ifcDataStore) throw unavailable('Native KMZ requires IFC geometry and georeferencing data.');
    const check = nativeExportGuard(c, [model.id]); check(); const result = await buildKmzForModel({ geometryResult: model.geometryResult, instancedModelRange: instancedModelRangeOf(model.id, s.models), dataStore: model.ifcDataStore, mutations: s.georefMutations.get(model.id), name: sanitizeFilename(stripExtension(model.name), { fallback: 'model' }), altitudeMode: i.altitude_mode });
    check(); if (typeof result === 'string') throw invalidInput('refused', `Native KMZ refused: ${result}`);
    return nativeArtifact(c, new Blob([new Uint8Array(result)], { type: 'application/vnd.google-earth.kmz' }), modelExportFilename(model.name, 'kmz'), { model_id: model.id, altitude_mode: i.altitude_mode }, check);
  }),
];
