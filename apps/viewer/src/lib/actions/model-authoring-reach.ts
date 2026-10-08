/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readWallJoinTarget, trimExtendElementInStore, type ElementTrimExtendParams } from '@ifc-lite/create';
import { StoreEditor, type MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import type { ViewerState } from '@/store';
import { nativeReachPin, sameReachPin } from './model-authoring-reach-fields';
import { toMetres, type AuthoringOp, type ModelAuthoringBatch } from './model-authoring';
import type { ElementId } from './model-authoring-native';

type ReachOp = Extract<AuthoringOp, { op: 'element.trimExtend' }>;

/** Snapshot from the same canonical readers the native writer uses. Source fields
 * are verbatim: WallJoinRead.location is in file units while its wall is in metres. */
export function nativeAuthoringReach(store: IfcDataStore, view: MutablePropertyView, editor: StoreEditor, id: number) {
  const scale = getModelLengthUnitScale(store), type = editor.getEntityType(id)?.toUpperCase();
  if (type === 'IFCWALL' || type === 'IFCWALLSTANDARDCASE') {
    const wall = readWallJoinTarget(store, view, id, scale);
    return wall && Number.isFinite(wall.height) ? { kind: 'wall' as const, wall } : null;
  }
  if (type !== 'IFCBEAM' && type !== 'IFCMEMBER') return null;
  const chain = resolveLinearElementChain(store, view, editor, id, scale);
  return chain ? { kind: 'beam' as const, chain } : null;
}

/** Available to the actual selected-element evidence producer, not only tests. */
export function authoringReachEvidence(state: ViewerState, modelId: string, id: number) {
  const store = state.models.get(modelId)?.ifcDataStore, view = state.mutationViews.get(modelId);
  if (!store || !view) return null;
  const editor = state.storeEditors.get(modelId);
  if (editor) return nativeAuthoringReach(store, view, editor, id);
  return view.prepareAtomic(draft => nativeAuthoringReach(store, draft, new StoreEditor(store, draft), id)).result;
}

export function verifyReachExpected(store: IfcDataStore, view: MutablePropertyView, editor: StoreEditor, id: number, op: ReachOp): void {
  const actual = nativeAuthoringReach(store, view, editor, id);
  const snapshot = actual?.kind === 'wall' ? actual.wall : actual?.chain;
  if (!actual || actual.kind !== op.expected.kind || !sameReachPin(snapshot, op.expected.snapshot))
    throw new Error('The current native Trim/Extend snapshot differs from expected');
}

export function reachParams(batch: ModelAuthoringBatch, op: ReachOp, boundary: ElementId | undefined, refs: ReadonlyMap<string, number>): ElementTrimExtendParams {
  const m = (v: number) => toMetres(batch, v);
  if ('line' in op.boundary) {
    const line = op.boundary.line;
    return { mode: op.mode, click: [m(op.click[0]), m(op.click[1])], boundary: {
      a: [m(line.a[0]), m(line.a[1])], b: [m(line.b[0]), m(line.b[1])], tMin: line.tMin, tMax: line.tMax, reach: m(line.reach),
    } };
  }
  const id = boundary && ('id' in boundary ? boundary.id : refs.get(boundary.ref));
  if (id === undefined) throw new Error('The Trim/Extend boundary creation is unavailable');
  return { mode: op.mode, click: [m(op.click[0]), m(op.click[1])], boundary: { wallId: id } };
}

/** Native expected-state pins are checked again inside the unpublished/committing
 * draft, so earlier edits in the batch cannot silently alter the approved input. */
export function writeAuthoringReach(batch: ModelAuthoringBatch, store: IfcDataStore, editor: StoreEditor, id: number,
  op: ReachOp, boundary: ElementId | undefined, refs: ReadonlyMap<string, number>) {
  const view = editor.getMutationView();
  verifyReachExpected(store, view, editor, id, op);
  const params = reachParams(batch, op, boundary, refs);
  if ('wallId' in params.boundary && 'wall' in op.boundary && op.boundary.expected) {
    const actual = readWallJoinTarget(store, view, params.boundary.wallId, getModelLengthUnitScale(store));
    if (!sameReachPin(actual, op.boundary.expected)) throw new Error('The native boundary wall differs from expected');
  }
  return trimExtendElementInStore(store, editor, id, params);
}

export function reachBefore(state: ViewerState, modelId: string, id: number): Record<string, unknown> | null {
  const actual = authoringReachEvidence(state, modelId, id);
  return actual ? nativeReachPin(actual.kind === 'wall' ? actual.wall : actual.chain, 'native reach') : null;
}
