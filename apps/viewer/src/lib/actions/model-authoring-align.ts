/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { alignmentStoreyInStore, type PlanBox } from '@ifc-lite/create';
import type { ViewerState } from '@/store';
import type { ModelEditTarget } from '@/store/slices/mutation-modelling-records';
import type { Workplane } from '@/lib/commands/modeling/types';
import { buildStoreyWorkplane, isWorkplane } from '@/lib/commands/modeling/workplane';
import { modelMeshes } from '@/lib/commands/modeling/align-boxes';
import { prepareNativeAlignmentGeometry } from '@/lib/element-transform/prepare-alignment';
import { batchDigest } from './model-change-preview';
import type { ModelAuthoringBatch } from './model-authoring';
import type { AuthoringRow } from './model-authoring-preview-types';
import { readOnlyModelEditLease } from './model-authoring-read-target';
import { nativePlacementFromTarget, sameNativePlacement } from './model-authoring-placement';
import { authoringSourcesAreCurrent } from './model-authoring-sources';
import { AuthoringRefusal } from './model-authoring-preview-refusal';

export interface PreparedAlignment { boxes: ReadonlyMap<number, PlanBox>; plane: Workplane }
interface OwnedPreparation extends PreparedAlignment {
  digest: string; current(state: ViewerState): boolean;
}
const prepared = new WeakMap<ModelAuthoringBatch, Map<number, OwnedPreparation>>();
const frameKey = (plane: Workplane) => JSON.stringify([[0,0,0], [1,0,0], [0,1,0], [0,0,1]].map(p => plane.localToRender([p[0],p[1],p[2]])));
const generations = new WeakMap<ModelAuthoringBatch, object>();

/** Resolve native eligibility first, then require geometry produced for this exact
 * invocation. Proposal JSON cannot supply boxes or manufacture a prepared lease. */
export function reviewAlignment(state: ViewerState, batch: ModelAuthoringBatch, row: AuthoringRow, target: ModelEditTarget): void {
  if (row.op.op !== 'element.align' || !row.resolved.alignment) throw new Error('Missing native Align binding');
  const { reference, targets } = row.resolved.alignment;
  const op = row.op;
  if (!sameNativePlacement(nativePlacementFromTarget(target, reference), op.expected.reference)
    || targets.some((id, i) => !sameNativePlacement(nativePlacementFromTarget(target, id), op.expected.targets[i]))) {
    throw new AuthoringRefusal('conflict', 'The current native Align placement differs from the captured expected state');
  }
  try { row.resolved.alignment.storeyId = alignmentStoreyInStore(target, { reference, targets, mode: op.mode }); }
  catch (error) { throw new AuthoringRefusal('invalid', error instanceof Error ? error.message : String(error)); }
  const owned = prepared.get(batch)?.get(row.index);
  if (!owned || owned.digest !== batchDigest(batch) || !owned.current(state)) {
    throw new AuthoringRefusal('blocked', 'Prepare current native Align geometry before approving this row');
  }
  row.resolved.alignment.geometry = owned;
}

/** Explicit review preparation, not Apply. Remeshing remains the native worker's
 * operation; cancellation prevents publishing its late result, not an abort claim. */
export async function prepareReviewedAlignments(get: () => ViewerState, batch: ModelAuthoringBatch, signal?: AbortSignal): Promise<void> {
  const generation = {};
  generations.set(batch, generation);
  prepared.delete(batch);
  const { previewModelAuthoring } = await import('./model-authoring-preview');
  const preview = previewModelAuthoring(get(), batch);
  const results = new Map<number, OwnedPreparation>();
  const digest = batchDigest(batch);
  const valid = () => {
    if (signal?.aborted || generations.get(batch) !== generation) throw new Error('Native Align preparation was cancelled or replaced');
    if (!authoringSourcesAreCurrent(get(), preview) || batchDigest(batch) !== digest) throw new Error('The native Align source changed during preparation');
  };
  for (const row of preview.rows) {
    if (row.op.op !== 'element.align') continue;
    const binding = row.resolved.alignment;
    if (!binding || !row.modelId || row.status !== 'blocked') throw new Error(row.issue ?? 'The native Align row is not eligible for geometry preparation');
    const lease = readOnlyModelEditLease(get(), row.modelId);
    if (!lease) throw new Error('The native Align source is unavailable');
    valid(); lease.validate();
    const modelId = row.modelId;
    const geometry = await prepareNativeAlignmentGeometry(get, modelId, binding.storeyId, [binding.reference, ...binding.targets]);
    valid(); lease.validate();
    const meshes = modelMeshes(get(), modelId), frame = frameKey(geometry.plane);
    // Native remesh replaces this owning mesh array. A later remesh/reload must
    // be prepared again; identical file fingerprints cannot adopt old bounds.
    results.set(row.index, { ...geometry, digest, current: state => {
      try { lease.validate(); }
      catch (error) { if (!(error instanceof Error)) throw error; return false; }
      const plane = buildStoreyWorkplane(state, modelId, binding.storeyId, 0);
      return authoringSourcesAreCurrent(state, preview) && modelMeshes(state, modelId) === meshes
        && isWorkplane(plane) && frameKey(plane) === frame;
    } });
  }
  valid();
  prepared.set(batch, results);
  const fresh = previewModelAuthoring(get(), batch);
  const failure = fresh.rows.find(row => row.op.op === 'element.align' && row.status !== 'ready');
  if (failure) { prepared.delete(batch); throw new Error(failure.issue ?? 'The native Align writer refused the prepared geometry'); }
}
