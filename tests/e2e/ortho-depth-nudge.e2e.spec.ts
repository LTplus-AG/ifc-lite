/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Orthographic depth ordering on large sites (#6729).
 *
 * The per-entity anti z-fighting depth nudge used to scale clip z, which in
 * orthographic depth (linear over the whole scene range) shifted a fragment by
 * up to `255e-6 * z * range`: tens of centimetres on a kilometre site, so a rod
 * running through a beam was drawn over the beam's face. The orthographic nudge
 * is now bounded to 2.5 cm (`depth-nudge.wgsl.ts`).
 *
 * Every scene is generated here, and express ids are padded until each
 * entity's depth hash is the one the case needs. The renderer's own entity
 * colours then confirm that hash before any pixel is judged. The hash and level
 * formulas mirror `main.wgsl.ts` and `depth-nudge.wgsl.ts`.
 *
 * 1. Rods 30 mm behind beam faces on a 1 km site, every rod at the top of the
 *    hash range and every beam at the bottom, from five orbit poses.
 * 2. On a 40 m and a 1 km site, viewed from above: coplanar overlapping plates
 *    exactly one ranking level apart (the smallest separation the nudge
 *    promises); annotation lines and text lying on top-hash plates; the
 *    selection highlight and a colour override on top-hash plates.
 * 3. Clip planes: with the camera's scene bounds narrowed so near and far cut
 *    through the scene, top-hash plates and annotation lines just beyond the
 *    far plane stay clipped, just inside the near plane stay drawn, and a
 *    plate crossing the far plane is cut where the plane is.
 */

import { expect, test, type Page } from '@playwright/test';
import { colorSaltByte } from '../../packages/renderer/src/scene-geometry';
import {
  MAX_DEPTH_NUDGE_HASH, ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL, ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES,
} from '../../packages/renderer/src/shaders/depth-nudge.wgsl';
import { decodePng, rendererColorFrame, type DecodedPng } from './federation-control-triplet.rendering';
import { watchGpuDeviceLoss, type GpuDeviceLossWatch } from './gpu-device-loss';
import { startViewerDevServer, type ViewerDevServer } from './viewer-dev-server';

declare global {
  var __ifc_lite_view_projection__: (() => number[]) | undefined;
  var __ifc_lite_annotation_line_vertices__: (() => number) | undefined;
  var __ifc_lite_scene_owner__: ((globalId: number) => {
    flat: Array<{ color: [number, number, number, number] }> | null;
    instance: boolean;
  }) | undefined;
}

type Rgb = readonly [number, number, number];
type Point = readonly [number, number, number];

const RED: Rgb = [0.9, 0.1, 0.1];
const BLUE: Rgb = [0.1, 0.2, 0.9];
const GREEN: Rgb = [0.1, 0.75, 0.15];
const GREY: Rgb = [0.6, 0.6, 0.6];
const YELLOW: Rgb = [0.9, 0.85, 0.1];

/** `vs_main`'s depth hash for a flat (non-instanced) mesh. */
function zHash(globalId: number, color: readonly number[]): number {
  const salt = Math.imul(colorSaltByte(color), 2654435761) >>> 0;
  return (Math.imul(((globalId & 0x00ffffff) ^ salt) >>> 0, 2654435761) >>> 0) & 255;
}

/** `orthographicNudgeLevels` for a depth range. */
function nudgeLevels(depthRange: number): number {
  const steps = ORTHOGRAPHIC_MAX_DEPTH_NUDGE_METRES / (depthRange * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL);
  return Math.min(Math.max(Math.floor(steps), 0), MAX_DEPTH_NUDGE_HASH) + 1;
}

const level = (hash: number, levels: number): number => (hash * levels) >> 8;

/** A minimal IFC4 writer for extruded, coloured products and annotations. */
class IfcScene {
  private readonly lines: string[] = [];
  private readonly products: number[] = [];
  private readonly up: number;
  private readonly east: number;
  private readonly north: number;
  private readonly axes: number;
  private readonly context: number;
  private readonly sitePlacement: number;
  private readonly site: number;
  private readonly profileOrigin: number;
  private guids = 0;

  constructor() {
    const origin = this.add('IFCCARTESIANPOINT((0.,0.,0.))');
    this.up = this.add('IFCDIRECTION((0.,0.,1.))');
    this.east = this.add('IFCDIRECTION((1.,0.,0.))');
    this.north = this.add('IFCDIRECTION((0.,1.,0.))');
    this.axes = this.add(`IFCAXIS2PLACEMENT3D(#${origin},#${this.up},#${this.east})`);
    this.context = this.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${this.axes},$)`);
    const units = this.add(`IFCUNITASSIGNMENT((#${this.add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)')}))`);
    const project = this.add(`IFCPROJECT('${this.guid()}',$,'Project',$,$,$,$,(#${this.context}),#${units})`);
    this.sitePlacement = this.add(`IFCLOCALPLACEMENT($,#${this.axes})`);
    this.site = this.add(`IFCSITE('${this.guid()}',$,'Site',$,$,#${this.sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`);
    this.add(`IFCRELAGGREGATES('${this.guid()}',$,$,$,#${project},(#${this.site}))`);
    this.profileOrigin = this.add(`IFCAXIS2PLACEMENT2D(#${this.add('IFCCARTESIANPOINT((0.,0.))')},$)`);
  }

  private add(entity: string): number {
    this.lines.push(`#${this.lines.length + 1}=${entity};`);
    return this.lines.length;
  }

  private guid(): string {
    return `3YvctVUKr0kugbFTf5${String(this.guids++).padStart(4, '0')}`;
  }

  private static real(value: number): string {
    const rounded = Number(value.toFixed(6));
    return Number.isInteger(rounded) ? `${rounded}.` : `${rounded}`;
  }

  private point([x, y, z]: Point): number {
    const r = IfcScene.real;
    return this.add(`IFCCARTESIANPOINT((${r(x)},${r(y)},${r(z)}))`);
  }

  /** A placement whose local z (the extrusion direction) is IFC z, or IFC y for `'y'`. */
  private placement(at: Point, along: 'z' | 'y' = 'z'): number {
    const axes = this.add(`IFCAXIS2PLACEMENT3D(#${this.point(at)},#${along === 'y' ? this.north : this.up},#${this.east})`);
    return this.add(`IFCLOCALPLACEMENT(#${this.sitePlacement},#${axes})`);
  }

  rectangle(x: number, y: number): number {
    return this.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,#${this.profileOrigin},${IfcScene.real(x)},${IfcScene.real(y)})`);
  }

  circle(radius: number): number {
    return this.add(`IFCCIRCLEPROFILEDEF(.AREA.,$,#${this.profileOrigin},${IfcScene.real(radius)})`);
  }

  /**
   * An extruded product placed at `at` (IFC, Z up), extruded along IFC z (or
   * y). Unused points pad the file until the product's express id gives a
   * depth hash `accept` takes.
   */
  product(type: string, predefined: string, at: Point, profile: number, depth: number, color: Rgb,
    accept: (hash: number) => boolean = () => true, along: 'z' | 'y' = 'z'): number {
    const shading = this.add(`IFCSURFACESTYLESHADING(#${this.add(`IFCCOLOURRGB($,${color.join(',')})`)},0.)`);
    const style = this.add(`IFCSURFACESTYLE($,.BOTH.,(#${shading}))`);
    const solid = this.add(`IFCEXTRUDEDAREASOLID(#${profile},#${this.axes},#${this.up},${IfcScene.real(depth)})`);
    this.add(`IFCSTYLEDITEM(#${solid},(#${style}),$)`);
    const representation = this.add(`IFCSHAPEREPRESENTATION(#${this.context},'Body','SweptSolid',(#${solid}))`);
    const body = this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${representation}))`);
    const placement = this.placement(at, along);
    while (!accept(zHash(this.lines.length + 1, color))) this.add('IFCCARTESIANPOINT((0.,0.,0.))');
    const id = this.add(`${type}('${this.guid()}',$,'${type}',$,$,#${placement},#${body},$,${predefined})`);
    this.products.push(id);
    return id;
  }

  /** A horizontal annotation polyline at height z. */
  line(from: readonly [number, number], to: readonly [number, number], z: number): void {
    this.annotation(this.sitePlacement, this.add(`IFCPOLYLINE((#${this.point([...from, z])},#${this.point([...to, z])}))`));
  }

  /** A camera-facing annotation text anchored at `at`, about 0.28 m tall. */
  text(label: string, at: Point): void {
    const extent = this.add('IFCPLANAREXTENT(1.,0.4)');
    this.annotation(this.placement(at), this.add(`IFCTEXTLITERALWITHEXTENT('${label}',#${this.profileOrigin},.LEFT.,#${extent},'bottom-left')`));
  }

  private annotation(placement: number, item: number): void {
    const representation = this.add(`IFCSHAPEREPRESENTATION(#${this.context},'Annotation','Annotation2D',(#${item}))`);
    const body = this.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(#${representation}))`);
    this.products.push(this.add(`IFCANNOTATION('${this.guid()}',$,'Note',$,$,#${placement},#${body})`));
  }

  toString(): string {
    const contained = `IFCRELCONTAINEDINSPATIALSTRUCTURE('${this.guid()}',$,$,$,(${this.products.map(id => `#${id}`).join(',')}),#${this.site})`;
    return ['ISO-10303-21;', 'HEADER;', "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
      "FILE_NAME('ortho-depth-nudge.ifc','2026-10-02T00:00:00',(''),(''),'','','');", "FILE_SCHEMA(('IFC4'));", 'ENDSEC;',
      'DATA;', ...this.lines, `#${this.lines.length + 1}=${contained};`, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n');
  }
}

async function loadScene(page: Page, gpu: GpuDeviceLossWatch, ifc: string, url = '/'): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('ifc-lite-theme', 'light'));
  await page.goto(url);
  await page.locator('#file-input-open').setInputFiles({
    name: 'ortho-depth-nudge.ifc', mimeType: 'application/octet-stream', buffer: Buffer.from(ifc),
  });
  await gpu.requireLiveGpu('the model load', () => gpu.raceLoss('the model load', () => page.waitForFunction(() => {
    const state = globalThis.__ifc_lite_viewer_store__?.getState();
    return !!state && !state.loading && state.models.size === 1 && !!state.cameraCallbacks.getViewpoint?.()
      && !!globalThis.__ifc_lite_capture_color_frame__ && !!globalThis.__ifc_lite_view_projection__;
  }, undefined, { timeout: 180_000 })));
}

/** The renderer's colour and draw path for an entity, so hashes are checked against what it drew. */
async function drawnHash(page: Page, expressId: number): Promise<number> {
  const owner = await page.evaluate((id) => {
    const state = globalThis.__ifc_lite_viewer_store__.getState();
    const globalId = state.toGlobalId([...state.models.values()][0]!.id, id);
    const scene = globalThis.__ifc_lite_scene_owner__!(globalId);
    return { globalId, instance: scene.instance, color: scene.flat?.[0]?.color ?? null };
  }, expressId);
  expect(owner.instance, `#${expressId} draws on the flat path`).toBe(false);
  expect(owner.color, `#${expressId} has a drawn colour`).not.toBeNull();
  return zHash(owner.globalId, owner.color!);
}

/** An axis-aligned box in viewer space (Y up), the shape `Camera.setSceneBounds` takes. */
interface ViewerBox { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }

/**
 * Look from `eye` at `target` (IFC, Z up) in orthographic projection, then read
 * the renderer's colour frame: a central crop of the drawing buffer.
 *
 * `sceneBounds` replaces the camera's scene bounds (and so its near and far
 * planes) for this frame; it needs the dev server, which can import the
 * renderer.
 */
async function orthoFrame(page: Page, gpu: GpuDeviceLossWatch, name: string, eye: Point, target: Point,
  orthoSize: number, sceneBounds?: ViewerBox): Promise<Frame> {
  const state = await page.evaluate(async ({ position, target, orthoSize, sceneBounds }) => {
    const store = globalThis.__ifc_lite_viewer_store__.getState();
    store.setProjectionMode('orthographic');
    store.cameraCallbacks.applyViewpoint?.({ position, target, up: { x: 0, y: 1, z: 0 }, fov: Math.PI / 4, projectionMode: 'orthographic', orthoSize }, false);
    await new Promise(resolve => setTimeout(resolve, 500));
    if (sceneBounds) {
      // After the view settles: the placement and point-cloud sync effects
      // that the store change wakes push the model bounds back.
      const { getGlobalRenderer }: typeof import('../../apps/viewer/src/hooks/useBCF') = await import('/src/hooks/useBCF.ts');
      getGlobalRenderer()!.getCamera().setSceneBounds(sceneBounds);
    }
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-viewport="main"]')!;
    return { width: canvas.width, height: canvas.height, viewProj: globalThis.__ifc_lite_view_projection__!() };
  }, { position: viewer(eye), target: viewer(target), orthoSize, sceneBounds });
  const png = await gpu.requireLiveGpu(name, () => rendererColorFrame(page));
  await test.info().attach(`${name}.png`, { body: png, contentType: 'image/png' });
  const decoded = decodePng(png);
  const m = state.viewProj;
  const cropX = Math.floor((state.width - decoded.width) / 2), cropY = Math.floor((state.height - decoded.height) / 2);
  const depthRange = 1 / Math.hypot(m[2]!, m[6]!, m[10]!);
  return {
    ...decoded,
    depthRange,
    levels: nudgeLevels(depthRange),
    depth(point) {
      const { x, y, z } = viewer(point);
      return m[2]! * x + m[6]! * y + m[10]! * z + m[14]!;
    },
    px(point) {
      // Orthographic: w is 1, so clip x/y are NDC.
      const { x, y, z } = viewer(point);
      const ndcX = m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, ndcY = m[1]! * x + m[5]! * y + m[9]! * z + m[13]!;
      return { x: ((ndcX + 1) / 2) * state.width - cropX, y: ((1 - ndcY) / 2) * state.height - cropY };
    },
  };
}

