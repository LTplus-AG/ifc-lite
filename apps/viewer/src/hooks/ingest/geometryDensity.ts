/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How much of a STEP file is dense triangulated geometry (#10264).
 *
 * Point lists and face sets turn into triangles at a far higher rate per file
 * byte than B-reps or extrusions, and their peak load memory grows faster:
 * synthetic `IfcTriangulatedFaceSet` files hit a 3 GiB tab cap at ~300 MB,
 * which the size-only estimate admitted. Admission samples a few windows
 * spread over the file and measures the share of record bytes that belong to
 * such records. Reads stay bounded and each stays below 1 MiB, like the ZIP
 * inspection: no whole-source read happens before the admission decision.
 */

/** Record types whose bytes are mostly mesh coordinates or vertex indices. A point
 * list can also hold an IfcIndexedPolyCurve's points, which make no triangles:
 * curve-heavy models (alignments) read denser than they are, which errs toward
 * refusal. */
const DENSE_TYPES = new Set([
  'IFCCARTESIANPOINTLIST3D', 'IFCTRIANGULATEDFACESET', 'IFCTRIANGULATEDIRREGULARNETWORK',
  'IFCPOLYGONALFACESET', 'IFCINDEXEDPOLYGONALFACE', 'IFCINDEXEDPOLYGONALFACEWITHVOIDS',
]);

const SAMPLE_WINDOWS = 4;
const SAMPLE_WINDOW_BYTES = 256 * 1024;
const RECORD_START = /#\d+\s*=\s*([A-Z][A-Z0-9_]*)\s*\(/g;

/** Mesh payload: coordinate and index tuples, nothing else. */
const NUMERIC_TUPLES = /[^0-9.,()eE+\-\s]/g;

/**
 * Dense and total record bytes in `text`. The bytes before the first record
 * start belong to a record cut by the window edge; a large mesh can be one
 * record longer than the window, so that fragment counts as dense when it is
 * numeric tuples alone (98 %+), and is skipped otherwise. A long numeric record
 * that is not a mesh (B-spline knots, curve points) also passes that test; like
 * the point-list overcount it errs toward refusal. The last record runs to the
 * end of the window.
 */
export function denseRecordBytes(text: string): { dense: number; total: number } {
  RECORD_START.lastIndex = 0;
  const first = RECORD_START.exec(text);
  const lead = first ? first.index : text.length;
  const other = lead > 0 ? (text.slice(0, lead).match(NUMERIC_TUPLES)?.length ?? 0) : lead;
  let dense = lead > 0 && other <= lead * 0.02 ? lead : 0, total = dense, start = -1, denseRecord = false;
  const close = (end: number) => { if (start >= 0) { total += end - start; if (denseRecord) dense += end - start; } };
  RECORD_START.lastIndex = 0;
  for (let match = RECORD_START.exec(text); match; match = RECORD_START.exec(text)) {
    close(match.index);
    start = match.index;
    denseRecord = DENSE_TYPES.has(match[1]!);
  }
  close(text.length);
  return { dense, total };
}

/**
 * Share (0..1) of sampled record bytes in dense geometry records, or undefined
 * when the sample holds no recognisable record. Reads at most
 * {@link SAMPLE_WINDOWS} windows of {@link SAMPLE_WINDOW_BYTES}.
 */
export async function sampleDenseGeometryShare(file: Blob): Promise<number | undefined> {
  const decoder = new TextDecoder('latin1');
  const windows = file.size < SAMPLE_WINDOWS * SAMPLE_WINDOW_BYTES
    ? [[0, file.size]]
    // First to last window, evenly spaced: no overlap once the file holds all four.
    : Array.from({ length: SAMPLE_WINDOWS }, (_, i) => {
      const start = Math.floor(((file.size - SAMPLE_WINDOW_BYTES) * i) / (SAMPLE_WINDOWS - 1));
      return [start, start + SAMPLE_WINDOW_BYTES];
    });
  let dense = 0, total = 0;
  for (const [start, end] of windows) {
    const counted = denseRecordBytes(decoder.decode(await file.slice(start, end).arrayBuffer()));
    dense += counted.dense; total += counted.total;
  }
  return total > 0 ? dense / total : undefined;
}
