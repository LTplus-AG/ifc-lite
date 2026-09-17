/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Headed Chrome walkthrough for the #4873 (model rotation) + #4897/#4906
// (federation RTC convergence) seam: the two features both move geometry, and
// a heading edited either side of a convergence must be applied EXACTLY ONCE
// about the point the user chose.
//
// The two runs end in the same place by construction:
//
//   turn-then-converge  load near, turn it 30°, load the LV95 model (which
//                       converges the near model onto the shared anchor),
//                       turn it to 75° using the pivot the panel offers,
//                       then load a third model to converge again.
//   converge-then-turn  load near, load the LV95 model, turn the near model
//                       straight to 75° about its bounds centre, load the
//                       third model.
//
// Both turn the SAME pristine geometry 75° about the near model's bounds
// centre — one world point — so every vertex must land within millimetres. A
// baseline or pivot left behind in the pre-convergence frame drops the model
// ~2.9e6 m away, and a compounded heading lands it at 105°.
//
// The LV95 model is AC20-FZK-Haus.ifc with its site placement point (#112)
// moved to (2600000.123, 1200000.456, 432.1), the fixture #4906 used.
// Run with `pnpm exec vite --port 5321 --strictPort` up in apps/viewer:
//   WALKTHROUGH_BASE=http://localhost:5321 node tests/e2e/rotation-federation-converge-4873.manual.mjs
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

const OUT = process.env.WALKTHROUGH_OUT ?? join(tmpdir(), 'ifc-lite-rot-converge-4873');
mkdirSync(OUT, { recursive: true });
const STORE = '__ifc_lite_viewer_store__';
const BASE = process.env.WALKTHROUGH_BASE ?? 'http://localhost:5321';
const NEAR = resolve(process.env.WALKTHROUGH_NEAR ?? 'apps/viewer/public/samples/hello-wall.ifc');
const FAR = resolve(process.env.WALKTHROUGH_FAR ?? 'apps/viewer/public/samples/tmp-4906-fzk-lv95.ifc');
const THIRD = resolve(process.env.WALKTHROUGH_THIRD ?? 'apps/viewer/public/samples/building-architecture.ifc');
const WORLD_FRAME = `/@fs/${resolve('packages/geometry/src/world-frame.ts').replace(/\\/g, '/')}`;
const FINAL_DEGREES = 75;
const log = (...a) => console.log('[walk]', ...a);
const failures = [];
const expect = (ok, what) => { log(ok ? 'PASS' : 'FAIL', what); if (!ok) failures.push(what); };
const fmt = (v) => JSON.stringify(v);
const maxDiff = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])));

const browser = await chromium.launch({
  headless: false, channel: 'chrome',
  args: ['--enable-gpu', '--enable-webgpu', '--enable-unsafe-webgpu', '--use-angle=default', '--ignore-gpu-blocklist', '--window-size=1600,1000'],
});