/** IFC (x, y, z) is viewer (x, z, -y). */
const viewer = ([x, y, z]: Point) => ({ x, y: z, z: -y });

interface Frame extends DecodedPng {
  depthRange: number;
  levels: number;
  /** Reverse-Z NDC depth of an IFC point: 1 on the near plane, 0 on the far. */
  depth(point: Point): number;
  /** Capture pixel of an IFC point. */
  px(point: Point): { x: number; y: number };
}

type Classify = (r: number, g: number, b: number) => boolean;
const isRed: Classify = (r, g, b) => r > 90 && r > g * 1.8 && r > b * 1.8;
const isBlue: Classify = (r, g, b) => b > 90 && b > r * 1.3 && b > g * 1.3;
const isGreen: Classify = (r, g, b) => g > 90 && g > r * 1.5 && g > b * 1.5;
const isYellow: Classify = (r, g, b) => r > 120 && g > 120 && b < Math.min(r, g) * 0.6;
/** Annotation ink, blended into the face it lies on: well darker than any plate. */
const isInk: Classify = (r, g, b) => r + g + b < 220;

/** Classified pixel counts in the capture-space box spanned by two points, shrunk by `inset` px. */
function count(frame: Frame, corner: Point, opposite: Point, inset: number, ...classes: Classify[]): number[] {
  const a = frame.px(corner), b = frame.px(opposite);
  const x0 = Math.max(0, Math.ceil(Math.min(a.x, b.x) + inset)), x1 = Math.min(frame.width - 1, Math.floor(Math.max(a.x, b.x) - inset));
  const y0 = Math.max(0, Math.ceil(Math.min(a.y, b.y) + inset)), y1 = Math.min(frame.height - 1, Math.floor(Math.max(a.y, b.y) - inset));
  const totals = classes.map(() => 0);
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const i = (y * frame.width + x) * 4;
    classes.forEach((matches, k) => { if (matches(frame.rgba[i]!, frame.rgba[i + 1]!, frame.rgba[i + 2]!)) totals[k]!++; });
  }
  return totals;
}

