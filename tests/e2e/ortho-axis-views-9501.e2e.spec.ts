/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orthographic plan and soffit views draw a hollow column as its section
 * (#9501).
 *
 * The top and bottom presets stopped 0.01 rad off the pole, so in
 * orthographic projection a 1.3 m column showed 13 mm of its walls beside
 * its section: inside the hollow, and as a band along one outer face. The
 * scene is the reported joint, generated here: a red 200x200x10 SHS column,
 * a grey gusset plate and a blue 45 degree SHS brace. After each preset, with
 * the renderer's own view-projection, the column's hollow (inset 3 px from
 * the inner faces) must show only the backdrop, and so must a 10 px band
 * around its outer faces; the wall ring itself must be red, which is what
 * makes the empty readings mean something.
 *
 * The renderer-level scoreboard for the same defect class is
 * `packages/renderer/src/test/ortho-fidelity.ts`.
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { decodePng, rendererColorFrame, type DecodedPng } from './federation-control-triplet.rendering';
import { watchGpuDeviceLoss, type GpuDeviceLossWatch } from './gpu-device-loss';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server';

declare global {
  var __ifc_lite_view_projection__: (() => number[]) | undefined;
}

type Point = readonly [number, number, number];

/** The #9501 joint, IFC4, metres, Z up. */
function jointIfc(): string {
  const lines: string[] = [];
  const add = (entity: string): number => { lines.push(`#${lines.length + 1}=${entity};`); return lines.length; };
  let guids = 0;
  const guid = () => `2Ortho9501Joint0000${String(guids++).padStart(3, '0')}`;
  const origin = add('IFCCARTESIANPOINT((0.,0.,0.))');
  const up = add('IFCDIRECTION((0.,0.,1.))');
  const east = add('IFCDIRECTION((1.,0.,0.))');
  const axes = add(`IFCAXIS2PLACEMENT3D(#${origin},#${up},#${east})`);
  const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${axes},$)`);
  const units = add(`IFCUNITASSIGNMENT((#${add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')}))`);
  const project = add(`IFCPROJECT('${guid()}',$,'Project',$,$,$,$,(#${context}),#${units})`);
  const sitePlacement = add(`IFCLOCALPLACEMENT($,#${axes})`);
  const site = add(`IFCSITE('${guid()}',$,'Site',$,$,#${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`);
  add(`IFCRELAGGREGATES('${guid()}',$,$,$,#${project},(#${site}))`);
  const profileAt = add(`IFCAXIS2PLACEMENT2D(#${add('IFCCARTESIANPOINT((0.,0.))')},$)`);
  const products: number[] = [];
  const product = (type: string, at: Point, axis: Point, refDir: Point, profile: number, depth: number, rgb: Point) => {
    const shading = add(`IFCSURFACESTYLESHADING(#${add(`IFCCOLOURRGB($,${rgb.join(',')})`)},0.)`);
    const style = add(`IFCSURFACESTYLE($,.BOTH.,(#${shading}))`);
    const solid = add(`IFCEXTRUDEDAREASOLID(#${profile},#${axes},#${up},${depth})`);
    add(`IFCSTYLEDITEM(#${solid},(#${style}),$)`);
    const rep = add(`IFCSHAPEREPRESENTATION(#${context},'Body','SweptSolid',(#${solid}))`);
    const shape = add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${rep}))`);
    const place = add(`IFCAXIS2PLACEMENT3D(#${add(`IFCCARTESIANPOINT((${at.join(',')}))`)},#${add(`IFCDIRECTION((${axis.join(',')}))`)},#${add(`IFCDIRECTION((${refDir.join(',')}))`)})`);
    const placement = add(`IFCLOCALPLACEMENT(#${sitePlacement},#${place})`);
    products.push(add(`${type}('${guid()}',$,'${type}',$,$,#${placement},#${shape},$,.NOTDEFINED.)`));
  };
  const shs = (size: number, wall: number) => add(`IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,#${profileAt},${size},${size},${wall},$,$)`);
  const S = Math.SQRT1_2;
  product('IFCCOLUMN', [0, 0, 0], [0, 0, 1], [1, 0, 0], shs(0.2, 0.01), 1.3, [0.9, 0.1, 0.1]);
  // The gusset stops at the column's face so the hollow stays empty from above and below.
  product('IFCPLATE', [0.35, 0, 0.35], [0, 0, 1], [1, 0, 0], add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${profileAt},0.5,0.01)`), 0.4, [0.6, 0.6, 0.6]);
  product('IFCMEMBER', [0.6, 0, 0.6], [S, 0, S], [S, 0, -S], shs(0.12, 0.006), 1.0, [0.1, 0.2, 0.9]);
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE('${guid()}',$,$,$,(${products.map(id => `#${id}`).join(',')}),#${site})`);
  return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    "FILE_NAME('ortho-axis-views-9501.ifc','2026-11-09T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
    'DATA;', ...lines, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
}

let server: ViewerDevServer;
test.beforeAll(async () => { server = await startViewerDevServer('ortho-axis'); });
test.afterAll(async () => { await server?.close(); });

async function loadJoint(page: Page, gpu: GpuDeviceLossWatch): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('ifc-lite-theme', 'light'));
  await page.goto(server.url);
  await page.locator('#file-input-open').setInputFiles({
    name: 'ortho-axis-views-9501.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(jointIfc()),
  });
  await gpu.requireLiveGpu('the model load', () => gpu.raceLoss('the model load', () => page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return !!state && !state.loading && state.models.size === 1 && !!state.cameraCallbacks.getViewpoint?.()
      && !!globalThis.__ifc_lite_capture_color_frame__ && !!globalThis.__ifc_lite_view_projection__;
  }, undefined, { timeout: 180_000 })));
}

