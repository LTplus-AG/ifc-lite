/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The last two `in-store` files carrying the dead `store.source` truthiness
 * check (#2345). `resolve-anchor.ts` was corrected in #2392; these two are its
 * siblings — `extract-walls.ts` is even named in `resolve-anchor.ts`'s own
 * comment as the file it mirrors, and it is the copy that was left behind.
 *
 * `IfcDataStore.source` is a MANDATORY accessor (#2183): the no-source state is
 * `EMPTY_SOURCE_BYTES`, an object, never null/undefined. So `if (store.source)`
 * is always true and `if (!store.source)` is always false, and the early
 * returns beneath them could not fire.
 *
 * Neither of these is the silent-wrong-output failure the USD exporter had —
 * both still fail closed, by producing nothing. What the dead guards cost is
 * DIAGNOSTIC, and that is what these tests assert on, because it is the only
 * thing that actually differs:
 *
 *   - `extractWallSegmentsForStorey` ran `extractLengthUnitScale` over the
 *     empty source, which cannot resolve IFCPROJECT and so emitted the
 *     "#2104 unconfirmed unit" console warning — telling the user their model
 *     may be mis-scaled, on a model that has no source to scale from.
 *   - `resolveDuplicateSource` threw `could not parse #N`, blaming the entity,
 *     instead of `data store has no source bytes`, which names the real cause.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_SOURCE_BYTES, IfcParser, type IfcAttributeValue, type IfcDataStore } from '@ifc-lite/parser';
import { extractWallSegmentsForStorey, type OverlayWallReader } from './extract-walls.js';
import { resolveDuplicateSource } from './resolve-source.js';

const STOREY_MODEL = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION((''),'2;1');
FILE_NAME('t.ifc','',(''),(''),'','','');
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('0proj00000000000000000',$,'P',$,$,$,$,(#7),#9);
#5=IFCCARTESIANPOINT((0.,0.,0.));
#6=IFCAXIS2PLACEMENT3D(#5,$,$);
#7=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#6,$);
#9=IFCUNITASSIGNMENT((#91));
#91=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#20=IFCLOCALPLACEMENT($,#6);
#30=IFCBUILDINGSTOREY('0storey000000000000000',$,'Level 0',$,$,#20,$,$,.ELEMENT.,0.);
ENDSEC;
END-ISO-10303-21;`;

const STOREY_ID = 30;

async function parsedStore(): Promise<IfcDataStore> {
  return new IfcParser().parseColumnar(
    new TextEncoder().encode(STOREY_MODEL).buffer as ArrayBuffer,
    { disableWorkerScan: true },
  );
}

/**
 * A real `entityIndex` with the source swapped out — the shape a server-parsed
 * or point-cloud model carries (`serverDataModel.ts` assigns exactly this
 * constant). Keeping the index real is what makes the test meaningful: the
 * dead guards got PAST it precisely because the index still resolves ids.
 */
async function sourcelessStore(): Promise<IfcDataStore> {
  return { ...(await parsedStore()), source: EMPTY_SOURCE_BYTES };
}

describe('extractWallSegmentsForStorey on a source-less store (#2345)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not emit a unit warning for a model that has no source to read units from', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await sourcelessStore();

    const result = extractWallSegmentsForStorey(store, STOREY_ID, undefined, {});

    // RED (pre-fix): `if (store.source)` was always true, so
    // `extractLengthUnitScale` ran over the empty source, failed to read
    // IFCPROJECT and warned '[UnitExtractor] ... defaulting to meters'.
    const unitWarnings = warn.mock.calls.filter((c) => String(c[0]).includes('[UnitExtractor]'));
    expect(unitWarnings).toEqual([]);

    // …and the documented "extraction cannot run" early return is reached, so
    // the metre default still comes back rather than a guessed scale.
    expect(result.lengthUnitScale).toBe(1.0);
    expect(result.segments).toEqual([]);
    expect(result.considered).toBe(0);
  });

  // BOUNDING CONTROL — passes before and after. A "fix" that simply stopped
  // reading units at all, or that routed every store down the early return,
  // would look identical to the real one without this.
  it('still reads the real unit scale from a store that HAS source bytes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = await parsedStore();

    const result = extractWallSegmentsForStorey(store, STOREY_ID, undefined, {});

    // The fixture declares MILLI.METRE, so the scale must be resolved (0.001),
    // not defaulted — proving the units path is still live for real stores.
    expect(result.lengthUnitScale).toBeCloseTo(0.001, 10);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[UnitExtractor]'))).toEqual([]);
  });
});

/**
 * A minimal overlay reader carrying ONE wall authored entirely in the overlay
 * (`editor.addEntity('IfcWall', …)`), with its placement chain and `Axis`
 * representation — the shape `addWallToStore` emits. Every id is above the
 * fixture's own ids so none of them resolve through `entityIndex.byId`, which
 * is exactly what makes `readEntity` take its documented overlay fallback.
 */
function overlayWithOneWall(): OverlayWallReader {
  const entities = [
    { expressId: 1000, type: 'IfcWall', attributes: [
      'guid-overlay-wall', null, 'Overlay Wall', null, null, 1001, 1002, null, null,
    ] as IfcAttributeValue[] },
    { expressId: 1001, type: 'IfcLocalPlacement', attributes: [null, 1003] as IfcAttributeValue[] },
    { expressId: 1003, type: 'IfcAxis2Placement3D', attributes: [1004, null, null] as IfcAttributeValue[] },
    { expressId: 1004, type: 'IfcCartesianPoint', attributes: [[0, 0, 0]] as IfcAttributeValue[] },
    { expressId: 1002, type: 'IfcProductDefinitionShape', attributes: [null, null, [1005]] as IfcAttributeValue[] },
    { expressId: 1005, type: 'IfcShapeRepresentation', attributes: [null, 'Axis', 'Curve2D', [1006]] as IfcAttributeValue[] },
    { expressId: 1006, type: 'IfcPolyline', attributes: [[1007, 1008]] as IfcAttributeValue[] },
    { expressId: 1007, type: 'IfcCartesianPoint', attributes: [[0, 0, 0]] as IfcAttributeValue[] },
    { expressId: 1008, type: 'IfcCartesianPoint', attributes: [[4, 0, 0]] as IfcAttributeValue[] },
  ];
  return { getNewEntities: () => entities };
}

/**
 * Regression for the review finding on #2485: the source-bytes guard must
 * suppress only what DEPENDS on source bytes (the unit-scale read and its
 * warning, and the source-backed storey scan) — never the overlay pass.
 *
 * A source-less store with an overlay is the live Auto Spaces case: the model
 * came from the server / a point cloud (`EMPTY_SOURCE_BYTES`) and every wall
 * the user drew lives in the mutation overlay. Returning early before the
 * overlay loop makes `generateSpacesFromWalls` report zero regions for walls
 * that are right there.
 */
describe('extractWallSegmentsForStorey: overlay walls on a source-less store', () => {
  it('still extracts an overlay-created wall when the store has no source bytes', async () => {
    const store = await sourcelessStore();

    const result = extractWallSegmentsForStorey(store, STOREY_ID, overlayWithOneWall(), {});

    // RED (before the fix): the source-bytes early return fired ahead of the
    // overlay loop, so considered=0 and no segment came back at all.
    expect(result.considered).toBe(1);
    expect(result.contributingWallIds).toEqual([1000]);
    expect(result.segments).toHaveLength(1);
    // Overlay walls are authored in metres and must NOT be re-scaled.
    expect(result.segments[0]).toEqual({ a: [0, 0], b: [4, 0] });
    expect(result.skipped).toEqual([]);
  });

  // BOUNDING CONTROL — passes before and after. Pins that the overlay pass was
  // never source-dependent in the first place, so "it works with source bytes"
  // cannot be mistaken for the fix.
  it('extracts the same overlay wall from a store that HAS source bytes', async () => {
    const store = await parsedStore();

    const result = extractWallSegmentsForStorey(store, STOREY_ID, overlayWithOneWall(), {});

    expect(result.contributingWallIds).toEqual([1000]);
    expect(result.segments).toEqual([{ a: [0, 0], b: [4, 0] }]);
  });
});

describe('resolveDuplicateSource on a source-less store (#2345)', () => {
  it('names the missing source rather than blaming the entity', async () => {
    const store = await sourcelessStore();

    // The id IS in the entity index — that is why the dead guard sailed past
    // it and the failure surfaced one step later, as a parse failure.
    expect(store.entityIndex.byId.get(STOREY_ID)).toBeDefined();

    // RED (pre-fix): 'resolveDuplicateSource: could not parse #30'.
    expect(() => resolveDuplicateSource(store, STOREY_ID)).toThrow(
      'resolveDuplicateSource: data store has no source bytes',
    );
  });

  // BOUNDING CONTROL — a store WITH bytes must still get past the guard and
  // resolve real attributes, not be swept into the new early throw.
  it('still resolves attributes from a store that HAS source bytes', async () => {
    const store = await parsedStore();
    const resolved = resolveDuplicateSource(store, STOREY_ID);
    // Real attributes read back out of the source buffer — the guard let it
    // through and the extractor found the entity.
    expect(resolved.attributes[0]).toBe('0storey000000000000000');
    expect(resolved.placementExpressId).toBe(20);
  });
});
