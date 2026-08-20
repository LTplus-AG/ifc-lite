/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert';
import type { RefObject } from 'react';

import type { CoordinateInfo, GeometryResult, MeshData } from '@ifc-lite/geometry';

import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';
import type { Renderer } from '@ifc-lite/renderer';

import { StepTokenizer, ColumnarParser, type IfcDataStore } from '@ifc-lite/parser';

import { setGlobalRendererRef } from '../../hooks/useBCF.js';
import type { KmzProcessor } from './kmz-exporter.js';
import {
  buildKmzForResolvedGeoref,
  computeKmzAltitude,
  kmzSuggestsAbsoluteAltitude,
  resolveKmzHeading,
} from './kmz-export.js';

/** Builds a real `IfcDataStore` from raw STEP text (mirrors the parser
 *  package's `on-demand-georef-epset.test.ts` fixture harness) so the ePset
 *  MapUnit correction is exercised through the actual extractor, not a mock. */
async function storeFromIfc(ifc: string): Promise<IfcDataStore> {
  const source = new TextEncoder().encode(ifc);
  const tokenizer = new StepTokenizer(source);
  const entityRefs: Array<{
    expressId: number;
    type: string;
    byteOffset: number;
    byteLength: number;
    lineNumber: number;
  }> = [];
  for (const ref of tokenizer.scanEntitiesFast()) {
    entityRefs.push({
      expressId: ref.expressId,
      type: ref.type,
      byteOffset: ref.offset,
      byteLength: ref.length,
      lineNumber: ref.line,
    });
  }
  const parser = new ColumnarParser();
  return parser.parseLite(source.buffer.slice(0), entityRefs, {}) as unknown as Promise<IfcDataStore>;
}

/**
 * A millimetre-unit IFC2x3 file whose only georeference is an
 * `ePset_MapConversion` property set — no `IfcMapConversion`/`IfcProjectedCRS`
 * entities, and (per the buildingSMART ePset convention) no MapUnit property
 * either. `OrthogonalHeight` is authored `500` — 500 *millimetres*, i.e. 0.5 m
 * — and the geometry's minimum Z is 500 IFC-world *metres*, well above
 * `BAKED_MIN_Z_THRESHOLD_METERS` (100 m), so a correctly-scaled 0.5 m
 * OrthogonalHeight is "no elevation in the georef" and the model should hint
 * "True elevation (MSL)".
 */
const EPSET_MM_IFC = `#1=IFCPROJECT('1mj5Hja8yfJfRTJSXP39EZ',$,'P',$,$,$,$,$,#2);
#2=IFCUNITASSIGNMENT((#3));
#3=IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.);
#30=IFCSITE('06pHC0eJnCHlVXWW2sVoPO',$,'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);
#1357=IFCPROPERTYSINGLEVALUE('Name',$,IFCLABEL('EPSG:7415'),$);
#1358=IFCPROPERTYSET('27AKTMp8j58fBEhvkJkcNJ',$,'ePset_ProjectedCRS',$,(#1357));
#1359=IFCRELDEFINESBYPROPERTIES('3eMryiQHj84vNzfI1G88R1',$,$,$,(#30),#1358);
#1360=IFCPROPERTYSINGLEVALUE('TargetCRS',$,IFCLABEL('EPSG:7415'),$);
#1361=IFCPROPERTYSINGLEVALUE('Eastings',$,IFCLENGTHMEASURE(160073528.13858587),$);
#1362=IFCPROPERTYSINGLEVALUE('Northings',$,IFCLENGTHMEASURE(384153306.2191765),$);
#1363=IFCPROPERTYSINGLEVALUE('OrthogonalHeight',$,IFCLENGTHMEASURE(500.),$);
#1364=IFCPROPERTYSINGLEVALUE('XAxisAbscissa',$,IFCREAL(1.),$);
#1365=IFCPROPERTYSINGLEVALUE('XAxisOrdinate',$,IFCREAL(0.),$);
#1366=IFCPROPERTYSINGLEVALUE('Scale',$,IFCREAL(1.),$);
#1367=IFCPROPERTYSET('2If4Y3Lpv6dgTDkC5x_dnr',$,'ePset_MapConversion',$,(#1360,#1361,#1362,#1363,#1364,#1365,#1366));
#1368=IFCRELDEFINESBYPROPERTIES('0AUnylrXbCLgALz5UN_kQ2',$,$,$,(#30),#1367);`;

