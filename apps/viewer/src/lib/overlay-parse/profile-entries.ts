/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Flat profile arrays → `ProfileEntry[]` (#2183).
 *
 * The construction-projection sibling of `buildSymbolicDrawingLines`: the
 * main-thread half that turns the worker's transferable arrays back into the
 * entries `ProfileProjector` consumes. It exists because `useDrawingGeneration`
 * used to call `extractProfiles` on the whole source on the main thread, which
 * regrew a `WebAssembly.Memory` there — ~470 MB on a 342 MB model — the first
 * time a user enabled construction projection, and that memory never shrinks.
 *
 * This is a transcription, not a redesign: field order, the `.slice()` copies,
 * and the RTC correction are exactly what the inline walk did.
 *
 * The RTC/`originShift` correction stays HERE rather than in the flatten
 * because it reads `geometryResult.coordinateInfo` — main-thread state the
 * worker has no view of.
 */

import type { ProfileEntry } from '@ifc-lite/drawing-2d';
import {
  EXTRUSION_DIR_STRIDE,
  TRANSFORM_STRIDE,
  type FlatProfiles,
} from './profiles-flat.js';

/**
 * The render-frame shift to subtract from each profile's world translation.
 *
 * Profiles come back in UNSHIFTED WebGL world space, but the meshes and the
 * section position live in the render frame (issue #945 RTC / large-coordinate
 * shift), so without this the projection lines miss the cut geometry on
 * georeferenced models. See the call site for how it is derived from
 * `coordinateInfo` — the derivation is main-thread-only, which is why this
 * arrives as a plain vector.
 */
export interface ProfileOriginShift {
  x: number;
  y: number;
  z: number;
}

/**
 * Rebuild the drawing's profile entries from a flatten.
 *
 * `modelIndex` is stamped on every entry; the projection path is single-model
 * for now (federated extraction would extract each model separately), which is
 * why it defaults to 0 — mirroring the symbolic path's federation limit.
 */
export function buildProfileEntries(
  flat: FlatProfiles,
  shift: ProfileOriginShift,
  modelIndex = 0,
): ProfileEntry[] {
  const profiles: ProfileEntry[] = [];
  const typeNames = flat.typeNames;

  for (let i = 0; i < flat.expressId.length; i++) {
    // Every array below is `slice`d, not viewed: the entries outlive this loop
    // (they are cached across section moves), and a view would keep the whole
    // concatenated buffer alive and alias its neighbours.
    const transform = flat.transform.slice(i * TRANSFORM_STRIDE, (i + 1) * TRANSFORM_STRIDE);
    transform[12] -= shift.x;
    transform[13] -= shift.y;
    transform[14] -= shift.z;

    profiles.push({
      expressId: flat.expressId[i],
      ifcType: typeNames[flat.typeIndex[i]],
      outerPoints: flat.outerPoints.slice(flat.outerStart[i], flat.outerStart[i + 1]),
      holeCounts: flat.holeCounts.slice(flat.holeCountStart[i], flat.holeCountStart[i + 1]),
      holePoints: flat.holePoints.slice(flat.holePointStart[i], flat.holePointStart[i + 1]),
      transform,
      extrusionDir: flat.extrusionDir.slice(
        i * EXTRUSION_DIR_STRIDE,
        (i + 1) * EXTRUSION_DIR_STRIDE,
      ),
      extrusionDepth: flat.extrusionDepth[i],
      modelIndex,
    });
  }

  return profiles;
}
