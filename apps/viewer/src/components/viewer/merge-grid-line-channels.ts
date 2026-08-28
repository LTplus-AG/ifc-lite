/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Merge the two sources currently feeding the renderer's `grid` line-overlay
 * channel: `useGridLines3D` (unclipped) and `useSymbolicAnnotations`'s grid
 * buffer (clipped, issue #3359). Split out of `Viewport.tsx` so the merge is
 * unit-testable without mounting the component. Pending #3368's dedupe,
 * which collapses this to a single owner.
 */
export function mergeGridLineChannels(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const merged = new Float32Array(a.length + b.length);
  merged.set(a, 0);
  merged.set(b, a.length);
  return merged;
}
