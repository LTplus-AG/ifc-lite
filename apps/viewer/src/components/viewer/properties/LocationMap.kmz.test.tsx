/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The Location panel's "Google Earth" button, driven through the REAL
 * component (#2526 follow-up).
 *
 * Codex on PR #2552: "For a map-absolute model whose authored axis is
 * non-identity, this correction only reaches `buildKmzForModel`, which is used
 * by `KmzExportDialog`. The Location panel still calls `buildKmz` directly in
 * `LocationMap.tsx`, passing the raw `mapConversion`." Confirmed, and it was
 * worse than reported: the raw call also passed `mapConversion.orthogonalHeight`
 * straight through as the KML altitude, skipping BOTH the map-unit scaling and
 * the wasm RTC Z fold-back that `computeKmzAltitude` exists for. On the #2526
 * file that is a 90-degree rotation AND a 14 m sink, from the button sitting
 * inches away from the one that got it right.
 *
 * A unit test on `buildKmzForResolvedGeoref` cannot catch this: it passes just
 * as happily while the component calls something else entirely. So this mounts
 * `LocationMap` and clicks the actual button, and asserts on what reached the
 * exporter. Reverting the component to `buildKmz({ ...mapConversion })` fails
 * all three assertions below.
 *
 * The wasm engine cannot load under `tsx --test`, so the export is driven
 * through the `createKmzProcessor` seam — the same seam `buildKmz` has always
 * exposed to `kmz-exporter.test.ts`, threaded one level up so this call site is
 * reachable at all.
 */

import '@/test/setup-dom.js';
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';

import type { CoordinateInfo, GeometryResult, MeshData, KmzAltitudeMode } from '@ifc-lite/geometry';
import type { MapConversion, ProjectedCRS } from '@ifc-lite/parser';

import { render, cleanup } from '@/test/render.js';
import { LocationMap } from './LocationMap.js';
import type { KmzProcessor } from '@/lib/geo/kmz-exporter.js';
import { setGlobalRendererRef } from '@/hooks/useBCF.js';
import type { Renderer } from '@ifc-lite/renderer';
import type { RefObject } from 'react';

/** A materialised instanced occurrence, as `getAllInstancedMeshData` returns
 *  them: world-space positions, no `origin`, real typed arrays (the export
 *  path sums their lengths). */
function instancedOccurrence(expressId: number): MeshData {
  return {
    expressId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    color: [1, 1, 1, 1],
  } as unknown as MeshData;
}

/** Install a fake global renderer whose scene reports `instanced` occurrences —
 *  the compact-shard half of the model, absent from `geometryResult.meshes`. */
function setInstancedScene(instanced: MeshData[] | null): void {
  const scene = instanced === null
    ? undefined
    : {
        getAllInstancedMeshData: () => instanced,
        getInstancedEntityCount: () => new Set(instanced.map((m) => m.expressId)).size,
      };
  setGlobalRendererRef(
    { current: { getScene: () => scene } as unknown as Renderer } as RefObject<Renderer | null>,
  );
}

/**
 * The #2526 file: IfcSite placed at the absolute EPSG:25833 coordinate (the
 * wasm RTC pre-pass rebased it, so the offset lives in `wasmRtcOffset`, Z = 14 m)
 * and an IfcMapConversion repeating the same anchor with a 90-degree rotation.
 */
const MAP_ABSOLUTE_CONVERSION: MapConversion = {
  id: 73, sourceCRS: 41, targetCRS: 71,
  eastings: 311_988.181, northings: 5_996_148.565, orthogonalHeight: 0,
  xAxisAbscissa: 0, xAxisOrdinate: 1, scale: 1,
};

const EPSG_25833: ProjectedCRS = {
  id: 71,
  name: 'EPSG:25833',
  description: 'ETRS89 / UTM zone 33N',
  geodeticDatum: 'ETRS89',
  mapUnitScale: 1,
} as ProjectedCRS;

const MAP_ABSOLUTE_COORDINATE_INFO = {
  originShift: { x: 0, y: 0, z: 0 },
  wasmRtcOffset: { x: 312_018.898, y: 5_996_169.654, z: 14 },
  originalBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  shiftedBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } },
  hasLargeCoordinates: true,
  lengthUnitScale: 1,
} as CoordinateInfo;

const GEOMETRY_RESULT = {
  meshes: [{ expressId: 1, geometryClass: 0 }] as unknown as MeshData[],
} as GeometryResult;

interface RecordedCall {
  meshes: MeshData[];
  altitude: number;
  xAxisAbscissa: number | undefined;
  xAxisOrdinate: number | undefined;
  altitudeMode: KmzAltitudeMode | undefined;
}

/** A stub `GeometryProcessor` slice that records the placement it was driven with. */
function makeStub() {
  const calls: RecordedCall[] = [];
  const gp: KmzProcessor = {
    async init() {},
    exportKmzFromMeshes(meshes, _lat, _lon, altitude, xAxisAbscissa, xAxisOrdinate, _name, altitudeMode) {
      calls.push({ meshes: meshes as MeshData[], altitude, xAxisAbscissa, xAxisOrdinate, altitudeMode });
      return new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
    },
    dispose() {},
  };
  return { gp, calls };
}

