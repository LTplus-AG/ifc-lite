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
