/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Subset of the loading slice that gates element picking. */
export interface PickGatingState {
  /** Authoritative "geometry is actively streaming into the scene" flag. */
  geometryStreamingActive: boolean;
  /** True for the whole span of an in-flight `loadFile`, false once it finishes. */
  loading: boolean;
  /** Loader progress. Its `percent` is a DISPLAY value, not a load-state flag. */
  progress: { phase: string; percent: number; indeterminate?: boolean } | null;
}

/**
 * Whether geometry is still streaming/loading, so element picking must be
 * suppressed (a mid-stream pick is slow and hits an incomplete scene).
 *
 * `geometryStreamingActive` is the authoritative signal. The `progress.percent`
 * check is only a secondary guard, and `percent` is a display value that can
 * outlive a load: the federated georef-alignment phase leaves `progress` at
 * `{ phase: 'Aligning georeferenced model', percent: 90 }` AFTER the model is
 * fully loaded. Gating that secondary signal on `loading` prevents a stale
 * sub-100 progress from disabling picking forever once a second model has
 * finished loading (#1570).
 */
export function isGeometryLoadStreaming(state: PickGatingState): boolean {
  if (state.geometryStreamingActive) return true;
  return state.loading && state.progress !== null && state.progress.percent < 100;
}