test('orthographic: rods 30 mm inside beams stay hidden on a 1 km site, adverse hashes, five poses (#6729)', async ({ page }) => {
  const ROWS = 4, PER_ROW = 10, SPACING = 0.4, PITCH = 1.2, BEAM = 0.2, ROD = 0.07;
  const scene = new IfcScene();
  // The slab spans y -10..990, so the pairs at y = 0 sit near the camera end of the depth range.
  scene.product('IFCSLAB', '.BASESLAB.', [0, 490, -1.3], scene.rectangle(1000, 1000), 0.3, GREY);
  const beamProfile = scene.rectangle(BEAM, BEAM), rodProfile = scene.circle(ROD);
  const pairs: Array<{ beam: number; rod: number }> = [];
  for (let row = 0; row < ROWS; row++) for (let k = 0; k < PER_ROW; k++) {
    const x = (k - (PER_ROW - 1) / 2) * SPACING, z = row * PITCH;
    const beam = scene.product('IFCBEAM', '.BEAM.', [x, 0, z], beamProfile, BEAM, BLUE, hash => hash <= 15);
    const rod = scene.product('IFCMEMBER', '.STUD.', [x, 0, z - 0.4], rodProfile, 1, RED, hash => hash >= 240);
    pairs.push({ beam, rod });
  }
  const gpu = await watchGpuDeviceLoss(page);
  // #6232 F3: scene ownership and pixel assertions also need the live GPU,
  // including a device lost after a successful frame readback.
  await gpu.requireLiveGpu('orthographic geometry and pixel assertions', async () => {
    await loadScene(page, gpu, scene.toString());
    for (const { beam, rod } of pairs) {
      expect(await drawnHash(page, beam), `beam #${beam} hashes to the bottom of the range`).toBeLessThanOrEqual(15);
      expect(await drawnHash(page, rod), `rod #${rod} hashes to the top of the range`).toBeGreaterThanOrEqual(240);
    }

    const middle = BEAM / 2 + ((ROWS - 1) / 2) * PITCH;
    // Each row's front face (IFC y = -BEAM / 2): its bottom and top edge.
    const edges: Point[] = Array.from({ length: ROWS }, (_, row): Point[] => [[0, -BEAM / 2, row * PITCH], [0, -BEAM / 2, row * PITCH + BEAM]]).flat();
    for (const [elevation, azimuth] of [[0, 0], [0, 35], [0, -50], [25, 0], [45, 0]] as const) {
      const e = (elevation * Math.PI) / 180, a = (azimuth * Math.PI) / 180;
      const eye: Point = [8 * Math.cos(e) * Math.sin(a), -8 * Math.cos(e) * Math.cos(a), middle + 8 * Math.sin(e)];
      const frame = await orthoFrame(page, gpu, `rods-${elevation}-${azimuth}`, eye, [0, 0, middle], 2.6);
      const pose = `${elevation}°/${azimuth}°`;
      const largestShift = (frame.levels - 1) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL * frame.depthRange;
      expect(frame.depthRange, `${pose}: kilometre depth range`).toBeGreaterThan(1000);
      expect(largestShift, `${pose}: the largest nudge stays under the 30 mm clearance`).toBeLessThan(0.03);
      let rodInFace = 0, beamInFace = 0;
      for (let row = 0; row < ROWS; row++) {
        const [bottom, top] = [edges[row * 2]!, edges[row * 2 + 1]!];
        // Full width: the face edges are horizontal on screen in all five poses.
        const yBottom = frame.px(bottom).y, yTop = frame.px(top).y;
        for (let y = Math.ceil(Math.min(yBottom, yTop)) + 3; y <= Math.floor(Math.max(yBottom, yTop)) - 3; y++) {
          for (let x = 0; x < frame.width; x++) {
            const i = (y * frame.width + x) * 4;
            if (isRed(frame.rgba[i]!, frame.rgba[i + 1]!, frame.rgba[i + 2]!)) rodInFace++;
            else if (isBlue(frame.rgba[i]!, frame.rgba[i + 1]!, frame.rgba[i + 2]!)) beamInFace++;
          }
        }
      }
      let rodElsewhere = 0;
      for (let i = 0; i < frame.rgba.length; i += 4) if (isRed(frame.rgba[i]!, frame.rgba[i + 1]!, frame.rgba[i + 2]!)) rodElsewhere++;
      expect(beamInFace, `${pose}: beam faces are drawn`).toBeGreaterThan(500);
      expect(rodElsewhere, `${pose}: rods are drawn above and below the beams`).toBeGreaterThan(500);
      expect(rodInFace, `${pose}: no rod pixel shows through a beam face`).toBe(0);
    }
  });
});

