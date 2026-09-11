/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Count the vertices ("v x y z" lines) in an IFC-Lite-generated Wavefront OBJ
 * export. Zero means the export carries no render geometry — the OBJ twin of
 * `countGlbMeshes` for GLB.
 *
 * The Rust OBJ exporter (`ifc_lite_export::export_obj`) has no "no render
 * geometry" error signal the way `export_glb` does (`NoRenderGeometry`) — it
 * always returns a string, even when zero meshes pass `mesh_visible`. That
 * string is never zero bytes: it still carries the two `# ifc-lite OBJ
 * export` / `# units: …` comment header lines, so a byte-length check alone
 * cannot tell an empty export from a real one (an all-header, zero-geometry
 * OBJ is a fixed ~88 bytes regardless of input). Vertex count is the actual
 * geometry-content signal.
 *
 * Only `v ` lines are counted, not `vn `/`vt ` — a line that starts "vn "
 * does not satisfy `startsWith('v ')` (the character after `v` is `n`, not a
 * space), so no explicit exclusion is needed.
 */
export function countObjVertices(obj: Uint8Array): number {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(obj);
  } catch {
    // A malformed / non-UTF-8 buffer has no countable vertices. Return 0 so
    // callers treat it as an empty export (and fail loud) rather than
    // crashing on the decode with an opaque stack trace.
    return 0;
  }
  let count = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('v ')) count++;
  }
  return count;
}
