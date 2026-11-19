/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { JSONSchemaType } from 'ajv';
import { useViewerStore } from '@/store';
import { exportModelStep } from '@/lib/export/model-step-export';
import { ensureModelExportReady } from '@/services/desktop-export';
import { packagePortableIfcAsync, assertPortableMergeSupported } from '@/lib/export/portable-ifc';
import { sectionExportOptions, sectionMergeInputs } from '@/lib/export/section-export';
import { resolveExportVisibility } from '@/store/exportVisibility';
import { hasRetainedSectionExport } from '@/store/retainedGeometry';
import { modelExportFilename } from '@/lib/export/download';
import { buildMergeInputs } from '@/components/viewer/export-merge-inputs';
import { roomMergeVisibility } from '@/lib/collab/room-merged-export';
import { operation, viewerOperation } from './contract';
import { exportMetadata } from './exports-common';
import { exportGuard, refuseComposedLayer } from './export-native-runtime';
import { normalizeMutationModelId } from '@/sdk/adapters/mutation-view';
interface Options {
  schema: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  include_geometry: boolean; apply_mutations: boolean; visible_only: boolean; section_mode: 'trim' | 'whole';
}
const properties = {
  schema: { type: 'string', enum: ['IFC2X3', 'IFC4', 'IFC4X3'] }, include_geometry: { type: 'boolean' },
  apply_mutations: { type: 'boolean' }, visible_only: { type: 'boolean' }, section_mode: { type: 'string', enum: ['trim', 'whole'] },
} as const;
const schema = { type: 'object', properties, required: Object.keys(properties), additionalProperties: false } as unknown as JSONSchemaType<Options>;
function retainedGuard(ids: Iterable<string>, visible: boolean, geometry: boolean) {
  if (visible && geometry && hasRetainedSectionExport(useViewerStore.getState(), ids)) {
    throw new Error('Native retained geometry cannot produce this exact visible section export.');
  }
}
export const stepExportOperations = [
  operation(exportMetadata('exports.modelStep', 'Produce one native full/visible STEP IFC or portable IFCZIP with the Export dialog schema, geometry, mutation and trim/whole-section options. Uses its exact shared exportModelStep producer, room/source ID mapping, appearance packaging and schedule splicing; refuses unsupported native source/section modes. No download.'), schema, async (i, c) => {
    // A legacy single model is 'default' to the agent host and '__legacy__' to the export services (#10695).
    const id = normalizeMutationModelId(useViewerStore.getState(), c.model.id);
    const current = exportGuard(c, [id], i.visible_only); current();
    retainedGuard([id], i.visible_only, i.include_geometry);
    const store = await ensureModelExportReady(id);
    if (!store) throw new Error('Native model data is unavailable for STEP export.');
    current();
    const state = useViewerStore.getState(), visibility = resolveExportVisibility(state, id);
    const result = await exportModelStep({ modelId: id, dataStore: store,
      mutationView: i.apply_mutations ? c.model.mutationView() ?? undefined : undefined,
      section: i.visible_only && i.include_geometry ? sectionExportOptions(state, i.section_mode, id) : undefined,
      options: { schema: i.schema, includeGeometry: i.include_geometry, applyMutations: i.apply_mutations, visibleOnly: i.visible_only,
        hiddenEntityIds: i.visible_only ? visibility.hiddenLocalIds : undefined,
        isolatedEntityIds: i.visible_only ? visibility.isolatedLocalIds : undefined,
        georefMutations: i.apply_mutations ? state.georefMutations.get(id) : undefined,
        application: 'ifc-lite', description: 'Exported through native viewer operations', onProgress: () => current() },
      scheduleState: { scheduleData: state.scheduleData, scheduleIsEdited: state.scheduleIsEdited, scheduleSourceModelId: state.scheduleSourceModelId },
    });
    current();
    const file = await packagePortableIfcAsync(id, result.content, result.resources);
    current();
    return { artifact: await c.artifacts.create({ data: file.content, filename: modelExportFilename(c.model.name, file.ext), mimeType: file.mime }), diagnostics_json: JSON.stringify(result.stats) };
  }),
  viewerOperation<Options & { model_ids: string[]; unit_reconciliation: 'auto' | 'normalize' | 'assume-shared' }>(exportMetadata('exports.mergedStep', 'Produce an explicit set of native merged STEP models, using the Export dialog merge-input, room visibility, unit reconciliation and section-cropping services. Skipped sources remain explicit diagnostics. Captures are rejected as inputs; no implicit active-model target and no download.'), {
    type: 'object', properties: { ...properties, model_ids: { type: 'array', minItems: 1, maxItems: 100, uniqueItems: true, items: { type: 'string', minLength: 1, maxLength: 200 } }, unit_reconciliation: { type: 'string', enum: ['auto', 'normalize', 'assume-shared'] } }, required: [...Object.keys(properties), 'model_ids', 'unit_reconciliation'], additionalProperties: false,
  } as unknown as JSONSchemaType<Options & { model_ids: string[]; unit_reconciliation: 'auto' | 'normalize' | 'assume-shared' }>, async (i, c) => {
    if (!i.include_geometry) throw new Error('The native merged STEP workflow always includes its source geometry; use the single-model geometry option instead.');
    const current = exportGuard(c, i.model_ids, i.visible_only); current();
    for (const id of i.model_ids) refuseComposedLayer(id, i.model_ids);
    const state = useViewerStore.getState();
    const models = i.model_ids.map(id => { const model = state.models.get(id); if (!model || model.gaussianSplat) throw new Error(`No exportable native model: ${id}`); return model; });
    retainedGuard(i.model_ids, i.visible_only, i.include_geometry);
    assertPortableMergeSupported(i.model_ids);
    const hydrated = [];
    for (const model of models) { hydrated.push({ model, dataStore: await ensureModelExportReady(model.id) }); current(); }
    const { inputs, portableByModel, skipped } = buildMergeInputs(hydrated, { applyMutations: i.apply_mutations, getMutationView: state.getMutationView, georefMutations: state.georefMutations });
    if (!inputs.length) throw new Error(`No native STEP input was writable: ${JSON.stringify(skipped)}`);
    const resolved = new Map<string, ReturnType<typeof resolveExportVisibility>>();
    const visibilityFor = (id: string) => { let v = resolved.get(id); if (!v) { v = resolveExportVisibility(state, id); resolved.set(id, v); } return v; };
    const visibility = i.visible_only ? roomMergeVisibility(i.model_ids, portableByModel,
      id => visibilityFor(id).hiddenLocalIds, id => visibilityFor(id).isolatedLocalIds)
      : { hidden: new Map<string, Set<number>>(), isolated: new Map<string, Set<number> | null>() };
    const prepared = await sectionMergeInputs(inputs, visibility, i.schema,
      id => i.visible_only ? sectionExportOptions(state, i.section_mode, id) : undefined);
    current();
    // Loaded on use: the merged export is its own lazy chunk, off the startup bundle.
    const { MergedExporter } = await import('@ifc-lite/export/merged-exporter');
    current();
    const result = await new MergedExporter(prepared.inputs).exportBlobAsync({ schema: i.schema, projectStrategy: 'keep-first', unitReconciliation: i.unit_reconciliation,
      visibleOnly: i.visible_only, hiddenEntityIdsByModel: prepared.visibility.hidden, isolatedEntityIdsByModel: prepared.visibility.isolated,
      application: 'ifc-lite', description: 'Merged export through native viewer operations', onProgress: () => current() });
    current();
    return { artifact: await c.artifacts.create({ data: result.content, filename: modelExportFilename(inputs[0].name, 'ifc', '_merged'), mimeType: 'text/plain' }), diagnostics_json: JSON.stringify({ stats: result.stats, skipped, section_warnings: prepared.warnings }) };
  }),
];
