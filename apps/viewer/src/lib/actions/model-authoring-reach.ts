/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { readWallJoinTarget, trimExtendElementInStore, type ElementTrimExtendParams } from '@ifc-lite/create';
import type { StoreEditor, MutablePropertyView } from '@ifc-lite/mutations';
import type { IfcDataStore } from '@ifc-lite/parser';
import { planElementTransform } from '@/lib/element-transform/plan';
import { effectiveStoreyId } from '@/lib/effective-storey';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { readOnlyModelEditTarget, nativeLengthUnitAvailable } from './model-authoring-read-target';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ViewerState } from '@/store';
import { uniqueSplitGuid } from './model-authoring-split';
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
  return authoringReachEvidenceFromTarget(readOnlyModelEditTarget(state, modelId), id);
}

export function authoringReachEvidenceFromTarget(target: ModelEditTarget | null, id: number) {
  return target && nativeLengthUnitAvailable(target)
    ? nativeAuthoringReach(target.dataStore, target.view, target.editor, id) : null;
}

/** Explicit plan coordinates are storey-local; the native reach writer uses
 * its immediate parent frame. Reuse the canonical transform planner's proof,
 * never reinterpret coordinates through an unproved parent (#7262). */
export function verifyReachStoreyFrame(store: IfcDataStore, view: MutablePropertyView, id: number): void {
  const plan = planElementTransform({ dataStore: store, view, selected: [id],
    storeyOf: candidate => effectiveStoreyId(store, view, candidate) ?? null });
  const frame = plan.roots.find(candidate => candidate.expressId === id)?.parent;
  if (!frame || ![...frame.origin, ...frame.axis].every(Number.isFinite)
    || Math.abs(frame.origin[0]) > 1e-9 || Math.abs(frame.origin[1]) > 1e-9
    || Math.abs(frame.axis[0] - 1) > 1e-9 || Math.abs(frame.axis[1]) > 1e-9) {
    throw new Error('Trim/Extend requires a native parent plan frame matching the storey-local coordinates; inspect or reparent this element before proposing the edit');
  }
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
  if (!uniqueSplitGuid(store, editor, op.target.globalId)) throw new Error('The native Trim/Extend target GlobalId is not unique');
  if ('wall' in op.boundary && !('ref' in op.boundary.wall) && !uniqueSplitGuid(store, editor, op.boundary.wall.globalId)) {
    throw new Error('The native Trim/Extend boundary GlobalId is not unique');
  }
  verifyReachStoreyFrame(store, view, id);
  verifyReachExpected(store, view, editor, id, op);
  const params = reachParams(batch, op, boundary, refs);
  if ('wallId' in params.boundary) verifyReachStoreyFrame(store, view, params.boundary.wallId);
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
