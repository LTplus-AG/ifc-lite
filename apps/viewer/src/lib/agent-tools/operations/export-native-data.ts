/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { editedModelBytes } from '@/lib/export/edited-model-bytes';
import { exportCsvFromBytes, type CsvMode } from '@/lib/export/csv';
import { buildCommandPaletteJsonEntities } from '@/components/viewer/commandPaletteJsonExport';
import { modelExportFilename } from '@/lib/export/download';
import { resolveTerrainSelection, runLandXmlTerrainExport, landXmlTerrainFilename } from '@/lib/export/landXmlTerrainExport';
import { viewerOperation } from './contract';
import { exportMetadata } from './exports-common';
import { nativeExportTarget, nativeExportGuard, nativeArtifact, targetSchema } from './export-native-runtime';
const suffix = { entities: '_entities', properties: '_properties', quantities: '_quantities', spatial: '_spatial-hierarchy' };
export const exportNativeDataOperations = [
  viewerOperation<{ target_model_id: string; table: CsvMode }>(exportMetadata('exports.csv', 'Await one native registry CSV table (entities with properties, properties, quantities or spatial hierarchy), from an explicit model including its pending edits. Uses the exact Rust CSV producer shared by toolbar exports. Does not silently combine federated express IDs.'), {
    type: 'object', properties: { target_model_id: targetSchema, table: { type: 'string', enum: ['entities', 'properties', 'quantities', 'spatial'] } }, required: ['target_model_id', 'table'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string; table: CsvMode }>, async (i, c) => {
    const model = nativeExportTarget(i.target_model_id); if (!model.ifcDataStore?.source.byteLength) throw new Error('Native CSV requires a parsed source store.');
    const check = nativeExportGuard(c, [model.id]); check(); const content = await exportCsvFromBytes(editedModelBytes(model.ifcDataStore, useViewerStore.getState().getMutationView(model.id)), i.table, { includeProperties: i.table === 'entities' });
    return nativeArtifact(c, new Blob([content], { type: 'text/csv' }), modelExportFilename(model.name, 'csv', suffix[i.table]), { model_id: model.id, table: i.table, scope: 'one-model' }, check);
  }),
  viewerOperation<{ target_model_id: string }>(exportMetadata('exports.json', 'Produce the native toolbar JSON entity envelope for one explicit model using its effective pending-edit view and canonical row builder. Preserve exact IFC EXPRESS names and native JSON value representation.'), {
    type: 'object', properties: { target_model_id: targetSchema }, required: ['target_model_id'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string }>, async (i, c) => {
    const model = nativeExportTarget(i.target_model_id); if (!model.ifcDataStore) throw new Error('Native JSON requires a parsed entity store.');
    const check = nativeExportGuard(c, [model.id]); check(); const entities = buildCommandPaletteJsonEntities(model.ifcDataStore, useViewerStore.getState().getMutationView(model.id));
    return nativeArtifact(c, new Blob([JSON.stringify({ entities }, null, 2)], { type: 'application/json' }), modelExportFilename(model.name, 'json', '_data'), { model_id: model.id, rows: entities.length, scope: 'one-model' }, check);
  }),
  viewerOperation<{ target_model_id: string; express_ids: number[]; linear_unit: 'metre' | 'internationalFoot' | 'usSurveyFoot'; decimals: number; surface_names: { express_id: number; name: string }[] }>(exportMetadata('exports.terrainLandXml', 'Run the exact native IFC terrain-to-LandXML preflight/producer over explicit model-local terrain products, with native eligibility/refusal diagnostics, precision, units and per-surface names. Export is the producer acceptance, never a fabricated terrain mesh.'), {
    type: 'object', properties: { target_model_id: targetSchema, express_ids: { type: 'array', minItems: 1, maxItems: 100000, uniqueItems: true, items: { type: 'integer', minimum: 1 } }, linear_unit: { type: 'string', enum: ['metre', 'internationalFoot', 'usSurveyFoot'] }, decimals: { type: 'integer', minimum: 0, maximum: 12 }, surface_names: { type: 'array', maxItems: 100000, items: { type: 'object', properties: { express_id: { type: 'integer', minimum: 1 }, name: { type: 'string', maxLength: 10000 } }, required: ['express_id', 'name'], additionalProperties: false } } }, required: ['target_model_id', 'express_ids', 'linear_unit', 'decimals', 'surface_names'], additionalProperties: false,
  } satisfies JSONSchemaType<{ target_model_id: string; express_ids: number[]; linear_unit: 'metre' | 'internationalFoot' | 'usSurveyFoot'; decimals: number; surface_names: { express_id: number; name: string }[] }>, async (i, c) => {
    const model = nativeExportTarget(i.target_model_id); const s = useViewerStore.getState(); const check = nativeExportGuard(c, [model.id]); check();
    const selection = resolveTerrainSelection({ refs: i.express_ids.map(expressId => ({ modelId: model.id === '__legacy__' ? 'legacy' : model.id, expressId })), models: s.models, legacyStore: s.ifcDataStore });
    if (selection.kind !== 'ready' || selection.skipped) throw new Error('Every requested product must be native-exportable IfcGeographicElement or IfcSite in the exact model.');
    if (new Set(i.surface_names.map(row => row.express_id)).size !== i.surface_names.length || i.surface_names.some(row => !selection.productIds.includes(row.express_id))) throw new Error('Duplicate or unrelated terrain surface name.');
    const outcome = await runLandXmlTerrainExport(editedModelBytes(selection.store, s.getMutationView(model.id)), selection.productIds, undefined, { linearUnit: i.linear_unit, decimals: i.decimals, surfaceNames: Object.fromEntries(i.surface_names.map(row => [row.express_id, row.name])) });
    check(); if (outcome.status !== 'ready') throw new Error(outcome.status === 'refused' ? outcome.reason : outcome.status === 'failed' ? outcome.message : 'Native terrain exporter unavailable.');
    const { xml, ...diagnostics } = outcome.result;
    return nativeArtifact(c, new Blob([xml], { type: 'application/xml' }), landXmlTerrainFilename(model.name), diagnostics, check);
  }),
];
