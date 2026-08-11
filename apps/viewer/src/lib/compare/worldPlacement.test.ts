/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { composeWorldPlacement, worldPlacementFingerprint } from './worldPlacement.js';

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
  return parser.parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** Express id of the single IfcSite in a parsed fixture. */
function siteId(store: IfcDataStore): number {
  const ids = store.entityIndex.byType.get('IFCSITE') ?? [];
  assert.strictEqual(ids.length, 1, 'fixture must carry exactly one IfcSite');
  return ids[0]!;
}

/**
 * A site under a two-link placement chain.
 *
 * `parent` is the grandparent placement's translation, `child` the site's own.
 * The world position is their sum, so two fixtures that split the SAME total
 * differently are the re-georeferencing control: the expression differs, the
 * composed transform does not.
 */
function siteUnderChain(
  parent: readonly [number, number, number],
  child: readonly [number, number, number],
  opts: { parentRefDirection?: readonly [number, number, number]; childRefDirection?: readonly [number, number, number] } = {},
): string {
  const dir = (v: readonly [number, number, number] | undefined, id: number) =>
    v ? `#${id}=IFCDIRECTION((${v[0]},${v[1]},${v[2]}));` : '';
  const parentRef = opts.parentRefDirection ? `#31` : '$';
  const childRef = opts.childRefDirection ? `#32` : '$';
  return [
    `#10=IFCCARTESIANPOINT((${parent[0]},${parent[1]},${parent[2]}));`,
    `#11=IFCCARTESIANPOINT((${child[0]},${child[1]},${child[2]}));`,
    dir(opts.parentRefDirection, 31),
    dir(opts.childRefDirection, 32),
    `#20=IFCAXIS2PLACEMENT3D(#10,$,${parentRef});`,
    `#21=IFCAXIS2PLACEMENT3D(#11,$,${childRef});`,
    `#22=IFCLOCALPLACEMENT($,#20);`,
    `#23=IFCLOCALPLACEMENT(#22,#21);`,
    `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'environment - site',$,$,#23,$,$,.ELEMENT.,$,$,$,$,$);`,
  ]
    .filter(Boolean)
    .join('\n');
}

