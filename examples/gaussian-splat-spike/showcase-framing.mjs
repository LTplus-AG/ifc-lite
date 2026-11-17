/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// #8567 research showcase: display-axis conversion and visual framing only.
// Neither function calibrates scale, georeferences or aligns a capture.

// Uncompressed 3DGS training output is commonly Y-down (COLMAP camera frame).
// A 180-degree turn about X shows it upright in the viewer's Y-up frame. It is
// a proper rotation: no scale, no mirror, no reconstruction-unit change.
export const DISPLAY_ROTATIONS = Object.freeze({
  none: Object.freeze({ eulerDegrees: [0, 0, 0], apply: (x, y, z) => [x, y, z] }),
  x180: Object.freeze({ eulerDegrees: [180, 0, 0], apply: (x, y, z) => [x, -y, -z] }),
});

const sigmoid = value => 1 / (1 + Math.exp(-value));

function percentile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p / 100 * sorted.length)))];
}

/**
 * Robust visual bounds of the opaque part of a capture, in display coordinates.
 * Sparse floaters and translucent haze would otherwise dominate a min/max box.
 * `opacityLogits` are raw PLY opacity values (pre-sigmoid), as stored on disk.
 */
export function robustFraming(x, y, z, opacityLogits, {
  rotation = 'none', minOpacity = 0.5, lowPercentile = 2, highPercentile = 98, sampleLimit = 400_000,
} = {}) {
  const count = x?.length;
  if (!count || y?.length !== count || z?.length !== count || opacityLogits?.length !== count) {
    throw new Error('robustFraming needs equal, non-empty position and opacity columns');
  }
  const display = DISPLAY_ROTATIONS[rotation];
  if (!display) throw new Error(`unknown display rotation: ${rotation}`);
  if (!(lowPercentile >= 0 && lowPercentile < highPercentile && highPercentile <= 100)) {
    throw new Error('percentiles must satisfy 0 <= low < high <= 100');
  }
  const step = Math.max(1, Math.floor(count / sampleLimit));
  const axes = [[], [], []];
  for (let i = 0; i < count; i += step) {
    if (!(sigmoid(opacityLogits[i]) > minOpacity)) continue;
    const p = display.apply(x[i], y[i], z[i]);
    if (!p.every(Number.isFinite)) continue;
    for (let a = 0; a < 3; a++) axes[a].push(p[a]);
  }
  const used = axes[0].length;
  if (used < 16) throw new Error(`too few opaque finite splats for framing (${used})`);
  const sorted = axes.map(values => Float64Array.from(values).sort());
  const min = sorted.map(values => percentile(values, lowPercentile));
  const max = sorted.map(values => percentile(values, highPercentile));
  const center = min.map((v, a) => (v + max[a]) / 2);
  const radius = Math.hypot(...max.map((v, a) => v - min[a])) / 2;
  if (!(radius > 0)) throw new Error('degenerate framing bounds');
  return {
    center, radius, box: { min, max }, used, sampledEvery: step,
    method: `opacity>${minOpacity} percentiles p${lowPercentile}-p${highPercentile}, half box diagonal; rotation ${rotation}`,
  };
}