for (const site of [{ name: '40 m', size: 40 }, { name: '1 km', size: 1000 }] as const) {
  test(`orthographic: coplanar plates, annotations, selection and an override on a ${site.name} site (#6729)`, async ({ page }) => {
    const COLS = 5, ROWS = 4, PITCH = 1.6, TOP = 0.1;
    const scene = new IfcScene();
    scene.product('IFCSLAB', '.BASESLAB.', [0, 0, -1.3], scene.rectangle(site.size, site.size), 0.3, GREY);
    // The ranking the frame will use, from the scene's bounding sphere
    // (computeOrthoNearFar); the live view-projection confirms it below.
    const radius = Math.hypot(site.size, site.size, 1.4) / 2;
    const levels = nudgeLevels(2 * radius + 2 * (0.1 * radius + 1));
    const plate = scene.rectangle(1, 1);

    // Red and green plates overlapping 0.5 m x 0.7 m with coplanar tops, the
    // green one exactly one ranking level above its red partner.
    const pairs: Array<{ red: number; green: number; x: number; y: number }> = [];
    for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLS; col++) {
      const x = (col - (COLS - 1) / 2) * PITCH - 0.25, y = (row - (ROWS - 1) / 2) * PITCH;
      const red = scene.product('IFCPLATE', '.NOTDEFINED.', [x, y, 0], plate, TOP, RED, hash => level(hash, levels) < levels - 1);
      const redLevel = level(zHash(red, RED), levels);
      const green = scene.product('IFCPLATE', '.NOTDEFINED.', [x + 0.5, y + 0.3, 0], plate, TOP, GREEN, hash => level(hash, levels) === redLevel + 1);
      pairs.push({ red, green, x, y });
    }
    // A row of top-hash plates: two carry an annotation line, two a text, one
    // is selected and one gets a colour override.
    const topRowY = -((ROWS - 1) / 2) * PITCH - 1.5;
    const tops = Array.from({ length: 6 }, (_, k) => {
      const x = (k - 2.5) * 1.4;
      return { x, id: scene.product('IFCPLATE', '.NOTDEFINED.', [x, topRowY, 0], plate, TOP, GREEN, hash => hash >= 250) };
    });
    for (const { x } of tops.slice(0, 2)) scene.line([x - 0.4, topRowY], [x + 0.4, topRowY], TOP);
    for (const { x } of tops.slice(2, 4)) scene.text('AB', [x - 0.3, topRowY - 0.1, TOP]);

    const gpu = await watchGpuDeviceLoss(page);
    // #6232 F3: scene ownership and pixel assertions also need the live GPU,
    // including a device lost after a successful frame readback.
    await gpu.requireLiveGpu('orthographic geometry and pixel assertions', async () => {
      await loadScene(page, gpu, scene.toString());
      for (const { red, green } of pairs) {
        const [redHash, greenHash] = [await drawnHash(page, red), await drawnHash(page, green)];
        expect(level(greenHash, levels), `#${green} ranks one level above #${red}`).toBe(level(redHash, levels) + 1);
      }
      for (const { id } of tops) expect(await drawnHash(page, id), `#${id} hashes to the top of the range`).toBeGreaterThanOrEqual(250);

      // Annotation overlays upload after the model finishes loading.
      await gpu.raceLoss('orthographic geometry and pixel assertions', () => page.waitForFunction(() => (globalThis.__ifc_lite_annotation_line_vertices__?.() ?? 0) >= 4));
      // Straight down (a hair off vertical, so the view keeps a horizontal up axis).
      const middle: Point = [0, topRowY / 2 + 0.6, TOP];
      const eye: Point = [middle[0], middle[1] - 0.01, 30];
      const overlapBoxes = pairs.map(({ x, y }): [Point, Point] => [[x, y - 0.2, TOP], [x + 0.5, y + 0.5, TOP]]);
      const topBoxes = tops.map(({ x }): [Point, Point] => [[x - 0.5, topRowY - 0.5, TOP], [x + 0.5, topRowY + 0.5, TOP]]);
      const lineEnds = tops.slice(0, 2).map(({ x }): [Point, Point] => [[x - 0.35, topRowY - 0.06, TOP], [x + 0.35, topRowY + 0.06, TOP]]);
      const textBoxes = tops.slice(2, 4).map(({ x }): [Point, Point] => [[x - 0.4, topRowY - 0.2, TOP], [x + 0.45, topRowY + 0.35, TOP]]);
      const frame = await orthoFrame(page, gpu, `plates-${site.size}`, eye, middle, 5);
      expect(frame.levels, 'the frame ranks with the predicted number of levels').toBe(levels);

      for (const [k, [corner, opposite]] of overlapBoxes.entries()) {
        const [red, green] = count(frame, corner, opposite, 3, isRed, isGreen);
        expect(green, `overlap ${k}: the higher-ranked plate is drawn`).toBeGreaterThan(200);
        expect(red, `overlap ${k}: the lower-ranked coplanar plate never shows through`).toBe(0);
      }
      for (const [k, [from, to]] of lineEnds.entries()) {
        const [ink] = count(frame, from, to, 0, isInk);
        const span = Math.abs(frame.px(to).x - frame.px(from).x);
        expect(ink, `line on top-hash plate ${k} is drawn over the face`).toBeGreaterThan(span * 0.5);
      }
      for (const [k, [corner, opposite]] of textBoxes.entries()) {
        const [ink] = count(frame, corner, opposite, 0, isInk);
        expect(ink, `text on top-hash plate ${k} is drawn over the face`).toBeGreaterThan(20);
      }

      // Selection highlight on one top-hash plate, a colour override on another.
      await page.evaluate(({ selected, overridden }) => {
        const state = globalThis.__ifc_lite_viewer_store__.getState();
        const model = [...state.models.values()][0]!;
        const selectedId = state.toGlobalId(model.id, selected);
        state.setSelectedEntityId(selectedId);
        state.setSelectedEntity({ modelId: model.id, expressId: selected });
        state.setSelectedEntityIds([selectedId]);
        state.setPendingColorUpdates(new Map([[state.toGlobalId(model.id, overridden), [1, 1, 0, 1]]]));
      }, { selected: tops[4]!.id, overridden: tops[5]!.id });
      await gpu.raceLoss('orthographic geometry and pixel assertions', () => page.waitForFunction(() => globalThis.__ifc_lite_viewer_store__.getState().pendingColorUpdates === null));
      const marked = await orthoFrame(page, gpu, `plates-${site.size}-marked`, eye, middle, 5);
      const [selectedCorner, selectedOpposite] = topBoxes[4]!;
      const [highlight, unhighlighted] = count(marked, selectedCorner, selectedOpposite, 4, isBlue, isGreen);
      expect(unhighlighted, 'the selection highlight covers the whole top-hash plate').toBe(0);
      expect(highlight, 'the selected plate is drawn in the highlight colour').toBeGreaterThan(500);
      const [overrideCorner, overrideOpposite] = topBoxes[5]!;
      const [overridden, original] = count(marked, overrideCorner, overrideOpposite, 4, isYellow, isGreen);
      expect(original, 'the override covers the whole top-hash plate').toBe(0);
      expect(overridden, 'the overridden plate is drawn in the override colour').toBeGreaterThan(500);
    });
  });
}