/** IFC (x, y, z) is viewer (x, z, -y). */
const viewer = ([x, y, z]: Point) => ({ x, y: z, z: -y });

interface Frame extends DecodedPng { px(point: Point): { x: number; y: number } }

/**
 * Switch to orthographic, click a preset `clicks` times, then centre the
 * column's near face in the capture: the same view direction and `up` the
 * preset produced, moved sideways (a pan), at ~0.8 mm per pixel.
 */
async function presetFrame(page: Page, gpu: GpuDeviceLossWatch, name: string, view: 'top' | 'bottom', clicks: number, z: number): Promise<Frame> {
  const state = await page.evaluate(async ({ view, clicks, near }) => {
    const store = globalThis.__ifc_lite_viewer_store__.getState();
    store.setProjectionMode('orthographic');
    for (let i = 0; i < clicks; i++) {
      store.cameraCallbacks.setPresetView!(view);
      await new Promise(resolve => setTimeout(resolve, 700));
    }
    const preset = store.cameraCallbacks.getViewpoint!()!;
    const target = { x: 0, y: near, z: 0 };
    const shift = { x: target.x - preset.target.x, y: target.y - preset.target.y, z: target.z - preset.target.z };
    store.cameraCallbacks.applyViewpoint?.({
      ...preset,
      position: { x: preset.position.x + shift.x, y: preset.position.y + shift.y, z: preset.position.z + shift.z },
      target, projectionMode: 'orthographic', orthoSize: 0.25,
    }, false);
    await new Promise(resolve => setTimeout(resolve, 500));
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]')!;
    return { width: canvas.width, height: canvas.height, viewProj: globalThis.__ifc_lite_view_projection__!(), preset };
  }, { view, clicks, near: z });
  // The preset itself is exact: straight down (or up) the vertical, `up` horizontal.
  const look = { x: state.preset.target.x - state.preset.position.x, y: state.preset.target.y - state.preset.position.y, z: state.preset.target.z - state.preset.position.z };
  expect.soft(Math.hypot(look.x, look.z), `${name}: the preset looks along the vertical`).toBeLessThan(1e-9 * Math.abs(look.y));
  expect.soft(state.preset.up.y, `${name}: the preset carries screen-up in a horizontal up`).toBe(0);
  const png = await gpu.requireLiveGpu(name, () => rendererColorFrame(page));
  await test.info().attach(`${name}.png`, { body: png, contentType: 'image/png' });
  if (process.env.ORTHO_9501_DUMP_DIR) writeFileSync(join(process.env.ORTHO_9501_DUMP_DIR, `${name}.png`), png);
  const decoded = decodePng(png);
  const m = state.viewProj;
  const cropX = Math.floor((state.width - decoded.width) / 2), cropY = Math.floor((state.height - decoded.height) / 2);
  return {
    ...decoded,
    px(point) {
      const { x, y, z } = viewer(point);
      const ndcX = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, ndcY = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      return { x: ((ndcX + 1) / 2) * state.width - cropX, y: ((1 - ndcY) / 2) * state.height - cropY };
    },
  };
}

