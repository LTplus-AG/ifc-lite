/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, useRef, useState } from 'react';
import { RendererOverlays } from '../../../../../packages/renderer/src/renderer-overlays.js';
import { cleanup, render } from '@/test/render.js';
import { fixtureModel, fixtureModels } from '@/test/store-fixture.js';
import { useViewerStore } from '@/store';
import { useClashRendererOverlays } from './useClashRendererOverlays';

const initial = useViewerStore.getState();
const canvasContext = HTMLCanvasElement.prototype.getContext;
const disposals: Array<() => void> = [];
afterEach(() => { cleanup(); disposals.splice(0).forEach(dispose => dispose());
  HTMLCanvasElement.prototype.getContext = canvasContext; useViewerStore.setState(initial, true); });

function owner() {
  // RendererOverlays also allocates an unused text atlas. happy-dom has no
  // canvas context; provide only that unrelated constructor boundary. No glyph
  // output is supplied or tested, and any attempt to rasterize text fails.
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, writable: true,
    value(type: string) {
      if (type !== '2d') throw new Error('Only the unused atlas canvas is supported in this test');
      return { clearRect() { /* Empty atlas allocation only. */ },
        fillText() { throw new Error('Text rasterization is outside this clash buffer test'); } };
    } });
  Object.assign(globalThis, { GPUBufferUsage: { COPY_DST: 8, VERTEX: 32, INDEX: 16, UNIFORM: 64 },
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUColorWrite: { ALL: 15 } });
  const live = new Set<GPUBuffer>();
  const writes: Array<{ label: string; values: number[] }> = [];
  const faults: Array<{ label: string; phase: 'allocation' | 'write' }> = [];
  let pendingFault: (typeof faults)[number] | null = null;
  function refuse(label: string, phase: 'allocation' | 'write') {
    if (pendingFault?.label !== label || pendingFault.phase !== phase) return;
    faults.push(pendingFault); pendingFault = null;
    throw new RangeError(`GPU allocation refused during ${phase}: ${label}`);
  }
  // Only native allocation/queue boundaries are substituted. Actual production
  // RendererOverlays, Section2DOverlayRenderer and ClashSolidPipeline own every
  // upload, clear and destroy below; no provider/geometry result is mocked.
  const device = { limits: { minUniformBufferOffsetAlignment: 256 },
    createBuffer(descriptor: GPUBufferDescriptor) {
      if (descriptor.usage & GPUBufferUsage.VERTEX) refuse(descriptor.label ?? '', 'allocation');
      const buffer = { label: descriptor.label ?? '', size: descriptor.size, usage: descriptor.usage,
        destroy() { live.delete(buffer as unknown as GPUBuffer); } } as unknown as GPUBuffer;
      live.add(buffer); return buffer;
    },
    createShaderModule() { return {}; }, createBindGroupLayout() { return {}; },
    createPipelineLayout() { return {}; }, createBindGroup() { return {}; },
    createRenderPipeline() { return { getBindGroupLayout() { return {}; } }; },
    queue: { writeBuffer(buffer: GPUBuffer, _offset: number, data: Float32Array) {
      if (buffer.usage & GPUBufferUsage.VERTEX) refuse(buffer.label, 'write');
      writes.push({ label: buffer.label, values: Array.from(data) });
    } },
  } as unknown as GPUDevice;
  const overlays = new RendererOverlays({ getModelBounds: () => null,
    expandModelBoundsWithFlatVertices() { throw new Error('Clash focus must not redefine model extent'); },
    expandModelBoundsWithAnchoredLineVertices() { throw new Error('Clash focus must not redefine model extent'); },
    syncCameraSceneBounds() { throw new Error('Clash focus must not redefine model extent'); },
    requestRender() { /* Dirty scheduling is independent of the upload contract. */ } });
  overlays.init(device, 'bgra8unorm', 1);
  disposals.push(() => overlays.destroy());
  return { overlays, writes, live, faults,
    failNext(label: string, phase: 'allocation' | 'write') { pendingFault = { label, phase }; }, recover() {
    overlays.destroy(); assert.equal(live.size, 0, 'every old GPU buffer is disposed');
    overlays.init(device, 'bgra8unorm', 1);
    assert.deepEqual(overlays.recoveryOmissions(), [], 'replacement owners genuinely start empty');
  } };
}

