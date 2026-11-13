/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Collab gate, shared-room mirroring and undo bookkeeping for the #6232
 * `bim.store` modelling surface: openings, hosted doors/windows, type objects
 * and materials.
 *
 * An opening or hosted filling is written by the store's `addHostedFill`
 * action, the same one the Model workspace's placing commands commit through
 * (`mutation-hosted-fill.ts`): the compound graph (opening,
 * IfcRelVoidsElement, and for a door or window the filling,
 * IfcRelFillsElement and containment) lands on the undo stack as ONE batch,
 * so `Ctrl+Z` removes all of it, it reaches a shared room, and the host is
 * re-meshed with its void.
 *
 * Relationship writes (type and material assignments, layer sets) still take
 * the blunt-but-safe path of the cost relationship writes: mark the model
 * dirty and clear its undo history so `Ctrl+Z` can never cross them.
 */

import type { StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { removeStairInStore, takeLayerThicknessOutcome } from '@ifc-lite/create';
import type { createModellingStoreBackendWithoutStoreys, EntityRef, ModellingStoreBackendMethods } from '@ifc-lite/sdk';
import { createStoreMutationTracker } from './store-adapter-cost.js';
import { normalizeMutationModelId } from './mutation-view.js';
import { editHostedFillIn, type HostedFillSpec } from '@/store/slices/mutation-hosted-fill';
import type { StoreApi } from './types.js';
import { recordModellingEdit } from '@/store/slices/mutation-modelling-records';
import { mutationDenial } from '@/store/mutation-permission';
import { remeshAfterCommit } from '@/lib/remesh/remesh-registry';
import { requestRemesh } from '@/lib/remesh/remesh-service';
import { reportLayerFollow } from '@/lib/authoring/layer-follow-report';
import { addCurtainWallIn, addGridIn } from '@/store/slices/mutation-curtain-grid';
import { addGridColumnIn } from '@/store/slices/mutation-grid-column';
import { addStairIn, addRailingIn } from '@/store/slices/mutation-stair-railing';
import { replaceElementIn } from '@/store/slices/mutation-element-replacement';
import { alignMutationTracking } from './store-adapter-align.js';
import { roomMutationTracking } from './store-adapter-room.js';
import { physicalMutationTracking } from './store-adapter-physical.js';
import { storeyMutationTracking } from './store-adapter-storey.js';
import { mirrorClassificationMutationTracking } from './store-adapter-mirror-classification.js';
import { completeEntityRemoval } from '@/store/slices/mutation-mesh-stash';

type ModellingMethods = ReturnType<typeof createModellingStoreBackendWithoutStoreys>;

/** `methods` has no storey methods; the result takes them from `storeyMutationTracking` (#9200). */
export function withModellingMutationTracking(
  methods: ModellingMethods,
  store: StoreApi,
  resolve: (modelId: string) => { editor: StoreEditor; dataStore: IfcDataStore } | null,
): ModellingStoreBackendMethods {
  const { create, relationship } = createStoreMutationTracker(store, resolve, 'modelling');
  const compound = <A extends [string, ...unknown[]]>(fn: (...args: A) => EntityRef) =>
    relationship((...args: A): EntityRef => {
      const ref = fn(...args);
      store.getState().markCostRelationshipMutation(ref.modelId);
      return ref;
    });
  const hosted = <K extends HostedFillSpec['kind']>(kind: K, op: string) =>
    (modelId: string, hostExpressId: number, params: Extract<HostedFillSpec, { kind: K }>['params']): EntityRef => {
      const state = store.getState();
      const normalized = normalizeMutationModelId(state, modelId);
      const outcome = state.addHostedFill(normalized, hostExpressId, { kind, params } as HostedFillSpec);
      if ('error' in outcome) throw new Error(`bim.store.${op}: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    };
  /**
   * A typing or material assignment can re-size what it types through the
   * backend (a layered type drives its occurrences' thickness), re-trimming
   * joined walls and refitting generated rooms. The backend writes that on this
   * model's editor; take it here so those elements re-mesh with the call and any
   * occurrence that could not follow is named, as every viewer path does (#9296).
   */
  const layered = <A extends [string, number, number[]]>(fn: (...args: A) => EntityRef) =>
    compound((...args: A): EntityRef => {
      const ref = fn(...args);
      const target = resolve(ref.modelId);
      if (target) {
        const outcome = takeLayerThicknessOutcome(target.editor);
        if (outcome.remesh.length > 0) void requestRemesh(store.getState, ref.modelId, outcome.remesh, 'shape');
        reportLayerFollow(store.getState(), ref.modelId, outcome);
      }
      return ref;
    });
  const addPlainMaterial = create('IFCMATERIAL', methods.addMaterial);
  const addStyledMaterial = compound(methods.addMaterial);
  return {
    ...mirrorClassificationMutationTracking(store),
    ...physicalMutationTracking(store),
    ...storeyMutationTracking(store),
    ...roomMutationTracking(store),
    ...alignMutationTracking(store),
    editHostedElement(ref, patch) {
      const normalized = normalizeMutationModelId(store.getState(), ref.modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.editHostedElement: the adapter requires a writable store');
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const outcome = editHostedFillIn({ ...store, setState }, normalized, ref.expressId, patch);
      if (!outcome.ok) throw new Error(`bim.store.editHostedElement: ${outcome.reason}`);
      const state = store.getState(), stack = state.undoStacks.get(normalized) ?? [];
      const last = stack.length > undoBefore ? stack.at(-1) : undefined;
      remeshAfterCommit(store.getState, normalized,
        last ? state.mutationBatchTags.get(last.id) ?? null : null, [...outcome.remesh], 'shape');
      return { modelId: normalized, expressId: ref.expressId };
    },
    addCurtainWall(modelId, storeyExpressId, { TopConstraint, ...params }) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.addCurtainWall: the adapter requires a writable store');
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const outcome = addCurtainWallIn({ ...store, setState }, normalized, storeyExpressId, params, TopConstraint ?? 'auto');
      if ('error' in outcome) throw new Error(`bim.store.addCurtainWall: ${outcome.error}`);
      const state = store.getState();
      const stack = state.undoStacks.get(normalized) ?? [];
      const last = stack.length > undoBefore ? stack.at(-1) : undefined;
      remeshAfterCommit(store.getState, normalized,
        last ? state.mutationBatchTags.get(last.id) ?? null : null, [...outcome.partIds], 'created');
      return { modelId: normalized, expressId: outcome.expressId };
    },
    addGrid(modelId, storeyExpressId, params) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.addGrid: the adapter requires a writable store');
      const outcome = addGridIn({ ...store, setState }, normalized, storeyExpressId, params);
      if ('error' in outcome) throw new Error(`bim.store.addGrid: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    },
    addColumnOnGrid(modelId, storeyExpressId, { TopConstraint, ...params }, binding) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.addColumnOnGrid: the adapter requires a writable store');
      const outcome = addGridColumnIn({ ...store, setState }, normalized, storeyExpressId, params, binding, TopConstraint ?? 'auto');
      if ('error' in outcome) throw new Error(`bim.store.addColumnOnGrid: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    },
    replaceElement(ref, storeyExpressId, element) {
      const normalized = normalizeMutationModelId(store.getState(), ref.modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.replaceElement: the adapter requires a writable store');
      const expressId = replaceElementIn({ ...store, setState }, normalized, ref.expressId, storeyExpressId, element);
      return { modelId: normalized, expressId };
    },
    removeStair(ref) {
      const normalized = normalizeMutationModelId(store.getState(), ref.modelId);
      const denial = mutationDenial(store.getState(), normalized);
      if (denial) throw new Error(`bim.store.removeStair: ${denial}`);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.removeStair: the adapter requires a writable store');
      const resolved = resolve(normalized);
      if (!resolved) throw new Error(`bim.store.removeStair: no model loaded for id "${ref.modelId}"`);
      const removed = recordModellingEdit({ ...store, setState }, normalized, (_methods, draft) =>
        removeStairInStore(resolved.dataStore, draft, ref.expressId));
      for (const id of [removed.stairId, removed.flightId]) {
        completeEntityRemoval(store.getState, setState, normalized, id,
          store.getState().removedNewEntities.get(`${normalized}:${id}`));
      }
      return true;
    },
    addStair(modelId, storeyExpressId, params) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.addStair: the adapter requires a writable store');
      const outcome = addStairIn({ ...store, setState }, normalized, storeyExpressId, params);
      if ('error' in outcome) throw new Error(`bim.store.addStair: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    },
    addRailing(modelId, storeyExpressId, params) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.addRailing: the adapter requires a writable store');
      const outcome = addRailingIn({ ...store, setState }, normalized, storeyExpressId, params);
      if ('error' in outcome) throw new Error(`bim.store.addRailing: ${outcome.error}`);
      return { modelId: normalized, expressId: outcome.expressId };
    },
    joinWalls(modelId, aExpressId, bExpressId, options) {
      const normalized = normalizeMutationModelId(store.getState(), modelId);
      const denial = mutationDenial(store.getState(), normalized);
      if (denial) throw new Error(`bim.store.joinWalls: ${denial}`);
      const setState = store.setState;
      if (!setState) throw new Error('bim.store.joinWalls: the adapter requires a writable store');
      const undoBefore = store.getState().undoStacks.get(normalized)?.length ?? 0;
      const result = recordModellingEdit({ ...store, setState }, normalized, methods => methods.joinWalls(normalized, aExpressId, bExpressId, options));
      const state = store.getState();
      const stack = state.undoStacks.get(normalized) ?? [];
      const last = stack.length > undoBefore ? stack.at(-1) : undefined;
      remeshAfterCommit(store.getState, normalized, last ? state.mutationBatchTags.get(last.id) ?? null : null, [aExpressId, bExpressId], 'shape');
      return result;
    },
    addOpening: hosted('opening', 'addOpening'),
    addHostedDoor: hosted('door', 'addHostedDoor'),
    addHostedWindow: hosted('window', 'addHostedWindow'),
    // Single records with no relationship: one CREATE_ENTITY entry inverts them.
    addElementType: relationship((modelId: string, params: Parameters<ModellingMethods['addElementType']>[1]) => {
      const ref = methods.addElementType(modelId, params);
      store.getState().pushCreateEntityUndo(ref.modelId, ref.expressId, params.Type.toUpperCase());
      return ref;
    }),
    // A plain material is one record; a coloured one also writes its appearance
    // chain (IfcMaterialDefinitionRepresentation and the style records), which a
    // single CREATE_ENTITY undo would leave behind pointing at nothing. That one
    // takes the compound fence the layer set already takes.
    addMaterial: (modelId: string, params: Parameters<ModellingMethods['addMaterial']>[1]) =>
      (params.Color === undefined ? addPlainMaterial : addStyledMaterial)(modelId, params),
    addMaterialLayerSetUsage: create('IFCMATERIALLAYERSETUSAGE', methods.addMaterialLayerSetUsage),
    // A layer set is several records; the assignments rewrite or remove
    // existing IfcRel* rows the objects move out of.
    addMaterialLayerSet: compound(methods.addMaterialLayerSet),
    assignType: layered(methods.assignType),
    assignMaterial: layered(methods.assignMaterial),
  };
}
