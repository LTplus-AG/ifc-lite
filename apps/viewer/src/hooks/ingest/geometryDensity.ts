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

/** Record types whose bytes are mostly mesh coordinates or vertex indices. */
const DENSE_TYPES = new Set([
  'IFCCARTESIANPOINTLIST3D', 'IFCTRIANGULATEDFACESET', 'IFCTRIANGULATEDIRREGULARNETWORK',
  'IFCPOLYGONALFACESET', 'IFCINDEXEDPOLYGONALFACE', 'IFCINDEXEDPOLYGONALFACEWITHVOIDS',
]);

const SAMPLE_WINDOWS = 4;
const SAMPLE_WINDOW_BYTES = 256 * 1024;
const RECORD_START = /#\d+\s*=\s*([A-Z][A-Z0-9_]*)\s*\(/g;

/**
 * Dense and total record bytes in `text`. Bytes before the first record start
 * (a record cut by the window edge) belong to no known type and are skipped;
 * the last record runs to the end of the window.
 */
export function denseRecordBytes(text: string): { dense: number; total: number } {
  let dense = 0, total = 0, start = -1, denseRecord = false;
  RECORD_START.lastIndex = 0;
  for (let match = RECORD_START.exec(text); match; match = RECORD_START.exec(text)) {
    if (start >= 0) { const bytes = match.index - start; total += bytes; if (denseRecord) dense += bytes; }
    start = match.index;
    denseRecord = DENSE_TYPES.has(match[1]!);
  }
  if (start >= 0) { const bytes = text.length - start; total += bytes; if (denseRecord) dense += bytes; }
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
    : Array.from({ length: SAMPLE_WINDOWS }, (_, i) => {
      const start = Math.floor(((file.size - SAMPLE_WINDOW_BYTES) * (i + 1)) / (SAMPLE_WINDOWS + 1));
      return [start, start + SAMPLE_WINDOW_BYTES];
    });
  let dense = 0, total = 0;
  for (const [start, end] of windows) {
    const counted = denseRecordBytes(decoder.decode(await file.slice(start, end).arrayBuffer()));
    dense += counted.dense; total += counted.total;
  }
  return total > 0 ? dense / total : undefined;
}
