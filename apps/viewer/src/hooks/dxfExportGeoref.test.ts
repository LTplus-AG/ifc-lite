/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * DXF export georeferencing (issue #1861): the drawing-space -> world/map
 * coordinate transform used when downloading a plan ('down') section as
 * DXF. Verifies the inversion of `dxfUnderlayMath.ts`'s `worldToDrawing`
 * against the same fixture values `dxfUnderlayMath.test.ts` uses, plus a
 * full round trip through the real DXF writer + parser (`@ifc-lite/drawing-2d`)
 * to prove a known drawing point lands at the expected world/map
 * coordinate in the exported file, not just in the pure transform function.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { exportToDXF, parseDxf, DEFAULT_SECTION_CONFIG, type Drawing2D } from '@ifc-lite/drawing-2d';
import { IfcParser } from '@ifc-lite/parser';
import { buildDxfExportTransform, buildDxfMapToWorldTransform, resolveDxfExportGeoreference } from './dxfExportGeoref.js';
import { dxfWorldShift, dxfUnderlayToDrawing } from './dxfUnderlayMath.js';
import type { DxfUnderlayState } from '@/store/slices/drawing2DSlice';
import type { GeorefMutationDataLike } from '@/lib/geo/effective-georef';
import type { FederatedModel } from '@/store/types';
import type { GeometryResult } from '@ifc-lite/geometry';

const close = (a: number, b: number, eps = 1e-6) =>
  assert.ok(Math.abs(a - b) < eps, `expected ${a} to be close to ${b}`);

const coordinateInfo = {
  wasmRtcOffset: { x: 1000, y: 2000, z: 0 },
  originShift: { x: 3, y: 0, z: -7 },
} as unknown as GeometryResult['coordinateInfo'];
// Per dxfUnderlayMath.test.ts: shift.x = rtc.x + originShift.x = 1003,
// shift.y = rtc.y - originShift.z = 2007.

describe('buildDxfExportTransform', () => {
  it('is the identity for elevation/side sections (no 2D CAD georeference meaning)', () => {
    for (const axis of ['front', 'side'] as const) {
      const transform = buildDxfExportTransform({
        coordinateInfo,
        sectionAxis: axis,
        isCustomPlane: false,
        flipped: false,
      });
      const p = { x: 12.5, y: -7.25 };
      const out = transform(p);
      close(out.x, p.x);
      close(out.y, p.y);
    }
  });

  it('is the identity for a custom (arbitrary-plane) plan section', () => {
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: true,
      flipped: false,
    });
    const p = { x: 1, y: 2 };
    assert.deepStrictEqual(transform(p), p);
  });

  it('re-derives true IFC world coordinates for an un-flipped plan section', () => {
    // world_x = drawing_x + shift.x; world_y = shift.y - drawing_y.
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
    });
    const world = transform({ x: 4, y: 6 });
    close(world.x, 4 + 1003);
    close(world.y, 2007 - 6);
  });

  it('un-mirrors a flipped-section pre-mirrored input back to the true world X', () => {
    // Drawing2D arrives PRE-MIRRORED on a flipped section: both cutters
    // (CPU projectTo2D, GPU flipU) already write `drawing_x = -u` for a
    // true render-frame X of `u`. So a flipped section's drawing point
    // { x: -4, y: 6 } represents the SAME physical point as an unflipped
    // section's { x: 4, y: 6 } — both must un-mirror to the same world X.
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: true,
    });
    const world = transform({ x: -4, y: 6 });
    close(world.x, 4 + 1003);
    close(world.y, 2007 - 6);
  });

  it('is flip-invariant: the same physical point exports to the same world coordinate whether the section is flipped or not', () => {
    // `flipped` is a display convention (which way the plan reads on
    // screen), not a change in where the model sits. The cutter bakes the
    // mirror into Drawing2D before this code runs, so un-mirroring here
    // must cancel it out exactly — flipped and unflipped exports of the
    // same physical point are byte-identical. This looks like a no-op bug
    // in isolation; it's the correct, intended behaviour for a
    // georeferenced CAD file (see the module docstring).
    const unflipped = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
    });
    const flipped = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: true,
    });
    // Same physical point, as it would arrive from each cutter variant:
    // unflipped sees drawing_x = u; flipped sees drawing_x = -u.
    const u = 4;
    const drawingY = 6;
    const unflippedOut = unflipped({ x: u, y: drawingY });
    const flippedOut = flipped({ x: -u, y: drawingY });
    close(flippedOut.x, unflippedOut.x);
    close(flippedOut.y, unflippedOut.y);
  });

  it('applies IfcMapConversion (translation + rotation + scale) on top of the world coordinate', () => {
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
      georeference: {
        mapConversion: {
          id: 1,
          sourceCRS: 1,
          targetCRS: 1,
          eastings: 500_000,
          northings: 6_000_000,
          orthogonalHeight: 0,
          xAxisAbscissa: 0, // cos(90deg)
          xAxisOrdinate: 1, // sin(90deg): 90-degree rotation
          scale: 1,
        },
        projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
        lengthUnitScale: 1,
      },
    });
    // world point (after un-shift/un-flip) is (4 + 1003, 2007 - 6) = (1007, 2001).
    // With a 90deg rotation (abscissa=0, ordinate=1), scale=1:
    // easting  = 500000 + (0*1007 - 1*2001) = 500000 - 2001
    // northing = 6000000 + (1*1007 + 0*2001) = 6000000 + 1007
    const out = transform({ x: 4, y: 6 });
    close(out.x, 500_000 - 2001);
    close(out.y, 6_000_000 + 1007);
  });

  it('bridges a non-metre CRS map unit: offsets authored in US survey feet land as metres (PR #1871 review)', () => {
    // All other georef tests use mapUnitScale = 1, leaving the
    // eastings/northings unit bridging unexercised. IfcMapConversion offsets
    // are authored in IfcProjectedCRS.MapUnit — here US survey feet — and
    // the exported DXF is always metres, so the offsets must be scaled by
    // mapUnitScale while the (already metre) geometry passes through at 1:1
    // via the spec-compliant Scale (= lengthUnitScale / mapUnitScale).
    const FT_US = 0.3048006096;
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
      georeference: {
        mapConversion: {
          id: 1,
          sourceCRS: 1,
          targetCRS: 1,
          eastings: 500_000, // authored in ftUS
          northings: 6_000_000, // authored in ftUS
          orthogonalHeight: 0,
          xAxisAbscissa: 1,
          xAxisOrdinate: 0,
          scale: 1 / FT_US, // spec unit bridge: metre project -> ftUS map
        },
        projectedCRS: { id: 1, name: 'EPSG:2230', mapUnit: 'USSURVEYFOOT', mapUnitScale: FT_US },
        lengthUnitScale: 1,
      },
    });
    // world point (after un-shift) is (1007, 2001); effective horizontal
    // scale = (1/FT_US) * FT_US / 1 = 1, offsets bridge ftUS -> metres.
    const out = transform({ x: 4, y: 6 });
    close(out.x, 500_000 * FT_US + 1007);
    close(out.y, 6_000_000 * FT_US + 2001);
  });

  it('normalizes a non-unit XAxisAbscissa/XAxisOrdinate direction (IFC allows non-unit vectors)', () => {
    // Some authoring tools write (abscissa, ordinate) scaled by an arbitrary
    // magnitude even though the IFC spec models it as a direction. A vector
    // scaled by 2 must produce the SAME map coordinates as its unit form,
    // not a drawing scaled by 2x (rust/core/src/georef.rs normalize_axis is
    // the source of truth this mirrors).
    const angle = (15 * Math.PI) / 180;
    const unitCos = Math.cos(angle);
    const unitSin = Math.sin(angle);
    const buildTransform = (abscissa: number, ordinate: number) =>
      buildDxfExportTransform({
        coordinateInfo,
        sectionAxis: 'down',
        isCustomPlane: false,
        flipped: false,
        georeference: {
          mapConversion: {
            id: 1,
            sourceCRS: 1,
            targetCRS: 1,
            eastings: 500_000,
            northings: 6_000_000,
            orthogonalHeight: 0,
            xAxisAbscissa: abscissa,
            xAxisOrdinate: ordinate,
            scale: 1,
          },
          projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
          lengthUnitScale: 1,
        },
      });

    const unit = buildTransform(unitCos, unitSin)({ x: 4, y: 6 });
    const nonUnit = buildTransform(2 * unitCos, 2 * unitSin)({ x: 4, y: 6 });
    close(nonUnit.x, unit.x);
    close(nonUnit.y, unit.y);
  });

  it('is the exact inverse of the DXF-underlay IMPORT mapping, flipped and unflipped (world -> drawing -> world = identity)', () => {
    // The contract that actually pins the flip question: `dxfUnderlayToDrawing`
    // (the REAL import code from issue #1782, not a re-derivation) maps world
    // plan coordinates into drawing space exactly the way the section cutters
    // build Drawing2D — render-frame shift, Y flip, and the U mirror on a
    // flipped section. Export must invert it exactly, for BOTH flip states.
    const world = { x: 1234.5, y: 2345.25 };
    const shift = dxfWorldShift(coordinateInfo);
    const entry: DxfUnderlayState = {
      id: 'u1',
      name: 'roundtrip.dxf',
      visible: true,
      opacity: 1,
      layerVisibility: {},
      placement: { offsetX: 0, offsetY: 0, rotationDeg: 0, scale: 1 },
      underlay: {
        name: 'roundtrip.dxf',
        unitScale: 1,
        skipped: {},
        warnings: [],
        bounds: { min: world, max: world },
        layers: [
          {
            name: 'L',
            color: '#000000',
            visible: true,
            fills: [],
            texts: [],
            paths: [{ points: [world, { x: world.x + 1, y: world.y + 1 }], closed: false }],
          },
        ],
      },
    };
    for (const flipped of [false, true]) {
      const drawingPoint = dxfUnderlayToDrawing(entry, shift, flipped).lines[0].points[0];
      const transform = buildDxfExportTransform({
        coordinateInfo,
        sectionAxis: 'down',
        isCustomPlane: false,
        flipped,
      });
      const back = transform(drawingPoint);
      close(back.x, world.x, 1e-9);
      close(back.y, world.y, 1e-9);
    }
  });

  it('guards a pathological IfcMapConversion.Scale of 0 (exports unscaled instead of collapsing to a point)', () => {
    const buildTransform = (scale: number) =>
      buildDxfExportTransform({
        coordinateInfo,
        sectionAxis: 'down',
        isCustomPlane: false,
        flipped: false,
        georeference: {
          mapConversion: {
            id: 1,
            sourceCRS: 1,
            targetCRS: 1,
            eastings: 500_000,
            northings: 6_000_000,
            orthogonalHeight: 0,
            xAxisAbscissa: 1,
            xAxisOrdinate: 0,
            scale,
          },
          projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
          lengthUnitScale: 1,
        },
      });
    const zeroed = buildTransform(0);
    const unit = buildTransform(1);
    const a = zeroed({ x: 4, y: 6 });
    const b = zeroed({ x: 40, y: 60 });
    // Distinct drawing points must stay distinct (no collapse to the origin)…
    assert.ok(Math.abs(a.x - b.x) > 1, 'points collapsed under Scale=0');
    // …and behave exactly like Scale=1.
    const u = unit({ x: 4, y: 6 });
    close(a.x, u.x);
    close(a.y, u.y);
  });

  it('falls back to the no-rotation default (1, 0) for a near-zero axis vector', () => {
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
      georeference: {
        mapConversion: {
          id: 1,
          sourceCRS: 1,
          targetCRS: 1,
          eastings: 0,
          northings: 0,
          orthogonalHeight: 0,
          xAxisAbscissa: 0,
          xAxisOrdinate: 0,
          scale: 1,
        },
        projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
        lengthUnitScale: 1,
      },
    });
    // world point is (1007, 2001); with the (1, 0) fallback, easting=world.x, northing=world.y.
    const out = transform({ x: 4, y: 6 });
    close(out.x, 1007);
    close(out.y, 2001);
  });
});

