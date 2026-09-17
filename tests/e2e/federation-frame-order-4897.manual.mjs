/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough for #4897 / #4906: a near-origin model and a
// large-coordinate model render in the same relative position, report the same
// federation frame, keep their vertex detail and stay pickable, whichever loads
// first. The large-coordinate model used for #4906 was AC20-FZK-Haus.ifc with
// its site placement (#114) moved to a new point (2600000.123, 1200000.456,
// 432.1), i.e. Swiss LV95 magnitude, saved under apps/viewer/public/samples.
// Run with `pnpm exec vite --port 5317 --strictPort` up in apps/viewer:
//   WALKTHROUGH_NEAR=apps/viewer/public/samples/hello-wall.ifc //   WALKTHROUGH_FAR=<large-coordinate .ifc> //   WALKTHROUGH_BASE=http://localhost:5317 node tests/e2e/federation-frame-order-4897.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-frame-4897');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5317';
const NEAR = resolve(process.env.WALKTHROUGH_NEAR ?? 'apps/viewer/public/samples/hello-wall.ifc');
const FAR = resolve(process.env.WALKTHROUGH_FAR ?? 'apps/viewer/public/samples/tmp-4906-fzk-lv95.ifc');
const WORLD_FRAME = `/@fs/${resolve('packages/geometry/src/world-frame.ts').replace(/\\/g, '/')}`;
const log = (...a) => console.log('[walk]', ...a);
const failures = [];
const expect = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures.push(what); };

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});

async function run(order) {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
    if (m.text().includes('#4897')) log('console:', m.text());
  });
  await page.goto(BASE);
  await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 120000 });
  const files = order === 'near-first' ? [NEAR, FAR] : [FAR, NEAR];
  const settled = (n) => page.waitForFunction(({ k, n }) => {
    const models = [...globalThis[k].getState().models.values()];
    // Federated entries register at finalize with final geometry and no loadState.
    return models.length === n && models.every((m) => (m.loadState ?? 'complete') === 'complete' && m.geometryResult);
  }, { k: STORE, n }, { timeout: 300000 });

  await page.locator('#file-input-open').setInputFiles(files[0]);
  await settled(1);
  await page.locator('#file-input-open + input[type="file"]').setInputFiles(files[1]);
  await settled(2);
  await page.waitForFunction(() => !!globalThis.__ifc_lite_scene_owner__, null, { timeout: 120000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(async ({ k, worldFrame, near, far }) => {
    const { federationFrameInfo, renderFrameWorldOffset, viewerToIfcAxes } = await import(worldFrame);
    const s = globalThis[k].getState();
    const models = [...s.models.values()];
    const frame = federationFrameInfo(models, s.geometryResult);
    const offset = renderFrameWorldOffset(frame);
    const out = { frameRtc: frame?.wasmRtcOffset ?? null, models: {} };
    for (const model of models) {
      const tag = model.name === near ? 'near' : model.name === far ? 'far' : model.name;
      const meshes = model.geometryResult.meshes.filter((m) => (m.geometryClass ?? 0) !== 2 && m.positions.length > 0);
      // Deterministic element across load orders: the one with the largest
      // rendered bounding box (least likely to be occluded when clicked).
      const locals = [...new Set(meshes.map((m) => m.expressId - model.idOffset))].sort((p, q) => p - q);
      let local = null, globalId = null, c = [], best = -1;
      for (const candidate of locals) {
        const corners = globalThis.__ifc_lite_scene_owner__(candidate + model.idOffset).corners;
        if (corners.length === 0) continue;
        const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
        for (let i = 0; i < corners.length; i += 3) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], corners[i + a]); hi[a] = Math.max(hi[a], corners[i + a]); }
        const size = (hi[0] - lo[0]) + (hi[1] - lo[1]) + (hi[2] - lo[2]);
        if (size > best) { best = size; local = candidate; globalId = candidate + model.idOffset; c = corners; }
      }
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < c.length; i += 3) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], c[i + a]); max[a] = Math.max(max[a], c[i + a]); }
      const rel = [];
      for (let i = 0; i < c.length; i += 3) rel.push(c[i] - min[0], c[i + 1] - min[1], c[i + 2] - min[2]);
      const z = viewerToIfcAxes({ x: min[0], y: min[1], z: min[2] });
      out.models[tag] = {
        loadedAt: model.loadedAt, idOffset: model.idOffset, maxExpressId: model.maxExpressId, local, globalId, min, max, rel,
        rtc: model.geometryResult.coordinateInfo.wasmRtcOffset ?? null,
        rtcFrame: model.geometryResult.coordinateInfo.wasmRtcFrame ?? null,
        worldMin: { x: z.x + offset.x, y: z.y + offset.y, z: z.z + offset.z },
        instanced: model.geometryResult.meshes.some((m) => (m.geometryClass ?? 0) === 2),
        hasSpatialIndex: !!model.ifcDataStore?.spatialIndex,
      };
    }
    return out;
  }, { k: STORE, worldFrame: WORLD_FRAME, near: basename(NEAR), far: basename(FAR) });

  // Picking and a visual check, per model: frame the element, click its projected centre.
  for (const tag of ['near', 'far']) {
    const { globalId } = result.models[tag];
    await page.evaluate((k) => { const s = globalThis[k].getState(); s.clearEntitySelection(); s.setSelectedEntityId(null); }, STORE);
    // Aim the camera straight at the element's rendered box (the renderer's own
    // corners), so the check does not depend on any framing heuristic.
    const { min, max } = result.models[tag];
    await page.evaluate(async ({ k, min, max }) => {
      const { createViewerAdapter } = await import('/src/sdk/adapters/viewer-adapter.ts');
      const c = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
      const r = Math.max(2, ...[0, 1, 2].map((a) => max[a] - min[a]));
      createViewerAdapter(globalThis[k]).setCamera({ position: [c[0] + r * 1.2, c[1] + r * 0.8, c[2] + r * 1.2], target: c, up: [0, 1, 0] });
    }, { k: STORE, min, max });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(OUT, `${order}-${tag}.png`), clip: { x: 270, y: 160, width: 920, height: 800 } });
    const screen = await page.evaluate((id) => globalThis.__ifc_lite_scene_owner__(id).screen, globalId);
    let picked = null;
    if (screen) {
      await page.mouse.click(screen.x, screen.y);
      await page.waitForTimeout(1000);
      picked = await page.evaluate((k) => globalThis[k].getState().selectedEntityId, STORE);
    }
    result.models[tag].screen = screen;
    result.models[tag].picked = picked;
  }
  result.errors = errors.filter((e) => !/favicon|posthog|localStorage/i.test(e));
  await page.context().close();
  return result;
}