describe('composeWorldPlacement - walking the whole ObjectPlacement chain', () => {
  it('sums a two-link chain into one world translation', async () => {
    const store = await storeFromStep(siteUnderChain([0, 40000, 0], [0, 0, 0]));
    const world = composeWorldPlacement(store, siteId(store));
    assert.ok(world, 'a site with an IfcLocalPlacement must compose');
    // Row-major 4x4: translation is the last column.
    assert.deepStrictEqual([world[3], world[7], world[11]], [0, 40000, 0]);
  });

  it('returns undefined for a product with no ObjectPlacement', async () => {
    const store = await storeFromStep(
      `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'environment - site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    );
    assert.strictEqual(composeWorldPlacement(store, siteId(store)), undefined);
  });

  it('folds a RefDirection rotation into the composed basis', async () => {
    // 90 degrees about Z: the local +X axis ends up along world +Y.
    const store = await storeFromStep(
      siteUnderChain([0, 0, 0], [0, 0, 0], { childRefDirection: [0, 1, 0] }),
    );
    const world = composeWorldPlacement(store, siteId(store));
    assert.ok(world);
    assert.ok(Math.abs(world[0] - 0) < 1e-9, `x-axis x component: ${world[0]}`);
    assert.ok(Math.abs(world[4] - 1) < 1e-9, `x-axis y component: ${world[4]}`);
  });
});

describe('worldPlacementFingerprint - the re-georeferencing control', () => {
  // THE mandatory control (brief, Gap 2). Re-georeferencing rewrites the
  // placement *expression* of objects that did not move a millimetre; in the
  // measured file that is three IfcSites. A fingerprint that moves for them
  // cries wolf on every corrected model, which is strictly worse than the
  // silence it replaces.
  it('is IDENTICAL when the chain is rewritten but the world transform is not', async () => {
    // 40000 contributed entirely by the parent, versus entirely by the child.
    const a = await storeFromStep(siteUnderChain([0, 40000, 0], [0, 0, 0]));
    const b = await storeFromStep(siteUnderChain([0, 0, 0], [0, 40000, 0]));
    const fa = worldPlacementFingerprint(a, siteId(a));
    const fb = worldPlacementFingerprint(b, siteId(b));
    assert.ok(fa, 'fixture A must produce a fingerprint');
    assert.strictEqual(fa, fb);
  });

  it('is identical when only the expressed split of a rotation moves', async () => {
    // Same total yaw (90 degrees), expressed on the parent in one revision and
    // on the child in the other.
    const a = await storeFromStep(
      siteUnderChain([0, 0, 0], [0, 0, 0], { parentRefDirection: [0, 1, 0] }),
    );
    const b = await storeFromStep(
      siteUnderChain([0, 0, 0], [0, 0, 0], { childRefDirection: [0, 1, 0] }),
    );
    const fa = worldPlacementFingerprint(a, siteId(a));
    assert.ok(fa, 'fixture A must produce a fingerprint, not abstain on both sides');
    assert.strictEqual(fa, worldPlacementFingerprint(b, siteId(b)));
  });

  it('DIFFERS when the composed world translation actually moves', async () => {
    // The measured case: IfcSite 23sFQGRy90RxVbRHD9iSE2, (0,40000,0) -> (0,0,0).
    const a = await storeFromStep(siteUnderChain([0, 40000, 0], [0, 0, 0]));
    const b = await storeFromStep(siteUnderChain([0, 0, 0], [0, 0, 0]));
    assert.notStrictEqual(
      worldPlacementFingerprint(a, siteId(a)),
      worldPlacementFingerprint(b, siteId(b)),
    );
  });

  it('DIFFERS when the composed world rotation actually turns', async () => {
    const a = await storeFromStep(
      siteUnderChain([0, 0, 0], [0, 0, 0], { childRefDirection: [0, 1, 0] }),
    );
    const b = await storeFromStep(siteUnderChain([0, 0, 0], [0, 0, 0]));
    assert.notStrictEqual(
      worldPlacementFingerprint(a, siteId(a)),
      worldPlacementFingerprint(b, siteId(b)),
    );
  });

  it('absorbs sub-tolerance float jitter rather than reporting a move', async () => {
    const a = await storeFromStep(siteUnderChain([0, 40000, 0], [0, 0, 0]));
    const b = await storeFromStep(siteUnderChain([0, 40000.0000000001, 0], [0, 0, 0]));
    assert.strictEqual(
      worldPlacementFingerprint(a, siteId(a)),
      worldPlacementFingerprint(b, siteId(b)),
    );
  });

  it('returns undefined for a product with no ObjectPlacement, so it stays out of the geometry channel', async () => {
    const store = await storeFromStep(
      `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'environment - site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`,
    );
    assert.strictEqual(worldPlacementFingerprint(store, siteId(store)), undefined);
  });

  it('abstains for an IfcLinearPlacement instead of composing a wrong transform', async () => {
    // IFC4x3 infrastructure models position elements along an alignment via
    // IfcLinearPlacement. Its location is an IfcPointByDistanceExpression,
    // which this walk cannot evaluate — and evaluating it as the ORIGIN would
    // make an element moved along its alignment read as stationary, the exact
    // class of miss this module exists to close. Abstain.
    const store = await storeFromStep(
      [
        `#10=IFCCARTESIANPOINT((0.,0.,0.));`,
        `#20=IFCAXIS2PLACEMENT3D(#10,$,$);`,
        `#22=IFCLINEARPLACEMENT($,#20,$);`,
        `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'s',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);`,
      ].join('\n'),
      'IFC4X3',
    );
    assert.strictEqual(worldPlacementFingerprint(store, siteId(store)), undefined);
  });

  it('abstains when a Location reference dangles instead of composing the origin', async () => {
    // A dangling (or `$`) Location is a malformed mandatory attribute. Reading
    // it as (0,0,0) FABRICATES a move the moment the other revision's location
    // is real — abstention is the only answer that cannot.
    const store = await storeFromStep(
      [
        `#20=IFCAXIS2PLACEMENT3D(#999,$,$);`,
        `#22=IFCLOCALPLACEMENT($,#20);`,
        `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'s',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);`,
      ].join('\n'),
    );
    assert.strictEqual(worldPlacementFingerprint(store, siteId(store)), undefined);
  });

  it('does not recurse forever on a self-referential placement chain', async () => {
    // A malformed file must answer, not hang. #22 is its own PlacementRelTo.
    const store = await storeFromStep(
      [
        `#10=IFCCARTESIANPOINT((0.,0.,0.));`,
        `#20=IFCAXIS2PLACEMENT3D(#10,$,$);`,
        `#22=IFCLOCALPLACEMENT(#22,#20);`,
        `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'s',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);`,
      ].join('\n'),
    );
    assert.strictEqual(worldPlacementFingerprint(store, siteId(store)), undefined);
  });
});

