/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import type { MeshData } from '@ifc-lite/geometry';
import { copyMeshShell } from '@ifc-lite/geometry/compact';
import { hashGeometry } from './mesh-geometry-hash.js';

function pieceKey(mesh: MeshData): string {
  return JSON.stringify([
    mesh.expressId, mesh.modelIndex ?? 0, mesh.geometryItemId, mesh.materialId,
    mesh.geometryClass ?? 0, mesh.origin ?? [0, 0, 0], mesh.color, mesh.occurrenceKey,
    mesh.material?.metallic, mesh.material?.roughness, mesh.localToWorld,
    mesh.positions.length, mesh.normals.length, mesh.indices.length,
    ...hashGeometry(mesh.positions, mesh.normals, mesh.indices),
  ]);
}

/** A bounds read returns entire chunks, including pieces that may have arrived
 * since eviction. Remember the source records in draw order without retaining
 * their CPU buffers. Repeated identical pieces occupy distinct slots. */
export class ColdPieceMembership {
  private readonly ids: Set<number>;
  private readonly keys: string[];

  constructor(sources: MeshData[]) {
    this.ids = new Set(sources.map(mesh => mesh.expressId));
    this.keys = sources.map(pieceKey);
  }

  restore(candidates: MeshData[]): MeshData[] {
    const slots = new Map<string, number[]>();
    this.keys.forEach((key, index) => {
      const group = slots.get(key);
      if (group) group.push(index);
      else slots.set(key, [index]);
    });
    const members = new Array<MeshData>(this.keys.length);
    let remaining = members.length;
    for (const mesh of candidates) {
      if (!this.ids.has(mesh.expressId) || mesh.entityIds?.length) continue;
      const slot = slots.get(pieceKey(mesh))?.pop();
      if (slot === undefined) continue;
      // A provider may reuse objects across reads. Each placed occurrence
      // needs its own scene identity even when the underlying buffers agree.
      members[slot] = copyMeshShell(mesh);
      if (--remaining === 0) return members;
    }
    return []; // Incomplete read: publish nothing, keep the shell retryable.
  }
}