describe('kmzSuggestsAbsoluteAltitude — ePset_MapConversion MapUnit scaling (#2859 shape)', () => {
  it('scales OrthogonalHeight by the project length unit, not 1, for an unset ePset MapUnit', async () => {
    const dataStore = await storeFromIfc(EPSET_MM_IFC);
    const geometryResult = {
      coordinateInfo: {
        originalBounds: { min: { x: 0, y: 500, z: 0 }, max: { x: 10, y: 510, z: 10 } },
        shiftedBounds: { min: { x: 0, y: 500, z: 0 }, max: { x: 10, y: 510, z: 10 } },
        originShift: { x: 0, y: 0, z: 0 },
      },
    } as unknown as GeometryResult;

    const suggests = kmzSuggestsAbsoluteAltitude({ geometryResult, dataStore, mutations: undefined });

    // OrthogonalHeight=500 authored in the project length unit (mm, per the
    // ePset convention) is 0.5 m — "near-zero" — so with geometry sitting at
    // 500 m Z (baked-in elevation), the dialog must hint absolute altitude.
    // Pre-fix, the unresolved `mapUnitScale` read 500 as 500 metres (not
    // near-zero), so this returned false — silently keeping clampToGround,
    // which floats the model 500 m above the terrain in Google Earth.
    assert.strictEqual(suggests, true);
  });
});

describe('computeKmzAltitude', () => {
  it('scales OrthogonalHeight from map units to metres (mm-CRS file is not 1000x off)', () => {
    // OrthogonalHeight authored as 500000 mm with a mm map unit = 500 m MSL.
    assert.strictEqual(computeKmzAltitude(500_000, { mapUnitScale: 0.001 }, 1, undefined), 500);
  });

  it('folds the wasm RTC Z offset back in (RTC-rebased models are not placed rtc.z too low)', () => {
    // The COLLADA exporter bakes post-RTC mesh Z; the KML altitude must restore it.
    const coordinateInfo = { wasmRtcOffset: { x: 0, y: 0, z: 417 } } as CoordinateInfo;
    assert.strictEqual(computeKmzAltitude(100, undefined, 1, coordinateInfo), 517);
  });

  it('defaults to 0 with no OrthogonalHeight, CRS, or coordinate info', () => {
    assert.strictEqual(computeKmzAltitude(undefined, undefined, 1, undefined), 0);
  });

  it('matches the pre-fix behaviour for the common metre-CRS, non-RTC model', () => {
    assert.strictEqual(computeKmzAltitude(455.5, { mapUnitScale: 1 }, 1, {} as CoordinateInfo), 455.5);
  });
});

describe('resolveKmzHeading', () => {
  // Deep review of #2534 (2026-08-10, louistrue) — blocking issue on
  // kmz-export.ts:97-108: `buildKmzForModel` got the PIN position through
  // the map-absolute guard (#2526, via `reprojectToLatLon`) but passed the
  // AUTHORED xAxisAbscissa/xAxisOrdinate straight through as the KML
  // heading. For the #2526 file shape (90-degree authored rotation, already
  // map-axis-aligned geometry), that rotated an otherwise-correctly-placed
  // .dae by 90 degrees in Google Earth. `resolveKmzHeading` must return the
  // SAME identity axis the position uses.
  function makeConversion(overrides: Partial<MapConversion> = {}): MapConversion {
    return {
      id: 1, sourceCRS: 1, targetCRS: 2,
      eastings: 311_988.181, northings: 5_996_148.565, orthogonalHeight: 0,
      xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1,
      ...overrides,
    };
  }

  it('returns the identity axis (not the authored 90-degree rotation) for a map-absolute file', () => {
    const conversion = makeConversion();
    // Geometry centre ~37m from the declared anchor — inside the 10km
    // detection window (#2526 signature).
    const coordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 },
      wasmRtcOffset: { x: 312_018.898, y: 5_996_169.654, z: 14 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
      hasLargeCoordinates: true,
    } as CoordinateInfo;
    const heading = resolveKmzHeading(conversion, { mapUnitScale: 1 }, 1, coordinateInfo);
    assert.strictEqual(heading.xAxisAbscissa, 1, 'heading must be the identity axis, not the authored rotation');
    assert.strictEqual(heading.xAxisOrdinate, 0, 'heading must be the identity axis, not the authored rotation');
  });

  it('keeps the authored axis for a compliant (non map-absolute) file', () => {
    const conversion = makeConversion({ eastings: 5000, northings: 3000, xAxisAbscissa: 0.6, xAxisOrdinate: 0.8 });
    const coordinateInfo = {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
      shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 3, z: 10 } },
      hasLargeCoordinates: false,
    } as CoordinateInfo;
    const heading = resolveKmzHeading(conversion, { mapUnitScale: 1 }, 1, coordinateInfo);
    assert.strictEqual(heading.xAxisAbscissa, 0.6);
    assert.strictEqual(heading.xAxisOrdinate, 0.8);
  });
});