test.describe('clip planes', () => {
  let server: ViewerDevServer | undefined;
  test.beforeAll(async () => { server = await startViewerDevServer('ortho-depth-clip'); });
  test.afterAll(async () => { await server?.close(); });

  test('orthographic: the nudge never moves a vertex across the near or far plane (#6729)', async ({ page }) => {
    // Narrowed scene bounds, a 2 m viewer-space cube at the origin. From an eye
    // 10 m away the planes sit 10 -/+ (r + 0.1 r + 1) along the view
    // (computeOrthoNearFar); the live matrix confirms them below.
    const bounds: ViewerBox = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };
    const r = Math.sqrt(3), reach = r + 0.1 * r + 1;
    const yNear = -reach, yFar = reach; // IFC y of the planes for an eye at y = -10 looking along +y
    const sliver = 0.0003; // under one largest nudge at this range (255 levels x 8 units x ~5.8 m = 0.7 mm)
    const scene = new IfcScene();
    const square = scene.rectangle(0.6, 0.6);
    const top = (hash: number) => hash >= 250;
    const beyondFar = scene.product('IFCPLATE', '.NOTDEFINED.', [-1, yFar + sliver, 0], square, 0.0001, RED, top, 'y');
    const insideNear = scene.product('IFCPLATE', '.NOTDEFINED.', [1, yNear + sliver, 0], square, 0.0001, GREEN, top, 'y');
    // Below the crossing plate on screen in both views, so it never hides the cut.
    const control = scene.product('IFCPLATE', '.NOTDEFINED.', [0, 0, -1.2], square, 0.0001, YELLOW, top, 'y');
    // Annotation lines the same sliver beyond the far plane and inside the near plane.
    scene.line([-1.2, yFar + sliver], [-0.4, yFar + sliver], 0.9);
    scene.line([0.4, yNear + sliver], [1.2, yNear + sliver], 0.9);
    // A horizontal plate running from inside the range out through the far plane.
    const crossing = scene.product('IFCPLATE', '.NOTDEFINED.', [0, 2, -0.6], scene.rectangle(0.4, 8), 0.01, BLUE, top);
    const gpu = await watchGpuDeviceLoss(page);
    // #6232 F3: scene ownership and pixel assertions also need the live GPU,
    // including a device lost after a successful frame readback.
    await gpu.requireLiveGpu('orthographic geometry and pixel assertions', async () => {
      await loadScene(page, gpu, scene.toString(), server!.url);
      for (const id of [beyondFar, insideNear, control, crossing]) {
        expect(await drawnHash(page, id), `#${id} hashes to the top of the range`).toBeGreaterThanOrEqual(250);
      }

      await gpu.raceLoss('orthographic geometry and pixel assertions', () => page.waitForFunction(() => (globalThis.__ifc_lite_annotation_line_vertices__?.() ?? 0) >= 4));
      const ahead = await orthoFrame(page, gpu, 'clip-level', [0, -10, 0], [0, 0, 0], 1.5, bounds);
      expect(ahead.depth([0, yFar, 0]), 'the far plane is where the narrowed bounds put it').toBeCloseTo(0, 5);
      expect(ahead.depth([0, yNear, 0]), 'the near plane is where the narrowed bounds put it').toBeCloseTo(1, 5);
      expect((ahead.levels - 1) * ORTHOGRAPHIC_DEPTH_NUDGE_PER_LEVEL, 'one largest nudge reaches past the sliver').toBeGreaterThan(sliver / ahead.depthRange);
      const face = (x: number, y: number, z: number): [Point, Point] => [[x - 0.25, y, z - 0.25], [x + 0.25, y, z + 0.25]];
      const [farRed] = count(ahead, ...face(-1, yFar + sliver, 0), 0, isRed);
      expect(farRed, 'a top-hash plate just beyond the far plane stays clipped').toBe(0);
      const [nearGreen] = count(ahead, ...face(1, yNear + sliver, 0), 0, isGreen);
      expect(nearGreen, 'a top-hash plate just inside the near plane stays drawn').toBeGreaterThan(5000);
      const lineBand = (x0: number, x1: number, y: number): [Point, Point] => [[x0 + 0.05, y, 0.9 - 0.03], [x1 - 0.05, y, 0.9 + 0.03]];
      const [farInk] = count(ahead, ...lineBand(-1.2, -0.4, yFar + sliver), 0, isInk);
      expect(farInk, 'an annotation line just beyond the far plane stays clipped').toBe(0);
      const [nearInk] = count(ahead, ...lineBand(0.4, 1.2, yNear + sliver), 0, isInk);
      expect(nearInk, 'an annotation line just inside the near plane stays drawn').toBeGreaterThan(50);
      const [controlYellow] = count(ahead, ...face(0, 0, -1.2), 0, isYellow);
      expect(controlYellow, 'a plate mid-range is drawn').toBeGreaterThan(5000);

      // Looking down 25°, the crossing plate's far end is cut by the far plane.
      const e = (25 * Math.PI) / 180;
      const down = await orthoFrame(page, gpu, 'clip-crossing', [0, -10 * Math.cos(e), 10 * Math.sin(e)], [0, 0, 0], 1.5, bounds);
      // Depth is linear along the plate's top centreline; find where it is 0.
      const at = (y: number): Point => [0, y, -0.59];
      const d0 = down.depth(at(0)), d1 = down.depth(at(1));
      const cut = at(-d0 / (d1 - d0));
      expect(down.depth(cut)).toBeCloseTo(0, 6);
      const predicted = down.px(cut);
      let topmost = Infinity;
      for (let x = Math.round(predicted.x) - 3; x <= Math.round(predicted.x) + 3; x++) {
        for (let y = 0; y < down.height; y++) {
          const i = (y * down.width + x) * 4;
          if (isBlue(down.rgba[i]!, down.rgba[i + 1]!, down.rgba[i + 2]!)) { topmost = Math.min(topmost, y); break; }
        }
      }
      expect(Math.abs(topmost - predicted.y), `the crossing plate is cut at the far plane (row ${topmost}, predicted ${predicted.y.toFixed(1)})`).toBeLessThanOrEqual(2);
    });
  });
});
