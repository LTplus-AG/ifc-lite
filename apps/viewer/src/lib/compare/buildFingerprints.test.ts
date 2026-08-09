/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { diffModels } from '@ifc-lite/diff';
import type { EntityWorldAabb, MeshData } from '@ifc-lite/geometry';
import {
  buildEntityFingerprints,
  geometryVolumesSurviveAlignment,
  hasGeometryHashes,
} from './buildFingerprints.js';

/** Wrap a STEP body in a minimal envelope for the given schema (same helper
 *  shape as describeChange.test.ts). */
function ifcFile(body: string, schema = 'IFC4'): string {
  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION((''),'2;1');",
    "FILE_NAME('','',(''),(''),'','','');",
    `FILE_SCHEMA(('${schema}'));`,
    'ENDSEC;',
    'DATA;',
    body,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

async function storeFromStep(body: string, schema = 'IFC4'): Promise<IfcDataStore> {
  const bytes = new TextEncoder().encode(ifcFile(body, schema));
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

  it('hashes Tag for a type object and not for an occurrence (#2021)', async () => {
    // Type objects reach this adapter because the wasm pass meshes type
    // geometry too (#957/#994), and they are the entities with no other
    // evidence: same name, same class, no occurrence attributes. Two of them
    // differing only in Tag used to share a data hash, so the content pass
    // had nothing to separate them by and abstained. Two OCCURRENCES differing
    // only in Tag must still agree — there Tag is the authoring tool's element
    // id, and it is the content bucket key that would move.
    const store = await storeFromStep(
      [
        "#1=IFCWALLTYPE('0aaaaaaaaaaaaaaaaaaaaa',$,'800 mm',$,$,$,$,'157200','800 mm',.STANDARD.);",
        "#2=IFCWALLTYPE('0bbbbbbbbbbbbbbbbbbbbb',$,'800 mm',$,$,$,$,'157607','800 mm',.STANDARD.);",
        "#3=IFCWALL('0ccccccccccccccccccccc',$,'Wall',$,$,$,$,'tagA',.STANDARD.);",
        "#4=IFCWALL('0ddddddddddddddddddddd',$,'Wall',$,$,$,$,'tagB',.STANDARD.);",
      ].join('\n'),
    );
    const built = await buildEntityFingerprints({
      modelId: 'A',
      store,
      meshes: [1, 2, 3, 4].map((expressId) => ({ expressId, geometryHash: 7n }) as MeshData),
      idOffset: 0,
    });
    const [typeA, typeB, wallA, wallB] = [1, 2, 3, 4].map((id) =>
      built.find((f) => f.ref.localId === id),
    );
    assert.ok(typeA && typeB && wallA && wallB, 'all four entities must be fingerprinted');

    assert.notStrictEqual(typeA.dataHash, typeB.dataHash, 'type objects must differ on Tag');
    assert.notStrictEqual(typeA.components!['attr:core'], typeB.components!['attr:core']);
    assert.strictEqual(wallA.dataHash, wallB.dataHash, 'occurrence Tag must stay out of the hash');
  });

  it('finds Tag on a type object the IFC4 pin does not carry (#2021)', async () => {
    // IfcRailType is IFC4X3-only. Its inheritance chain resolves across the
    // bundled schemas, so `isTypeObjectClass` says yes — but its ATTRIBUTE names
    // do not resolve through the parser's IFC4 codegen pin, which answers an
    // empty list for it. A Tag lookup routed through the pin finds nothing and
    // silently no-ops on exactly the infrastructure classes IFC4X3 exists for,
    // while every IFC2X3 and IFC4 assertion above still passes.
    const store = await storeFromStep(
      [
        "#1=IFCRAILTYPE('0aaaaaaaaaaaaaaaaaaaaa',$,'60E1',$,$,$,$,'157200','60E1',.RACKRAIL.);",
        "#2=IFCRAILTYPE('0bbbbbbbbbbbbbbbbbbbbb',$,'60E1',$,$,$,$,'157607','60E1',.RACKRAIL.);",
      ].join('\n'),
      'IFC4X3',
    );
    const built = await buildEntityFingerprints({
      modelId: 'A',
      store,
      meshes: [1, 2].map((expressId) => ({ expressId, geometryHash: 7n }) as MeshData),
      idOffset: 0,
    });
    const [railA, railB] = [1, 2].map((id) => built.find((f) => f.ref.localId === id));
    assert.ok(railA && railB, 'both rail types must be fingerprinted');
    // Vacuous unless the class really reached the adapter under its own name.
    assert.strictEqual(railA.ifcType, 'IfcRailType');
    assert.notStrictEqual(railA.dataHash, railB.dataHash, 'IFC4X3 type objects must differ on Tag');
  });
});

