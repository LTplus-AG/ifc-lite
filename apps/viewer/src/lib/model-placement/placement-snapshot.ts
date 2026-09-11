/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { displayedTranslation, type PlacementState } from './state';
import { equalTranslation, type Translation } from './translation';
interface SnapshotState { models: ReadonlyMap<string, unknown>; modelPlacement: PlacementState; pointCloudAlignmentEnabled: boolean }
interface Snapshot { frame: string | null; positions: ReadonlyMap<string, Translation>; alignment: boolean | undefined }
export function placementSnapshot(state: SnapshotState, ids: Iterable<string> = state.models.keys(), includeScanAlignment = true): Snapshot {
  return { frame: state.modelPlacement.frameKey, positions: new Map([...ids].map((id) => [id, displayedTranslation(state.modelPlacement, id)])), alignment: includeScanAlignment ? state.pointCloudAlignmentEnabled : undefined };
}
export function placementSnapshotIsCurrent(snapshot: Snapshot, state: SnapshotState): boolean {
  return snapshot.frame === state.modelPlacement.frameKey && (snapshot.alignment === undefined || snapshot.alignment === state.pointCloudAlignmentEnabled) && [...snapshot.positions].every(([id, position]) =>
    state.models.has(id) && equalTranslation(position, displayedTranslation(state.modelPlacement, id)));
}
const jobs = new WeakMap<object, Snapshot>();
export function rememberPlacementSnapshot(job: object, state: SnapshotState, ids: Iterable<string>): void {
  jobs.set(job, placementSnapshot(state, ids));
}
export function jobPlacementIsCurrent(job: object, state: SnapshotState): boolean {
  const snapshot = jobs.get(job);
  return !snapshot || placementSnapshotIsCurrent(snapshot, state);
}
