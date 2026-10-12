/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import '@/test/setup-dom.js';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';
import { act, Component, useRef, useState, type ReactNode } from 'react';
import type { Renderer, SymbolicFillInput, SymbolicTextInput } from '@ifc-lite/renderer';
import { WorldLineBuffer } from '../../../../../packages/renderer/src/section-2d-line-buffer.js';
import { SymbolicFillPipeline, SymbolicTextPipeline } from '../../../../../packages/renderer/src/symbolic-overlay-pipelines.js';
import type { SymbolicTextAtlas } from '../../../../../packages/renderer/src/symbolic-text-atlas.js';
import { cleanup, render } from '@/test/render.js';
import { useViewportSymbolicUploads } from './useViewportSymbolicUploads.js';
import { resetGpuUploadGuardForTests } from './gpu-upload-guard.js';
import type { RendererLineVertices } from '@/lib/renderer/line-overlay-rte';

const disposals: Array<() => void> = [];

// Actual production buffer owners run on a controlled allocation/queue boundary;
// glyph geometry is a stated single-glyph fixture, not a physical-GPU claim.
function fixture() {
  Object.assign(globalThis, {
    GPUShaderStage: { VERTEX: 1, FRAGMENT: 2 }, GPUColorWrite: { ALL: 15 },
    GPUBufferUsage: { COPY_DST: 8, VERTEX: 32, UNIFORM: 64 },
    GPUTextureUsage: { COPY_DST: 8, TEXTURE_BINDING: 4 },
  });
  let allocations = 0, failAt = Infinity, writeAttempts = 0, failWriteAt = Infinity;
  const failures: string[] = [];
  const live = new Set<GPUBuffer>();
  const writes: ArrayBuffer[] = [];
  const device = new Proxy({}, { get(_target, name) {
    if (name === 'createBuffer') return ({ size }: GPUBufferDescriptor) => {
      if (++allocations === failAt) { failures.push('allocation'); throw new RangeError('GPU createBuffer allocation failed (#6993)'); }
      const buffer = { size, destroy: () => live.delete(buffer as unknown as GPUBuffer) } as unknown as GPUBuffer;
      live.add(buffer); return buffer;
    };
    if (name === 'queue') return {
      writeBuffer(_buffer: GPUBuffer, _offset: number, data: ArrayBufferView) {
        if (++writeAttempts === failWriteAt) { failures.push('queue write'); throw new RangeError('GPU writeBuffer upload failed (#6993)'); }
        writes.push(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
      }, copyExternalImageToTexture() {},
    };
    if (name === 'createTexture') return () => ({ createView: () => ({}), destroy() {} });
    return () => ({});
  } }) as GPUDevice;
  const atlas = {
    atlasSize: 64, glyphPx: 48, canvas: {}, getVersion: () => 1,
    layoutString: () => ({ totalAdvancePx: 12, glyphs: [{ xOffsetPx: 0,
      glyph: { u0: 0, v0: 0, u1: 0.25, v1: 0.25, widthPx: 12,
        heightPx: 24, advancePx: 12, baselinePx: 18 } }] }),
  } as unknown as SymbolicTextAtlas;
  const lines = { annotation: new WorldLineBuffer(0), alignment: new WorldLineBuffer(1), grid: new WorldLineBuffer(2) };
  const fills = new SymbolicFillPipeline(device, 'bgra8unorm', 1);
  const texts = new SymbolicTextPipeline(device, 'bgra8unorm', 1, atlas);
  fills.upload([]); texts.upload([]);
  const persistentBuffers = live.size;
  const target: Pick<Renderer, 'setLineOverlay' | 'uploadAnnotationFills3D' | 'uploadAnnotationTexts3D'> = {
    setLineOverlay(channel, value) {
      assert.ok(channel === 'annotation' || channel === 'alignment' || channel === 'grid');
      if (value === null) lines[channel].clear(); else lines[channel].upload(device, value);
    },
    uploadAnnotationFills3D: value => fills.upload(value),
    uploadAnnotationTexts3D: value => texts.upload(value),
  };
  const dispose = () => { for (const line of Object.values(lines)) line.clear(); fills.destroy(); texts.destroy(); };
  disposals.push(dispose);
  return { target, lines, fills, texts, live, writes, failures, persistentBuffers,
    faultAfter(count: number) { failAt = allocations + count; },
    faultWriteAfter(count: number) { failWriteAt = writeAttempts + count; },
    recover() { failAt = failWriteAt = Infinity; },
    dispose,
  };
}

const empty = new Float32Array(0);
const twoLines: RendererLineVertices = [
  { localVertices: new Float32Array([0, 0, 0, 1, 0, 0]), origin: [0, 0, 0] },
  { localVertices: new Float32Array([0, 0, 0, 0, 1, 0]), origin: [2, 0, 0] },
];
const twoFills: SymbolicFillInput[] = [0, 2].map<SymbolicFillInput>(x => ({
  points: new Float32Array([0, 0, 1, 0, 0, 1]), holesOffsets: new Uint32Array(0), worldY: 0, color: [1, 0, 0, 1], origin: [x, 0, 0],
}));
const glyph: SymbolicTextInput[] = [{ content: 'A', worldPos: [0, 0, 0], dirX: 1, dirZ: 0, height: 0.48, alignment: 'bottom-left' }];

type Data = Pick<Parameters<typeof useViewportSymbolicUploads>[0], 'annotation' | 'alignment' | 'grid' | 'fills' | 'texts'>;
function mount(native: ReturnType<typeof fixture>, initial: Data) {
  let update: (data: Data, epoch: number, visible?: boolean) => void = () => { throw new Error('unmounted fixture'); };
  let boundaryErrors = 0;
  const count = { current: 0 };
  class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch() { boundaryErrors++; }
    render() { return this.state.failed ? <p>viewport unmounted</p> : this.props.children; }
  }
  function Viewport() {
    const [state, set] = useState({ data: initial, epoch: 0, visible: true });
    update = (data, epoch, visible = true) => set({ data, epoch, visible });
    const rendererRef = useRef<typeof native.target | null>(native.target);
    useViewportSymbolicUploads({ rendererRef, isInitialized: true, gpuRecoveryEpoch: state.epoch,
      ...state.data, gridVisible: state.visible, annotationCountRef: count });
    return <canvas data-testid="surviving-viewport" />;
  }
  const ui = render(<Boundary><Viewport /></Boundary>);
  return { update, count, ui, errors: () => boundaryErrors };
}
const data = (): Data => ({ annotation: empty, alignment: empty, grid: empty, fills: [], texts: [] });
afterEach(() => { cleanup(); for (const dispose of disposals.splice(0)) dispose(); resetGpuUploadGuardForTests(); });

