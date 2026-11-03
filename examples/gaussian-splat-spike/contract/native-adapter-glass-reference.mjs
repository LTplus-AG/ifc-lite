/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
// #8564 affine glass reference (pure). Straight-alpha blending is affine in the
// destination, so glass over a splat is B0 + (B1 - B0) * A / 255 per channel, from
// the glass over black (B0), over white (B1) and the splat alone (A); each capture
// is rounded once, so the true value lies within 1/255 of that.

const pixelAt = (frame, x, y) => Array.from(frame.rgba.subarray((y * frame.width + x) * 4, (y * frame.width + x) * 4 + 4));

/** The affine reference over `region`, RGB only; also counts pixels where the splat changed the glass. */
export function glassOverSplats(actual, glassBlack, glassWhite, splats, region, tolerance = 2) {
  const [x0, y0, x1, y1] = region.bounds;
  let compared = 0, overTolerance = 0, maxDelta = 0, tinted = 0, worst = null;
  for (let y = Math.max(0, y0); y <= Math.min(actual.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(actual.width - 1, x1); x++) {
      if (!region.contains(x, y)) continue;
      compared++;
      const i = (y * actual.width + x) * 4;
      let delta = 0, lit = false;
      for (let c = 0; c < 3; c++) {
        const expected = glassBlack.rgba[i + c] + (glassWhite.rgba[i + c] - glassBlack.rgba[i + c]) * splats.rgba[i + c] / 255;
        delta = Math.max(delta, Math.abs(actual.rgba[i + c] - expected));
        if (splats.rgba[i + c] > 8) lit = true;
      }
      if (lit) tinted++;
      if (delta > maxDelta) { maxDelta = delta; worst = { x, y, actual: pixelAt(actual, x, y), glassBlack: pixelAt(glassBlack, x, y), glassWhite: pixelAt(glassWhite, x, y), splats: pixelAt(splats, x, y) }; }
      if (delta > tolerance) overTolerance++;
    }
  }
  return { region: region.describe, tolerance, compared, splatPixels: tinted, overTolerance, maxDelta: Math.round(maxDelta * 1000) / 1000, worst };
}