/**
 * A model can have an EMPTY flat mesh list and still have geometry, because
 * every occurrence is GPU-instanced. `buildKmzForModel` used to short-circuit
 * on `geometryResult.meshes.length` and report "no geometry" for exactly that
 * model; the check now lives here, against the complete set (#2577 review).
 */
describe('buildKmzForResolvedGeoref — the model is not the flat mesh list', () => {
  afterEach(() => {
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  const CONVERSION: MapConversion = {
    id: 1, sourceCRS: 0, targetCRS: 0,
    eastings: 311_988.181, northings: 5_996_148.565, orthogonalHeight: 0,
    xAxisAbscissa: 1, xAxisOrdinate: 0, scale: 1,
  };
  const CRS = { id: 2, name: 'EPSG:25833', mapUnitScale: 1 } as ProjectedCRS;

  function occurrence(expressId: number): MeshData {
    return {
      expressId,
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      color: [1, 1, 1, 1],
    } as unknown as MeshData;
  }

  function setInstancedScene(instanced: MeshData[]): void {
    const scene = {
      getAllInstancedMeshData: () => instanced,
      getInstancedEntityCount: () => new Set(instanced.map((m) => m.expressId)).size,
    };
    setGlobalRendererRef(
      { current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>,
    );
  }

  function stub() {
    const seen: MeshData[][] = [];
    const gp: KmzProcessor = {
      async init() {},
      exportKmzFromMeshes(meshes) {
        seen.push(meshes as MeshData[]);
        return new Uint8Array([0x50, 0x4b, 0x03, 0x04]);
      },
      dispose() {},
    };
    return { gp, seen };
  }

  const build = (meshes: MeshData[], gp: KmzProcessor) => buildKmzForResolvedGeoref({
    conversion: CONVERSION,
    crs: CRS,
    coordinateInfo: undefined,
    lengthUnitScale: 1,
    geometryResult: { meshes } as GeometryResult,
    instancedModelRange: { idOffset: 0, maxExpressId: 1000 },
    name: 'IFC Model',
  }, () => gp);

  it('exports an instanced-only model, whose flat mesh list is empty', async () => {
    setInstancedScene([occurrence(42)]);
    const { gp, seen } = stub();

    const out = await build([], gp);

    assert.ok(out instanceof Uint8Array, 'expected KMZ bytes, not a no-geometry error');
    assert.deepStrictEqual(seen[0].map((m) => m.expressId), [42]);
  });

  it("still reports no-geometry when the COMPLETE set is empty", async () => {
    setInstancedScene([]);
    const { gp, seen } = stub();

    assert.strictEqual(await build([], gp), 'no-geometry');
    assert.strictEqual(seen.length, 0, 'the exporter must not be driven with nothing');
  });

  it('adopts only THIS federated model\'s own instanced occurrences, not another loaded model\'s', async () => {
    // GPU instancing stopped being primary-only on 2026-08-06 (#2255) — a
    // federated model at idOffset 100 can carry its own instanced shard,
    // re-homed onto its own global id space (100 + local id). The scene also
    // holds instanced entity 42, which belongs to a DIFFERENT model (e.g. the
    // primary, idOffset 0) — `withInstancedMeshes` must include the former and
    // exclude the latter (#2865/#2878 follow-up).
    setInstancedScene([occurrence(42), occurrence(142)]);
    const { gp, seen } = stub();

    const out = await buildKmzForResolvedGeoref({
      conversion: CONVERSION,
      crs: CRS,
      coordinateInfo: undefined,
      lengthUnitScale: 1,
      geometryResult: { meshes: [occurrence(107)] } as GeometryResult,
      instancedModelRange: { idOffset: 100, maxExpressId: 100 },
      name: 'IFC Model',
    }, () => gp);

    assert.ok(out instanceof Uint8Array);
    assert.deepStrictEqual(
      seen[0].map((m) => m.expressId).sort((a, b) => a - b),
      [107, 142],
      'the federated model\'s own instanced occurrence (142) is adopted; the other model\'s (42) is not',
    );
  });
});