const a = await run('near-first');
const b = await run('far-first');
const fmt = (v) => JSON.stringify(v);
for (const r of [a, b]) {
  log('frame', fmt(r.frameRtc), 'near', fmt({ min: r.models.near.min, rtc: r.models.near.rtc, picked: r.models.near.picked }),
    'far', fmt({ min: r.models.far.min, rtc: r.models.far.rtc, picked: r.models.far.picked }));
}
const vec = (r) => r.models.far.min.map((v, i) => v - r.models.near.min[i]);
const vA = vec(a), vB = vec(b);
log('far.min - near.min  near-first', fmt(vA), ' far-first', fmt(vB));
const maxDiff = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])));
expect(maxDiff(vA, vB) < 1e-3, `relative position identical in both orders (max diff ${maxDiff(vA, vB)} m)`);
expect(fmt(a.frameRtc) === fmt(b.frameRtc) && a.frameRtc != null, `federationFrameInfo reports the same anchored frame (${fmt(a.frameRtc)} vs ${fmt(b.frameRtc)})`);
for (const [name, r] of [['near-first', a], ['far-first', b]]) {
  for (const tag of ['near', 'far']) {
    const m = r.models[tag];
    expect(fmt(m.rtc) === fmt(r.frameRtc), `${name}: ${tag} is drawn in the reported frame`);
    expect(m.rtcFrame == null || (m.rtcFrame.needsShift === true && m.rtcFrame.x === m.rtc?.x), `${name}: ${tag} wasmRtcFrame agrees with wasmRtcOffset`);
    expect(m.picked != null && m.picked >= m.idOffset && m.picked <= m.idOffset + m.maxExpressId, `${name}: clicking the ${tag} element's projected centre picks an entity of that model (picked ${m.picked}, local ${m.picked - m.idOffset}, element ${m.local})`);
    expect(m.hasSpatialIndex, `${name}: ${tag} spatial index rebuilt`);
  }
  const w = [r.models.near.worldMin, r.models.far.worldMin];
  log(`${name}: world min near`, fmt(w[0]), 'far', fmt(w[1]));
  expect(r.errors.length === 0, `${name}: no page errors ${fmt(r.errors.slice(0, 3))}`);
}
for (const tag of ['near', 'far']) {
  expect(a.models[tag].picked - a.models[tag].idOffset === b.models[tag].picked - b.models[tag].idOffset, `${tag}: the same entity is picked in both orders (local ${a.models[tag].picked - a.models[tag].idOffset} vs ${b.models[tag].picked - b.models[tag].idOffset})`);
  const d = maxDiff(a.models[tag].rel, b.models[tag].rel);
  expect(a.models[tag].rel.length === b.models[tag].rel.length && d < 1e-5, `${tag}: element vertex detail identical across orders (max ${d} m)`);
}
await browser.close();
log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
