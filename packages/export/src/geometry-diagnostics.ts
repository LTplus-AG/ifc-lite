// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

import { GeometryProcessor, type GeometryDiagnostics } from '@ifc-lite/geometry';

type WorstHost = GeometryDiagnostics['worstHosts'][number];

/**
 * Narrow the bounded `worstHosts` list to a single product and/or IFC type.
 * Pure so it's directly unit-testable without a wasm/model round-trip.
 */
export function filterWorstHosts(
  hosts: WorstHost[],
  opts: { productId?: number; ifcType?: string },
): WorstHost[] {
  return hosts.filter((h) => {
    if (opts.productId !== undefined && h.productId !== opts.productId) return false;
    if (opts.ifcType && h.ifcType !== opts.ifcType) return false;
    return true;
  });
}

/** Collect the Rust geometry and opening diagnostics for a STEP model. */
export async function readGeometryDiagnostics(bytes: Uint8Array): Promise<GeometryDiagnostics | null> {
  const processor = new GeometryProcessor();
  try {
    await processor.init();
    return processor.diagnoseGeometry(bytes) ?? null;
  } finally {
    processor.dispose();
  }
}
