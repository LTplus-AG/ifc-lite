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
import type { AuthoredElement } from './authoredElement.js';
import { toNativeLength } from '@ifc-lite/create';
import { mutationsSince, newMutationBatchId, undoStackLengths } from './mutation-batch-tags.js';
import { mirrorAuthoredGeometry } from './mutation-geometry-mirror.js';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale.js';
import { resolveSplitTarget, splitChainOfKind } from '@/lib/split-target.js';
import { deriveSplitGlobalId, globalIdTakenIn, keepsFirstPiece } from '@/lib/split-guid.js';
import { computeWallSplitGeometry } from '@/lib/wall-edit.js';
import { computeLinearElementSplitGeometry } from '@/lib/linear-element-edit.js';
import { readAttributes, resolvePlacementChain } from '@/lib/placement-core.js';
import { cloneElementMetadata } from '@/lib/metadata-clone.js';
import { reassignWallOpenings } from '@/lib/wall-opening-reassign.js';
import { resolve as translate } from '@/i18n/registry';

type Get = () => ViewerState;
type Vec3 = [number, number, number];
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
  // @raw-entity-enumeration-ok point lookup; authored elements are registered into this map (registerAuthoredElement), the same one resolveSplitTarget gates on
  const storeyExpressId = dataStore.spatialHierarchy?.elementToStorey.get(expressId);
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
 * Reshape the source in place: positional writes (native units). Its local
 * mesh is rebuilt by the wasm re-mesh service when the split's transaction
 * commits (`element.split` returns it in `remesh`, and undo / redo re-mesh
 * the batch again); collaborators get `element`'s builder mesh.
 */
export function reshapeSource(
  get: Get,
  modelId: string,
  expressId: number,
  writes: Array<{ entityId: number; index: number; value: IfcAttributeValue }>,
  element: AuthoredElement,
): void {
  for (const w of writes) get().setPositionalAttribute(modelId, w.entityId, w.index, w.value);
  mirrorAuthoredGeometry(get, modelId, expressId, element);
}

/** Close the split: clone the source's metadata onto the new piece, make it all one undo step. */
export function closeSplit(get: Get, modelId: string, env: SplitEnv, sourceId: number, newId: number): void {
  cloneElementMetadata(env.dataStore, env.view, env.editor, sourceId, [newId]);
  get().tagMutationBatch(mutationsSince(get().undoStacks, env.stackLengths), newMutationBatchId());
}

export function piece(get: Get, modelId: string, expressId: number): Piece {
  return { expressId, globalId: toGlobalIdFromModels(get().models, modelId, expressId) };
}

const native = (v: number, k: number) => toNativeLength({ lengthUnitScale: k }, v);
const scaled = (p: readonly number[], k: number): Vec3 => [native(p[0], k), native(p[1], k), native(p[2], k)];
const along = (s: Vec3, dir: Vec3, t: number): Vec3 => [s[0] + dir[0] * t, s[1] + dir[1] * t, s[2] + dir[2] * t];

