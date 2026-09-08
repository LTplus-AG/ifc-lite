/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour-space helpers shared by every glTF/GLB reader in this repo.
 *
 * glTF's `baseColorFactor`/`emissiveFactor` are defined in linear-light space
 * (per the glTF 2.0 spec), while IFC colours (and the mesh colours the viewer
 * consumes) are sRGB-encoded (IEC 61966-2-1). The Rust GLB exporter and the
 * TypeScript `@ifc-lite/export` GLTFExporter both decode sRGB into linear on
 * write; every GLB reader in this repo must apply the exact inverse on read
 * so an export -> re-import round-trip is lossless and any spec-conformant
 * external GLB is interpreted correctly.
 */

/**
 * Encode a single linear-light channel value to sRGB, clamped to [0, 1].
 * Inverse of the exporters' sRGB-to-linear conversion.
 */
export function linearToSrgb(c: number): number {
  const x = c <= 0 ? 0 : c >= 1 ? 1 : c;
  const encoded = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return encoded < 0 ? 0 : encoded > 1 ? 1 : encoded;
}
