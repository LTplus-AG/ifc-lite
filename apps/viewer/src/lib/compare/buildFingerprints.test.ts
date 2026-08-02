/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { EntityWorldAabb, MeshData } from '@ifc-lite/geometry';
import { buildEntityFingerprints } from './buildFingerprints.js';

/** Wrap a STEP body in a minimal IFC4 envelope (same helper shape as
 *  describeChange.test.ts). */
function ifc4(body: string): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function storeFromStep(body: string): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifc4(body));
  const parser = new IfcParser();
  // disableWorkerScan keeps the scan in-process (no Worker in node test).
  return parser.parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** A wall carrying one property set. `guid`/`psetGuid` are the re-exported
 *  identity; `fireRating` is the only piece of real content. */
function wallWithPset(guid: string, psetGuid: string, relGuid: string, fireRating: string): string {
  return [
    `#1=IFCWALL('${guid}',$,'Wall A',$,$,$,$,$,.STANDARD.);`,
    `#2=IFCPROPERTYSINGLEVALUE('FireRating',$,IFCLABEL('${fireRating}'),$);`,
    `#3=IFCPROPERTYSET('${psetGuid}',$,'Pset_WallCommon',$,(#2));`,
    `#4=IFCRELDEFINESBYPROPERTIES('${relGuid}',$,$,$,(#1),#3);`,
  ].join('\n');
}

/** One mesh for express id 1 - the only thing `buildEntityFingerprints` reads
 *  off a mesh is its express id and its geometry hash. */
function meshes(expressId: number, geometryHash: bigint): readonly MeshData[] {
  return [{ expressId, geometryHash } as unknown as MeshData];
}

async function fingerprintWall(step: string, modelId: string, geometryHash: bigint) {
  const store = await storeFromStep(step);
  const built = await buildEntityFingerprints({
    modelId,
    store,
    meshes: meshes(1, geometryHash),
    idOffset: 0,
  });
  const wall = built.find((f) => f.ifcType === 'IfcWall');
  assert.ok(wall, `expected an IfcWall fingerprint in ${modelId}`);
  return wall;
}

describe('buildEntityFingerprints - component sub-hashes (#1891)', () => {
  it('populates components, so the content pass has its collision guard', async () => {
    // Without `components` the viewer sits in the weakest row of the collision
    // table in docs/guide/model-diff.md: only a differing ifcType can reject a
    // colliding data hash, and the pass retires a real add+delete on it.
    const wall = await fingerprintWall(
      wallWithPset('0aaaaaaaaaaaaaaaaaaaaa', '0bbbbbbbbbbbbbbbbbbbbb', '0ccccccccccccccccccccc', '60'),
      'A',
      1n,
    );
    assert.ok(wall.components, 'components must be supplied');
    assert.ok(wall.components!['attr:core'], 'attr:core sub-hash missing');
    assert.ok(wall.components!['pset:Pset_WallCommon'], 'per-pset sub-hash missing');
  });

  it('is stable across a from-scratch re-export (new GlobalIds, same content)', async () => {
    // This is the whole premise of the content pass: re-GUIDing every IfcRoot
    // must leave the data hash AND every sub-hash untouched.
    const a = await fingerprintWall(
      wallWithPset('0aaaaaaaaaaaaaaaaaaaaa', '0bbbbbbbbbbbbbbbbbbbbb', '0ccccccccccccccccccccc', '60'),
      'A',
      1n,
    );
    const b = await fingerprintWall(
      wallWithPset('1zzzzzzzzzzzzzzzzzzzzz', '1yyyyyyyyyyyyyyyyyyyyy', '1xxxxxxxxxxxxxxxxxxxxx', '60'),
      'B',
      1n,
    );
    assert.notStrictEqual(a.key, b.key, 'the fixture must actually re-GUID the wall');
    assert.strictEqual(a.dataHash, b.dataHash);
    assert.deepStrictEqual(a.components, b.components);
  });

  it('moves the differing sub-hash, and only that one, when a property changes', async () => {
    // The guard only works if a sub-hash tracks the slice it names: a pset edit
    // must move `pset:...` and leave `attr:core` alone.
    const a = await fingerprintWall(
      wallWithPset('0aaaaaaaaaaaaaaaaaaaaa', '0bbbbbbbbbbbbbbbbbbbbb', '0ccccccccccccccccccccc', '60'),
      'A',
      1n,
    );
    const b = await fingerprintWall(
      wallWithPset('0aaaaaaaaaaaaaaaaaaaaa', '0bbbbbbbbbbbbbbbbbbbbb', '0ccccccccccccccccccccc', '90'),
      'B',
      1n,
    );
    assert.notStrictEqual(a.dataHash, b.dataHash, 'a property edit must change the data hash');
    assert.strictEqual(a.components!['attr:core'], b.components!['attr:core']);
    assert.notStrictEqual(
      a.components!['pset:Pset_WallCommon'],
      b.components!['pset:Pset_WallCommon'],
    );
  });
});