for (const channel of ['annotation', 'alignment', 'grid'] as const) {
  it(`contains partial ${channel} allocation and retries unchanged CPU lines on recovery (#6993/#7484)`, async () => {
    const native = fixture(); const initial = { ...data(), [channel]: twoLines };
    const ui = mount(native, initial);
    const positiveVertexCount = native.lines[channel].vertexCount;
    assert.equal(positiveVertexCount, 4, 'actual two source partitions reached their buffer owner');
    const cpu = structuredClone(twoLines);
    if (channel === 'annotation') native.faultWriteAfter(2); else native.faultAfter(2);
    const replacement = { ...initial, [channel]: structuredClone(twoLines) };
    await act(async () => ui.update(replacement, 0));
    console.info('overlay-prerequisites', JSON.stringify({ case: channel, positiveVertexCount, faults: native.failures, actualWrites: native.writes.length }));
    assert.equal(native.failures.length, 1, 'the actual GPU boundary refused the replacement after the positive upload');
    assert.equal(ui.errors(), 0, 'the sibling upload must not unmount React');
    assert.equal(native.lines[channel].vertexCount, 0, 'completed partial partitions are dropped');
    assert.equal(native.live.size, native.persistentBuffers, 'failed replacement retains no drawable line buffers');
    if (channel === 'annotation') assert.equal(ui.count.current, 0);
    assert.deepEqual(twoLines, cpu, 'the CPU source is retained without rewriting coordinates');
    native.recover();
    await act(async () => ui.update(replacement, 1));
    assert.equal(native.lines[channel].vertexCount, 4);
    assert.ok(ui.ui.querySelector('canvas'));
    assert.equal(ui.errors(), 0);
  });
}

for (const kind of ['fills', 'texts'] as const) {
  it(`contains ${kind} allocation, clears partial GPU ownership and retries identical input (#6993/#7484)`, async () => {
    const native = fixture(); const initial: Data = kind === 'fills' ? { ...data(), fills: twoFills } : { ...data(), texts: glyph };
    const ui = mount(native, initial);
    const positiveGeometry = native[kind].hasGeometry();
    assert.ok(positiveGeometry, 'the real pipeline accepted the fixture first');
    const source = structuredClone(initial);
    native.faultAfter(2);
    const replacement = structuredClone(initial);
    await act(async () => ui.update(replacement, 0));
    console.info('overlay-prerequisites', JSON.stringify({ case: kind, positiveGeometry, faults: native.failures, actualWrites: native.writes.length }));
    assert.equal(native.failures.length, 1, 'the real resource allocation reached the injected refusal');
    assert.equal(ui.errors(), 0);
    assert.equal(native[kind].hasGeometry(), false, 'no partial symbolic layer remains drawable');
    assert.equal(native.live.size, native.persistentBuffers, 'no replacement allocation leaks');
    assert.deepEqual(initial, source, 'CPU rich data survives the failed upload');
    native.recover();
    await act(async () => ui.update(replacement, 1));
    assert.ok(native[kind].hasGeometry(), 'recovery must restore actual retained symbolic data');
    assert.ok(ui.ui.querySelector('canvas'));
  });
}
