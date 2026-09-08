/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The `ifc_model_loaded` payload, built in one place.
 *
 * This event is the project's field perf truth (see `scripts/perf/README.md`),
 * and a per-model regression alert reads it. Two of its fields exist purely to
 * make past ambiguities answerable, and both have a falsy value that MUST
 * survive to the wire:
 *
 * - `was_hidden: false` is the statement "this timing is clean". Dropping it
 *   would make a clean load indistinguishable from an old client that never
 *   reported, which is the difference between filtering the metric and
 *   silently discarding half of it.
 * - `total_csg_failures: 0` is the statement "no void cut fell back". Dropping
 *   it would make it indistinguishable from `null` = "this client cannot tell
 *   you", which is exactly the question it was added to settle (#2385).
 *
 * `null` means "not measured" for every optional field and is omitted, because
 * PostHog treats an absent property and an explicit null differently in
 * `IS NOT NULL` filters.
 */

import { posthog } from '@/lib/analytics';

export interface ModelLoadedInputs {
  format: string;
  fileSizeMB: number;
  loadTarget: 'primary' | 'federated';
  loadPath: string;
  meshCount: number;
  totalElapsedMs: number;
  totalVertices: number;
  totalTriangles: number;
  fileReadMs: number;
  /** Milestones. `null` = this load never reached the milestone. */
  metadataCompleteMs: number | null;
  firstGeometryBatchMs: number | null;
  firstVisibleGeometryMs: number | null;
  streamCompleteMs: number | null;
  /** `null` = the engine reported no diagnostics at all (older wasm). */
  totalCsgFailures: number | null;
  /** Was the tab hidden at any point during this load? */
  wasHidden: boolean;
}

/** Round a milestone, preserving "not measured" as an omitted property. */
function milestone(value: number | null): number | undefined {
  return value != null ? Math.round(value) : undefined;
}

export function buildModelLoadedPayload(
  input: ModelLoadedInputs,
): Record<string, string | number | boolean | undefined> {
  return {
    format: input.format,
    file_size_mb: Math.round(input.fileSizeMB * 100) / 100,
    load_target: input.loadTarget,
    load_path: input.loadPath,
    mesh_count: input.meshCount,
    total_elapsed_ms: Math.round(input.totalElapsedMs),
    // Vertices/triangles size the model; the milestones (read -> metadata ->
    // first batch -> first paint -> stream done) locate where a load regressed.
    total_vertices: input.totalVertices,
    total_triangles: input.totalTriangles,
    file_read_ms: Math.round(input.fileReadMs),
    metadata_complete_ms: milestone(input.metadataCompleteMs),
    first_geometry_batch_ms: milestone(input.firstGeometryBatchMs),
    first_visible_geometry_ms: milestone(input.firstVisibleGeometryMs),
    stream_complete_ms: milestone(input.streamCompleteMs),
    // A nonzero count means some void cut fell back, which changes
    // triangulation without changing the mesh roster — the leading explanation
    // for the same file reporting two triangle counts on one build (#2388).
    total_csg_failures: input.totalCsgFailures ?? undefined,
    // Load timings are wall-clock, so a load spanning a tab switch reports the
    // user's absence as work. Lets the perf queries drop those rows on
    // evidence rather than on a magic duration threshold (#2385).
    was_hidden: input.wasHidden,
  };
}

/**
 * The size of the last completed load, retained for the device-loss report
 * (issue #2624). `ifc_model_loaded`'s totals are computed transiently at the
 * capture site and stored nowhere else, so a later GPU loss had no way to say
 * how big the model on the device was. Module state is deliberate, for the
 * same reason as the once-per-session latches in `device-loss-report.ts`: the
 * last load is a property of the session, not of a component instance.
 */