function emptyDrawing(): Drawing2D {
  return {
    config: { ...DEFAULT_SECTION_CONFIG, scale: 100, plane: { axis: 'y', position: 0, flipped: false } },
    lines: [],
    cutPolygons: [],
    projectionPolygons: [],
    bounds: { min: { x: 0, y: 0 }, max: { x: 10, y: 10 } },
    stats: {
      cutLineCount: 0,
      projectionLineCount: 0,
      hiddenLineCount: 0,
      silhouetteLineCount: 0,
      polygonCount: 0,
      totalTriangles: 0,
      processingTimeMs: 0,
    },
  };
}

describe('DXF export georeference round trip (through the real writer + parser)', () => {
  it('a known plan-drawing point lands at the expected world coordinate in the exported DXF', () => {
    const drawing = emptyDrawing();
    drawing.lines = [
      {
        line: { start: { x: 4, y: 6 }, end: { x: 4, y: 6 } },
        category: 'cut',
        visibility: 'visible',
        entityId: 1,
        ifcType: 'IfcWall',
        modelIndex: 0,
        depth: 0,
      },
    ];
    const transform = buildDxfExportTransform({
      coordinateInfo,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
    });
    const dxf = exportToDXF(drawing, { coordinateTransform: transform });
    // R12 (the writer's target, see dxf/writer.ts) has no $INSUNITS header
    // var; the unit (always metres) is stated in a leading 999 comment.
    assert.match(dxf, /^999\n.*metres/);
    const doc = parseDxf(dxf);
    const line = doc.entities.find((e) => e.kind === 'line');
    assert.ok(line && line.kind === 'line');
    close(line.x1, 4 + 1003);
    close(line.y1, 2007 - 6);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// resolveDxfExportGeoreference (PR #1871 review, P1): placement edits applied
// in CesiumPlacementEditor land in the store's `georefMutations` map, not in
// the IfcDataStore. The DXF export must resolve the same anchor-model
// mutation entry ViewportContainer's Cesium georef memo uses, or the export
// silently ships the ORIGINAL file placement while the viewer displays the
// edited one. These tests parse a real minimal IFC (IfcMapConversion +
// IfcProjectedCRS) and assert that a mutation entry actually changes the
// coordinates written into the exported DXF.
// ═══════════════════════════════════════════════════════════════════════════

const GEOREF_FIXTURE = `ISO-10303-21;
HEADER;
FILE_SCHEMA(('IFC4'));
ENDSEC;
DATA;
#1=IFCPROJECT('Proj0000000000000000001',$,'P',$,$,$,$,(#10),#20);
#10=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,#11,$);
#11=IFCAXIS2PLACEMENT3D(#12,$,$);
#12=IFCCARTESIANPOINT((0.,0.,0.));
#20=IFCUNITASSIGNMENT((#21));
#21=IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.);
#30=IFCPROJECTEDCRS('EPSG:2056','CH1903+ / LV95','CH1903+','LN02',$,$,#21);
#31=IFCMAPCONVERSION(#10,#30,2600000.,1200000.,400.,1.,0.,1.);
ENDSEC;
END-ISO-10303-21;
`;

/** Same model, no georeferencing entities at all. */
const UNGEOREFERENCED_FIXTURE = GEOREF_FIXTURE
  .split('\n')
  .filter((l) => !l.startsWith('#30=') && !l.startsWith('#31='))
  .join('\n');

async function parseStore(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

function federatedModel(id: string, ifcDataStore: unknown, loadedAt: number): FederatedModel {
  return { id, ifcDataStore, loadedAt } as unknown as FederatedModel;
}

/** Export the fixed drawing point (4, 6) through `georeference` and read back the DXF line. */
function exportPoint(georeference: ReturnType<typeof resolveDxfExportGeoreference>) {
  const drawing = emptyDrawing();
  drawing.lines = [
    {
      line: { start: { x: 4, y: 6 }, end: { x: 4, y: 6 } },
      category: 'cut',
      visibility: 'visible',
      entityId: 1,
      ifcType: 'IfcWall',
      modelIndex: 0,
      depth: 0,
    },
  ];
  const transform = buildDxfExportTransform({
    coordinateInfo: undefined, // no render-frame shift: world == drawing (x, -y)
    sectionAxis: 'down',
    isCustomPlane: false,
    flipped: false,
    georeference,
  });
  const doc = parseDxf(exportToDXF(drawing, { coordinateTransform: transform }));
  const line = doc.entities.find((e) => e.kind === 'line');
  assert.ok(line && line.kind === 'line');
  return { x: line.x1, y: line.y1 };
}

describe('resolveDxfExportGeoreference (PR #1871 review: edited georeferencing must reach the DXF export)', () => {
  it('resolves the file georeference when no mutations exist', async () => {
    const store = await parseStore(GEOREF_FIXTURE);
    const georef = resolveDxfExportGeoreference({
      models: new Map(),
      legacyDataStore: store,
      georefMutations: new Map(),
    });
    assert.ok(georef);
    close(georef.mapConversion.eastings, 2_600_000);
    close(georef.mapConversion.northings, 1_200_000);
    assert.strictEqual(georef.projectedCRS.name, 'EPSG:2056');
    close(georef.lengthUnitScale, 1);
    // World point (4, -6), no rotation: easting = E + 4, northing = N - 6.
    const out = exportPoint(georef);
    close(out.x, 2_600_004);
    close(out.y, 1_199_994);
  });

  it('an applied placement edit (georefMutations) changes the exported DXF coordinates', async () => {
    const store = await parseStore(GEOREF_FIXTURE);
    const mutations = new Map<string, GeorefMutationDataLike>([
      // '__legacy__' is the mutation key for the single-model store — the
      // same key ViewportContainer passes for its legacy fallback.
      ['__legacy__', {
        mapConversion: {
          eastings: 2_600_100,
          northings: 1_199_950,
          // 90 deg grid rotation: XAxisAbscissa 0, XAxisOrdinate 1.
          xAxisAbscissa: 0,
          xAxisOrdinate: 1,
        },
      }],
    ]);
    const georef = resolveDxfExportGeoreference({
      models: new Map(),
      legacyDataStore: store,
      georefMutations: mutations,
    });
    assert.ok(georef);
    close(georef.mapConversion.eastings, 2_600_100);
    // World point (4, -6) rotated by +90 deg then offset:
    //   easting  = E' + (0*4 - 1*(-6)) = E' + 6
    //   northing = N' + (1*4 + 0*(-6)) = N' + 4
    const out = exportPoint(georef);
    close(out.x, 2_600_106);
    close(out.y, 1_199_954);
    // And it genuinely differs from the unmutated export of the same point.
    const base = resolveDxfExportGeoreference({
      models: new Map(),
      legacyDataStore: store,
      georefMutations: new Map(),
    });
    const baseOut = exportPoint(base);
    assert.notStrictEqual(out.x, baseOut.x);
    assert.notStrictEqual(out.y, baseOut.y);
  });

  it('resolves the federated anchor model mutation entry by model id (not the legacy key)', async () => {
    const store = await parseStore(GEOREF_FIXTURE);
    const models = new Map<string, FederatedModel>([
      ['m1', federatedModel('m1', store, 5)],
    ]);
    const mutations = new Map<string, GeorefMutationDataLike>([
      ['m1', { mapConversion: { eastings: 2_600_250 } }],
      // A stale legacy entry must NOT leak onto the federated anchor.
      ['__legacy__', { mapConversion: { eastings: 9_999_999 } }],
    ]);
    const georef = resolveDxfExportGeoreference({
      models,
      legacyDataStore: null,
      georefMutations: mutations,
    });
    assert.ok(georef);
    close(georef.mapConversion.eastings, 2_600_250);
    close(georef.mapConversion.northings, 1_200_000); // unmutated field keeps the file value
  });

  it('exports a georef the user ADDED entirely via the placement editor (no file georef)', async () => {
    const store = await parseStore(UNGEOREFERENCED_FIXTURE);
    assert.strictEqual(
      resolveDxfExportGeoreference({ models: new Map(), legacyDataStore: store, georefMutations: new Map() }),
      null,
      'ungeoreferenced fixture must not resolve without mutations',
    );
    const georef = resolveDxfExportGeoreference({
      models: new Map(),
      legacyDataStore: store,
      georefMutations: new Map<string, GeorefMutationDataLike>([
        ['__legacy__', {
          projectedCRS: { name: 'EPSG:2056' },
          mapConversion: { eastings: 2_600_500, northings: 1_200_500 },
        }],
      ]),
    });
    assert.ok(georef);
    assert.strictEqual(georef.projectedCRS.name, 'EPSG:2056');
    const out = exportPoint(georef);
    close(out.x, 2_600_504);
    close(out.y, 1_200_494);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// buildDxfMapToWorldTransform (issue #1929): the INVERSE of the georeferenced
// branch of buildDxfExportTransform, for the DXF-underlay IMPORT path. A
// surveyor's DXF is typically authored in map/CRS coordinates; this maps it
// back to IFC world coordinates so it lands where the model actually is.
// ═══════════════════════════════════════════════════════════════════════════

describe('buildDxfMapToWorldTransform', () => {
  it('is the identity when no georeference is available', () => {
    const transform = buildDxfMapToWorldTransform(null);
    const p = { x: 2_600_123, y: 1_200_456 };
    assert.deepStrictEqual(transform(p), p);
    assert.deepStrictEqual(buildDxfMapToWorldTransform(undefined)(p), p);
  });

  it('inverts a known rotated+offset georeference to the exact world coordinate', () => {
    // Same georeference and expected numbers as buildDxfExportTransform's
    // "applies IfcMapConversion" test above: world (1007, 2001) forward-maps
    // to (500000 - 2001, 6000000 + 1007) under a 90deg rotation. The inverse
    // must recover the original world point from that exact map point.
    const georeference = {
      mapConversion: {
        id: 1, sourceCRS: 1, targetCRS: 1,
        eastings: 500_000, northings: 6_000_000, orthogonalHeight: 0,
        xAxisAbscissa: 0, xAxisOrdinate: 1, // 90-degree rotation
        scale: 1,
      },
      projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
      lengthUnitScale: 1,
    };
    const transform = buildDxfMapToWorldTransform(georeference);
    const world = transform({ x: 500_000 - 2001, y: 6_000_000 + 1007 });
    close(world.x, 1007);
    close(world.y, 2001);
  });

  it('round-trips through buildDxfExportTransform: forward(inverse(p)) === p and inverse(forward(p)) === p', () => {
    const georeference = {
      mapConversion: {
        id: 1, sourceCRS: 1, targetCRS: 1,
        eastings: 2_600_000, northings: 1_200_000, orthogonalHeight: 400,
        xAxisAbscissa: 0.8, xAxisOrdinate: 0.6, // non-axis-aligned rotation, non-unit-length input
        scale: 1.0000002,
      },
      projectedCRS: { id: 1, name: 'EPSG:2056', mapUnit: 'METRE', mapUnitScale: 1 },
      lengthUnitScale: 1,
    };
    const toWorld = buildDxfMapToWorldTransform(georeference);
    // buildDxfExportTransform's georeferenced branch needs a section/coordinateInfo
    // context; drive it with no render-frame shift, but its `toWorld` step
    // ALSO y-flips its drawing-space input (`y: shift.y - p.y`, matching a
    // plan section's drawing convention — see the module docstring). With
    // shift = (0, 0) that reduces to `world = (p.x, -p.y)`, so a drawing
    // input of `(worldX, -worldY)` reproduces a given world point exactly —
    // undo that same flip on both sides to compare pure world<->map values.
    const toMap = buildDxfExportTransform({
      coordinateInfo: undefined,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
      georeference,
    });
    const worldPoint = { x: 1234.5, y: -678.25 };
    const mapPoint = toMap({ x: worldPoint.x, y: -worldPoint.y });
    const backToWorld = toWorld(mapPoint);
    close(backToWorld.x, worldPoint.x, 1e-6);
    close(backToWorld.y, worldPoint.y, 1e-6);

    const mapPoint2 = { x: 2_600_500.75, y: 1_199_800.25 };
    const worldFromMap = toWorld(mapPoint2);
    const backToMap = toMap({ x: worldFromMap.x, y: -worldFromMap.y });
    close(backToMap.x, mapPoint2.x, 1e-6);
    close(backToMap.y, mapPoint2.y, 1e-6);
  });

  it('guards a pathological IfcMapConversion.Scale of 0 the same way the forward transform does', () => {
    const buildTransform = (scale: number) => buildDxfMapToWorldTransform({
      mapConversion: {
        id: 1, sourceCRS: 1, targetCRS: 1,
        eastings: 500_000, northings: 6_000_000, orthogonalHeight: 0,
        xAxisAbscissa: 1, xAxisOrdinate: 0, scale,
      },
      projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
      lengthUnitScale: 1,
    });
    const zeroed = buildTransform(0);
    const unit = buildTransform(1);
    const a = zeroed({ x: 500_004, y: 6_000_006 });
    const b = zeroed({ x: 500_040, y: 6_000_060 });
    // Distinct map points must stay distinct (no division-by-zero collapse)…
    assert.ok(Math.abs(a.x - b.x) > 1, 'points collapsed under Scale=0');
    // …and behave exactly like Scale=1 (the same fallback the forward transform uses).
    const u = unit({ x: 500_004, y: 6_000_006 });
    close(a.x, u.x);
    close(a.y, u.y);
  });

  it('falls back to the no-rotation default (1, 0) for a near-zero axis vector', () => {
    const transform = buildDxfMapToWorldTransform({
      mapConversion: {
        id: 1, sourceCRS: 1, targetCRS: 1,
        eastings: 0, northings: 0, orthogonalHeight: 0,
        xAxisAbscissa: 0, xAxisOrdinate: 0, scale: 1,
      },
      projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
      lengthUnitScale: 1,
    });
    // With the (1, 0) fallback: worldX = mapX, worldY = mapY.
    const out = transform({ x: 1007, y: 2001 });
    close(out.x, 1007);
    close(out.y, 2001);
  });

  it('bridges a non-metre CRS map unit the same way the forward transform does (PR #1871 review parity)', () => {
    const FT_US = 0.3048006096;
    const transform = buildDxfMapToWorldTransform({
      mapConversion: {
        id: 1, sourceCRS: 1, targetCRS: 1,
        eastings: 500_000, northings: 6_000_000, orthogonalHeight: 0, // authored in ftUS
        xAxisAbscissa: 1, xAxisOrdinate: 0,
        scale: 1 / FT_US, // spec unit bridge: metre project -> ftUS map
      },
      projectedCRS: { id: 1, name: 'EPSG:2230', mapUnit: 'USSURVEYFOOT', mapUnitScale: FT_US },
      lengthUnitScale: 1,
    });
    // effective scale = (1/FT_US) * FT_US / 1 = 1; map point = eastings*FT_US + world.
    const out = transform({ x: 500_000 * FT_US + 1007, y: 6_000_000 * FT_US + 2001 });
    close(out.x, 1007);
    close(out.y, 2001);
  });

  // PR #1965 review, "NaN can permanently corrupt placement state": a
  // malformed IfcMapConversion.Eastings (or Northings) must not make every
  // transformed point NaN. `resolveGeorefLinearParams`'s finite guard is
  // the last line of defence even though `mergeMapConversion`
  // (effective-georef.ts) already stops most NaNs earlier in the chain —
  // this exercises the transform functions directly with a raw
  // `DxfExportGeoreference` that skipped that earlier guard (e.g. a caller
  // constructing one without going through `getEffectiveGeoreference`).
  it('guards a non-finite Eastings/Northings instead of propagating NaN through every point (PR #1965 review)', () => {
    const georeference = {
      mapConversion: {
        id: 1, sourceCRS: 1, targetCRS: 1,
        eastings: NaN, northings: 6_000_000, orthogonalHeight: 0,
        xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
      },
      projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
      lengthUnitScale: 1,
    };
    const inverse = buildDxfMapToWorldTransform(georeference);
    const world = inverse({ x: 1007, y: 6_000_000 + 2001 });
    // NaN eastings falls back to 0 (same convention as `mergeMapConversion`'s
    // `?? 0`), NOT NaN -- so the result must be finite, not NaN.
    assert.ok(Number.isFinite(world.x), `expected finite x, got ${world.x}`);
    assert.ok(Number.isFinite(world.y), `expected finite y, got ${world.y}`);
    close(world.x, 1007);
    close(world.y, 2001);

    const forward = buildDxfExportTransform({
      coordinateInfo: undefined,
      sectionAxis: 'down',
      isCustomPlane: false,
      flipped: false,
      georeference,
    });
    const mapPoint = forward({ x: 1007, y: -2001 });
    assert.ok(Number.isFinite(mapPoint.x), `expected finite x, got ${mapPoint.x}`);
    assert.ok(Number.isFinite(mapPoint.y), `expected finite y, got ${mapPoint.y}`);
  });

  // PR #1965 second review round: `axisLen < 1e-9` only catches the
  // near-zero MAGNITUDE case -- `NaN < 1e-9` and `Infinity < 1e-9` are both
  // `false`, so a non-finite XAxisAbscissa/XAxisOrdinate used to take the
  // *divide* branch and manufacture a NaN axis instead of falling back to
  // the no-rotation default (1, 0), unlike the near-zero case just above
  // and the Eastings/Northings guard just below. Covers both NaN and
  // Infinity, and both the forward and inverse transforms, since both read
  // `resolveGeorefLinearParams`.
  for (const [label, bad] of [['NaN', NaN], ['Infinity', Infinity]] as const) {
    it(`guards a non-finite (${label}) axis component instead of propagating NaN through every point`, () => {
      const georeference = {
        mapConversion: {
          id: 1, sourceCRS: 1, targetCRS: 1,
          eastings: 500_000, northings: 6_000_000, orthogonalHeight: 0,
          xAxisAbscissa: bad, xAxisOrdinate: 0, scale: 1,
        },
        projectedCRS: { id: 1, name: 'EPSG:32632', mapUnit: 'METRE', mapUnitScale: 1 },
        lengthUnitScale: 1,
      };

      const inverse = buildDxfMapToWorldTransform(georeference);
      const world = inverse({ x: 500_000 + 1007, y: 6_000_000 + 2001 });
      assert.ok(Number.isFinite(world.x), `expected finite x, got ${world.x}`);
      assert.ok(Number.isFinite(world.y), `expected finite y, got ${world.y}`);
      // A non-finite abscissa with ordinate 0 falls back to the (1, 0)
      // no-rotation default, same as the near-zero-vector case, so the
      // inverse is exact, not just finite.
      close(world.x, 1007);
      close(world.y, 2001);

      const forward = buildDxfExportTransform({
        coordinateInfo: undefined,
        sectionAxis: 'down',
        isCustomPlane: false,
        flipped: false,
        georeference,
      });
      const mapPoint = forward({ x: 1007, y: -2001 });
      assert.ok(Number.isFinite(mapPoint.x), `expected finite x, got ${mapPoint.x}`);
      assert.ok(Number.isFinite(mapPoint.y), `expected finite y, got ${mapPoint.y}`);
      close(mapPoint.x, 500_000 + 1007);
      close(mapPoint.y, 6_000_000 + 2001);
    });
  }
});
