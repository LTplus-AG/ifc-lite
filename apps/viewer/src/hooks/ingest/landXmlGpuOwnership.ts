/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/** One-shot handoff from the LandXML provisional transaction to Scene sync. */

import type { MeshData } from '@ifc-lite/geometry';

const alreadyUploaded = new WeakSet<MeshData>();

/** Mark the store-owned mesh after its identical global-id batch reached GPU. */
export function markLandXmlGpuUploaded(mesh: MeshData): void {
  alreadyUploaded.add(mesh);
}

/** Consume the marker exactly once; scene rebuilds must upload again. */
export function takeLandXmlGpuUploaded(mesh: MeshData): boolean {
  if (!alreadyUploaded.has(mesh)) return false;
  alreadyUploaded.delete(mesh);
  return true;
}
