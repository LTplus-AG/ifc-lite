/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Discard-free variant of the main shader, derived from `main.wgsl.ts` the way
 * `textured.wgsl.ts` and `ghost.wgsl.ts` are.
 *
 * A fragment stage that CAN discard makes the GPU defer the depth write until
 * the shader has run, which on most hardware turns off early depth rejection
 * for the whole draw: every overdrawn fragment is lit, specular-shaded and
 * written to both colour targets before the depth test throws it away. The
 * three discards in `fs_main` only fire for clipped geometry (section plane,
 * extra planes, clip box), for hidden GPU-instanced occurrences, and for the
 * instanced passes' opacity routing. A draw for which none of those can fire
 * shades identically without them, so the renderer swaps this variant in for
 * exactly those draws (`opaque-draw-variants.ts`) and keeps the full shader
 * everywhere else.
 */
import { FRAGMENT_DISCARDS_BEGIN, FRAGMENT_DISCARDS_END, mainShaderSource } from './main.wgsl.js';

/** Remove the bracketed discard span from `fs_main`; throws if the brackets moved. */
export function withoutFragmentDiscards(source: string): string {
  const begin = source.indexOf(FRAGMENT_DISCARDS_BEGIN);
  const end = source.indexOf(FRAGMENT_DISCARDS_END);
  if (begin < 0 || end < begin) {
    throw new Error('main-opaque-fast.wgsl: discard brackets not found; update the derivation.');
  }
  if (source.indexOf(FRAGMENT_DISCARDS_BEGIN, begin + 1) >= 0 || source.indexOf(FRAGMENT_DISCARDS_END, end + 1) >= 0) {
    throw new Error('main-opaque-fast.wgsl: discard brackets are not unique; update the derivation.');
  }
  const kept = source.slice(0, begin) + source.slice(end + FRAGMENT_DISCARDS_END.length);
  // The fast variant keeps early depth only if it has no discard anywhere in
  // the fragment stage, including one a later main.wgsl edit adds outside the
  // brackets.
  const fragment = kept.slice(kept.indexOf('fn fs_main('));
  if (/\bdiscard\b/.test(fragment)) {
    throw new Error('main-opaque-fast.wgsl: fs_main still discards outside the brackets; move it inside them.');
  }
  return kept;
}

export const opaqueFastShaderSource = withoutFragmentDiscards(mainShaderSource);
