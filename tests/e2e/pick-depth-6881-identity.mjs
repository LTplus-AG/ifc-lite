/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Cross-sample identity for the #6881 hover cohort. Everything except the
// unprojected world position must match exactly. Separate browser sessions can
// rasterize a texel one depth ULP apart (observed: up to 2.1e-4 m at about 11 m, with
// identical ids, items, texels and camera), so world position may drift by at
// most WORLD_TOLERANCE_METRES per component. The tolerance is not transitive, so
// callers must compare every sample against the first (never the previous one). Same-render depth/world equality
// between the candidate and the full-copy sample stays exact in the functional
// controls; this tolerance applies only to comparing different cohort samples.
export const WORLD_TOLERANCE_METRES = 1e-3;

const AXES = ['x', 'y', 'z'];
const stripWorld = signature => JSON.stringify({
  ...signature,
  picks: signature.picks.map(pick => ({ ...pick, result: pick.result && { ...pick.result, worldXYZ: null } })),
});

export function sameSampleIdentity(reference, signature) {
  if (stripWorld(reference) !== stripWorld(signature)) return false;
  return reference.picks.every((pick, index) => {
    const other = signature.picks[index];
    if (!pick.result) return !other.result;
    return AXES.every(axis => {
      const a = pick.result.worldXYZ?.[axis], b = other.result.worldXYZ?.[axis];
      return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= WORLD_TOLERANCE_METRES;
    });
  });
}
