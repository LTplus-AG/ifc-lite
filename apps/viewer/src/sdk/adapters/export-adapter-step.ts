/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { StepExporter, StepExportOptions } from '@ifc-lite/export';
import type { IfcDataStore } from '@ifc-lite/parser';
import { iterateEffectiveEntityIds } from '@ifc-lite/mutations';
import { prepareAppearanceSerialization } from '../../lib/appearance/serialization.js';
import { packagePortableIfc } from '../../lib/export/portable-ifc.js';
import { resolveExportVisibility } from '../../store/exportVisibility.js';
import type { StoreApi } from './types.js';
import { getDefaultModelId, getModelForRef } from './model-compat.js';
import { getMutationViewForModel } from './mutation-view.js';
import { spliceScheduleIntoExport } from './export-schedule-splice.js';
import { viewerDrawingAnnotations } from '@/lib/export/viewer-drawing-annotations';
import { isEntityRefArray, normalizeRefs } from './export-entity-refs.js';

/** Options for IFC STEP export */
interface IfcExportOptions {
  schema?: 'IFC2X3' | 'IFC4' | 'IFC4X3';
  filename?: string;
  includeMutations?: boolean;
  visibleOnly?: boolean;
}

/** Validate that a value is an IfcExportOptions object. */
function isIfcExportOptions(v: unknown): v is IfcExportOptions {
  if (v === null || typeof v !== 'object') return false;
  const options = v as IfcExportOptions;
  if (options.schema !== undefined && options.schema !== 'IFC2X3' && options.schema !== 'IFC4' && options.schema !== 'IFC4X3') return false;
  if (options.filename !== undefined && typeof options.filename !== 'string') return false;
  if (options.includeMutations !== undefined && typeof options.includeMutations !== 'boolean') return false;
  if (options.visibleOnly !== undefined && typeof options.visibleOnly !== 'boolean') return false;
  return true;
}

/**
 * Resolve `sdk.export.ifc()` visibility filters. "Full model" means coverage, not size: `selectedExpressIds` is
 * the whole model only when size === `entityCount` and `hasEntity` confirms every id exists -- cardinality alone
 * let nonexistent ids pass as "full", silently exporting the whole model (reproduced live). Short of that it
 * isolates to `selectedExpressIds`; a verified full model instead routes through `resolveExportVisibility()`
 * (ExportDialog/GLBExportDialog's resolver) so `classFilter`/`selectedStoreys`/`typeVisibility` apply too (#4328).
 * `null` is no ref list at all (#4738) and takes that same full-model branch: nothing was filtered out. */
export function resolveVisibilityFilterSets(
  state: StoreApi['getState'] extends () => infer T ? T : never,
  modelId: string,
  selectedExpressIds: Set<number> | null,
  entityCount: number,
  hasEntity: (expressId: number) => boolean,
): { visibleOnly: boolean; hiddenEntityIds: Set<number>; isolatedEntityIds: Set<number> | null } {
  if (selectedExpressIds !== null && (selectedExpressIds.size !== entityCount || ![...selectedExpressIds].every(hasEntity))) {
    return { visibleOnly: true, hiddenEntityIds: new Set<number>(), isolatedEntityIds: selectedExpressIds };
  }

  const visibility = resolveExportVisibility(state, modelId);
  return {
    visibleOnly: false,
    hiddenEntityIds: visibility.hiddenLocalIds,
    isolatedEntityIds: visibility.isolatedLocalIds,
  };
}

/** Source ID domain for full-model coverage, including deferred property atoms. */
function* sourceEntityIds(store: IfcDataStore): IterableIterator<number> {
  // @raw-entity-enumeration-ok source IDs are passed through the effective accessor below, never used as live membership
  yield* store.entityIndex.byId.keys();
  if (store.deferredEntityIndex) yield* store.deferredEntityIndex.keys();
  // @raw-entity-enumeration-ok IFCX source rows provide the domain when there is no STEP byte index; the effective accessor applies the overlay
  if (store.entityIndex.byId.size === 0 && !store.deferredEntityIndex) {
    yield* store.entities.expressId;
  }
}

