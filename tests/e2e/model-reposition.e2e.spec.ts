/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { test, expect, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import type { ViewerState } from '../../apps/viewer/src/store';

declare global {
  var __ifc_lite_viewer_store__: { getState(): ViewerState };
}
const IFC = 'tests/models/ara3d/AC20-FZK-Haus.ifc';
const OFFSET = [10_000, 20_000, 30_000];

async function load(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, count: number) {
  await page.locator('input[type=file]').nth(count === 1 ? 0 : 1).setInputFiles(file);
  await page.waitForFunction((n) => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return state && !state.loading && !state.geometryStreamingActive && state.models.size === n && [...state.models.values()].every((m) => m.pointCloudHandleId !== undefined || m.geometryResult?.meshes.length > 0);
  }, count, { timeout: 120_000 });
}

/** Synthetic diagnostic scan, explicitly derived from a real authoring fixture.
 * The known translation is the oracle; this does not pretend to be a field scan. */
async function diagnosticScan(page: Page): Promise<Buffer> {
  const text = await page.evaluate((offset) => {
    const model = [...globalThis.__ifc_lite_viewer_store__.getState().models.values()][0];
    const points: string[] = [];
    for (const mesh of model.geometryResult.meshes) {
      const p = mesh.positions, o = mesh.origin ?? [0, 0, 0];
      for (let i = 0; i < p.length; i += 3) {
        points.push(`${p[i] + o[0] + offset[0]} ${-p[i + 2] - o[2] + offset[1]} ${p[i + 1] + o[1] + offset[2]}`);
        if (points.length >= 20_000) return points.join('\n');
      }
    }
    return points.join('\n');
  }, OFFSET);
  return Buffer.from(text);
}

async function openScanMove(page: Page) {
  await page.evaluate(() => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    state.setPointCloudAlignmentEnabled(false);
    state.setPointCloudFixedColor([1, 0.35, 0, 1]); state.setPointCloudColorMode('fixed');
    const scan = [...state.models].find(([, m]) => m.pointCloudHandleId !== undefined);
    if (!scan) throw new Error('Scan did not load');
    state.openReposition([scan[0]]);
  });
}

