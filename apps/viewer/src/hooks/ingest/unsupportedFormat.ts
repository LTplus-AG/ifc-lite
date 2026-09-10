/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Map common unsupported formats to a user-facing explanation. Drop
 * handlers call this when nothing else recognises a dropped file so the
 * user sees "this is a Recap project, export to E57" instead of nothing
 * happening.
 *
 * Split out of pointCloudIngest.ts (which is at its module-size budget) —
 * this function has no dependency on the point-cloud ingest pipeline, it's
 * pure string matching shared by every "why didn't my drop do anything"
 * case, point clouds included.
 */
export function describeUnsupportedFormat(fileName: string): string | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.blend.zip')) {
    return 'Blender archive — extract it, then export a GLB or select the .gltf, .bin and texture files together.';
  }
  if (lower.endsWith('.zip')) {
    return 'ZIP archive — please extract first. GLB, glTF bundles, PLY, LAS, LAZ and E57 files inside can load.';
  }
  if (
    lower.endsWith('.rwp') || lower.endsWith('.rwi')
    || lower.endsWith('.rwcx') || lower.endsWith('.dmt')
    || lower.endsWith('.lay') || lower.endsWith('.db1')
  ) {
    return 'Autodesk ReCap (.rwp/.rwi/.rwcx) is a proprietary format we cannot decode. Export to E57 or LAS from ReCap.';
  }
  if (lower.endsWith('.skp')) return 'SketchUp model — not a point cloud.';
  if (lower.endsWith('.fls') || lower.endsWith('.lsproj')) {
    return 'Faro Scene project — export to E57 from Scene to load it here.';
  }
  // BCF collaboration archives aren't models — they attach comments and
  // camera viewpoints to GlobalIds in a model that must already be loaded.
  // Without this, dropping one here (a natural first try — issue #4099)
  // matched no branch above and failed silently.
  if (lower.endsWith('.bcf') || lower.endsWith('.bcfzip')) {
    return 'BCF file, not a model — use the BCF panel\'s Import button to open it (load the model it refers to first if you haven\'t already).';
  }
  return null;
}
