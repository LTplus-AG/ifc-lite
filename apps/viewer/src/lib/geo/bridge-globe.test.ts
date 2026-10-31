/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * The bridge's per-vertex half against PROJ (`__fixtures__/proj-oracle.json`,
 * `warp`): the Exact camera frame, and `createCesiumBridge` choosing and using
 * the Exact placement.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectedCRS } from '@ifc-lite/parser';
import PROJ_ORACLE from './__fixtures__/proj-oracle.json' with { type: 'json' };
import { loadCesium } from '@/components/viewer/cesium/cesium-module';
import { createExactCameraFrame } from './bridge-globe.js';
import { createCesiumBridge } from './cesium-bridge.js';
import { gridViewer, rigidLine, rigidMapping } from '@/test/geo-warp-fixture.js';

const c = PROJ_ORACLE.warp[1];
const line = c.points.filter((p) => p.H === 100);
const UTM32: ProjectedCRS = { id: 3, name: 'EPSG:32632', mapUnitScale: 1 };

describe('Exact camera frame', () => {
  it('maps the camera target where PROJ puts it, and 500 m away stays within d²/2R (19.6 mm)', async () => {
    const Cesium = await loadCesium();
    const m = rigidMapping(c);
    const frame = createExactCameraFrame(m, m.anchor);
    const target = line[26]; // 3 km north-east of the anchor
    const [tx, ty, tz] = gridViewer(target);
    const matrix = frame(Cesium, { x: tx, y: ty, z: tz }, 0);
    assert.ok(matrix);
    const ecef = (p: typeof target) => {
      const [x, y, z] = gridViewer(p);
      return Cesium.Matrix4.multiplyByPoint(matrix, new Cesium.Cartesian3(x, y, z), new Cesium.Cartesian3());
    };
    const proj = (p: typeof target) => new Cesium.Cartesian3(p.ecef[0], p.ecef[1], p.ecef[2]);
    assert.ok(Cesium.Cartesian3.distance(ecef(target), proj(target)) < 1e-3);
    const off = Cesium.Cartesian3.distance(ecef(line[27]), proj(line[27]));
    assert.ok(off < 0.021, `500 m from the target: ${(off * 1000).toFixed(2)} mm`);
  });

  it('keeps its matrix while the target stays within 250 m, and re-linearises beyond', async () => {
    const Cesium = await loadCesium();
    const m = rigidMapping(c);
    const frame = createExactCameraFrame(m, m.anchor);
    const at = { x: 3000, y: 110, z: -2000 };
    const first = frame(Cesium, at, 0);
    assert.strictEqual(frame(Cesium, { ...at, x: at.x + 200 }, 0), first);
    const moved = frame(Cesium, { ...at, x: at.x + 300 }, 0);
    assert.ok(moved && moved !== first);
    const lifted = frame(Cesium, { ...at, x: at.x + 300 }, 12);
    assert.ok(lifted && lifted !== moved, 'a terrain clamp change rebuilds it');
  });
});

describe('createCesiumBridge globe placement', () => {
  const { mapConversion, coordinateInfo } = rigidLine(c);
  const bridge = (mode?: 'auto' | 'anchor' | 'exact') =>
    createCesiumBridge(mapConversion, UTM32, coordinateInfo, 1, c.anchor.h, true, mode);

  it('defaults to Anchor, still estimating the error for the panel', async () => {
    const b = await bridge();
    assert.ok(b);
    assert.equal(b.placement.mode, 'anchor');
    assert.equal(b.placement.key, '');
    assert.ok(b.geoMapping, 'the mapping exists for a projected CRS');
    // A 20 km line: curvature alone at its 10 km ends is 1e8 / 12 742 000 = 7.85 m.
    assert.ok(b.placement.estimate && Math.abs(b.placement.estimate.curvature - 7.85) < 0.01);
  });

  it('Auto picks Exact for the 20 km line and picks through the mapping, where PROJ puts each point', async () => {
    const b = await bridge('auto');
    assert.ok(b);
    assert.equal(b.placement.mode, 'exact');
    assert.notEqual(b.placement.key, '');
    for (const p of [line[0], line[20], line[40]]) {
      const pick = b.viewerToGeodetic(...gridViewer(p));
      assert.ok(pick);
      // 1e-8° is 1 mm.
      assert.ok(Math.abs(pick.longitude - p.lon) < 1e-8 && Math.abs(pick.latitude - p.lat) < 1e-8, JSON.stringify(pick));
      assert.ok(Math.abs(pick.height - p.H) < 1e-9, 'the authored orthometric height, as before');
    }
  });
});