/** Screen box of the column's square at half-size `half` (m), at height z. */
function square(frame: Frame, half: number, z: number) {
  const ps = [[-half, -half], [half, half], [-half, half], [half, -half]].map(([x, y]) => frame.px([x!, y!, z]));
  return {
    x0: Math.min(...ps.map(p => p.x)), x1: Math.max(...ps.map(p => p.x)),
    y0: Math.min(...ps.map(p => p.y)), y1: Math.max(...ps.map(p => p.y)),
  };
}

const rgbAt = (f: Frame, x: number, y: number) => {
  const i = (y * f.width + x) * 4;
  return [f.rgba[i]!, f.rgba[i + 1]!, f.rgba[i + 2]!] as const;
};
const isRed = ([r, g, b]: readonly number[]) => r! > 40 && r! > g! * 1.6 && r! > b! * 1.6;

/**
 * Pixels in `outer` but outside every `holes` box (screen boxes) that are
 * red, and that differ from the backdrop.
 */
type Box = ReturnType<typeof square>;
function census(f: Frame, outer: Box, holes: readonly Box[], backdrop: readonly number[]) {
  let pixels = 0, red = 0, ink = 0;
  for (let y = Math.max(0, Math.ceil(outer.y0)); y <= Math.min(f.height - 1, Math.floor(outer.y1)); y++) {
    for (let x = Math.max(0, Math.ceil(outer.x0)); x <= Math.min(f.width - 1, Math.floor(outer.x1)); x++) {
      if (holes.some(h => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1)) continue;
      const c = rgbAt(f, x, y);
      pixels++;
      if (isRed(c)) red++;
      if (Math.abs(c[0] - backdrop[0]!) + Math.abs(c[1] - backdrop[1]!) + Math.abs(c[2] - backdrop[2]!) > 24) ink++;
    }
  }
  return { pixels, red, ink };
}

const grow = (b: Box, px: number): Box => ({ x0: b.x0 - px, x1: b.x1 + px, y0: b.y0 - px, y1: b.y1 + px });

for (const [view, clicks] of [['top', 1], ['top', 2], ['bottom', 1]] as const) {
  test(`orthographic ${view} preset (click ${clicks}) draws the hollow column as its section only (#9501)`, async ({ page }) => {
    const gpu = await watchGpuDeviceLoss(page);
    await loadJoint(page, gpu);
    // The face nearest the camera: the top end for a plan, the bottom end for a soffit view.
    const z = view === 'top' ? 1.3 : 0;
    const frame = await presetFrame(page, gpu, `${view}-${clicks}`, view, clicks, z);
    const inner = square(frame, 0.09, z), outer = square(frame, 0.1, z);
    expect(outer.x1 - outer.x0, 'the column is ~200 px wide at this zoom').toBeGreaterThan(120);
    expect(outer.x0 > 12 && outer.y0 > 12 && outer.x1 < frame.width - 12 && outer.y1 < frame.height - 12, 'the column and its band are inside the capture').toBe(true);
    // Backdrop: the frame corner diagonally away from the joint.
    const backdrop = rgbAt(frame, 2, 2);

    const ring = census(frame, grow(outer, -1), [grow(inner, 1)], backdrop);
    expect(ring.red / ring.pixels, `the wall ring reads red (${JSON.stringify(ring)})`).toBeGreaterThan(0.6);

    const hollow = census(frame, grow(inner, -3), [], backdrop);
    expect(hollow, 'nothing is drawn inside the hollow: its walls run along the view axis').toMatchObject({ red: 0, ink: 0 });

    // The gusset (IFC x 0.1..0.6, 10 mm thick) touches the column's +x face: its footprint is left out.
    const gp = [frame.px([0.1, -0.005, z]), frame.px([0.6, 0.005, z])];
    const gusset = grow({ x0: Math.min(gp[0]!.x, gp[1]!.x), x1: Math.max(gp[0]!.x, gp[1]!.x), y0: Math.min(gp[0]!.y, gp[1]!.y), y1: Math.max(gp[0]!.y, gp[1]!.y) }, 4);
    const band = census(frame, grow(outer, 10), [grow(outer, 3), gusset], backdrop);
    expect(band, 'nothing is drawn beside the outer faces either').toMatchObject({ red: 0 });
  });
}
