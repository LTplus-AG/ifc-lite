/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * Several cutting planes on the production Renderer (#7545), read back from a
 * real WebGPU device.
 *
 * What is clipped is judged three independent ways at the same sample points:
 * the colour the renderer drew (a Renderer-produced screenshot), the GPU
 * ID-buffer pick, and the CPU raycaster. All three must equal the analytical
 * answer (kept where EVERY enabled plane keeps the point), for the flat,
 * instanced and point-cloud draw families, through one Renderer whose plane set
 * goes 0 -> 7 -> 2 -> 0 -> 7 -> (8, one beyond capacity) so resources are
 * reused, not rebuilt. Sample points within 0.5 m of an effective plane are
 * skipped (rasterisation of the exact boundary is not under test); every state
 * must still have kept AND removed samples, so an all-kept or all-removed
 * frame cannot pass.
 */

import { Renderer } from '../../packages/renderer/src/index.js';
import type { DecodedInstancedShard, MeshData } from '../../packages/geometry/src/index.js';

export type Family = 'flat' | 'instanced' | 'point';
type Vec3 = [number, number, number];

/** A plane as the analytical oracle sees it: kept where `dot(p, n) - d` is <= 0, or >= 0 when flipped. */
interface Plane { n: Vec3; d: number; flipped: boolean; effective: boolean }

export interface Mismatch {
  at: [number, number, number]; screen: [number, number];
  expected: boolean; colour: boolean; gpuPick: boolean; cpuPick: boolean | null;
}

export interface StateRow {
  family: Family; state: string; planes: number; kept: number; removed: number; skipped: number;
  /** Whether the CPU raycaster sees this family at all (judged on the unclipped baseline). */
  cpuSupported: boolean; mismatches: Mismatch[];
}

export interface SectionPlanesReport {
  adapter: { vendor?: string; architecture?: string; description?: string } | null;
  rows: StateRow[]; gpuErrors: number; errors: string[];
}

const ID: Record<Family, number> = { flat: 101, instanced: 103, point: 105 };
const CENTER: Record<Family, number> = { flat: -24, instanced: 0, point: 24 };
const CLEAR: [number, number, number, number] = [0.02, 0.02, 0.02, 1];
const CSS = { width: 640, height: 480 };
const MARGIN_METRES = 0.5;
const unit = (v: Vec3): Vec3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

/** The states, as a function of the family's centre x so every family is cut through its own middle. */
function states(cx: number): { name: string; planes: Plane[] }[] {
  const p1: Plane = { n: [1, 0, 0], d: cx + 4.5, flipped: false, effective: true }; // keeps x <= cx + 4.5 (the primary)
  const p2: Plane = { n: [1, 0, 0], d: cx - 6.5, flipped: true, effective: true }; // keeps x >= cx - 6.5 (flipped)
  const p3: Plane = { n: [0, 1, 0], d: 5.5, flipped: false, effective: true }; // keeps y <= 5.5
  const p4: Plane = { n: [0, -1, 0], d: 6.5, flipped: false, effective: true }; // keeps y >= -6.5
  const s = Math.SQRT1_2;
  const p5: Plane = { n: [s, s, 0], d: (cx + 4.5) * s, flipped: false, effective: true }; // keeps (x - cx) + y <= 4.5 (oblique)
  const far = (n: Vec3): Plane => ({ n, d: 100_000, flipped: false, effective: false }); // keeps everything near the scene
  const seven = [p1, p2, p3, p4, p5, far([0, 0, 1]), far([0, 0, -1]), far([0, 1, 0])]; // primary + 7 extras
  // One beyond capacity: effective, so a renderer that used it would remove the whole family.
  const beyond: Plane = { n: [0, 1, 0], d: -50, flipped: false, effective: true };
  return [
    { name: 'none', planes: [] },
    { name: 'seven-extras', planes: seven },
    { name: 'two', planes: [p1, p3] },
    { name: 'none-again', planes: [] },
    { name: 'seven-extras-again', planes: seven },
    { name: 'eight-extras-capacity', planes: [...seven, beyond] },
  ];
}

const dot = (p: Vec3, n: Vec3) => p[0] * n[0] + p[1] * n[1] + p[2] * n[2];
/** The oracle: the renderer's own rule, `(dot(p, n) - d) * (flipped ? -1 : 1) > 0` is removed. */
function keeps(planes: readonly Plane[], p: Vec3, capacity: number): boolean {
  return planes.slice(0, 1 + capacity).every((pl) => (dot(p, pl.n) - pl.d) * (pl.flipped ? -1 : 1) <= 0);
}
const nearestEffective = (planes: readonly Plane[], p: Vec3): number =>
  Math.min(Infinity, ...planes.filter((pl) => pl.effective).map((pl) => Math.abs(dot(p, pl.n) - pl.d)));

function flatMesh(cx: number): MeshData {
  return {
    expressId: ID.flat, origin: [cx, 0, 0], color: [1, 0.15, 0.1, 1],
    positions: new Float32Array([-10, -8, 0, 10, -8, 0, 10, 8, 0, -10, 8, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
  };
}

function instancedShard(cx: number): DecodedInstancedShard {
  // Native IFC is Z up; the viewer is Y up (x, z, -y). This rectangle faces the +Z camera in viewer space.
  return {
    templates: [{
      positions: new Float32Array([-10, 0, -8, 10, 0, -8, 10, 0, 8, -10, 0, 8]),
      normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
      indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
      origin: [cx, 0, 0],
    }],
    instances: [{
      templateIndex: 0, entityId: ID.instanced, color: [0.1, 0.8, 1, 1],
      transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    }],
    carriesItemIds: false,
  };
}

/** A 7 x 5 grid of points a few metres apart, at z = 1, none on a plane. */
const POINT_GRID: Vec3[] = (() => {
  const out: Vec3[] = [];
  for (const x of [-9, -6, -3, 0, 3, 6, 9]) for (const y of [-6, -3, 0, 3, 6]) out.push([x, y, 1]);
  return out;
})();

function samplePoints(family: Family, cx: number): Vec3[] {
  if (family === 'point') return POINT_GRID.map(([x, y, z]) => [cx + x, y, z]);
  const out: Vec3[] = [];
  for (let i = 0; i < 11; i++) for (let j = 0; j < 11; j++) out.push([cx - 9.5 + i * 1.9, -7.5 + j * 1.5, 0]);
  return out;
}

async function decode(dataUrl: string): Promise<{ at(x: number, y: number): [number, number, number] }> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const probe = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = probe.getContext('2d');
  if (!context) throw new Error('2D probe context unavailable');
  context.drawImage(bitmap, 0, 0);
  const { width, height } = bitmap;
  const pixels = context.getImageData(0, 0, width, height).data;
  bitmap.close();
  return {
    at(x, y) {
      const px = Math.min(width - 1, Math.floor(x * width / CSS.width)), py = Math.min(height - 1, Math.floor(y * height / CSS.height));
      const i = (py * width + px) * 4;
      return [pixels[i]!, pixels[i + 1]!, pixels[i + 2]!];
    },
  };
}
const isForeground = ([r, g, b]: [number, number, number]) => Math.max(Math.abs(r - 5), Math.abs(g - 5), Math.abs(b - 5)) > 8;

/** The renderer's `SectionPlane` for an oracle plane (an explicit normal and distance, used verbatim). */
const toSection = (pl: Plane) => ({ axis: 'side' as const, position: 50, enabled: true, flipped: pl.flipped, normal: pl.n, distance: pl.d });

export async function runSectionExtraPlanesWitness(): Promise<SectionPlanesReport> {
  const report: SectionPlanesReport = { adapter: null, rows: [], gpuErrors: 0, errors: [] };
  if (!navigator.gpu) throw new Error('WebGPU is unavailable');
  const canvas = document.createElement('canvas');
  canvas.width = CSS.width; canvas.height = CSS.height;
  canvas.style.cssText = `display:block;width:${CSS.width}px;height:${CSS.height}px`;
  document.body.replaceChildren(canvas);
  const renderer = new Renderer(canvas);
  try {
    await renderer.init();
    report.adapter = renderer.getAdapterInfo();
    const device = renderer.getGPUDevice();
    if (!device) throw new Error('Renderer initialized without a live GPU device');
    device.addEventListener('uncapturederror', (e: Event) => report.errors.push((e as GPUUncapturedErrorEvent).error.message));

    renderer.loadGeometry([flatMesh(CENTER.flat)]);
    renderer.getScene().addInstancedShard(device, instancedShard(CENTER.instanced));
    const handle = renderer.beginPointCloudStream({ expressId: ID.point });
    renderer.appendPointCloudChunk(handle, {
      positions: new Float32Array(POINT_GRID.flat()),
      colors: new Float32Array(POINT_GRID.flatMap(() => [0, 1, 1])),
      pointCount: POINT_GRID.length,
      bbox: { min: [-9, -6, 1], max: [9, 6, 1] },
    });
    renderer.setPointCloudTranslation(handle, [CENTER.point, 0, 0]);
    renderer.endPointCloudStream(handle);
    renderer.setPointCloudOptions({ colorMode: 'fixed', fixedColor: [0, 1, 1, 1], sizeMode: 'fixed-px', pointSize: 14 });

    const camera = renderer.getCamera();
    for (const family of ['flat', 'instanced', 'point'] as const) {
      const cx = CENTER[family];
      camera.setPosition(cx, 0, 60);
      camera.setTarget(cx, 0, 0);
      const points = samplePoints(family, cx);
      // Whether the CPU raycaster sees this family at all, judged on the unclipped frame.
      renderer.render({ clearColor: CLEAR });
      await device.queue.onSubmittedWorkDone();
      const centre = camera.projectToScreen({ x: points[0]![0], y: points[0]![1], z: points[0]![2] }, CSS.width, CSS.height);
      const cpuSupported = family !== 'point' && !!centre && renderer.raycastScene(centre.x, centre.y)?.intersection.expressId === ID[family];
      for (const state of states(cx)) {
        const [primary, ...extras] = state.planes;
        // The seven extras the renderer will honour; the eighth, when given, is beyond capacity.
        renderer.render({
          clearColor: CLEAR,
          ...(primary ? { sectionPlane: toSection(primary) } : {}),
          ...(extras.length ? { extraSectionPlanes: extras.map(toSection) } : {}),
        });
        await device.queue.onSubmittedWorkDone();
        const screenshot = await renderer.captureScreenshot();
        if (!screenshot) throw new Error(`no screenshot for ${family}/${state.name}`);
        const frame = await decode(screenshot);

        const row: StateRow = { family, state: state.name, planes: state.planes.length, kept: 0, removed: 0, skipped: 0, cpuSupported, mismatches: [] };
        for (const point of points) {
          if (nearestEffective(state.planes, point) < MARGIN_METRES) { row.skipped++; continue; }
          const screen = camera.projectToScreen({ x: point[0], y: point[1], z: point[2] }, CSS.width, CSS.height);
          if (!screen) throw new Error(`sample ${point} is off screen`);
          const expected = keeps(state.planes, point, 7);
          const colour = isForeground(frame.at(screen.x, screen.y));
          const pick = await renderer.pick(Math.floor(screen.x), Math.floor(screen.y));
          const gpuPick = pick?.expressId === ID[family];
          // The raycaster mirrors the last frame's clip, like the GPU picker.
          const cpuPick = cpuSupported ? renderer.raycastScene(screen.x, screen.y)?.intersection.expressId === ID[family] : null;
          expected ? row.kept++ : row.removed++;
          if (colour !== expected || gpuPick !== expected || (cpuPick !== null && cpuPick !== expected)) {
            row.mismatches.push({ at: point, screen: [screen.x, screen.y], expected, colour, gpuPick, cpuPick });
          }
        }
        report.rows.push(row);
      }
    }
    report.gpuErrors = renderer.getDiagnostics().gpuErrors;
    return report;
  } finally {
    renderer.destroy();
  }
}
