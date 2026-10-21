/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { Renderer } from '../../packages/renderer/src/index.js';
import type { RenderOptions } from '../../packages/renderer/src/types.js';
import type { DecodedInstancedShard, MeshData } from '../../packages/geometry/src/index.js';
import { shadowProbe } from './selective-clipping-shadow.gpu.js';

const WIDTH = 640, HEIGHT = 480;
const COLOR: [number, number, number, number] = [0.1, 0.8, 1, 1];
const PRIMARY = { axis: 'side' as const, position: 50, enabled: true, normal: [0, 1, 0] as [number, number, number], distance: 0 };
const EXTRA = { ...PRIMARY, normal: [0, -1, 0] as [number, number, number], distance: 2 };
type Family = 'batched' | 'instanced' | 'wide-instanced' | 'individual';
interface Sample { id: number; x: number; y: number; expected: boolean; color: boolean; gpu: number | null; cpu: number | null }
export interface SelectiveClippingReport {
  adapter: ReturnType<Renderer['getAdapterInfo']>;
  rows: { family: Family; state: string; checked: number; mismatches: Sample[]; shadowMismatches: number[] }[];
  errors: string[];
  gpuErrors: number;
  screenshot: string | null;
}

function mesh(id: number, x: number): MeshData {
  return { expressId: id, origin: [x, 0, 0], color: COLOR,
    positions: new Float32Array([-4, -4, 0, 4, -4, 0, 4, 4, 0, -4, 4, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
}

function shard(cx = 18, firstId = 201): DecodedInstancedShard {
  return { templates: [{ origin: [cx, 0, 0],
    positions: new Float32Array([-4, 0, -4, 4, 0, -4, 4, 0, 4, -4, 0, 4]),
    normals: new Float32Array([0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1, 0]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]) }],
    instances: [-6, 6].map((x, i) => ({ templateIndex: 0, entityId: firstId + i, color: COLOR,
      transform: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]) })),
    carriesItemIds: false };
}

