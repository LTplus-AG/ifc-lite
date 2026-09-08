/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Colour-space helper for the GLB reader.
 *
 * glTF's `baseColorFactor` is defined in linear-light space, while IFC colours
 * (and the mesh colours the viewer consumes) are sRGB-encoded. The GLB exporter
 * decodes sRGB into linear on write via `srgb_to_linear`; the reader applies the
 * inverse on read so an export -> re-import round-trip is lossless and any
 * spec-conformant external GLB is interpreted correctly.
 *
 * Re-exported from `@ifc-lite/data`, the single shared home for this
 * conversion — `@ifc-lite/export`'s own GLB->MeshData reader
 * (`parseGLBToMeshData`) applies the identical decode and must stay in sync.
 */
export { linearToSrgb } from '@ifc-lite/data';