for (const scanFirst of [false, true]) test(`reposition IFC and diagnostic scan, ${scanFirst ? 'scan' : 'IFC'} first (#4226)`, async ({ page }, info) => {
  test.skip(!existsSync(IFC), 'Real IFC fixture missing — run pnpm fixtures');
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await load(page, IFC, 1);
  const scan = { name: 'known-offset.xyz', mimeType: 'text/plain', buffer: await diagnosticScan(page) };
  if (scanFirst) {
    await page.reload();
    await load(page, scan, 1);
    await load(page, IFC, 2);
  } else await load(page, scan, 2);
  await openScanMove(page);
  for (const [i, axis] of ['X', 'Y', 'Z'].entries()) await page.getByLabel(`Delta ${axis}`, { exact: true }).fill(String(-OFFSET[i]));
  await page.getByRole('button', { name: 'Preview values', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Frame both', exact: true }).click();
  const placement = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return { identities: [...s.models.values()].map((model) => model.sourceContentHash), translations: [...s.models].filter(([, m]) => m.pointCloudHandleId !== undefined).map(([id]) => s.modelPlacement.placements.get(id)?.translation),
      fixed: [...s.models].filter(([, m]) => m.pointCloudHandleId === undefined).map(([id]) => s.modelPlacement.placements.get(id)?.translation ?? [0, 0, 0]), count: s.pointCloudAssetCount };
  });
  expect(placement.translations).toEqual([OFFSET.map((v) => -v)]);
  expect(placement.count).toBe(1);
  expect(placement.identities).toHaveLength(2);
  for (const identity of placement.identities) expect(identity).toMatch(/^placement-sha256-1m-v1:[0-9a-f]{64}$/);
  expect(placement.fixed).toEqual([[0, 0, 0]]);
  // Match the existing smoke suite: hosted SwiftShader devices are unstable.
  // CPU assertions above still gate CI; strict local runs exercise actual GPU picks.
  if (process.env.E2E_GPU_STRICT === '0') { info.annotations.push({ type: 'GPU coverage', description: 'Picking requires a healthy WebGPU device; run locally without E2E_GPU_STRICT=0.' }); return; }

  const previewRun = await page.evaluate(async () => {
    const initial = globalThis.__ifc_lite_viewer_store__.getState();
    const buffers = [...initial.models.values()].flatMap((m) => m.geometryResult.meshes.map((mesh) => mesh.positions));
    const triangles = [...initial.models.values()].reduce((n, m) => n + m.geometryResult.totalTriangles, 0);
    const elapsed: number[] = [];
    for (let i = 0; i < 60; i++) {
      const start = performance.now();
      initial.previewModelTranslation([i * 0.001, 0, 0]);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      elapsed.push(performance.now() - start);
    }
    initial.closeReposition();
    const after = globalThis.__ifc_lite_viewer_store__.getState();
    const current = [...after.models.values()].flatMap((m) => m.geometryResult.meshes.map((mesh) => mesh.positions));
    elapsed.sort((a, b) => a - b);
    return { frameIntervalP50Ms: elapsed[30], frameIntervalP95Ms: elapsed[57],
      sourceBuffersUnchanged: buffers.every((buffer, i) => buffer === current[i]),
      trianglesBefore: triangles, trianglesAfter: [...after.models.values()].reduce((n, m) => n + m.geometryResult.totalTriangles, 0) };
  });
  expect(previewRun.sourceBuffersUnchanged).toBe(true);
  expect(previewRun.trianglesAfter).toBe(previewRun.trianglesBefore);
  await info.attach('60 scan previews, real house plus diagnostic scan', { body: JSON.stringify(previewRun), contentType: 'application/json' });
  await openScanMove(page);

  // Use projected real mesh vertices as screen locations, then select the scan
  // through the production magnetic picker. No injected snap result or anchor.
  const priorSelection = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId);
  await page.getByRole('button', { name: 'Pick source point', exact: true }).click();
  const candidates = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const model = [...s.models.values()].find((m) => m.pointCloudHandleId === undefined)!;
    const project = s.cameraCallbacks.projectToScreen!;
    const points: Array<{ x: number; y: number }> = [];
    for (const mesh of model.geometryResult.meshes) {
      const o = mesh.origin ?? [0, 0, 0];
      for (let i = 0; i < mesh.positions.length; i += 30) {
        const point = project({ x: mesh.positions[i] + o[0], y: mesh.positions[i + 1] + o[1], z: mesh.positions[i + 2] + o[2] });
        if (point && point.x > 100 && point.x < 750 && point.y > 100 && point.y < 700) points.push(point);
        if (points.length >= 80) return points;
      }
    }
    return points;
  });
  const canvas = await page.locator('canvas').first().boundingBox();
  expect(canvas).not.toBeNull();
  let picked = false;
  for (const point of candidates) {
    await page.mouse.click(canvas!.x + point.x, canvas!.y + point.y);
    picked = await page.evaluate(() => Boolean(globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.preview?.source));
    if (picked) break;
  }
  expect(picked, 'a real scan point must be pickable at its corrected placement').toBe(true);
  // Target the IFC at a distinct screen point; preview must satisfy the
  // source-to-target alignment equation and keep the fixed model unmoved.
  for (const point of candidates.slice().reverse()) {
    await page.mouse.click(canvas!.x + point.x, canvas!.y + point.y);
    const target = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.preview?.target);
    if (target) break;
  }
  const anchors = await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.preview);
  expect(anchors?.target).toBeTruthy();
  // Independent oracles: source is one of the input scan's known translated
  // points; target lies on the unchanged real IFC triangle surface. These do
  // not use preview.delta or trust either picked coordinate as ground truth.
  const rawScanPoints = scan.buffer.toString().split('\n').map((line) => line.split(' ').map(Number));
  const sourceError = Math.min(...rawScanPoints.map((point) => Math.hypot(...point.map((value, axis) => value - OFFSET[axis] - anchors!.source!.point[axis]))));
  expect(sourceError).toBeLessThan(0.005);
  const targetError = await page.evaluate((target) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const model = state.models.get(target.modelId)!; let closest = Infinity;
    const point = [target.point[0], target.point[2], -target.point[1]];
    const sub = (a: number[], b: number[]) => a.map((v, i) => v - b[i]);
    const dot = (a: number[], b: number[]) => a.reduce((sum, v, i) => sum + v * b[i], 0);
    const segmentDistance = (a: number[], b: number[]) => {
      const edge = sub(b, a), relative = sub(point, a);
      const t = Math.max(0, Math.min(1, dot(relative, edge) / (dot(edge, edge) || 1)));
      return Math.hypot(...relative.map((v, i) => v - t * edge[i]));
    };
    for (const mesh of model.geometryResult.meshes) {
      const o = mesh.origin ?? [0, 0, 0], p = mesh.positions;
      const vertex = (index: number) => [p[index * 3] + o[0], p[index * 3 + 1] + o[1], p[index * 3 + 2] + o[2]];
      for (let i = 0; i < mesh.indices.length; i += 3) {
        const a = vertex(mesh.indices[i]), b = vertex(mesh.indices[i + 1]), c = vertex(mesh.indices[i + 2]);
        const ab = sub(b, a), ac = sub(c, a), ap = sub(point, a);
        const aa = dot(ab, ab), cc = dot(ac, ac), cross = dot(ab, ac), denom = aa * cc - cross * cross;
        if (denom > 1e-20) {
          const u = (cc * dot(ap, ab) - cross * dot(ap, ac)) / denom;
          const v = (aa * dot(ap, ac) - cross * dot(ap, ab)) / denom;
          if (u >= -1e-7 && v >= -1e-7 && u + v <= 1 + 1e-7)
            closest = Math.min(closest, Math.hypot(...ap.map((value, axis) => value - u * ab[axis] - v * ac[axis])));
        }
        closest = Math.min(closest, segmentDistance(a, b), segmentDistance(b, c), segmentDistance(c, a));
      }
    }
    return closest;
  }, anchors!.target!);
  expect(targetError).toBeLessThan(0.005);
  expect(await page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().selectedEntityId)).toBe(priorSelection);
  for (let axis = 0; axis < 3; axis++) expect(anchors!.source!.point[axis] + anchors!.delta[axis]).toBeCloseTo(anchors!.target!.point[axis], 6);
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    s.closeReposition(); s.setSelectedEntityId(null);
    for (const [id, model] of s.models) if (model.pointCloudHandleId === undefined) s.setModelVisibility(id, false);
  });
  let selectedScan = false;
  for (const point of candidates) {
    await page.mouse.click(canvas!.x + point.x, canvas!.y + point.y);
    selectedScan = await page.evaluate(() => {
      const s = globalThis.__ifc_lite_viewer_store__.getState();
      const scan = [...s.models.values()].find((model) => model.pointCloudHandleId !== undefined)!;
      return s.selectedEntityId !== null && s.selectedEntityId >= scan.idOffset && s.selectedEntityId <= scan.idOffset + scan.maxExpressId;
    });
    if (selectedScan) break;
  }
  expect(selectedScan, 'normal GPU selection picks the visible translated scan').toBe(true);
  await page.evaluate(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(); for (const [id] of s.models) s.setModelVisibility(id, true); });
  await openScanMove(page);
  await page.getByRole('button', { name: 'Frame both', exact: true }).click();
  await info.attach('aligned real IFC and diagnostic scan', { body: await page.screenshot(), contentType: 'image/png' });
  await page.getByRole('button', { name: 'Undo move', exact: true }).click();
  await page.getByRole('button', { name: 'Redo move', exact: true }).click();
  expect(await page.evaluate(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(); return [...s.models].filter(([, m]) => m.pointCloudHandleId !== undefined).map(([id]) => s.modelPlacement.placements.get(id)?.translation); })).toEqual([OFFSET.map((v) => -v)]);
  expect(errors).toEqual([]);
});

