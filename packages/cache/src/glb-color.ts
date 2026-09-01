/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour-space helpers for the GLB reader.
 *
 * glTF's `baseColorFactor` is defined in linear-light space, while IFC colours
 * (and the mesh colours the viewer consumes) are sRGB-encoded. The GLB exporter
 * decodes sRGB into linear on write via `srgb_to_linear`; the reader applies the
 * inverse on read so an export -> re-import round-trip is lossless and any
 * spec-conformant external GLB is interpreted correctly.
 */

/**
 * Encode a single linear-light channel value to sRGB, clamped to [0, 1].
 * Inverse of the exporter's `srgb_to_linear`.
 */
export function linearToSrgb(c: number): number {
  const x = c <= 0 ? 0 : c >= 1 ? 1 : c;
  const encoded = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return encoded < 0 ? 0 : encoded > 1 ? 1 : encoded;
}
