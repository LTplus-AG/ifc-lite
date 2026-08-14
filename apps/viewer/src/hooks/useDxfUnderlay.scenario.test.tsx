/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Scenario test for `useDxfMapToWorldTransform` (issue #2526's map-absolute
 * guard, through the REAL hook call site rather than the pure helpers it
 * wraps).
 *
 * Deep review of #2534 (2026-08-10, louistrue): "three of the routed call
 * sites have no test that can fail. (a) useDxfUnderlay.ts:83 — deleting the
 * new `legacyCoordinateInfo: geometryResult?.coordinateInfo` line breaks
 * nothing; the added dxfExportGeoref.test.ts case tests
 * `resolveDxfExportGeoreference`'s threading, not the hook's call site, and
 * no test imports `useDxfMapToWorldTransform`." This file imports and
 * mounts the hook itself, through the Zustand store, exactly as
 * `Section2DPanel`/`useDxfUnderlaysForDrawing` do, and asserts on the
 * transform it publishes for a map-absolute legacy-store model. Deleting
 * the `legacyCoordinateInfo` line under test fails the "identity axis"
 * assertion below (the guard would never fire without it, and the
 * authored 90-degree rotation would come through instead).
 */

import '@/test/setup-dom.js';
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IfcParser } from '@ifc-lite/parser';
import type { GeometryResult } from '@ifc-lite/geometry';

import { useViewerStore } from '@/store';
import { useDxfMapToWorldTransform, type DxfMapToWorld } from './useDxfUnderlay.js';

// Vectorworks-style map-absolute fixture (#2526): geometry authored at the
// absolute EPSG:25833 coordinate (rebased into wasmRtcOffset), IfcMapConversion
// repeating the same anchor with a 90-degree rotation.
const MAP_ABSOLUTE_FIXTURE = `ISO-10303-21;
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
#30=IFCPROJECTEDCRS('EPSG:25833','ETRS89 / UTM zone 33N',$,$,$,$,#21);
#31=IFCMAPCONVERSION(#10,#30,312000.,5996150.,0.,0.,1.,1.);
ENDSEC;
END-ISO-10303-21;
`;

async function parseStore(source: string) {
  const bytes = new TextEncoder().encode(source);
  return new IfcParser().parseColumnar(bytes.buffer as ArrayBuffer, { disableWorkerScan: true });
}

/** Render `useDxfMapToWorldTransform()` once and capture what it returns. */
async function renderHook(): Promise<DxfMapToWorld> {
  let result: DxfMapToWorld | null = null;
  function Harness(): null {
    result = useDxfMapToWorldTransform();
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | null = null;
  try {
    await act(async () => { root = createRoot(container); root.render(<Harness />); });
    assert.ok(result, 'harness never rendered — the hook was not called');
    return result!;
  } finally {
    if (root) await act(async () => { root!.unmount(); });
    container.remove();
  }
}

const originalState = useViewerStore.getState();
after(() => { useViewerStore.setState(originalState, true); });

describe('useDxfMapToWorldTransform (real hook call site, #2534 review gap)', () => {
  it('routes the legacy single-model store through the map-absolute guard (identity axis, not the authored 90deg rotation)', async () => {
    const store = await parseStore(MAP_ABSOLUTE_FIXTURE);
    const coordinateInfo: NonNullable<GeometryResult['coordinateInfo']> = {
      originShift: { x: 0, y: 0, z: 0 },
      originalBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      shiftedBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
      hasLargeCoordinates: false,
      // Geometry re-based right next to the declared anchor — inside the
      // 10km detection window (#2526 signature).
      wasmRtcOffset: { x: 312000, y: 5996150, z: 10 },
    };
    useViewerStore.setState({
      ifcDataStore: store as never,
      geometryResult: { coordinateInfo, meshes: [] } as unknown as GeometryResult,
      models: new Map(),
      anchorModelIdOverride: null,
      georefMutations: new Map(),
      mutationVersion: 0,
    });

    const { transform, available } = await renderHook();
    assert.strictEqual(available, true, 'a map-absolute legacy model must still resolve a usable georeference');

    // The guard-neutralised conversion is the identity axis: a map point
    // offset from the anchor round-trips to the SAME offset in world space
    // (no 90-degree rotation applied). Without `legacyCoordinateInfo`
    // threaded into `resolveDxfExportGeoreference`, the guard never sees
    // `coordinateInfo`, never fires, and the authored 90-degree rotation
    // would instead swap/negate the offset.
    const out = transform({ x: 312010, y: 5996140 });
    assert.ok(Math.abs(out.x - 312010) < 1e-6, `x = ${out.x}`);
    assert.ok(Math.abs(out.y - 5996140) < 1e-6, `y = ${out.y}`);
  });
});
