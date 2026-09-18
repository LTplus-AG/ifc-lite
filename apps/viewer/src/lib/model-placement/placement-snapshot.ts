/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { displayedTranslation, placementFor, type PlacementState } from './state';
import { equalRotation, type ModelRotation } from './rotation';
import { equalTranslation, type Translation } from './translation';
interface SnapshotState { models: ReadonlyMap<string, unknown>; modelPlacement: PlacementState; pointCloudAlignmentEnabled: boolean }
// Rotations ride along: a heading is baked into the vertices, so a result built
// on the previous heading is as stale as one built before a move.
interface Snapshot { frame: string | null; positions: ReadonlyMap<string, Translation>; rotations: ReadonlyMap<string, ModelRotation>; alignment: boolean | undefined }
export function placementSnapshot(state: SnapshotState, ids: Iterable<string> = state.models.keys(), includeScanAlignment = true): Snapshot {
  const list = [...ids];
  return { frame: state.modelPlacement.realignedFrameKey, positions: new Map(list.map((id) => [id, displayedTranslation(state.modelPlacement, id)])),
    rotations: new Map(list.map((id) => [id, placementFor(state.modelPlacement, id).rotation])), alignment: includeScanAlignment ? state.pointCloudAlignmentEnabled : undefined };
}
export function placementSnapshotIsCurrent(snapshot: Snapshot, state: SnapshotState): boolean {
  return snapshot.frame === state.modelPlacement.realignedFrameKey && (snapshot.alignment === undefined || snapshot.alignment === state.pointCloudAlignmentEnabled) && [...snapshot.positions].every(([id, position]) =>
    state.models.has(id) && equalTranslation(position, displayedTranslation(state.modelPlacement, id))
    && equalRotation(snapshot.rotations.get(id)!, placementFor(state.modelPlacement, id).rotation));
}
const jobs = new WeakMap<object, Snapshot>();
export function rememberPlacementSnapshot(job: object, state: SnapshotState, ids: Iterable<string>): void {
  jobs.set(job, placementSnapshot(state, ids));
}
export function jobPlacementIsCurrent(job: object, state: SnapshotState): boolean {
  const snapshot = jobs.get(job);
  return !snapshot || placementSnapshotIsCurrent(snapshot, state);
}