describe('buildEntityFingerprints - geometry hash first-wins (#924)', () => {
  it('keeps the FIRST defined hash when two submeshes of one entity disagree', async () => {
    // The doc comment on `geometryByLocalId` promises "the first mesh carrying
    // a geometryHash wins (all submeshes of an entity share the whole-entity
    // hash)". Every other fixture in this file gives an entity at most one
    // submesh, so a fold that quietly became last-wins would pass unnoticed -
    // this pins the order.
    const store = await storeFromStep(
      wallWithPset('0aaaaaaaaaaaaaaaaaaaaa', '0bbbbbbbbbbbbbbbbbbbbb', '0ccccccccccccccccccccc', '60'),
    );
    const built = await buildEntityFingerprints({
      modelId: 'A',
      store,
      meshes: [
        { expressId: 1, geometryHash: 11n } as unknown as MeshData,
        { expressId: 1, geometryHash: 22n } as unknown as MeshData,
      ],
      idOffset: 0,
    });
    const wall = built.find((f) => f.ifcType === 'IfcWall');
    assert.ok(wall);
    assert.strictEqual(wall.geometryHash, 11n, 'the first submesh hash must win, not the last');
  });

  it('skips a leading undefined hash to take the first REAL one', async () => {
    // Also documented on `geometryByLocalId`: a submesh with no hash yet
    // (hashing disabled, or predates the WASM build) must not shadow a later
    // submesh that does carry one.
    const store = await storeFromStep(
      wallWithPset('0aaaaaaaaaaaaaaaaaaaaa', '0bbbbbbbbbbbbbbbbbbbbb', '0ccccccccccccccccccccc', '60'),
    );
    const built = await buildEntityFingerprints({
      modelId: 'A',
      store,
      meshes: [
        { expressId: 1, geometryHash: undefined } as unknown as MeshData,
        { expressId: 1, geometryHash: 33n } as unknown as MeshData,
      ],
      idOffset: 0,
    });
    const wall = built.find((f) => f.ifcType === 'IfcWall');
    assert.ok(wall);
    assert.strictEqual(wall.geometryHash, 33n, 'must fall through the undefined submesh to the real hash');
  });
});

describe('buildEntityFingerprints - synthetic key for a missing GlobalId (#924)', () => {
  it('gives two GlobalId-less entities in the SAME model distinct keys', async () => {
    // "entities without a resolvable GlobalId fall back to a per-model
    // synthetic key so they never collide across A/B" (module doc). A
    // fallback that drops the express id from that key would silently
    // collide any two such entities within one model - untested by every
    // other fixture here, which always supplies a real GlobalId.
    const store = await storeFromStep(
      [
        "#1=IFCWALL($,$,'Wall A',$,$,$,$,$,.STANDARD.);",
        "#2=IFCWALL($,$,'Wall B',$,$,$,$,$,.STANDARD.);",
      ].join('\n'),
    );
    const built = await buildEntityFingerprints({
      modelId: 'A',
      store,
      meshes: [1, 2].map((expressId) => ({ expressId, geometryHash: 7n }) as MeshData),
      idOffset: 0,
    });
    const [wallA, wallB] = [1, 2].map((id) => built.find((f) => f.ref.localId === id));
    assert.ok(wallA && wallB, 'both GlobalId-less walls must be fingerprinted');
    assert.notStrictEqual(
      wallA.key,
      wallB.key,
      'two entities missing a GlobalId in the same model must not share a synthetic key',
    );
  });
});

