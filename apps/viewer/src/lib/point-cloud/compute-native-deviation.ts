/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { Renderer } from '@ifc-lite/renderer';
import { useViewerStore } from '@/store';
import { placementSnapshot, placementSnapshotIsCurrent } from '../model-placement/placement-snapshot';
import { noteDeviationWrite } from '../model-placement/preview-analysis';
export class NativeDeviationError extends Error {
  constructor(readonly key: 'deviationPanel.positionsChangedError' | 'deviationPanel.noPointsError' | 'deviationPanel.noMeshError') { super(key); }
}
export class NativeDeviationReadError extends Error {
  constructor(readonly revision: number, cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); }
}
/** One admitted GPU dispatch and readback; the UI and operation await this exact native path.
 * GPU work cannot be cancelled after dispatch. Callers must authorize before admission.
 */
export async function computeNativeDeviation(renderer: Pick<Renderer, 'computeDeviations' | 'readDeviationDistances'>, clipRange: number, onComputed?: (stage: { result: Awaited<ReturnType<Renderer['computeDeviations']>>; revision: number; durationMs: number }) => void) {
  const placement = placementSnapshot(useViewerStore.getState());
  const t0 = performance.now();
  noteDeviationWrite(renderer);
  const result = await renderer.computeDeviations({ maxRange: clipRange });
  if (!placementSnapshotIsCurrent(placement, useViewerStore.getState())) throw new NativeDeviationError('deviationPanel.positionsChangedError');
  if (result.pointsProcessed === 0) throw new NativeDeviationError('deviationPanel.noPointsError');
  if (result.bvhTriangles === 0) throw new NativeDeviationError('deviationPanel.noMeshError');
  const state = useViewerStore.getState();
  state.setPointCloudDeviationComputed(true);
  if (state.pointCloudDeviationHalfRange === 0.05 && result.suggestedHalfRange !== 0.05) state.setPointCloudDeviationHalfRange(result.suggestedHalfRange);
  state.setPointCloudColorMode('deviation');
  const revision = useViewerStore.getState().pointCloudDeviationRevision;
  // Publish the admitted run before awaiting readback: native COPC can replace
  // it during this await, and the UI needs this revision to queue its refresh.
  onComputed?.({ result, revision, durationMs: performance.now() - t0 });
  let read: Awaited<ReturnType<Renderer['readDeviationDistances']>>;
  try { read = await renderer.readDeviationDistances(); }
  catch (error) { throw new NativeDeviationReadError(revision, error); }
  const after = useViewerStore.getState();
  if (after.pointCloudDeviationRevision !== revision) throw new NativeDeviationReadError(revision, new Error('The native deviation run was superseded.'));
  if (!placementSnapshotIsCurrent(placement, after) || !after.pointCloudDeviationComputed) throw new NativeDeviationError('deviationPanel.positionsChangedError');
  return { result, read, revision, durationMs: performance.now() - t0 };
}