async function pixels(data: string): Promise<(x: number, y: number) => boolean> {
  const bitmap = await createImageBitmap(await (await fetch(data)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('No pixel readback context');
  context.drawImage(bitmap, 0, 0);
  const { data: rgba } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  const width = bitmap.width, height = bitmap.height;
  bitmap.close();
  return (x, y) => {
    const i = (Math.floor(y * height / HEIGHT) * width + Math.floor(x * width / WIDTH)) * 4;
    return Math.max(rgba[i]!, rgba[i + 1]!, rgba[i + 2]!) > 30;
  };
}

/** #8015: an analytical oracle on the production GPU paths, including mutable-set transitions. */
export async function runSelectiveClippingWitness(): Promise<SelectiveClippingReport> {
  const canvas = document.createElement('canvas');
  canvas.width = WIDTH; canvas.height = HEIGHT;
  canvas.style.cssText = `display:block;width:${WIDTH}px;height:${HEIGHT}px`;
  document.body.replaceChildren(canvas);
  const renderer = new Renderer(canvas);
  let shadow: ReturnType<typeof shadowProbe> | undefined;
  const report: SelectiveClippingReport = { adapter: null, rows: [], errors: [], gpuErrors: 0, screenshot: null };
  try {
    await renderer.init();
    report.adapter = renderer.getAdapterInfo();
    const device = renderer.getGPUDevice();
    if (!device) throw new Error('No live WebGPU device');
    device.addEventListener('uncapturederror', (event: Event) => report.errors.push((event as GPUUncapturedErrorEvent).error.message));
    renderer.loadGeometry([mesh(101, -24), mesh(102, -12)]);
    if (!renderer.getScene().getBatchedMeshes().some(batch => batch.expressIds.includes(101) && batch.expressIds.includes(102))) {
      throw new Error('Witness must exercise two entities in the same colour batch');
    }
    renderer.getScene().addInstancedShard(device, shard());
    renderer.getScene().addInstancedShard(device, shard(54, 0x40000065));
    shadow = shadowProbe(device, renderer.getScene());
    for (const family of ['batched', 'instanced', 'wide-instanced', 'individual'] as const) {
      const cx = family === 'batched' ? -18 : family === 'instanced' ? 18 : family === 'wide-instanced' ? 54 : 0;
      const first = family === 'batched' ? 101 : family === 'instanced' ? 201 : family === 'wide-instanced' ? 0x40000065 : 301;
      if (family === 'individual') {
        renderer.getScene().clear();
        for (const index of [0, 1]) {
          const data = mesh(first + index, index === 0 ? -6 : 6);
          renderer['scene'].addMeshData(data); // Internal registration for the individual-draw CPU oracle.
          renderer.createMeshFromData(data);
        }
        for (const individual of renderer.getScene().getMeshes()) individual.hydrated = false;
        renderer.ensureMeshResources();
        renderer.setModelBounds({ min: { x: -10, y: -4, z: -1 }, max: { x: 10, y: 4, z: 1 } });
      }
      const excluded = new Set<number>();
      const camera = renderer.getCamera();
      camera.setPosition(cx, 0, 35); camera.setTarget(cx, 0, 0);
      const states = ['baseline', 'clipped', 'first-whole', 'both-whole', 'second-whole', 'cleared', 'extra-only', 'hidden', 'crop-box'] as const;
      for (const state of states) {
        if (state === 'first-whole') excluded.add(first);
        if (state === 'both-whole') excluded.add(first + 1);
        if (state === 'second-whole') excluded.delete(first);
        if (state === 'cleared') excluded.clear();
        if (state === 'extra-only') excluded.add(first);
        const options: RenderOptions = { clearColor: [0.02, 0.02, 0.02, 1], sectionExcludedIds: excluded,
          sunShadows: { enabled: true, resolution: 512 } };
        if (state !== 'baseline') {
          options.extraSectionPlanes = [EXTRA];
          if (state !== 'extra-only') options.sectionPlane = PRIMARY;
        }
        if (state === 'hidden') options.hiddenIds = new Set([first]);
        if (state === 'crop-box') options.clipBox = { enabled: true, min: [cx - 2, -10, -10], max: [cx + 12, 10, 10] };
        renderer.render(options);
        await device.queue.onSubmittedWorkDone();
        const screenshot = await renderer.captureScreenshot();
        if (!screenshot) throw new Error(`No screenshot: ${family}/${state}`);
        if (family === 'batched' && state === 'first-whole') report.screenshot = screenshot;
        const foreground = await pixels(screenshot);
        const row: SelectiveClippingReport['rows'][number] = { family, state, checked: 0, mismatches: [], shadowMismatches: [] };
        const expectedSamples: boolean[] = [];
        for (const index of [0, 1]) for (const y of [-3, -1, 2]) {
          const id = first + index, x = cx + (index === 0 ? -6 : 6);
          const screen = camera.projectToScreen({ x, y, z: 0 }, WIDTH, HEIGHT);
          if (!screen) throw new Error('Oracle sample outside camera');
          const planeKeeps = state === 'baseline' || excluded.has(id) || (y >= -2 && (state === 'extra-only' || y <= 0));
          const expected = planeKeeps && !(state === 'hidden' && id === first) && !(state === 'crop-box' && index === 0);
          expectedSamples.push(expected);
          const color = foreground(screen.x, screen.y);
          const gpu = (await renderer.pick(Math.floor(screen.x), Math.floor(screen.y)))?.expressId ?? null;
          const cpu = renderer.raycastScene(screen.x, screen.y)?.intersection.expressId ?? null;
          row.checked++;
          // The existing pick transport stores 30-bit IDs. Its clipping lookup
          // must still use the full ID, independently of the encoded sample.
          const pickId = family === 'wide-instanced' ? id & 0x3FFFFFFF : id;
          if (color !== expected || gpu !== (expected ? pickId : null) || cpu !== (expected ? id : null)) row.mismatches.push({ id, x, y, expected, color, gpu, cpu });
        }
        // Visibility partitioning is tested through Renderer above. The depth oracle
        // tests the production ShadowPass clipping itself on the real scene buffers.
        if (state !== 'hidden') {
          const depths = await shadow.read(cx, {
            sectionExcludedIds: excluded,
            section: options.sectionPlane ? { normal: PRIMARY.normal, distance: PRIMARY.distance } : null,
            extraPlanes: options.extraSectionPlanes ? [{ normal: EXTRA.normal, distance: EXTRA.distance, flipped: false }] : [],
            box: options.clipBox,
          });
          row.shadowMismatches = depths.flatMap((kept, index) => kept === expectedSamples[index] ? [] : [index]);
        }
        report.rows.push(row);
      }
    }
    report.gpuErrors = renderer.getDiagnostics().gpuErrors;
    return report;
  } finally { shadow?.destroy(); renderer.destroy(); }
}