describe('hasGeometryHashes (#924)', () => {
  const fp = (geometryHash: bigint | undefined) => ({
    key: `k${geometryHash}`,
    ifcType: 'IfcWall',
    dataHash: 'd',
    geometryHash,
    ref: { modelId: 'm', localId: 1, globalId: 1 },
  });

  it('is true when at least one entity carries a hash, even if others do not', () => {
    // SOME, not EVERY: a partially-hashed side (mixed WASM builds, or an
    // instanced-only entity that never got folded in) still has usable
    // geometry data and must not trip the "no geometry hashes" warning.
    assert.strictEqual(hasGeometryHashes([fp(undefined), fp(1n)]), true);
  });

  it('is false when no entity on the side carries a hash', () => {
    assert.strictEqual(hasGeometryHashes([fp(undefined), fp(undefined)]), false);
  });

  it('is false for an empty side', () => {
    assert.strictEqual(hasGeometryHashes([]), false);
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

describe('buildEntityFingerprints - proved volume (#1993)', () => {
  const WALL = wallWithPset(
    '0aaaaaaaaaaaaaaaaaaaaa',
    '0bbbbbbbbbbbbbbbbbbbbb',
    '0ccccccccccccccccccccc',
    '60',
  );

  async function wallFrom(
    model: Omit<Parameters<typeof buildEntityFingerprints>[0], 'store' | 'modelId'>,
  ) {
    const store = await storeFromStep(WALL);
    const built = await buildEntityFingerprints({ modelId: 'A', store, ...model });
    const wall = built.find((f) => f.ifcType === 'IfcWall');
    assert.ok(wall, 'expected an IfcWall fingerprint');
    return wall;
  }

  it('carries the flat mesh volume onto the fingerprint', async () => {
    // Without this the split/merge detector has no confirming evidence at all
    // and can only ever reach its extent tier.
    const wall = await wallFrom({
      meshes: [{ expressId: 1, geometryHash: 1n, geometryVolume: 2.5 } as unknown as MeshData],
      idOffset: 0,
    });
    assert.strictEqual(wall.volume, 2.5);
  });

  it('does not sum the identical whole-entity volume across submeshes', async () => {
    // Every submesh of one entity carries the SAME whole-entity value, so a
    // running total would report a three-submesh wall at three times its size -
    // and the detector's 3% band would then reject every honest split of it.
    const wall = await wallFrom({
      meshes: [
        { expressId: 1, geometryHash: 1n, geometryVolume: 2.5 } as unknown as MeshData,
        { expressId: 1, geometryHash: 1n, geometryVolume: 2.5 } as unknown as MeshData,
        { expressId: 1, geometryHash: 1n, geometryVolume: 2.5 } as unknown as MeshData,
      ],
      idOffset: 0,
    });
    assert.strictEqual(wall.volume, 2.5);
  });

  it('leaves volume absent when the kernel proved none', async () => {
    // Absent means NOT PROVED. A zero would read as a proved empty solid and
    // refute every claim the entity could take part in.
    const wall = await wallFrom({
      meshes: [{ expressId: 1, geometryHash: 1n, geometryAabb: { min: [0, 0, 0], max: [1, 1, 1] } } as unknown as MeshData],
      idOffset: 0,
    });
    assert.strictEqual(wall.volume, undefined);
    assert.ok(!('volume' in wall), 'the key must not be present at all');
  });

  it('falls back to the instanced-only volume through the federation id offset', async () => {
    // A precast slab field is exactly the repeated geometry instancing removes
    // from `meshes`, and exactly the population a split claim is made of. The
    // offset is checked here because this is a separate loop from the boxes'.
    const wall = await wallFrom({
      meshes: [],
      instancedGeometryHashes: new Map([[1001, 9n]]),
      instancedGeometryVolumes: new Map([[1001, 4]]),
      idOffset: 1000,
    });
    assert.strictEqual(wall.volume, 4, 'localId 1 must resolve from globalId 1001');
  });

  it('prefers the flat mesh volume over the instanced-only one', async () => {
    const wall = await wallFrom({
      meshes: [{ expressId: 1, geometryHash: 1n, geometryVolume: 2.5 } as unknown as MeshData],
      instancedGeometryHashes: new Map([[1, 9n]]),
      instancedGeometryVolumes: new Map([[1, 99]]),
      idOffset: 0,
    });
    assert.strictEqual(wall.volume, 2.5);
  });

  it('withholds volumes when the model was re-baked by federation alignment', async () => {
    // The alignment carries a scale, and nothing on this side can re-measure a
    // proved volume the way `federationAlignAabb.ts` re-measures the box. The
    // box and the hash must survive; only the volume is withheld.
    const wall = await wallFrom({
      meshes: [
        {
          expressId: 1,
          geometryHash: 1n,
          geometryVolume: 2.5,
          geometryAabb: { min: [0, 0, 0], max: [1, 1, 1] },
        } as unknown as MeshData,
      ],
      instancedGeometryVolumes: new Map([[1, 99]]),
      geometryVolumesTrusted: false,
      idOffset: 0,
    });
    assert.strictEqual(wall.volume, undefined, 'a re-baked volume must not be believed');
    assert.strictEqual(wall.geometryHash, 1n);
    assert.deepStrictEqual(wall.aabb, { min: [0, 0, 0], max: [1, 1, 1] });
  });
});

describe('geometryVolumesSurviveAlignment (#1993)', () => {
  it('withholds exactly the two statuses that re-bake vertices', () => {
    // 'same-crs' applies an affine that carries IfcMapConversion.Scale;
    // 'reprojected' pushes every vertex through proj4. Both change the size of
    // the geometry the volume was measured on.
    assert.strictEqual(geometryVolumesSurviveAlignment('same-crs'), false);
    assert.strictEqual(geometryVolumesSurviveAlignment('reprojected'), false);
  });

  it('trusts every status that left the vertices alone', () => {
    // 'identity' computed a transform and found nothing to apply; 'failed' gave
    // up before applying one; the rest never had one. Withholding on those
    // would cost the detector its only confirming evidence for no reason.
    for (const status of ['anchor', 'identity', 'failed', 'none', undefined] as const) {
      assert.strictEqual(geometryVolumesSurviveAlignment(status), true, `status ${status}`);
    }
  });
});

describe('buildEntityFingerprints - geometry-less products', () => {
  /**
   * A model shaped like the field report that exposed this: a site holding a
   * geometry-less `IfcElementAssembly` (Representation `$`) whose only mesh
   * lives on the `IfcMember` it aggregates, plus a geometry-less
   * `IfcBuildingElementProxy` marking a survey origin. `IfcCartesianPoint`,
   * `IfcRelAggregates` and `IfcPropertySet` are present so the widened
   * enumeration can be shown NOT to take them in.
   *
   * `assemblyName` is the assembly's only piece of comparable content;
   * `withOrigin` drops the proxy to model a deletion.
   */
  function infraModel(assemblyName: string, withOrigin = true): string {
    return [
      "#1=IFCPROJECT('0projectprojectproject',$,'Project',$,$,$,$,$,$);",
      "#2=IFCSITE('0siteesiteesiteesiteee',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);",
      `#3=IFCELEMENTASSEMBLY('0assemblyassemblyassy',$,'${assemblyName}',$,$,#40,$,$,.NOTDEFINED.,.USERDEFINED.);`,
      "#4=IFCMEMBER('0memberrmemberrmemberr',$,'Member',$,$,#40,#50,$,.NOTDEFINED.);",
      "#5=IFCRELAGGREGATES('0relaggrelaggrelaggre',$,$,$,#3,(#4));",
      "#6=IFCPROPERTYSINGLEVALUE('Status',$,IFCLABEL('New'),$);",
      "#7=IFCPROPERTYSET('0psetpsetpsetpsetpset',$,'Pset_Common',$,(#6));",
      "#8=IFCRELDEFINESBYPROPERTIES('0reldefreldefreldefr',$,$,$,(#3),#7);",
      withOrigin
        ? "#9=IFCBUILDINGELEMENTPROXY('0originoriginoriginn',$,'origin',$,$,#40,$,$,.NOTDEFINED.);"
        : '',
      '#40=IFCLOCALPLACEMENT($,#41);',
      '#41=IFCAXIS2PLACEMENT3D(#42,$,$);',
      '#42=IFCCARTESIANPOINT((0.,0.,0.));',
      '#50=IFCPRODUCTDEFINITIONSHAPE($,$,(#51));',
      "#51=IFCSHAPEREPRESENTATION($,'Body','SweptSolid',(#42));",
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** Fingerprint one side. Only the `IfcMember` produced a mesh — exactly the
   *  situation the mesh-driven enumeration could not see past. */
  async function side(step: string, modelId: string) {
    const store = await storeFromStep(step);
    return buildEntityFingerprints({
      modelId,
      store,
      meshes: meshes(4, 1n),
      idOffset: 0,
    });
  }

  const byKey = (built: Awaited<ReturnType<typeof side>>, key: string) =>
    built.find((f) => f.key === key);

  it('fingerprints a geometry-less assembly, so an attribute edit reads as modified', async () => {
    // SHAPE ONE of the defect. The assembly carries Representation `$` and its
    // geometry lives on the aggregated member, so a mesh-driven enumeration
    // never reaches it: rename it, re-status it, and the compare panel reports
    // nothing at all. Not a wrong row — no row.
    const a = await side(infraModel('Abutment A'), 'A');
    const b = await side(infraModel('Abutment B'), 'B');
    const assemblyA = byKey(a, '0assemblyassemblyassy');
    const assemblyB = byKey(b, '0assemblyassemblyassy');
    assert.ok(assemblyA, 'the geometry-less assembly must be fingerprinted in A');
    assert.ok(assemblyB, 'the geometry-less assembly must be fingerprinted in B');
    assert.strictEqual(assemblyA.ifcType, 'IfcElementAssembly');
    assert.strictEqual(assemblyA.geometryHash, undefined, 'it has no geometry of its own');

    const diff = diffModels(a, b, { scope: 'both' });
    const entry = diff.byKey.get('0assemblyassemblyassy');
    assert.ok(entry, 'the assembly must appear in the diff');
    assert.strictEqual(entry.state, 'modified');
    // Data only: neither side has a geometry hash, so `geometryEqual` must read
    // the pair as equal rather than reporting a phantom reshape.
    assert.deepStrictEqual(entry.changeKinds, ['data']);
  });

  it('reports a geometry-less object that disappears as deleted', async () => {
    // SHAPE TWO. The 'origin' proxy is a pure survey marker with Representation
    // `$`. Deleting one is a real, reportable change, and the mesh-driven
    // enumeration could not report it because the object was never in either
    // side to begin with.
    const a = await side(infraModel('Abutment A', true), 'A');
    const b = await side(infraModel('Abutment A', false), 'B');
    assert.ok(byKey(a, '0originoriginoriginn'), 'the proxy must be fingerprinted in A');
    assert.strictEqual(byKey(b, '0originoriginoriginn'), undefined, 'B must not carry it');

    const diff = diffModels(a, b, { scope: 'both' });
    const entry = diff.byKey.get('0originoriginoriginn');
    assert.ok(entry, 'the deleted proxy must appear in the diff');
    assert.strictEqual(entry.state, 'deleted');
    assert.strictEqual(entry.base?.ifcType, 'IfcBuildingElementProxy');
  });

  it('takes in the spatial structure too, not just elements', async () => {
    // An IfcSite was among the objects the field report lost. Spatial elements
    // are IfcProducts, so the one rule covers them; a rule written as "physical
    // elements" would not.
    const a = await side(infraModel('Abutment A'), 'A');
    const site = byKey(a, '0siteesiteesiteesiteee');
    assert.ok(site, 'the geometry-less site must be fingerprinted');
    assert.strictEqual(site.ifcType, 'IfcSite');
  });

  it('stops at IfcProduct: no resource, relationship, pset or IfcProject gets in', async () => {
    // The bounding control in the other direction. Deleting the geometry filter
    // outright would list every IfcCartesianPoint and every IfcRelAggregates —
    // a compare nobody can read. These are the families the rule excludes by
    // inheritance: representation items, relationships, property definitions.
    // IfcProject is excluded as well: rooted and comparable, but not an
    // element, and the report it belongs in is not this one.
    //
    // This pins the LINE, not the volume. Everything on the product side of it
    // does get in — including the geometry-less ports and storeys the module
    // note calls out — and that is the intended rule, not an oversight.
    const a = await side(infraModel('Abutment A'), 'A');
    const types = new Set(a.map((f) => f.ifcType));
    for (const excluded of [
      'IfcCartesianPoint',
      'IfcAxis2Placement3D',
      'IfcLocalPlacement',
      'IfcRelAggregates',
      'IfcRelDefinesByProperties',
      'IfcPropertySet',
      'IfcPropertySingleValue',
      'IfcProductDefinitionShape',
      'IfcShapeRepresentation',
      'IfcProject',
    ]) {
      assert.ok(!types.has(excluded), `${excluded} must stay out of the comparison`);
    }
    // Exactly the four products, and nothing else.
    assert.deepStrictEqual(
      a.map((f) => f.key).sort(),
      [
        '0assemblyassemblyassy',
        '0memberrmemberrmemberr',
        '0originoriginoriginn',
        '0siteesiteesiteesiteee',
      ].sort(),
    );
  });

  it('leaves a meshed element exactly as it was, hash and all', async () => {
    // Bounding control the other way round: the rows that were already correct
    // must not change. The member is the one meshed entity here, and it must
    // still carry its geometry hash — a fold that overwrote existing entries
    // instead of gap-filling would blank it and turn every correct geometry row
    // into a silent no-change.
    const a = await side(infraModel('Abutment A'), 'A');
    const member = byKey(a, '0memberrmemberrmemberr');
    assert.ok(member);
    assert.strictEqual(member.geometryHash, 1n, 'the meshed element keeps its hash');
    assert.strictEqual(hasGeometryHashes(a), true);
  });

  it('marks which fingerprints the renderer can actually draw', async () => {
    // `ref.meshed` is what stops the overlay hiding an element's only drawable
    // copy (see overlay.ts). It is NOT derivable from `geometryHash`, which is
    // also undefined for a meshed entity on a build with hashing off — so it
    // has to be recorded here, and something has to assert that it is.
    const a = await side(infraModel('Abutment A'), 'A');
    assert.strictEqual(byKey(a, '0memberrmemberrmemberr')!.ref.meshed, true);
    for (const key of [
      '0assemblyassemblyassy',
      '0siteesiteesiteesiteee',
      '0originoriginoriginn',
    ]) {
      assert.strictEqual(byKey(a, key)!.ref.meshed, false, `${key} has nothing to draw`);
    }
  });

  it('skips a product with no GlobalId rather than keying it synthetically', async () => {
    // A synthetic key is per-model, so it can never match across A and B:
    // admitting one would manufacture an add on one side and a delete on the
    // other for an entity nobody touched. The meshed population accepts that
    // trade; the widening must not.
    const store = await storeFromStep(
      "#1=IFCBUILDINGELEMENTPROXY($,$,'nameless',$,$,$,$,$,.NOTDEFINED.);",
    );
    const built = await buildEntityFingerprints({ modelId: 'A', store, meshes: [], idOffset: 0 });
    assert.deepStrictEqual(built, [], 'a GlobalId-less geometry-less product must not be compared');
  });
});