describe('worldPlacementFingerprint - IfcAxis2Placement2D RelativePlacement (review find)', () => {
  // `IfcLocalPlacement.RelativePlacement` is the `IfcAxis2Placement` SELECT,
  // which legally admits `IfcAxis2Placement2D` — [Location, RefDirection], only
  // TWO attributes. Reading it positionally as [Location, Axis, RefDirection]
  // takes the 2D RefDirection for the local +Z and bakes a sideways basis into
  // the fingerprint: a revision that migrates the same placement to the 3D form
  // (or adds an explicit Axis) then reports a phantom geometry change on a
  // product that never moved.
  const site2D = (refDirection: string) =>
    [
      `#10=IFCCARTESIANPOINT((0.,0.));`,
      refDirection,
      `#20=IFCAXIS2PLACEMENT2D(#10,${refDirection ? '#31' : '$'});`,
      `#22=IFCLOCALPLACEMENT($,#20);`,
      `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'s',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);`,
    ]
      .filter(Boolean)
      .join('\n');

  it('reads a 2D placement per EXPRESS: RefDirection turns about global Z, never becomes the Z axis', async () => {
    // The same 90-degree yaw spelled 2D and 3D must fingerprint identically:
    // the 2D form's plane normal IS global +Z, so its RefDirection is exactly
    // the 3D form's RefDirection under the default Axis.
    const twoD = await storeFromStep(site2D(`#31=IFCDIRECTION((0.,1.));`));
    const threeD = await storeFromStep(
      siteUnderChain([0, 0, 0], [0, 0, 0], { childRefDirection: [0, 1, 0] }),
    );
    const f2 = worldPlacementFingerprint(twoD, siteId(twoD));
    assert.ok(f2, 'a 2D relative placement must compose, not abstain');
    assert.strictEqual(f2, worldPlacementFingerprint(threeD, siteId(threeD)));
  });

  it('defaults an omitted 2D RefDirection to the identity frame', async () => {
    const twoD = await storeFromStep(site2D(''));
    const threeD = await storeFromStep(siteUnderChain([0, 0, 0], [0, 0, 0]));
    const f2 = worldPlacementFingerprint(twoD, siteId(twoD));
    assert.ok(f2, 'a 2D placement without RefDirection must compose');
    assert.strictEqual(f2, worldPlacementFingerprint(threeD, siteId(threeD)));
  });

  it('abstains for a RelativePlacement that is neither axis-placement form', async () => {
    // The whitelist one level down: anything that is not positively an
    // IfcAxis2Placement3D/2D — here a bare IfcCartesianPoint — must abstain
    // rather than be read positionally into a wrong-but-plausible frame.
    const store = await storeFromStep(
      [
        `#10=IFCCARTESIANPOINT((0.,0.,0.));`,
        `#22=IFCLOCALPLACEMENT($,#10);`,
        `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'s',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);`,
      ].join('\n'),
    );
    assert.strictEqual(worldPlacementFingerprint(store, siteId(store)), undefined);
  });
});

