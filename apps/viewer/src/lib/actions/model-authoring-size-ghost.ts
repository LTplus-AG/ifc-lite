/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { StoreEditor } from '@ifc-lite/mutations';
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { vecCross, vecNorm } from '../../../../../packages/create/src/ifc-creator-math';
import { getModelLengthUnitScale } from '@/lib/length-unit-scale';
import { resolveLinearElementChain } from '@/lib/linear-element-edit';
import { asExpressIdRef, readAttributes, resolvePlacementChain, resolveRotationState } from '@/lib/placement-edit';
import { readPushPullTarget } from '@/lib/push-pull/push-pull-target';
import { sectionGhostMesh, sectionGhostOmissions } from '@/lib/profile-section/profile-outline';
import { prismGhostMesh } from '@/lib/commands/modeling/ghost-shapes';
import { elementStoreyId, buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { draftAuthoringOperation, type DryRunRow } from './model-authoring-native';
import type { ModelAuthoringBatch } from './model-authoring';
import { AUTHORING_VERTEX_LIMIT } from './model-authoring-shape-params';

export interface SizeGhost { mesh: MeshData | null; omitted: string[]; unavailable: boolean; outerBodyOnly: boolean }
const unavailable = (): SizeGhost => ({ mesh: null, omitted: [], unavailable: true, outerBodyOnly: false });

/** #7229: draw the canonical post-edit draft, without publishing it or inventing a placement. */
export function authoringSizeGhost(state: ViewerState, batch: ModelAuthoringBatch, row: DryRunRow, modelId: string, id: number): SizeGhost {
  const dataStore = state.models.get(modelId)?.ifcDataStore, view = state.mutationViews.get(modelId);
  if (!dataStore || !view || row.resolved.target === undefined) return unavailable();
  // #7262: the independent body draft does not contain an earlier-created boundary.
  // The whole batch dry run validates it; disclose unavailable geometry here.
  if (row.op.op === 'element.trimExtend' && row.resolved.reachBoundary && 'ref' in row.resolved.reachBoundary) return unavailable();
  return view.prepareAtomic((draftView) => {
    const editor = new StoreEditor(dataStore, draftView);
    draftAuthoringOperation(batch, dataStore, modelId, editor, row, new Map());
    const draftState: ViewerState = { ...state, mutationViews: new Map([...state.mutationViews, [modelId, draftView]]),
      storeEditors: new Map([...state.storeEditors, [modelId, editor]]) };
    const expressId = row.resolved.target!;
    const storeyId = elementStoreyId(draftState, modelId, expressId);
    const plane = storeyId === null ? null : buildStoreyWorkplane(draftState, modelId, storeyId, 0);
    const placement = resolvePlacementChain(dataStore, draftView, editor, expressId);
    const storeyAttrs = storeyId === null ? null : readAttributes(dataStore, draftView, editor, storeyId);
    const localAttrs = placement ? readAttributes(dataStore, draftView, editor, placement.localPlacementId) : null;
    // Native edits work in the immediate parent frame. Only use the storey plane
    // when the current placement actually names that storey's placement.
    if (!plane || !isWorkplane(plane) || !placement || !storeyAttrs || !localAttrs || asExpressIdRef(storeyAttrs[5]) === null
      || asExpressIdRef(localAttrs[0]) !== asExpressIdRef(storeyAttrs[5])) return unavailable();
    const linear = resolveLinearElementChain(dataStore, draftView, editor, expressId, getModelLengthUnitScale(dataStore));
    if (linear) {
      const rotation = resolveRotationState(dataStore, draftView, editor, expressId);
      if (!rotation || !rotation.refDirection.every(Number.isFinite)) return unavailable();
      const transverse = vecCross(linear.axisDirection, rotation.refDirection);
      if (Math.hypot(...transverse) < 1e-9) return unavailable();
      const v = vecNorm(transverse), u = vecCross(v, linear.axisDirection);
      const section = linear.profile ?? { Type: 'Rectangle' as const, XDim: linear.profileWidth, YDim: linear.profileHeight };
      const mesh = sectionGhostMesh(plane, section, { origin: linear.startCoordinates, along: linear.axisDirection, length: linear.depth, u, v }, id);
      return { mesh, omitted: sectionGhostOmissions(section), unavailable: mesh === null, outerBodyOnly: false };
    }
    const target = readPushPullTarget(draftState, modelId, expressId), face = target?.faces[0];
    const prism = target && face ? target.prism(face, face.size) : null;
    if (!target || !prism || prism.outline.length > AUTHORING_VERTEX_LIMIT) return unavailable();
    const mesh = prismGhostMesh(target.plane, prism.outline, prism.z0, prism.z1, id);
    return { mesh, omitted: [], unavailable: mesh === null, outerBodyOnly: true };
  }).result;
}
