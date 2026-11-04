/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * #8769: the surface under a point from the last frame's own depth. A fake
 * device stands in for the GPU: the "texture" answers one device depth per
 * texel, and the probe must turn it back into the world point that frame drew.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from './camera.js';
import { FrameDepthProbe, type FrameDepthRecord } from './frame-depth-probe.js';
import { MathUtils } from './math.js';

const g = globalThis as Record<string, unknown>;
g.GPUBufferUsage ??= { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
g.GPUMapMode ??= { READ: 1 };

const TEX_W = 800, TEX_H = 600, CSS_W = 400, CSS_H = 300; // a 2x HiDPI canvas

interface FakeGpu {
  device: GPUDevice;
  shaders: string[];
  /** Texels the probe read, in submission order. */
  reads: Array<[number, number]>;
  /** Buffers created and how many were destroyed. */
  buffers: { destroyed: boolean }[];
}

/** `depthAt(tx, ty)` is what the depth attachment holds at that texel. */
function fakeGpu(depthAt: (tx: number, ty: number) => number, opts: { mapError?: Error } = {}): FakeGpu {
  const shaders: string[] = [];
  const reads: Array<[number, number]> = [];
  const buffers: { destroyed: boolean }[] = [];
  let lastTexel: [number, number] = [0, 0];
  const device = {
    createShaderModule: ({ code }: { code: string }) => { shaders.push(code); return {}; },
    createComputePipeline: () => ({ getBindGroupLayout: () => ({}) }),
    createBindGroup: () => ({}),
    createBuffer: ({ size, mappedAtCreation }: { size: number; mappedAtCreation?: boolean }) => {
      const data = new ArrayBuffer(Math.max(size, 8));
      const b = {
        data, destroyed: false,
        getMappedRange: () => data,
        unmap: () => { if (mappedAtCreation) lastTexel = [...new Uint32Array(data, 0, 2)] as [number, number]; },
        mapAsync: async () => { if (opts.mapError) throw opts.mapError; },
        destroy() { this.destroyed = true; },
      };
      buffers.push(b);
      return b;
    },
    createCommandEncoder: () => ({
      beginComputePass: () => ({ setPipeline() {}, setBindGroup() {}, dispatchWorkgroups() {}, end() {} }),
      copyBufferToBuffer: (_src: unknown, _so: number, dst: { data: ArrayBuffer }, offset: number) => {
        reads.push(lastTexel);
        new Float32Array(dst.data, offset, 1)[0] = depthAt(...lastTexel);
      },
      finish: () => ({}),
    }),
    queue: { submit() {} },
  };
  return { device: device as unknown as GPUDevice, shaders, reads, buffers };
}

const texture = (width = TEX_W, height = TEX_H) =>
  ({ width, height, createView: () => ({}) }) as unknown as GPUTexture;

/** A camera far out on a site, so the RTE camera translation matters. */
function siteCamera(): Camera {
  const camera = new Camera();
  camera.setAspect(TEX_W / TEX_H);
  camera.setPosition(250_000, 1_200_000, 900);
  camera.setTarget(250_400, 1_200_300, 0);
  return camera;
}

/** The attachment every frame below draws into, unless a test replaces it. */
const TEX = texture();

function record(camera: Camera, tex = TEX): FrameDepthRecord {
  return { snapshot: camera.getRelativeToEyeFrame().snapshot(), texture: tex, width: TEX_W, height: TEX_H, cssWidth: CSS_W, cssHeight: CSS_H };
}

/** The world point the frame drew at a texel centre with device depth `depth`. */
function drawnAt(rec: FrameDepthRecord, tx: number, ty: number, depth: number) {
  const inv = MathUtils.invert(rec.snapshot.getViewProjection())!;
  const rel = MathUtils.transformPoint(inv, { x: ((tx + 0.5) / TEX_W) * 2 - 1, y: 1 - ((ty + 0.5) / TEX_H) * 2, z: depth });
  const eye = rec.snapshot.getCameraWorld();
  return { x: rel.x + eye[0], y: rel.y + eye[1], z: rel.z + eye[2] };
}

describe('frame depth probe (#8769)', () => {
  it('misses before the first frame, without touching the GPU', async () => {
    const gpu = fakeGpu(() => 0.01);
    const probe = new FrameDepthProbe(gpu.device, () => TEX, 1);
    assert.equal(await probe.probe(10, 10, { width: CSS_W, height: CSS_H }), null, 'no frame recorded yet');
    assert.equal(gpu.reads.length, 0);
  });

  it('reads the texel under the CSS point and unprojects it with that frame, far from the origin', async () => {
    const camera = siteCamera();
    const rec = record(camera);
    const gpu = fakeGpu(() => 0.004);
    const probe = new FrameDepthProbe(gpu.device, () => TEX, 1);
    probe.frameDrawn(rec);
    const pending = probe.probe(100.4, 220.9, { width: CSS_W, height: CSS_H });
    // The camera moves before the readback lands: the answer is still the frame's.
    camera.setPosition(250_010, 1_200_010, 400);
    camera.getRelativeToEyeFrame();
    const point = await pending;
    assert.deepEqual(gpu.reads, [[200, 441]], 'CSS px scale to the depth attachment texel');
    assert.ok(point);
    const want = drawnAt(rec, 200, 441, 0.004);
    const err = Math.hypot(point.x - want.x, point.y - want.y, point.z - want.z);
    assert.ok(err < 1e-3, `world point off by ${err} m: ${JSON.stringify(point)} vs ${JSON.stringify(want)}`);
    // Independent of the inverse helpers both sides above use: project the
    // answer forward with a plain column-major product, back to its texel.
    const eye = rec.snapshot.getCameraWorld(), m = rec.snapshot.getViewProjection().m;
    const [rx, ry, rz] = [point.x - eye[0], point.y - eye[1], point.z - eye[2]];
    const clip = [0, 1, 2, 3].map((r) => m[r] * rx + m[4 + r] * ry + m[8 + r] * rz + m[12 + r]);
    const texX = ((clip[0] / clip[3] + 1) / 2) * TEX_W, texY = ((1 - clip[1] / clip[3]) / 2) * TEX_H;
    assert.ok(Math.abs(texX - 200.5) < 0.5 && Math.abs(texY - 441.5) < 0.5, `projects to texel (${texX}, ${texY}), not (200.5, 441.5)`);
    assert.ok(Math.abs(clip[2] / clip[3] - 0.004) < 1e-4, `at device depth ${clip[2] / clip[3]}, not 0.004`);
    assert.ok(gpu.buffers.every((b) => b.destroyed), 'every per-probe buffer is released');
  });

  it('records a submitted frame against the attachment current at submit, as the renderer publishes it', async () => {
    let tex = texture(TEX_W, TEX_H);
    const gpu = fakeGpu(() => 0.004);
    const probe = FrameDepthProbe.forPipeline(gpu.device, { getDepthTexture: () => tex, getSampleCount: () => 1 });
    const camera = siteCamera();
    const snapshot = camera.getRelativeToEyeFrame().snapshot();
    tex = texture(TEX_W, TEX_H); // a mid-frame resize swapped the attachment before submit
    probe.frameSubmitted(snapshot, { width: CSS_W, height: CSS_H });
    const point = await probe.probe(100.4, 220.9, { width: CSS_W, height: CSS_H });
    assert.ok(point, 'the frame is paired with the attachment every pass drew into');
    assert.deepEqual(gpu.reads, [[200, 441]]);
  });

  it('reports empty space (cleared reverse-Z depth) as a miss', async () => {
    const gpu = fakeGpu(() => 0);
    const probe = new FrameDepthProbe(gpu.device, () => TEX, 1);
    probe.frameDrawn(record(siteCamera()));
    assert.equal(await probe.probe(200, 150, { width: CSS_W, height: CSS_H }), null);
  });

  it('misses rather than misreads when the layout or attachment changed since the frame', async () => {
    const gpu = fakeGpu(() => 0.01);
    let tex = TEX;
    const probe = new FrameDepthProbe(gpu.device, () => tex, 1);
    probe.frameDrawn(record(siteCamera()));
    assert.equal(await probe.probe(200, 150, { width: CSS_W + 40, height: CSS_H }), null, 'canvas resized since the frame');
    assert.equal(await probe.probe(-1, 150, { width: CSS_W, height: CSS_H }), null, 'outside the canvas');
    assert.equal(await probe.probe(CSS_W, 150, { width: CSS_W, height: CSS_H }), null, 'past the right edge');
    tex = texture(TEX_W * 2, TEX_H * 2);
    assert.equal(await probe.probe(200, 150, { width: CSS_W, height: CSS_H }), null, 'attachment recreated by a resize');
    tex = texture();
    assert.equal(await probe.probe(200, 150, { width: CSS_W, height: CSS_H }), null, 'a same-sized replacement is not the frame\'s attachment either');
    assert.equal(gpu.reads.length, 0, 'none of those read the GPU');
  });

  it('resolves null when the device dies mid-readback', async () => {
    const abort = Object.assign(new Error('instance gone'), { name: 'AbortError' });
    const gpu = fakeGpu(() => 0.01, { mapError: abort });
    const probe = new FrameDepthProbe(gpu.device, () => TEX, 1);
    probe.frameDrawn(record(siteCamera()));
    assert.equal(await probe.probe(200, 150, { width: CSS_W, height: CSS_H }), null);
    assert.ok(gpu.buffers.every((b) => b.destroyed));
  });

  it('reads the nearest sample of a multisampled depth attachment', async () => {
    const gpu = fakeGpu(() => 0.01);
    const probe = new FrameDepthProbe(gpu.device, () => TEX, 4);
    probe.frameDrawn(record(siteCamera()));
    await probe.probe(200, 150, { width: CSS_W, height: CSS_H });
    const code = gpu.shaders.at(-1) ?? '';
    assert.match(code, /texture_depth_multisampled_2d/);
    assert.match(code, /s < 4i/, 'every sample is read');
    assert.match(code, /max\(d, textureLoad/, 'reverse-Z: the largest sample is the nearest surface');
  });
});
