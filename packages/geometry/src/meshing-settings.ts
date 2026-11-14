/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The settings a `GeometryProcessor` meshes with (`meshingSettings()`). The
 * worker pool forwards exactly these to every worker, and a processor in
 * another thread built from them (`new GeometryProcessor(...)` plus
 * `enableGeometryHashes`) produces the same per-element geometry. A host can
 * therefore check that work started early on another processor matches the
 * one it would run now.
 */
export interface GeometryMeshingSettings {
  /** Issue #540: the merge-layers preference snapshotted at construction; the pool posts `set-merge-layers` after `init`. */
  mergeLayers: boolean;
  /** Federated loads may disable instancing. */
  enableInstancing: boolean;
  /** Issue #976: every worker tessellates at the same density as the main-thread paths. */
  tessellationQuality: import('./types.js').TessellationQuality | null;
  /**
   * Issue #1286: every worker drops the same tiny detail cuts as the main-thread
   * paths. Forwarded every run, so an export processor (default false) never
   * inherits a prior load's skip.
   */
  skipSmallCuts: boolean;
  skipVoids: boolean;
  /** Issue #924: the geometry-hash tolerance the host enabled via `enableGeometryHashes()`, so workers fingerprint too. */
  geometryHashTolerance: number | null;
}