describe('buildEntityFingerprints - world AABB (#1891)', () => {
  const WALL = wallWithPset(
    '0aaaaaaaaaaaaaaaaaaaaa',
    '0bbbbbbbbbbbbbbbbbbbbb',
    '0ccccccccccccccccccccc',
    '60',
  );

  const box = (x: number): EntityWorldAabb => ({ min: [x, 0, 0], max: [x + 1, 2, 3] });

  /** Build one wall's fingerprint from an explicit model description. */
  async function wallFrom(
    model: Omit<Parameters<typeof buildEntityFingerprints>[0], 'store' | 'modelId'>,
  ) {
    const store = await storeFromStep(WALL);
    const built = await buildEntityFingerprints({ modelId: 'A', store, ...model });
    const wall = built.find((f) => f.ifcType === 'IfcWall');
    assert.ok(wall, 'expected an IfcWall fingerprint');
    return wall;
  }

  it('carries the flat mesh box onto the fingerprint', async () => {
    // Without this the whole positional half of the content pass is dead: the
    // engine reports a geometry-hash difference as a bare `moved` with no
    // distance, which is what the viewer shipped before this change.
    const wall = await wallFrom({
      meshes: [{ expressId: 1, geometryHash: 1n, geometryAabb: box(5) } as unknown as MeshData],
      idOffset: 0,
    });
    assert.deepStrictEqual(wall.aabb, box(5));
  });

  it('leaves aabb undefined - never a NaN-bearing object - when the pass produced no box', async () => {
    // The engine's contract: absent means `undefined`. A `{min:[NaN,...]}` would
    // pass `aabb !== undefined` and poison every distance computed from it.
    const wall = await wallFrom({
      meshes: [{ expressId: 1, geometryHash: 1n } as unknown as MeshData],
      idOffset: 0,
    });
    assert.strictEqual(wall.aabb, undefined);
    assert.ok(!('aabb' in wall), 'the key must not be present at all');
  });

  it('falls back to the instanced-only box, so repeated components are not dark', async () => {
    // A GPU-instanced element never reaches the flat `meshes` array - and it is
    // instanced precisely BECAUSE it is one of many identical copies, i.e. the
    // exact population tier 3 pairs by position. No fallback, no tiers.
    const wall = await wallFrom({
      meshes: [],
      instancedGeometryHashes: new Map([[1, 9n]]),
      instancedGeometryAabbs: new Map([[1, box(7)]]),
      idOffset: 0,
    });
    assert.strictEqual(wall.geometryHash, 9n);
    assert.deepStrictEqual(wall.aabb, box(7));
  });

  it('prefers the flat mesh box over the instanced-only one', async () => {
    // Same precedence as the hash: a box measured on this load's real mesh wins
    // over the side-channel, so the two can never disagree about an entity.
    const wall = await wallFrom({
      meshes: [{ expressId: 1, geometryHash: 1n, geometryAabb: box(5) } as unknown as MeshData],
      instancedGeometryHashes: new Map([[1, 9n]]),
      instancedGeometryAabbs: new Map([[1, box(7)]]),
      idOffset: 0,
    });
    assert.deepStrictEqual(wall.aabb, box(5));
  });

  it('resolves a flat mesh box through the federation id offset', async () => {
    // Meshes are keyed by federation-global id, the store by local express id.
    // Getting this wrong drops every box on any non-anchor model, silently.
    const wall = await wallFrom({
      meshes: [{ expressId: 1001, geometryHash: 1n, geometryAabb: box(5) } as unknown as MeshData],
      idOffset: 1000,
    });
    assert.deepStrictEqual(wall.aabb, box(5), 'localId 1 must resolve from globalId 1001');
  });

  it('resolves an instanced-only box through the federation id offset', async () => {
    // The side-channel is keyed the same way, and it is a SEPARATE loop - so it
    // needs its own offset check or the subtraction can go missing on one side.
    const wall = await wallFrom({
      meshes: [],
      instancedGeometryHashes: new Map([[1001, 9n]]),
      instancedGeometryAabbs: new Map([[1001, box(7)]]),
      idOffset: 1000,
    });
    assert.deepStrictEqual(wall.aabb, box(7), 'localId 1 must resolve from globalId 1001');
  });
});