async function run(scenario) {
  const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(BASE);
  await page.waitForFunction((k) => !!globalThis[k], STORE, { timeout: 120000 });

  const settled = (n) => page.waitForFunction(({ k, n }) => {
    const models = [...globalThis[k].getState().models.values()];
    return models.length === n && models.every((m) => (m.loadState ?? 'complete') === 'complete' && m.geometryResult);
  }, { k: STORE, n }, { timeout: 300000 });

  let loaded = 0;
  const load = async (file) => {
    const selector = loaded === 0 ? '#file-input-open' : '#file-input-open + input[type="file"]';
    await page.locator(selector).setInputFiles(file);
    loaded += 1;
    await settled(loaded);
    // The convergence runs as the load settles; give the re-index and the
    // rotation sync a beat to follow it.
    await page.waitForTimeout(1500);
  };

  // Find the near model's id by name, then turn it to `degrees` about the pivot
  // the panel would offer — the stored one once it has a heading, its bounds
  // centre before that. This is exactly `RotationControls.defaultPivot`.
  const turn = async (degrees) => page.evaluate(async ({ k, name, degrees }) => {
    const { modelCenter } = await import('/src/lib/model-placement/scene.ts');
    const { placementFor, displayedTranslation } = await import('/src/lib/model-placement/state.ts');
    const s = globalThis[k].getState();
    const id = [...s.models.values()].find((m) => m.name === name).id;
    const placement = placementFor(s.modelPlacement, id);
    const pivot = placement.rotation.angle !== 0
      ? placement.rotation.pivot.map((v, i) => v + displayedTranslation(s.modelPlacement, id)[i])
      : (modelCenter(id) ?? [0, 0, 0]);
    s.setModelRotation([id], { angle: (degrees * Math.PI) / 180, pivot: [...pivot] });
    return { id, pivot, degrees };
  }, { k: STORE, name: basename(NEAR), degrees });

  const steps = [];
  if (scenario === 'turn-then-converge') {
    await load(NEAR);
    steps.push(await turn(30));
    await load(FAR);
    steps.push(await turn(FINAL_DEGREES));
    await load(THIRD);
  } else {
    await load(NEAR);
    await load(FAR);
    steps.push(await turn(FINAL_DEGREES));
    await load(THIRD);
  }
  await page.waitForFunction(() => !!globalThis.__ifc_lite_scene_owner__, null, { timeout: 120000 });
  await page.waitForTimeout(2500);

  const result = await page.evaluate(async ({ k, worldFrame, near, far }) => {
    const { federationFrameInfo, renderFrameWorldOffset, viewerToIfcAxes, totalYupOffset } = await import(worldFrame);
    const { placementFor } = await import('/src/lib/model-placement/state.ts');
    const s = globalThis[k].getState();
    const models = [...s.models.values()];
    const frame = federationFrameInfo(models, s.geometryResult);
    const offset = renderFrameWorldOffset(frame);
    const out = { frameRtc: frame?.wasmRtcOffset ?? null, models: {} };
    for (const model of models) {
      const tag = model.name === near ? 'near' : model.name === far ? 'far' : 'third';
      const geometry = model.geometryResult;
      const meshes = geometry.meshes.filter((m) => (m.geometryClass ?? 0) !== 2 && m.positions.length > 0);
      const own = totalYupOffset(geometry.coordinateInfo);
      // Every vertex in ABSOLUTE world coordinates, and the largest f32 local
      // coordinate still stored in the buffers: the convergence must carry the
      // distance in the f64 origin, never in the vertices.
      const world = [Infinity, Infinity, Infinity], worldMax = [-Infinity, -Infinity, -Infinity];
      let maxLocal = 0;
      for (const mesh of meshes) {
        const o = mesh.origin ?? [0, 0, 0];
        for (let i = 0; i < mesh.positions.length; i += 3) {
          for (let a = 0; a < 3; a += 1) {
            maxLocal = Math.max(maxLocal, Math.abs(mesh.positions[i + a]));
            const v = mesh.positions[i + a] + o[a] + [own.x, own.y, own.z][a];
            world[a] = Math.min(world[a], v); worldMax[a] = Math.max(worldMax[a], v);
          }
        }
      }
      // A deterministic element: the one with the largest rendered box.
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
      const placement = placementFor(s.modelPlacement, model.id);
      out.models[tag] = {
        local, globalId, min, max, rel, idOffset: model.idOffset, maxExpressId: model.maxExpressId,
        rtc: geometry.coordinateInfo.wasmRtcOffset ?? null,
        rtcFrame: geometry.coordinateInfo.wasmRtcFrame ?? null,
        worldMin: world, worldMax, maxLocal,
        degrees: (placement.rotation.angle * 180) / Math.PI,
        pivot: placement.rotation.pivot,
        worldBoxMin: { x: z.x + offset.x, y: z.y + offset.y, z: z.z + offset.z },
        hasSpatialIndex: !!model.ifcDataStore?.spatialIndex,
      };
    }
    return out;
  }, { k: STORE, worldFrame: WORLD_FRAME, near: basename(NEAR), far: basename(FAR) });

  // Picking: frame each model's chosen element and click its projected centre.
  for (const tag of ['near', 'far']) {
    const { globalId, min, max } = result.models[tag];
    await page.evaluate((k) => { const s = globalThis[k].getState(); s.clearEntitySelection(); s.setSelectedEntityId(null); }, STORE);
    await page.evaluate(async ({ k, min, max }) => {
      const { createViewerAdapter } = await import('/src/sdk/adapters/viewer-adapter.ts');
      const c = [0, 1, 2].map((a) => (min[a] + max[a]) / 2);
      const r = Math.max(2, ...[0, 1, 2].map((a) => max[a] - min[a]));
      createViewerAdapter(globalThis[k]).setCamera({ position: [c[0] + r * 1.2, c[1] + r * 0.8, c[2] + r * 1.2], target: c, up: [0, 1, 0] });
    }, { k: STORE, min, max });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(OUT, `${scenario}-${tag}.png`), clip: { x: 270, y: 160, width: 920, height: 800 } });
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
  result.steps = steps;
  result.errors = errors.filter((e) => !/favicon|posthog|localStorage/i.test(e));
  await page.context().close();
  return result;
}

const turned = await run('turn-then-converge');
const control = await run('converge-then-turn');
writeFileSync(join(OUT, 'result.json'), JSON.stringify({ turned, control }, null, 1));

