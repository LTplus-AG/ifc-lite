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
    assert.strictEqual(
      worldPlacementFingerprint(a, siteId(a)),
      worldPlacementFingerprint(b, siteId(b)),
    );
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