test('sectioning follows a real IFC moved above its original extent (#4226)', async ({ page }, info) => {
  test.skip(!existsSync(IFC), 'Real IFC fixture missing — run pnpm fixtures');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/'); await load(page, IFC, 1);
  await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState(); s.openReposition([...s.models.keys()]);
  });
  await page.getByLabel('Delta Z', { exact: true }).fill('100 m');
  await page.getByRole('button', { name: 'Preview values', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.getByRole('button', { name: 'Frame moving', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel repositioning', exact: true }).click();
  const selectedCenter = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    const geometry = [...s.models.values()][0].geometryResult;
    const id = geometry.meshes.find((mesh) => mesh.positions.length > 0 && mesh.ifcType?.toUpperCase().startsWith('IFCWALL'))!.expressId;
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (const mesh of geometry.meshes.filter((mesh) => mesh.expressId === id)) {
      for (let i = 0; i < mesh.positions.length; i += 3) for (let axis = 0; axis < 3; axis++) {
        const value = mesh.positions[i + axis] + (mesh.origin?.[axis] ?? 0);
        min[axis] = Math.min(min[axis], value); max[axis] = Math.max(max[axis], value);
      }
    }
    s.setSelectedEntityId(id);
    return { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2 + 100, z: (min[2] + max[2]) / 2 };
  });
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame);
    globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.frameSelection!();
  });
  const viewport = await page.locator('canvas').first().boundingBox();
  await expect.poll(() => page.evaluate(({ center, width, height }) => {
    const projected = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.projectToScreen!(center);
    return projected ? Math.hypot(projected.x - width / 2, projected.y - height / 2) : Infinity;
  }, { center: selectedCenter, width: viewport!.width, height: viewport!.height })).toBeLessThan(2);
  await page.evaluate(() => {
    const c = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks;
    c.applyViewpoint!({ ...c.getViewpoint!()!, position: { x: 20, y: 20, z: 20 }, target: { x: 0, y: 0, z: 0 } }, false);
    c.frameBuildingExtent!();
  });
  await expect.poll(() => page.evaluate(() => globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.getViewpoint!()!.target.y)).toBeGreaterThan(90);
  await page.evaluate(() => { const s = globalThis.__ifc_lite_viewer_store__.getState(); s.cameraCallbacks.frameEntities!([s.selectedEntityId!]); });
  await expect.poll(() => page.evaluate((expected) => {
    const actual = globalThis.__ifc_lite_viewer_store__.getState().cameraCallbacks.getViewpoint!()!.target;
    return Math.hypot(actual.x - expected.x, actual.y - expected.y, actual.z - expected.z);
  }, selectedCenter)).toBeLessThan(0.001);
  await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    s.setSectionPlaneAxis('down'); s.setSectionPlanePosition(50); s.setSectionPlaneEnabled(true); s.setActiveTool('section');
  });
  await page.waitForFunction(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    return s.drawing2DStatus === 'ready' && (s.drawing2D?.config.plane.position ?? 0) > 100;
  });
  const cut = await page.evaluate(() => {
    const s = globalThis.__ifc_lite_viewer_store__.getState();
    let min = Infinity, max = -Infinity;
    for (const model of s.models.values()) for (const mesh of model.geometryResult.meshes) {
      for (let i = 1; i < mesh.positions.length; i += 3) {
        const y = mesh.positions[i] + (mesh.origin?.[1] ?? 0); min = Math.min(min, y); max = Math.max(max, y);
      }
    }
    return { expected: (min + max) / 2 + 100, actual: s.drawing2D!.config.plane.position, lines: s.drawing2D!.lines.length };
  });
  expect(cut.actual).toBeCloseTo(cut.expected, 3); expect(cut.lines).toBeGreaterThan(0);
  await info.attach('Real IFC section after 100 m elevation move', { body: await page.screenshot(), contentType: 'image/png' });
  expect(await page.evaluate(() => [...globalThis.__ifc_lite_viewer_store__.getState().modelPlacement.placements.values()][0].translation)).toEqual([0, 0, 100]);
});
