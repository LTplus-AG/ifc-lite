/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { useViewerStore } from '@/store';
import { exportModelIfcx } from '@/lib/export/model-ifcx-export';
import { modelExportFilename } from '@/lib/export/download';
import { resolveExportVisibility } from '@/store/exportVisibility';
import { hasRetainedShapeOnlyModel } from '@/store/retainedGeometry';
import { roomExportPathPrefix } from '@/lib/collab/room-export-paths';
import { buildChangesJson, activeChangesJsonMutations } from '@/components/viewer/export-changes-json';
import { listExportModels, resolveExportModel } from '@/components/viewer/export-model-selection';
import { omittedCaptureCount } from '@/lib/export/capture-export';
import { operation, viewerOperation, emptySchema } from './contract';
import { exportCheckpoint, exportMetadata } from './exports-common';
export const ifcxExportOperations = [
  viewerOperation({ id: 'exports.models', owner: 'exports', description: 'Read the exact native Export dialog model choices, including source-independent/native-metadata models and legacy IDs. Gaussian captures are omitted with an explicit count.',
    effects: ['read'], capability: 'read', implementation: 'native-store', features: ['export.files'], outputSchema: {
      type: 'object', properties: { models_json: { type: 'string' }, omitted_captures: { type: 'integer' } }, required: ['models_json', 'omitted_captures'], additionalProperties: false,
    } }, emptySchema, () => { const s = useViewerStore.getState(); return { models_json: JSON.stringify(listExportModels(s.models, s.dirtyModels, s.ifcDataStore)), omitted_captures: omittedCaptureCount(s.models) }; }),
  operation<{ include_geometry: boolean; apply_mutations: boolean; visible_only: boolean; changes_only: boolean; only_known_properties: boolean }>(exportMetadata('exports.modelIfcx', 'Produce native IFCX with the Export dialog geometry, mutation, visible-only, changes-only and known-property options. Shares its exact instanced-mesh scoped producer and room path mapping. Native empty-pset/property-collision diagnostics remain in diagnostics_json; no download.'), {
    type: 'object', properties: { include_geometry: { type: 'boolean' }, apply_mutations: { type: 'boolean' }, visible_only: { type: 'boolean' }, changes_only: { type: 'boolean' }, only_known_properties: { type: 'boolean' } }, required: ['include_geometry', 'apply_mutations', 'visible_only', 'changes_only', 'only_known_properties'], additionalProperties: false,
  }, async (i, c) => {
    const current = exportCheckpoint(c, [c.model.id]); current();
    const state = useViewerStore.getState(), model = state.models.get(c.model.id), view = c.model.mutationView();
    if (model?.gaussianSplat) throw new Error('Gaussian captures are omitted by native model exporters.');
    if (i.include_geometry && !i.changes_only && model && hasRetainedShapeOnlyModel(new Map([[model.id, model]]))) throw new Error('Native retained geometry is incomplete or shape-only for IFCX export.');
    // Without a mutation view there are no pending changes; a changes-only file must not fall back to the full model.
    if (i.changes_only && !view) throw new Error('This model has no pending changes to export.');
    const visibility = resolveExportVisibility(state, c.model.id);
    const result = await exportModelIfcx({ modelId: c.model.id, dataStore: c.model.store, mutationView: view ?? undefined,
      geometryResult: model ? model.geometryResult : state.geometryResult, idOffset: model?.idOffset ?? 0,
      maxExpressId: model ? model.maxExpressId ?? 0 : undefined,
      options: { includeGeometry: i.changes_only ? false : i.include_geometry, includeProperties: true,
        applyMutations: i.changes_only && view ? true : i.apply_mutations,
        visibleOnly: i.changes_only && view ? true : i.visible_only,
        hiddenEntityIds: !(i.changes_only && view) && i.visible_only ? visibility.hiddenLocalIds : undefined,
        isolatedEntityIds: i.changes_only && view ? new Set(view.getMutations().map(mutation => mutation.entityId))
          : i.visible_only ? visibility.isolatedLocalIds ?? undefined : undefined,
        onlyKnownProperties: i.only_known_properties, author: 'ifc-lite', stripPathPrefix: roomExportPathPrefix(state, c.model.id) },
    });
    current();
    return { artifact: await c.artifacts.create({ data: result.content, filename: modelExportFilename(c.model.name, 'ifcx', i.changes_only ? '_changes' : '_export'), mimeType: 'application/json' }), diagnostics_json: JSON.stringify(result.stats) };
  }),
  viewerOperation<{ target_model_id: string }>(exportMetadata('exports.changesJson', 'Produce the exact native source-independent JSON mutation delta for an explicit Export dialog model ID. Uses its active history/revert/georeference filter, including models without parsed IFC. No download and no source replacement.'), {
    type: 'object', properties: { target_model_id: { type: 'string', minLength: 1, maxLength: 200 } }, required: ['target_model_id'], additionalProperties: false,
  }, async (i, c) => {
    const current = exportCheckpoint(c, [i.target_model_id]); current();
    const state = useViewerStore.getState();
    const model = resolveExportModel(state.models, i.target_model_id, state.ifcDataStore, state.geometryResult);
    if (!model || ('gaussianSplat' in model && model.gaussianSplat)) throw new Error('Unknown native Export dialog model ID.');
    const mutations = activeChangesJsonMutations(i.target_model_id, state.getMutationView(i.target_model_id)?.getMutations() ?? [], useViewerStore);
    const file = buildChangesJson(i.target_model_id, model.name, mutations);
    current();
    return { artifact: await c.artifacts.create({ data: file.content, filename: file.filename, mimeType: file.mime }), diagnostics_json: JSON.stringify({ mutations: mutations.length }) };
  }),
];