/** Mount the panel and click Google Earth, returning what reached the exporter. */
async function exportViaButton(): Promise<RecordedCall[]> {
  const { gp, calls } = makeStub();
  const container = render(
    <LocationMap
      mapConversion={MAP_ABSOLUTE_CONVERSION}
      projectedCRS={EPSG_25833}
      coordinateInfo={MAP_ABSOLUTE_COORDINATE_INFO}
      geometryResult={GEOMETRY_RESULT}
      lengthUnitScale={1}
      createKmzProcessor={() => gp}
    />,
  );

  // The button is gated on `latLon`, which the panel resolves asynchronously —
  // and `resolveProjection` loads the generated EPSG index, so this is real I/O
  // and NOT reachable by flushing microtasks. Poll on a timer instead. (The
  // index is cached after the first resolve, which is why a microtask-only
  // flush passed for whichever test happened to run third and failed for the
  // rest — a source of order-dependent flake, not a real pass.)
  let button: HTMLButtonElement | undefined;
  for (let i = 0; i < 200 && !button; i++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    button = Array.from(container.querySelectorAll('button'))
      .find(b => (b.textContent ?? '').includes('Google Earth'));
  }
  assert.ok(button, 'expected the Google Earth button to render once the pin resolved');

  await act(async () => {
    button!.click();
    // Let the handler's awaits settle (reproject → build → download).
    await new Promise(resolve => setTimeout(resolve, 50));
  });
  return calls;
}

describe('LocationMap — Google Earth (KMZ) export', () => {
  afterEach(() => {
    cleanup();
    setGlobalRendererRef({ current: null } as RefObject<Renderer | null>);
  });

  it('exports a map-absolute model with the GUARDED heading, not the authored 90-degree axis', async () => {
    const calls = await exportViaButton();
    assert.strictEqual(calls.length, 1, 'expected exactly one KMZ export');
    // Authored axis is (0, 1) — a 90-degree rotation. The geometry is already
    // map-axis-aligned (that is the map-absolute premise), so applying it would
    // rotate an otherwise correctly-placed .dae by 90 degrees in Google Earth.
    assert.strictEqual(calls[0].xAxisAbscissa, 1, 'heading must be the identity axis');
    assert.strictEqual(calls[0].xAxisOrdinate, 0, 'heading must be the identity axis');
  });

  it('folds the RTC Z offset into the altitude instead of passing OrthogonalHeight raw', async () => {
    const calls = await exportViaButton();
    assert.strictEqual(calls.length, 1, 'expected exactly one KMZ export');
    // OrthogonalHeight is 0, but the RTC pre-pass subtracted 14 m from every
    // mesh Z the COLLADA exporter bakes. Passing the raw 0 sinks the model by
    // its whole site elevation — the same 14 m #2526 reported losing.
    assert.strictEqual(calls[0].altitude, 14);
  });

  it('exports the GPU-instanced occurrences too, not just the flat mesh list (#2577)', async () => {
    // `geometryResult.meshes` is only part of the model: repeated opaque
    // geometry (facade panels, mullions, windows) renders from compact shards
    // and is deliberately absent from it. Passing that list straight to the
    // exporter shipped a KMZ with the repeated geometry missing — the same
    // defect #2576 fixed for the on-screen world view.
    setInstancedScene([instancedOccurrence(42)]);

    const calls = await exportViaButton();

    assert.strictEqual(calls.length, 1, 'expected exactly one KMZ export');
    assert.deepStrictEqual(
      calls[0].meshes.map((m) => m.expressId).sort((a, b) => a - b),
      [1, 42],
      'the exported file must carry the flat mesh AND the instanced occurrence',
    );
  });

  it('exports the flat model unchanged when the scene holds no instanced geometry', async () => {
    setInstancedScene([]);

    const calls = await exportViaButton();

    assert.deepStrictEqual(calls[0].meshes.map((m) => m.expressId), [1]);
  });

  it('agrees with the Export KMZ dialog, which is the point of sharing one builder', async () => {
    const { gp, calls } = makeStub();
    const { buildKmzForResolvedGeoref } = await import('@/lib/geo/kmz-export.js');
    const out = await buildKmzForResolvedGeoref({
      conversion: MAP_ABSOLUTE_CONVERSION,
      crs: EPSG_25833,
      coordinateInfo: MAP_ABSOLUTE_COORDINATE_INFO,
      lengthUnitScale: 1,
      geometryResult: GEOMETRY_RESULT,
      isPrimaryModel: true,
      name: 'IFC Model',
    }, () => gp);
    assert.ok(out instanceof Uint8Array);

    const viaPanel = await exportViaButton();
    assert.strictEqual(viaPanel.length, 1, 'expected exactly one KMZ export from the panel');
    assert.strictEqual(calls.length, 1, 'expected exactly one KMZ export from the builder');
    const placement = ({ meshes: _meshes, ...rest }: RecordedCall) => rest;
    assert.deepStrictEqual(
      placement(viaPanel[0]),
      placement(calls[0]),
      'the panel and the dialog must place the same model identically',
    );
  });
});