for (const models of [1, 2]) for (const channel of ['contact', 'box'] as const)
for (const target of ['lines', 'solid'] as const) for (const phase of ['allocation', 'write'] as const) {
  it(`#7484 focused ${channel}/${target} ${phase} refusal keeps ${models}-model viewport mounted and retries retained input`, async () => {
    const sourceModels = Array.from({ length: models }, (_, index) => fixtureModel(`m${index}`, { idOffset: index * 1_000_000 }));
    const vertices = [10, 20, 30, 40, 50, 60];
    const positions = new Float64Array([10, 20, 30, 11, 20, 30, 10, 21, 30, 10, 20, 31]);
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const solid = { positions, indices };
    useViewerStore.setState({ ...fixtureModels(...sourceModels), clashSelectedId: 'retained-clash',
      clashContactLines: channel === 'contact' ? { vertices } : null,
      clashOverlapBox: { min: [10, 20, 30], max: [40, 50, 60] },
      showClashRegionBox: true, clashSolidStatus: 'solid', clashSolidMesh: solid });
    const modelOwner = useViewerStore.getState().models;
    const original = { vertices: vertices.slice(), positions: positions.slice(), indices: indices.slice() };
    const native = owner();
    let recover: () => void = () => { throw new Error('unmounted'); };
    function Probe() {
      const [epoch, setEpoch] = useState(0); recover = () => setEpoch(value => value + 1);
      useClashRendererOverlays(useRef(native.overlays), true, epoch);
      return <canvas />;
    }
    const ui = render(<Probe />);
    const uploads = () => native.writes.filter(write => write.label === '' || write.label === 'clash-solid-vbuf');
    const first = structuredClone(uploads());
    assert.equal(first.length, 2, 'real line and indexed tetrahedron uploads precede the fault');
    native.recover();
    const faultLabel = target === 'lines' ? '' : 'clash-solid-vbuf';
    const refusedAt = uploads().length;
    native.failNext(faultLabel, phase);
    await assert.doesNotReject(async () => { await act(async () => recover()); },
      'real clash buffer refusal must not escape the mounted viewport effect');
    assert.deepEqual(native.faults, [{ label: faultLabel, phase }], 'the production owner reached the fault boundary');
    assert.ok(ui.querySelector('canvas'), 'viewport survives either sibling failure');
    assert.equal([...native.live].filter(buffer => buffer.label === faultLabel && (buffer.usage & GPUBufferUsage.VERTEX)).length, 0,
      'clear disposes any newly allocated partial clash buffer');
    assert.deepEqual(uploads().slice(refusedAt), first.filter(write => write.label !== faultLabel),
      'the independent sibling still uploads its original geometry');
    assert.equal(useViewerStore.getState().models, modelOwner);
    assert.equal(useViewerStore.getState().clashSolidMesh, solid);
    assert.deepEqual(vertices, original.vertices); assert.deepEqual(positions, original.positions); assert.deepEqual(indices, original.indices);
    native.recover(); const written = uploads().length;
    await act(async () => recover());
    assert.deepEqual(uploads().slice(written), first, 'a later recovery uploads the exact retained line and solid coordinates');
  });
}

for (const models of [1, 2]) for (const channel of ['contact', 'box'] as const) {
  it(`#6993/#7484 retained ${channel} focus and intersection solid replay into real replacement owners at ${models} models`, async () => {
    const sourceModels = Array.from({ length: models }, (_, index) => fixtureModel(`m${index}`, { idOffset: index * 1_000_000 }));
    // Stated invariant: one two-point contact and a four-face tetrahedron.
    // This proves retained overlay ownership, not kernel intersection accuracy,
    // native driver reset, rendering throughput or a vendor model measurement.
    const vertices: number[] = [10, 20, 30, 40, 50, 60];
    const positions = new Float64Array([10, 20, 30, 11, 20, 30, 10, 21, 30, 10, 20, 31]);
    const indices = new Uint32Array([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
    const contact = { vertices };
    const box: NonNullable<ReturnType<typeof useViewerStore.getState>['clashOverlapBox']> = { min: [10, 20, 30], max: [40, 50, 60] };
    const solid = { positions, indices };
    useViewerStore.setState({ ...fixtureModels(...sourceModels), clashSelectedId: 'retained-clash',
      clashContactLines: channel === 'contact' ? contact : null, clashOverlapBox: box,
      showClashRegionBox: true, clashSolidStatus: 'solid', clashSolidMesh: solid });
    const modelOwner = useViewerStore.getState().models;
    const originalVertices = vertices.slice(), originalPositions = positions.slice(), originalIndices = indices.slice();
    const native = owner();
    let recover: () => void = () => { throw new Error('unmounted'); };
    function Probe() {
      const [epoch, setEpoch] = useState(0);
      recover = () => setEpoch(value => value + 1);
      const ref = useRef(native.overlays);
      useClashRendererOverlays(ref, true, epoch);
      return <canvas />;
    }
    const ui = render(<Probe />);
    const uploads = () => native.writes.filter(write => write.label === '' || write.label === 'clash-solid-vbuf');
    const first = structuredClone(uploads());
    assert.equal(first.filter(write => write.label === '').length, 1, 'production contact/box line buffer is allocated');
    assert.equal(first.find(write => write.label === '')?.values.length, channel === 'contact' ? 6 : 72);
    assert.equal(first.filter(write => write.label === 'clash-solid-vbuf').length, 1);
    assert.equal(first.find(write => write.label === 'clash-solid-vbuf')?.values.length, 4 * 3 * 7, 'production solid expands four indexed faces');
    assert.ok(native.overlays.recoveryOmissions().includes('line-overlays'));
    native.recover();
    const written = uploads().length;
    console.info('clash-focus-recovery-prerequisites', JSON.stringify({ models, channel, lineVertices: channel === 'contact' ? 2 : 24,
      solidTriangles: 4, disposed: true, replacementEmpty: true }));
    await act(async () => recover());
    const replay = uploads().slice(written);
    assert.equal(replay.filter(write => write.label === '').length, 1, 'recovery replays retained focused contact/box');
    assert.equal(replay.filter(write => write.label === 'clash-solid-vbuf').length, 1, 'recovery replays retained intersection solid');
    assert.deepEqual(replay, first, 'both actual replacement GPU owners receive the same retained coordinates');
    assert.equal(useViewerStore.getState().models, modelOwner);
    assert.equal(useViewerStore.getState().clashSolidMesh, solid);
    assert.deepEqual(vertices, originalVertices); assert.deepEqual(positions, originalPositions); assert.deepEqual(indices, originalIndices);
    await act(async () => useViewerStore.setState({ showClashRegionBox: false, clashSelectedId: null }));
    assert.deepEqual(native.overlays.recoveryOmissions(), [], 'focus teardown clears both recreated owners');
    assert.ok(ui.querySelector('canvas'));
  });
}
