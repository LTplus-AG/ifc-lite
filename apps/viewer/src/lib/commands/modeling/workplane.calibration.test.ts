/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Storey workplane calibration against the real mesh pipeline (charter
 * #6232, WP2). Each wall's axis, read in its storey's LOCAL frame from the
 * STEP source (`extractWallSegmentsForStorey`, the frame `addWall` writes),
 * is mapped through `localToRender` and must land inside that wall's rendered
 * mesh — the geometry the wasm pipeline produced, RTC and origin shift
 * included. Fixtures: AC20-FZK-Haus (near origin) and rvt01 (LV-style survey
 * anchor, RTC ≈ 500 km / 2 780 km). Skips when fixtures or wasm are absent.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { IfcParser, type IfcDataStore } from '@ifc-lite/parser';
import { GeometryProcessor, type MeshData, type CoordinateInfo } from '@ifc-lite/geometry';
import { extractWallSegmentsForStorey, storeyPlanFrame } from '@ifc-lite/create';
import { effectiveStoreyElevation } from '@/components/viewer/add-element-storeys';
import { ZERO_ROTATION } from '@/lib/model-placement/rotation';
import { ZERO_TRANSLATION } from '@/lib/model-placement/translation';
import type { Vec3 } from './types.js';
import { composeStoreyWorkplane } from './workplane.js';

const WASM = new URL('../../../../../../packages/wasm/pkg/ifc-lite_bg.wasm', import.meta.url);
const fixture = (path: string) => new URL(`../../../../../../tests/models/${path}`, import.meta.url);

interface Box { min: Vec3; max: Vec3 }

async function load(path: string): Promise<{ store: IfcDataStore; boxes: Map<number, Box>; coordinateInfo: CoordinateInfo } | null> {
  try { await Promise.all([access(WASM), access(fixture(path))]); } catch { return null; }
  const { default: init } = await import('@ifc-lite/wasm');
  await init({ module_or_path: await readFile(WASM) });
  const bytes = new Uint8Array(await readFile(fixture(path)));
  const processor = new GeometryProcessor();
  let meshes: MeshData[];
  let coordinateInfo: CoordinateInfo;
  try {
    await processor.init();
    ({ meshes, coordinateInfo } = await processor.process(bytes.slice()));
  } finally { processor.dispose(); }
  const store = await new IfcParser().parseColumnar(bytes.slice().buffer, { disableWorkerScan: true });
  const boxes = new Map<number, Box>();
  for (const mesh of meshes) {
    const o = mesh.origin ?? [0, 0, 0];
    const box = boxes.get(mesh.expressId) ?? { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const min = [...box.min], max = [...box.max];
    for (let i = 0; i < mesh.positions.length; i += 3) {
      for (let a = 0; a < 3; a++) {
        const v = mesh.positions[i + a] + o[a];
        if (v < min[a]) min[a] = v;
        if (v > max[a]) max[a] = v;
      }
    }
    boxes.set(mesh.expressId, { min: min as unknown as Vec3, max: max as unknown as Vec3 });
  }
  return { store, boxes, coordinateInfo };
}

/** Every storey-local wall axis point, mapped to render, inside its wall's mesh box. */
function calibrate(store: IfcDataStore, boxes: Map<number, Box>, coordinateInfo: CoordinateInfo) {
  const TOL = 0.02; // metres, horizontal slack around the rendered box
  let checked = 0;
  let onFloor = 0;
  const misses: string[] = [];
  for (const storeyId of store.spatialHierarchy?.storeyElevations.keys() ?? []) {
    const plan = storeyPlanFrame(store, storeyId);
    assert.ok(plan, `storey #${storeyId} resolves in plan`);
    const workplane = composeStoreyWorkplane({
      modelId: 'm', spec: { kind: 'storey', storeyId, offset: 0 }, plan,
      elevation: effectiveStoreyElevation(store, null, storeyId), coordinateInfo, alignment: null,
      placement: { translation: ZERO_TRANSLATION, rotation: ZERO_ROTATION },
    });
    const walls = extractWallSegmentsForStorey(store, storeyId);
    walls.segments.forEach((segment, i) => {
      const id = walls.contributingWallIds[i];
      const type = store.entities.getTypeName(id);
      const box = boxes.get(id);
      if (!box || !/^IfcWall/.test(type)) return;
      // Points along the axis, not its ends: a joined wall's axis runs into
      // the corner its neighbour's mesh owns.
      const along = (f: number): [number, number] => [segment.a[0] + (segment.b[0] - segment.a[0]) * f, segment.a[1] + (segment.b[1] - segment.a[1]) * f];
      for (const p of [along(0.25), along(0.5), along(0.75)]) {
        const r = workplane.localToRender([p[0], p[1], 0]);
        checked++;
        const inside = r[0] >= box.min[0] - TOL && r[0] <= box.max[0] + TOL
          && r[2] >= box.min[2] - TOL && r[2] <= box.max[2] + TOL;
        // Height is checked in aggregate: a storey also contains walls based
        // on another level (parapets, retaining walls), so one wall's span
        // need not reach its storey's floor.
        if (r[1] >= box.min[1] - TOL && r[1] <= box.max[1] + TOL) onFloor++;
        if (!inside) misses.push(`#${id} storey #${storeyId}: local ${p.map((v) => v.toFixed(3))} → render ${r.map((v) => v.toFixed(3))} vs box ${box.min.map((v) => v.toFixed(2))}..${box.max.map((v) => v.toFixed(2))}`);
        const back = workplane.renderToLocal(r);
        assert.ok(Math.hypot(back[0] - p[0], back[1] - p[1], back[2]) < 1e-6, 'renderToLocal inverts localToRender');
      }
    });
  }
  return { checked, misses, onFloor };
}

test('AC20-FZK-Haus: every storey-local wall axis lands inside its rendered wall', async (t) => {
  const loaded = await load('ara3d/AC20-FZK-Haus.ifc');
  if (!loaded) { t.skip('Run pnpm fixtures and pnpm build:wasm for the workplane calibration'); return; }
  const { checked, misses, onFloor } = calibrate(loaded.store, loaded.boxes, loaded.coordinateInfo);
  assert.ok(checked >= 30, `checked ${checked} axis points`);
  assert.deepEqual(misses, []);
  assert.equal(onFloor, checked, 'every AC20 wall stands on its storey floor');
});

test('rvt01 (georeferenced, RTC ~2 780 km): every storey-local wall axis lands inside its rendered wall', async (t) => {
  const loaded = await load('various/rvt01.ifc');
  if (!loaded) { t.skip('Run pnpm fixtures and pnpm build:wasm for the workplane calibration'); return; }
  assert.ok(loaded.coordinateInfo.wasmRtcOffset, 'the fixture is meshed with an RTC anchor');
  const { checked, misses, onFloor } = calibrate(loaded.store, loaded.boxes, loaded.coordinateInfo);
  assert.ok(checked >= 30, `checked ${checked} axis points`);
  assert.deepEqual(misses, []);
  assert.ok(onFloor / checked >= 0.8, `the storey floor lies within ${onFloor}/${checked} wall spans`);
});
