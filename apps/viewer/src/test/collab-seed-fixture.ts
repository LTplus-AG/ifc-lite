/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The smallest owner-side model that exercises the REAL seed-into-room path
 * (#4446): a legacy STEP store with two IfcRoot products (`buildStepSeedSource`
 * derives the structure from it, `pathForEntity` keys geometry by its GUIDs)
 * and one textured mesh per product, so the guest side can prove it got the
 * geometry AND the image back, not just the entity list.
 *
 * Shared by the `runOwnerSeed` unit test and the `startCollab` phase test so
 * the two seed the same model and can be read against each other.
 */

import type { IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';

export const SEED_GUIDS = {
  wall: '0aBcDeFgHiJkLmNoPqRsT1',
  slab: '0aBcDeFgHiJkLmNoPqRsT2',
} as const;

/** 2x2 RGBA image, distinct per pixel so a byte-exact round-trip is meaningful. */
export const SEED_TEXTURE_PIXELS = new Uint8Array([
  255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 128,
]);

/**
 * A STEP-origin store as `buildStepSeedSource` / `pathForEntity` read it. No
 * source bytes and no spatial tree: the seed must come from the entity table
 * alone (the same invariant `step-seed.test.ts` pins).
 */
export function seedFixtureStore(): IfcDataStore {
  const rows = new Map<number, { guid: string; name: string; type: string }>([
    [1, { guid: SEED_GUIDS.wall, name: 'Wall-A', type: 'IfcWall' }],
    [2, { guid: SEED_GUIDS.slab, name: 'Slab-B', type: 'IfcSlab' }],
  ]);
  return {
    source: new Uint8Array(0),
    entityIndex: {
      byId: new Map([
        [1, { type: 'IFCWALL', byteOffset: 0, byteLength: 0 }],
        [2, { type: 'IFCSLAB', byteOffset: 0, byteLength: 0 }],
      ]),
      byType: new Map(),
    },
    entities: {
      getGlobalId: (id: number) => rows.get(id)?.guid ?? '',
      getName: (id: number) => rows.get(id)?.name ?? '',
      getDescription: () => '',
      getObjectType: () => '',
      getTypeName: (id: number) => rows.get(id)?.type ?? 'Unknown',
    },
    properties: { getForEntity: () => [] },
    relationships: { getRelated: () => [] },
    spatialHierarchy: null,
    schemaVersion: 'IFC4',
  } as unknown as IfcDataStore;
}

/** One textured triangle per product; `z` varies so the blobs are distinct. */
export function seedFixtureMesh(expressId: number): MeshData {
  return {
    expressId,
    ifcType: expressId === 1 ? 'IfcWall' : 'IfcSlab',
    positions: new Float32Array([0, 0, expressId, 1, 0, expressId, 0, 1, expressId]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
    uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
    texture: { width: 2, height: 2, rgba: SEED_TEXTURE_PIXELS, repeatS: false, repeatT: true },
  };
}

export function seedFixtureMeshes(): MeshData[] {
  return [seedFixtureMesh(1), seedFixtureMesh(2)];
}
