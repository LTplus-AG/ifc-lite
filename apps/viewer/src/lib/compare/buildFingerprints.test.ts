/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import type { MeshData } from '@ifc-lite/geometry';
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
