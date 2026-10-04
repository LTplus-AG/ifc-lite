/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The split commit actions, under the split identity policy (#6233,
 * `lib/split-guid.ts`): the larger piece stays the source entity, reshaped in
 * place (same express id, GlobalId, containment, type, material, psets and
 * the openings still inside it), and exactly ONE new element is authored for
 * the other piece, with a derived GlobalId. The whole split is one undo step.
 *
 * Order matters for failure: the new piece is built first, so a builder
 * refusal returns before the source is touched.
 */

import type { IfcAttributeValue, MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import type { ViewerState } from '../index.js';
import { toGlobalIdFromModels } from '../globalId.js';
import { mutationDenial } from '../mutation-permission.js';
import { mutationsSince, newMutationBatchId, undoStackLengths } from './mutation-batch-tags.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { resolveSplitTarget, splitChainOfKind } from '@/lib/split-target.js';
import { effectiveStoreyId } from '@/lib/effective-storey.js';
import { deriveSplitGlobalId, globalIdTakenIn } from '@/lib/split-guid.js';
import { readAttributes } from '@/lib/placement-core.js';
import { cloneElementMetadata } from '@/lib/metadata-clone.js';
import { recordModellingCommit, type ModellingStore } from './mutation-modelling-records.js';
import { resolve as translate } from '@/i18n/registry';

import { splitElementInStore, type ElementSplitCut } from '../../../../../packages/create/src/in-store/element-split.js';

type Get = () => ViewerState;
type SplitKind = 'wall' | 'linear' | 'slab';
type Piece = { expressId: number; globalId: number };

/** Everything a split commit reads before it writes. */
export interface SplitEnv {
  view: MutablePropertyView;
  editor: StoreEditor;
  dataStore: IfcDataStore;
  storeyExpressId: number;
  /** Native-unit → metre factor; the chains are metres, STEP slots native. */
  lengthUnitScale: number;
  /** The new piece's GlobalId, derived from the source's. */
  newGlobalId: string;
  /** The source's Name, carried onto the new piece. */
  name: string | undefined;
  /** Undo-stack lengths before the split, to tag it as one batch. */
  stackLengths: Map<string, number>;
}

/** Gate + context for splitting `expressId` as `kind`; the chain is metres. */
export function openSplit<K extends SplitKind>(
  get: Get,
  editorFor: (modelId: string) => StoreEditor | null,
  modelId: string,
  expressId: number,
  kind: K,
) {
  const denial = mutationDenial(get(), modelId);
  if (denial) return { ok: false as const, reason: denial };
  const view = get().mutationViews.get(modelId);
  const editor = view ? editorFor(modelId) : null;
  const dataStore = get().models.get(modelId)?.ifcDataStore;
  if (!view || !editor || !dataStore) return { ok: false as const, reason: `No editable model for id "${modelId}"` };
  // The Split button's predicate (`readSplitTarget`) — the two cannot disagree.
  const lengthUnitScale = getModelLengthUnitScale(dataStore);
  const gate = splitChainOfKind(resolveSplitTarget(dataStore, view, editor, expressId, lengthUnitScale), kind);
  if ('reasonKey' in gate) return { ok: false as const, reason: translate(gate.reasonKey) };
  // The live storey (queued containment edits count), as resolveSplitTarget gates on.
  const storeyExpressId = effectiveStoreyId(dataStore, view, expressId);
  if (storeyExpressId === undefined) return { ok: false as const, reason: translate('splitTool.unavailable.storey') };
  const attrs = readAttributes(dataStore, view, editor, expressId);
  const sourceGuid = typeof attrs?.[0] === 'string' ? attrs[0] : String(expressId);
  const state = get();
  const newGlobalId = deriveSplitGlobalId(sourceGuid, globalIdTakenIn(
    [...state.models].map(([id, m]) => ({ dataStore: m.ifcDataStore, view: state.mutationViews.get(id) }))));
  const env: SplitEnv = {
    view, editor, dataStore, storeyExpressId, newGlobalId, lengthUnitScale,
    name: typeof attrs?.[2] === 'string' ? attrs[2] : undefined,
    stackLengths: undoStackLengths(state.undoStacks),
  };
  return { ok: true as const, env, chain: gate.chain };
}

/**
 * Reshape the source in place: positional writes (native units). Its mesh is
 * rebuilt by the wasm re-mesh service when the split's transaction commits
 * (`element.split` returns it in `remesh`, and undo / redo re-mesh the batch
 * again); the re-mesh also sends that mesh to the room (#6391).
 */
export function reshapeSource(
  get: Get,
  modelId: string,
  writes: Array<{ entityId: number; index: number; value: IfcAttributeValue }>,
): void {
  for (const w of writes) get().setPositionalAttribute(modelId, w.entityId, w.index, w.value);
}

/** Close the split: clone the source's metadata onto the new piece, make it all one undo step. */
export function closeSplit(get: Get, modelId: string, env: SplitEnv, sourceId: number, newId: number): void {
  cloneElementMetadata(env.dataStore, env.view, env.editor, sourceId, [newId]);
  get().tagMutationBatch(mutationsSince(get().undoStacks, env.stackLengths), newMutationBatchId());
}

export function piece(get: Get, modelId: string, expressId: number): Piece {
  return { expressId, globalId: toGlobalIdFromModels(get().models, modelId, expressId) };
}

/** Commit the shared writer, then publish the authored tree and history. */
export function splitInViewer(
  get: Get, editorFor: (id: string) => StoreEditor | null, modelId: string,
  expressId: number, cut: ElementSplitCut, store: ModellingStore,
) {
  const open = openSplit(get, editorFor, modelId, expressId, cut.kind);
  if (!open.ok) return open;
  try {
    const scopes = [...get().models].map(([id, model]) => ({ dataStore: model.ifcDataStore, view: get().mutationViews.get(id) }));
    const result = recordModellingCommit(store, modelId, (editor, dataStore) =>
      splitElementInStore(dataStore, editor, expressId, cut, { globalIdScopes: scopes }));
    get().recordAuthoredElement(modelId, result.storeyId, result.addedId, result.element, { historyRecorded: true });
    return { ok: true as const, left: piece(get, modelId, result.leftId), right: piece(get, modelId, result.rightId), openings: result.openings };
  } catch (error) {
    return { ok: false as const, reason: error instanceof Error ? error.message : String(error) };
  }
}

export function splitWall(get: Get, editorFor: (id: string) => StoreEditor | null, modelId: string, expressId: number, distance: number, store: ModellingStore) {
  return splitInViewer(get, editorFor, modelId, expressId, { kind: 'wall', distance }, store);
}
export function splitLinear(get: Get, editorFor: (id: string) => StoreEditor | null, modelId: string, expressId: number, distance: number, store: ModellingStore) {
  return splitInViewer(get, editorFor, modelId, expressId, { kind: 'linear', distance }, store);
}