export function splitWall(
  get: Get,
  editorFor: (modelId: string) => StoreEditor | null,
  modelId: string,
  expressId: number,
  distance: number,
): { ok: true; left: Piece; right: Piece; openings: { toLeft: number; toRight: number; skipped: number } } | { ok: false; reason: string } {
  const open = openSplit(get, editorFor, modelId, expressId, 'wall');
  if (!open.ok) return open;
  const { env, chain } = open;
  const geo = computeWallSplitGeometry(chain, distance, chain.height);
  if (!geo.ok) return geo;
  const keepLeft = keepsFirstPiece(distance, chain.wallLength - distance);
  const kept = keepLeft ? geo.geometry.left : geo.geometry.right;
  const cut = keepLeft ? geo.geometry.right : geo.geometry.left;

  const added = get().addWall(modelId, env.storeyExpressId, { ...cut, Name: env.name, GlobalId: env.newGlobalId });
  if ('error' in added) return { ok: false, reason: added.error };

  const k = chain.lengthUnitScale;
  const keptLength = Math.hypot(kept.End[0] - kept.Start[0], kept.End[1] - kept.Start[1]);
  reshapeSource(get, modelId, expressId, [
    { entityId: chain.startPointId, index: 0, value: scaled(kept.Start, k) },
    { entityId: chain.profileId, index: 3, value: native(keptLength, k) },
    { entityId: chain.profileOriginPointId, index: 0, value: [native(keptLength, k) / 2, 0] },
  ], { kind: 'wall', params: { Start: kept.Start, End: kept.End, Thickness: chain.thickness, Height: chain.height } });

  // Only openings in the new piece change host. An opening's local X is
  // native units; a kept RIGHT piece starts at the cut, so the openings it
  // keeps shift by the cut too.
  const leftId = keepLeft ? expressId : added.expressId;
  const rightId = keepLeft ? added.expressId : expressId;
  const leftPlacement = resolvePlacementChain(env.dataStore, env.view, env.editor, leftId)?.localPlacementId;
  const rightPlacement = resolvePlacementChain(env.dataStore, env.view, env.editor, rightId)?.localPlacementId;
  let openings = { toLeft: 0, toRight: 0, skipped: 0 };
  if (leftPlacement !== undefined && rightPlacement !== undefined) {
    const s = reassignWallOpenings(env.dataStore, env.view, env.editor, expressId, leftId, rightId, native(distance, k), leftPlacement, rightPlacement);
    openings = { toLeft: s.toLeft, toRight: s.toRight, skipped: s.skipped };
  }
  closeSplit(get, modelId, env, expressId, added.expressId);
  return { ok: true, left: piece(get, modelId, leftId), right: piece(get, modelId, rightId), openings };
}

export function splitLinear(
  get: Get,
  editorFor: (modelId: string) => StoreEditor | null,
  modelId: string,
  expressId: number,
  distance: number,
): { ok: true; left: Piece; right: Piece } | { ok: false; reason: string } {
  const open = openSplit(get, editorFor, modelId, expressId, 'linear');
  if (!open.ok) return open;
  const { env, chain } = open;
  const geo = computeLinearElementSplitGeometry(chain, distance);
  if (!geo.ok) return geo;
  const start = chain.startCoordinates;
  const axis = chain.axisDirection;
  const keepFirst = keepsFirstPiece(distance, chain.depth - distance);
  const keptStart = keepFirst ? start : geo.geometry.cutPoint;
  const keptLength = keepFirst ? distance : chain.depth - distance;
  const newStart = keepFirst ? geo.geometry.cutPoint : start;
  const newLength = keepFirst ? chain.depth - distance : distance;
  const { width, height } = geo.geometry;
  const common = { Name: env.name, GlobalId: env.newGlobalId };

  const added = chain.elementType === 'IfcColumn'
    ? get().addColumn(modelId, env.storeyExpressId, { ...common, Position: newStart, Width: width, Depth: height, Height: newLength })
    : get()[chain.elementType === 'IfcBeam' ? 'addBeam' : 'addMember'](modelId, env.storeyExpressId, {
      ...common, Start: newStart, End: along(newStart, axis, newLength), Width: width, Height: height,
    });
  if ('error' in added) return { ok: false, reason: added.error };

  const k = chain.lengthUnitScale;
  const writes: Array<{ entityId: number; index: number; value: IfcAttributeValue }> = [
    { entityId: chain.extrudedSolidId, index: 3, value: native(keptLength, k) },
  ];
  if (!keepFirst) writes.push({ entityId: chain.startPointId, index: 0, value: scaled(keptStart, k) });
  const linear = { Start: keptStart, End: along(keptStart, axis, keptLength), Width: width, Height: height };
  const element: AuthoredElement = chain.elementType === 'IfcColumn'
    ? { kind: 'column', params: { Position: keptStart, Width: width, Depth: height, Height: keptLength } }
    : chain.elementType === 'IfcBeam' ? { kind: 'beam', params: linear } : { kind: 'member', params: linear };
  reshapeSource(get, modelId, expressId, writes, element);

  closeSplit(get, modelId, env, expressId, added.expressId);
  const [leftId, rightId] = keepFirst ? [expressId, added.expressId] : [added.expressId, expressId];
  return { ok: true, left: piece(get, modelId, leftId), right: piece(get, modelId, rightId) };
}
