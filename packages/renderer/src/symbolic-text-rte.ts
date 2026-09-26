/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** Per-glyph RTE delta stream for symbolic text labels. */

import { collectInstanceRuns, type InstanceRun } from './instanced-rte.js';
import { tryPackRteDrawableDelta, type WorldPoint } from './relative-to-eye.js';

/** Floats per glyph in the dynamic delta stream: high.xyzw + low.xyzw. */
export const TEXT_RTE_DELTA_FLOATS = 8;
export const TEXT_RTE_DELTA_STRIDE_BYTES = TEXT_RTE_DELTA_FLOATS * 4;

/**
 * Pack each glyph's f64 anchor against `camera` via the shared RTE contract,
 * returning the runs of glyphs to draw. An anchor outside this camera's eye
 * envelope cannot be rasterised this frame and keeps a stale delta, so it is
 * left out of every run (#6128). Without a camera (legacy path) every glyph
 * draws with a zero delta. high.w flags RTE projection; low.w marks an
 * anchor-local legacy origin.
 */
export function packTextRteDeltas(
  anchors: ReadonlyArray<WorldPoint | null>,
  camera: WorldPoint | undefined,
  out: Float32Array,
): InstanceRun[] {
  return collectInstanceRuns(anchors.length, (index) => {
    const offset = index * TEXT_RTE_DELTA_FLOATS;
    const anchor = anchors[index];
    let drawable = true;
    if (anchor && camera) {
      drawable = tryPackRteDrawableDelta(anchor, camera, out, offset);
      if (drawable) out[offset + 3] = 1;
    } else {
      out.fill(0, offset, offset + TEXT_RTE_DELTA_FLOATS);
    }
    // Keep the anchor-local marker separate from high.w's RTE projection flag.
    if (anchor) out[offset + 7] = 1;
    return drawable;
  });
}
