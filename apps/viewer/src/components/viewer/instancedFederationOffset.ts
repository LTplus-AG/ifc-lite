/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import type { DecodedInstance } from '@ifc-lite/geometry';

/**
 * The instanced half of "every express id is global": re-home, in place, the
 * ids each occurrence of a decoded IFNS shard carries onto its owning model's
 * global id space. The flat half, `applyFederationOffsetToMesh` in
 * `hooks/useIfcLoader.ts`, carries the reasoning and the absence rules; the two
 * must move together because `Scene.getInstancedMeshDataPieces` materializes an
 * occurrence into a `MeshData` and stamps `itemId` onto its `geometryItemId`,
 * so a shard left in local space feeds the flat field a local number.
 *
 * Typed to the one field it touches rather than to `DecodedInstancedShard`, so
 * a header field added to the wire format does not become part of this
 * function's contract, or of every fixture that exercises it.
 */
export function applyFederationOffsetToShard(
  shard: { instances: DecodedInstance[] },
  idOffset: number,
): void {
  if (idOffset <= 0) return;
  for (const instance of shard.instances) {
    instance.entityId = instance.entityId + idOffset;
    if (typeof instance.itemId === 'number') {
      instance.itemId = instance.itemId + idOffset;
    }
  }
}
