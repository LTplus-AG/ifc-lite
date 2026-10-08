/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { MeshData } from '@ifc-lite/geometry';
import type { ViewerState } from '@/store';
import { vecCross, vecNorm } from '../../../../../packages/create/src/ifc-creator-math';
import { asExpressIdRef, readAttributes, resolvePlacementChain, resolveRotationState } from '@/lib/placement-edit';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { prismGhostMesh, segmentOutline } from '@/lib/commands/modeling/ghost-shapes';
import { sectionGhostMesh } from '@/lib/profile-section/profile-outline';
import { modelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview';
import { readSplitSnapshot } from './model-authoring-split-state';
import { splitCutInMetres } from './model-authoring-split-params';

/** Existing command mesh primitives draw a cut marker, never split solids.
 * A nested placement stays native-authorable, but its marker is unavailable
 * until its native parent frame has a supported viewport projection. */
export function authoringSplitMarker(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, id: number): MeshData | null {
  if (row.op.op !== 'element.split' || !row.modelId || row.resolved.target === undefined) return null;
  const ctx = modelEditTarget(state, row.modelId);
  if (!ctx) return null;
  const snapshot = readSplitSnapshot(ctx.dataStore, ctx.editor, row.resolved.target, 'm');
  const storey = readAttributes(ctx.dataStore, ctx.view, ctx.editor, snapshot.storeyId);
  const placement = resolvePlacementChain(ctx.dataStore, ctx.view, ctx.editor, row.resolved.target);
  const built = buildStoreyWorkplane(state, row.modelId, snapshot.storeyId, 0);
  if (!storey || !placement || !isWorkplane(built) || asExpressIdRef(storey[5]) === null
    || snapshot.placement.parent !== asExpressIdRef(storey[5])) return null;
  const cut = splitCutInMetres(row.op.cut, batch.units);
  if (snapshot.kind === 'slab' && cut.kind === 'slab') {
    if (snapshot.chain.baseElevation === null) return null;
    return prismGhostMesh(built, segmentOutline(cut.a, cut.b, .01), snapshot.chain.baseElevation,
      snapshot.chain.baseElevation + Math.max(.05, snapshot.chain.thickness), id);
  }
  if (cut.kind === 'slab' || snapshot.kind === 'slab') return null;
  const start = snapshot.chain.startCoordinates;
  const axis = snapshot.kind === 'wall' ? snapshot.chain.refDirection : snapshot.chain.axisDirection;
  const origin = start.map((v, i) => v + axis[i] * cut.distance) as [number, number, number];
  const rotation = resolveRotationState(ctx.dataStore, ctx.view, ctx.editor, row.resolved.target);
  if (!rotation) return null;
  const transverse = vecCross(axis, rotation.refDirection);
  // Walls have a horizontal longitudinal X; their existing marker stands in
  // the transverse/vertical plane. Linear bodies keep the native section roll.
  const v = snapshot.kind === 'wall' ? [0, 0, 1] as [number, number, number] : vecNorm(transverse);
  if (snapshot.kind === 'linear' && Math.hypot(...transverse) < 1e-9) return null;
  const u = vecCross(v, axis);
  return sectionGhostMesh(built, { Type: 'Rectangle', XDim: .6, YDim: .6 }, { origin, along: axis, length: .01, u, v }, id);
}
