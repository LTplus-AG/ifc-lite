/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { existsSync, readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { IfcParser } from '@ifc-lite/parser';
import { GeometryProcessor } from '@ifc-lite/geometry';
import { MutablePropertyView, StoreEditor } from '@ifc-lite/mutations';
import { wallRectsFromMeshes } from './room-wall-rects.js';
import { storeyAuthoringFrame, storeyLocalToModelPlan } from './room-storey-frame.js';
import { effectiveStoreyIds, effectiveStoreyElevation } from './edit/effective-storeys.js';
import { floorToFloorHeight } from './room-floor-height.js';

const wasm = new URL('../../../wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
it.skipIf(!existsSync(wasm))('shared Room mesh decoder reads the actual void-cut Bonsai wall without source-centroid bias (#6232)', async () => {
  const bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const processor = new GeometryProcessor({ enableInstancing: false });
  try {
    await processor.init();
    const native = await processor.process(bytes);
    const meshes = native.meshes.filter(mesh => mesh.expressId === 1222);
    expect(meshes.length).toBeGreaterThan(0);
    const elevation = effectiveStoreyElevation(store, null, 42);
    const rects = wallRectsFromMeshes(meshes, native.coordinateInfo, elevation, 3);
    expect(rects).toHaveLength(1);
    // Independent authoring ground truth: Bonsai #1252 defines the wall's
    // footprint from (0,0) to (10,0.1); its two real void cuts must not bias it.
    expect(rects[0].thickness).toBeCloseTo(.1, 5);
    const [a, b] = rects[0].centreline;
    expect(Math.hypot(b[0] - a[0], b[1] - a[1])).toBeCloseTo(10, 5);
    const frame = storeyAuthoringFrame(store, 42, native.coordinateInfo);
    const localStart = storeyLocalToModelPlan(frame, [0, .05]);
    expect(Math.min(Math.hypot(a[0] - localStart[0], a[1] - localStart[1]), Math.hypot(b[0] - localStart[0], b[1] - localStart[1]))).toBeLessThan(1e-5);
    expect(wallRectsFromMeshes(meshes, native.coordinateInfo, 100, 3)).toEqual([]);
  } finally { processor.dispose(); }
});
it('shared Room floor context reads the live Bonsai Elevation instead of the load-time hierarchy (#6232)', async () => {
  const bytes = readFileSync(new URL('../../../../apps/viewer/public/samples/hello-wall.ifc', import.meta.url));
  const store = await new IfcParser().parseColumnar(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), { disableWorkerScan: true });
  const view = new MutablePropertyView(null, 'm'), editor = new StoreEditor(store, view);
  expect(effectiveStoreyIds(store, view)).toContain(42);
  editor.setPositionalAttribute(42, 9, { real: 3.2 });
  expect(effectiveStoreyElevation(store, view, 42)).toBe(3.2);
  expect(floorToFloorHeight([{ id: 42, elev: effectiveStoreyElevation(store, view, 42) }, { id: 99, elev: 6.4 }], 42)).toBeCloseTo(3.2);
});