describe('worldPlacementFingerprint - EXPRESS IfcFirstProjAxis default (review find)', () => {
  // With RefDirection omitted, the standard projects global X onto the plane
  // normal to Axis — for EVERY Axis that is not exactly parallel to X. An
  // approximation that switches seeds early (e.g. at |z_x| >= 0.9) computes a
  // different local X than a writer that spells the default explicitly, so the
  // fingerprint flips the moment one revision writes `$` and the other writes
  // the equivalent explicit RefDirection.
  const siteWithAxis = (axis: string, refDirection: string) =>
    [
      `#10=IFCCARTESIANPOINT((0.,0.,0.));`,
      `#30=IFCDIRECTION((${axis}));`,
      refDirection ? `#31=IFCDIRECTION((${refDirection}));` : '',
      `#20=IFCAXIS2PLACEMENT3D(#10,#30,${refDirection ? '#31' : '$'});`,
      `#22=IFCLOCALPLACEMENT($,#20);`,
      `#40=IFCSITE('23sFQGRy90RxVbRHD9iSE2',$,'s',$,$,#22,$,$,.ELEMENT.,$,$,$,$,$);`,
    ]
      .filter(Boolean)
      .join('\n');

  it('projects global X for an Axis merely NEAR X, matching the explicit spelling', async () => {
    // Axis (0.95, 0.31, 0): not parallel to X, so EXPRESS projects [1,0,0].
    const implicit = await storeFromStep(siteWithAxis('0.95,0.31,0.', ''));
    const explicit = await storeFromStep(siteWithAxis('0.95,0.31,0.', '1.,0.,0.'));
    const fi = worldPlacementFingerprint(implicit, siteId(implicit));
    assert.ok(fi, 'the implicit-RefDirection fixture must compose');
    assert.strictEqual(fi, worldPlacementFingerprint(explicit, siteId(explicit)));
  });

  it('falls back to global Y only when the Axis IS global X', async () => {
    // Axis exactly [1,0,0]: projecting X yields nothing, the derivation takes Y.
    const implicit = await storeFromStep(siteWithAxis('1.,0.,0.', ''));
    const explicit = await storeFromStep(siteWithAxis('1.,0.,0.', '0.,1.,0.'));
    const fi = worldPlacementFingerprint(implicit, siteId(implicit));
    assert.ok(fi, 'an X-parallel Axis must still compose via the Y fallback');
    assert.strictEqual(fi, worldPlacementFingerprint(explicit, siteId(explicit)));
  });
});

describe('worldPlacementFingerprint - georeferenced-magnitude translations (review find)', () => {
  it('treats sub-ulp spellings of the same georeferenced easting as identical', async () => {
    // A millimetre-unit file georeferenced to a national grid puts ~1e9 in a
    // coordinate, where one double ulp is ~1.2e-7 — half an absolute 1e-6 grid
    // cell. These two literals are the same position up to write-out rounding
    // (2e-7 apart at 1e9, i.e. 2e-16 relative), yet they snap to different
    // 1e-6 buckets. The translation grid must scale with the magnitude.
    const a = await storeFromStep(siteUnderChain([1000000000.0000004, 0, 0], [0, 0, 0]));
    const b = await storeFromStep(siteUnderChain([1000000000.0000006, 0, 0], [0, 0, 0]));
    const fa = worldPlacementFingerprint(a, siteId(a));
    assert.ok(fa, 'a georeferenced placement must compose');
    assert.strictEqual(fa, worldPlacementFingerprint(b, siteId(b)));
  });

  it('still reports a real move at georeferenced magnitude', async () => {
    // The relative widening must stay far below a real edit: 5 units at 1e9
    // (5 mm on a 1000 km easting) remains plainly different.
    const a = await storeFromStep(siteUnderChain([1000000000, 0, 0], [0, 0, 0]));
    const b = await storeFromStep(siteUnderChain([1000000005, 0, 0], [0, 0, 0]));
    assert.notStrictEqual(
      worldPlacementFingerprint(a, siteId(a)),
      worldPlacementFingerprint(b, siteId(b)),
    );
  });
});