for (const [name, r] of [['turn-then-converge', turned], ['converge-then-turn', control]]) {
  log(name, 'frame', fmt(r.frameRtc));
  for (const tag of ['near', 'far', 'third']) {
    const m = r.models[tag];
    if (!m) continue;
    log(` ${name} ${tag}: heading ${m.degrees.toFixed(3)}° rtc ${fmt(m.rtc)} worldMin ${fmt(m.worldMin.map((v) => +v.toFixed(3)))} maxLocal ${m.maxLocal.toFixed(2)}`);
    expect(fmt(m.rtc) === fmt(r.frameRtc), `${name}: ${tag} is drawn in the federation's shared frame`);
    expect(m.hasSpatialIndex, `${name}: ${tag} spatial index rebuilt after the frame moved`);
  }
  // The distance lives in the f64 origins, not the f32 vertices: a model
  // 2.6e6 m out whose buffers hold 2.6e6-sized numbers has lost millimetres.
  expect(r.models.near.maxLocal < 1e4, `${name}: near model keeps small f32 local coordinates (max ${r.models.near.maxLocal})`);
  expect(r.models.far.maxLocal < 1e4, `${name}: far model keeps small f32 local coordinates (max ${r.models.far.maxLocal})`);
  expect(Math.abs(r.models.near.degrees - FINAL_DEGREES) < 1e-6,
    `${name}: the near model's declared heading is ${FINAL_DEGREES}° (got ${r.models.near.degrees})`);
  for (const tag of ['far', 'third']) {
    expect(Math.abs(r.models[tag].degrees) < 1e-9, `${name}: the ${tag} model was never given a heading (got ${r.models[tag].degrees})`);
  }
  expect(r.models.near.picked != null && r.models.near.picked >= r.models.near.idOffset
    && r.models.near.picked <= r.models.near.idOffset + r.models.near.maxExpressId,
  `${name}: clicking the rotated near element picks an entity of that model (picked ${r.models.near.picked}, element ${r.models.near.local})`);
  expect(r.models.far.picked != null && r.models.far.picked >= r.models.far.idOffset
    && r.models.far.picked <= r.models.far.idOffset + r.models.far.maxExpressId,
  `${name}: clicking the far element picks an entity of that model (picked ${r.models.far.picked}, element ${r.models.far.local})`);
  expect(r.errors.length === 0, `${name}: no page errors ${fmt(r.errors.slice(0, 3))}`);
}

// THE interaction assertion: the same heading about the same world point,
// whether or not a convergence happened in the middle of editing it.
const wa = turned.models.near.worldMin, wb = control.models.near.worldMin;
log('near world min  turn-then-converge', fmt(wa.map((v) => +v.toFixed(4))), ' converge-then-turn', fmt(wb.map((v) => +v.toFixed(4))));
expect(maxDiff(wa, wb) < 1e-3, `the heading is applied exactly once whichever side of the convergence it is edited (max diff ${maxDiff(wa, wb)} m)`);
expect(maxDiff(turned.models.near.worldMax, control.models.near.worldMax) < 1e-3,
  `the rotated model has the same world extent in both orders (max diff ${maxDiff(turned.models.near.worldMax, control.models.near.worldMax)} m)`);

// Relative position of the two models is the thing a dropped frame destroys.
const vec = (r) => r.models.far.worldMin.map((v, i) => v - r.models.near.worldMin[i]);
log('far - near  turn-then-converge', fmt(vec(turned).map((v) => +v.toFixed(4))), ' converge-then-turn', fmt(vec(control).map((v) => +v.toFixed(4))));
expect(maxDiff(vec(turned), vec(control)) < 1e-3, `relative position of the two models is stable (max diff ${maxDiff(vec(turned), vec(control))} m)`);

// Vertex detail: the same element, same shape, to f32 precision.
const d = maxDiff(turned.models.near.rel, control.models.near.rel);
expect(turned.models.near.rel.length === control.models.near.rel.length && d < 1e-4,
  `the rotated element keeps its vertex detail through the convergence (max ${d} m)`);
expect(turned.models.near.picked - turned.models.near.idOffset === control.models.near.picked - control.models.near.idOffset,
  `the same near entity is picked in both orders (${turned.models.near.picked - turned.models.near.idOffset} vs ${control.models.near.picked - control.models.near.idOffset})`);

await browser.close();
log(`evidence in ${OUT}`);
log(failures.length === 0 ? 'ALL PASS' : `FAILURES: ${failures.length}\n - ${failures.join('\n - ')}`);
process.exit(failures.length === 0 ? 0 : 1);
