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
 * spread over the file and measures the share of sampled bytes that belong
 * to such records. Reads stay bounded and each stays below 1 MiB, like the ZIP
 * inspection; a file under 1 MiB is read in one slice. Admission only samples
 * loads near the budget, so no large source is read whole before the decision.
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

/** Anything but mesh payload: coordinate and index tuples, or a polygonal face set's `#n` face list. */
const NOT_NUMERIC_TUPLES = /[^0-9.,()eE+\-\s#]/g;

/**
 * Bytes of `text` in dense geometry records. The bytes before the first record
 * start belong to a record cut by the window edge; a large mesh can be one
 * record longer than the window, so that fragment counts as dense when it is
 * numeric tuples or `#n` references alone (98 %+). A cut record's type is
 * unknown, so a long numeric record that is not a mesh (B-spline knots, curve
 * points, a B-rep shell's or a relationship's `#n` list) also passes that test;
 * like the point-list overcount it errs toward refusal, where counting those as
 * sparse would undercount a large polygonal face set's face list (reviews on
 * #10814). The last record runs to the end of the
 * window.
 */
export function denseRecordBytes(text: string): number {
  RECORD_START.lastIndex = 0;
  let match = RECORD_START.exec(text);
  const lead = match ? match.index : text.length;
  const other = lead - text.slice(0, lead).replace(NOT_NUMERIC_TUPLES, '').length;
  let dense = lead > 0 && other <= lead * 0.02 ? lead : 0;
  while (match) {
    const next = RECORD_START.exec(text);
    if (DENSE_TYPES.has(match[1]!)) dense += (next ? next.index : text.length) - match.index;
    match = next;
  }
  return dense;
}

/**
 * Share (0..1) of sampled bytes in dense geometry records, or undefined for an
 * empty file. Every sampled byte counts toward the total, so a window inside a
 * long text record weighs as much as one inside a mesh record (review on
 * #10814); the STEP header, a few KB of the first window, counts as sparse.
 * Reads at most {@link SAMPLE_WINDOWS} windows of {@link SAMPLE_WINDOW_BYTES}.
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
    dense += denseRecordBytes(decoder.decode(await file.slice(start, end).arrayBuffer()));
    total += end - start;
  }
  return total > 0 ? dense / total : undefined;
}
