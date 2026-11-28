/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { GeometryProcessor } from '@ifc-lite/geometry';

/** Run the same filterable Rust export for CLI and MCP callers. */
export function exportRustArtifact(
  processor: Pick<GeometryProcessor, 'exportGlb' | 'exportObj' | 'exportJsonld'>,
  format: 'glb' | 'obj' | 'jsonld',
  bytes: Uint8Array,
  isolated?: Uint32Array,
  nameByGlobalId = false,
): Uint8Array | null {
  switch (format) {
    case 'obj':
      return processor.exportObj(bytes, true, new Uint32Array(), isolated);
    case 'jsonld':
      return processor.exportJsonld(bytes, '', true, false, false, isolated);
    case 'glb':
      return processor.exportGlb(bytes, false, new Uint32Array(), isolated, '', true, false, nameByGlobalId);
  }
}