export interface ModelLoadedSnapshot {
  fileSizeMB: number;
  /**
   * Absent = this load path genuinely has no triangle figure (a point cloud's
   * resident geometry is points, not triangles). A real measured 0 and an
   * unknown are different facts, and a substituted 0 would read as a
   * measurement - so unknown stays `undefined` and the loss report omits the
   * field.
   */
  totalTriangles?: number;
  /** Same absent-vs-zero contract as `totalTriangles`. */
  meshCount?: number;
}

let lastLoadSnapshot: ModelLoadedSnapshot | null = null;

/**
 * Record the just-completed load. Fused into `captureModelLoaded` below so
 * every `ifc_model_loaded` capture site records the numbers IT reported -
 * recording anywhere else would drift from what the load event said.
 */
export function recordModelLoadedSnapshot(snapshot: ModelLoadedSnapshot): void {
  lastLoadSnapshot = snapshot;
}

/**
 * Forget the previous model's numbers. Called at the START of every primary
 * (replace-everything) load in `useIfcLoader.ts`, so a load path that never
 * records a snapshot - a future seventh path, or a load that dies midway -
 * leaves the device-loss fields ABSENT rather than describing a model that is
 * no longer the one on the GPU. Stale numbers mislead triage worse than
 * missing ones; this is the fail-safe half, per-path recording is the other.
 */
export function clearModelLoadedSnapshot(): void {
  lastLoadSnapshot = null;
}

/** The last recorded load, or null when no load has completed this session. */
export function getModelLoadedSnapshot(): ModelLoadedSnapshot | null {
  return lastLoadSnapshot;
}

/** Reset the retained snapshot. Test seam - not used in production. */
export function resetModelLoadedSnapshotForTests(): void {
  lastLoadSnapshot = null;
}

/**
 * Derive a snapshot from a load path's `GeometryResult`-shaped totals.
 * `null`/`undefined` geometry (the store slot can legitimately hold null on
 * the cache/server paths) records only the file size - absent, not zero, per
 * the `ModelLoadedSnapshot` contract above.
 *
 * ACCURACY CAVEAT: `geometry.meshes` and `totalTriangles` cover the FLAT mesh
 * path only. An entity whose whole mesh set went to the GPU-instanced shard
 * never appears in `GeometryResult.meshes` (the partial-model property behind
 * #2558), and its triangles are counted nowhere here - so on the load paths
 * where instancing runs (wasm STEP, and the cache path that replays it) a
 * heavily instanced model records substantially fewer meshes/triangles than
 * are actually resident. The IFCX/GLB/server paths carry no instanced shard,
 * so their counts are complete. This is deliberate, not fixable here: the
 * figures must match what `ifc_model_loaded` reported for the same load, and
 * that event has always counted the same way. For true device residency on a
 * loss report, `gpu_resident_mb` is the field to trust - the scene sum behind
 * it includes instanced templates.
 */
export function snapshotFromGeometry(
  fileSizeMB: number,
  geometry: { totalTriangles: number; meshes: readonly unknown[] } | null | undefined,
): ModelLoadedSnapshot {
  return geometry
    ? { fileSizeMB, totalTriangles: geometry.totalTriangles, meshCount: geometry.meshes.length }
    : { fileSizeMB };
}

/**
 * THE `ifc_model_loaded` capture seam: records the last-load snapshot for the
 * device-loss report (#2624), then emits the event. Every completing load path
 * in `useIfcLoader.ts` goes through this, so the loss report can never ship a
 * previous model's numbers after a cache-hit or server load. The guarantee is
 * structural: the event-name literal below is PRIVATE to this module - no
 * other code spells `'ifc_model_loaded'` in a capture call - so this function
 * is the only thing in the codebase that can emit the event, and its
 * mandatory `snapshot` argument means no path, present or future, can emit it
 * without stating what it knows about the model's size. Keep it that way:
 * never export the event name, never add a bare capture elsewhere.
 */
export function captureModelLoaded(
  payload: Record<string, string | number | boolean | undefined>,
  snapshot: ModelLoadedSnapshot,
): void {
  recordModelLoadedSnapshot(snapshot);
  posthog.capture('ifc_model_loaded', payload);
}