export function createStepExportMethod(store: StoreApi, getWriter: () => typeof StepExporter) {
  return function ifc(rawRefs: unknown, rawOptions: unknown) {
    const candidateOptions = rawOptions ?? {};
    // No ref list is "no isolation filter" (#4738): the active model whole, the same
    // export refs covering it produce. An EMPTY list matched nothing and never arrives.
    if (rawRefs != null && !isEntityRefArray(rawRefs)) {
      throw new Error('export.ifc: first argument must be an array of entity references');
    }
    if (!isIfcExportOptions(candidateOptions)) {
      throw new Error('export.ifc: second argument must be { schema?: IFC2X3|IFC4|IFC4X3, filename?: string, includeMutations?: boolean, visibleOnly?: boolean }');
    }
    const refs = rawRefs == null ? null : normalizeRefs(rawRefs);
    if (refs?.length === 0) {
      throw new Error('export.ifc: expected at least one entity reference');
    }
    if (refs && new Set(refs.map(ref => ref.modelId)).size !== 1) {
      throw new Error('export.ifc: all entity references must belong to the same model');
    }
    const state = store.getState();
    const modelId = refs ? refs[0].modelId : getDefaultModelId(state);
    if (!modelId) throw new Error('export.ifc: no model is loaded');
    const model = getModelForRef(state, modelId);
    if (!model?.ifcDataStore) {
      throw new Error(`export.ifc: model '${modelId}' is not loaded`);
    }
    const dataStore = model.ifcDataStore;
    if (dataStore.schemaVersion === 'IFC5') {
      throw new Error('export.ifc: IFC5 export is not supported by STEP exporter, use IFC2X3/IFC4/IFC4X3 models');
    }
    if (dataStore.sourceKind === 'tabular') {
      throw new Error(`export.ifc: model '${modelId}' has no IFC STEP source for the STEP exporter`);
    }

    const options = candidateOptions;
    const selectedExpressIds = refs ? new Set(refs.map(ref => ref.expressId)) : null;
    const mutationView = options.includeMutations === false ? null : getMutationViewForModel(store, modelId);
    const effectiveIds = selectedExpressIds && mutationView ? new Set<number>() : null;
    if (effectiveIds) {
      for (const entity of iterateEffectiveEntityIds(dataStore, mutationView, undefined, sourceEntityIds(dataStore))) {
        effectiveIds.add(entity.expressId);
      }
    }
    // @raw-entity-enumeration-ok with no mutation view (or includeMutations:false), parsed membership is the exported membership
    const hasEntity = effectiveIds
      ? (expressId: number) => effectiveIds.has(expressId)
      : (expressId: number) => dataStore.entityIndex.byId.has(expressId);
    const visibilityFilters = resolveVisibilityFilterSets(
      state, modelId, selectedExpressIds, effectiveIds?.size ?? dataStore.entityCount,
      hasEntity,
    );
    const visibleOnly = options.visibleOnly === true || visibilityFilters.visibleOnly;
    const hiddenEntityIds = visibleOnly ? visibilityFilters.hiddenEntityIds : new Set<number>();
    const isolatedEntityIds = visibleOnly ? visibilityFilters.isolatedEntityIds : null;

    const StepExporter = getWriter();
    const serialized = prepareAppearanceSerialization(
      modelId, model.ifcDataStore,
      mutationView ?? undefined,
    );
    const exporter = new StepExporter(model.ifcDataStore, options.includeMutations === false ? serialized.view : viewerDrawingAnnotations(modelId, model.ifcDataStore, serialized.view));
    // Include georeferencing mutations if present
    const georefMutations = options.includeMutations !== false
      ? state.georefMutations?.get(modelId) ?? undefined
      : undefined;

    const exportOptions: StepExportOptions = {
      schema: options.schema ?? model.ifcDataStore.schemaVersion,
      includeGeometry: true,
      includeProperties: true,
      includeQuantities: true,
      includeRelationships: true,
      applyMutations: options.includeMutations ?? true,
      visibleOnly,
      hiddenEntityIds,
      isolatedEntityIds,
      georefMutations,
    };

    // Splice any in-memory schedule (parsed-and-cached, or generated
    // via the Gantt panel's "Generate from storeys" dialog) into the
    // STEP output via the shared splice helper. Keeps this adapter
    // in lockstep with the viewer's ExportDialog / ExportChangesButton
    // so bugs can't differ across surfaces.
    const exportResult = exporter.export(exportOptions);
    const spliced = spliceScheduleIntoExport(exportResult, modelId, model.ifcDataStore as IfcDataStore, {
      scheduleData: state.scheduleData ?? null,
      scheduleIsEdited: state.scheduleIsEdited === true,
      scheduleSourceModelId: state.scheduleSourceModelId ?? null,
    });
    return packagePortableIfc(modelId, spliced.content, serialized.resources).content;
  };
}
