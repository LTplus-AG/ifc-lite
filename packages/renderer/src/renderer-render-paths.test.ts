/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';
import { Picker } from './picker.js';
import type { MeshData } from '@ifc-lite/geometry';
import type { RenderOptions, BatchedMesh, Mesh } from './types.js';
import type { Scene } from './scene.js';
import { OpaqueVisibilityPass } from './opaque-visibility-pass.js';
import { mainShaderSource } from './shaders/main.wgsl.js';
import type { RenderPipeline } from './pipeline.js';
import { DEFAULT_GHOST_ALPHA } from './overlay-routing.js';
import { rteRelativePositionF32 } from './relative-to-eye.js';
import { MESH_UNIFORM_BYTES, MESH_UNIFORM_OFFSET } from './mesh-rte-uniforms.js';
import type { MeshUniformSlot } from './mesh-uniform-arena.js';
import type { GaussianBackend } from './gaussian/gaussian-backend.js';

async function requireColorTable() {
    const module = await import('./entity-color-table.js').catch(() => null);
    assert.ok(module, 'the renderer provides the entity colour table');
    return module;
}

/**
 * Drives the REAL render() loop against a stub GPU so the frame-lifecycle
 * fixes are exercised end to end without a browser: error-scope push/pop
 * balance on every exit path, destroy() idempotency, content-based
 * visibility epochs reaching the batched draw path, partial-cache
 * drop/rebuild on hide/isolate toggling, hydrated-mesh disposal across
 * selections and federated models, and the pick path's device-liveness
 * guard. The stub records buffer creates/destroys, draw calls and
 * `mapAsync` readbacks; everything else (Scene, Camera, batching, caches,
 * Picker, PickingManager) is real.
 */

// WebGPU enum globals used by Scene buffer creation (not defined in node).
(globalThis as Record<string, unknown>).GPUBufferUsage = {
    MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16,
    VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512,
};
(globalThis as Record<string, unknown>).GPUMapMode = { READ: 1, WRITE: 2 };
(globalThis as Record<string, unknown>).GPUTextureUsage = {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
};
// Used by the SkyPass bind-group layout (GPUShaderStage.FRAGMENT).
(globalThis as Record<string, unknown>).GPUShaderStage = {
    VERTEX: 1, FRAGMENT: 2, COMPUTE: 4,
};

/**
 * Verbatim Chromium/Dawn wording when a pending (or newly issued) buffer map
 * is completed by wire-client shutdown — i.e. the GPU device behind it is
 * destroyed or lost. This is the exact string reported in #1901.
 */
const MAP_ASYNC_ABORT =
    "Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists.";

interface FakeBuffer {
    size: number;
    destroyed: number;
    getMappedRange(): ArrayBuffer;
    mapAsync(mode: number): Promise<void>;
    unmap(): void;
    destroy(): void;
}

interface Harness {
    renderer: Renderer;
    stats: {
        push: number;
        pop: number;
        submissions: number;
        /** vertex buffer bound at slot 0 when each drawIndexed fired */
        draws: unknown[];
        createdBuffers: FakeBuffer[];
        /** how many times a readback buffer was actually mapped */
        mapAsync: number;
        /** every `queue.writeBuffer` payload, copied at call time */
        writes: { buffer: unknown; offset: number; floats: Float32Array }[];
        /** what each buffer holds after every write, kept when a test clears `writes` */
        gpuBytes: Map<unknown, Uint8Array>;
        /**
         * Ordered log of `setPipeline` / `setBindGroup` / `drawIndexed` calls on
         * the render pass, so a test can assert command ORDER (e.g. that the
         * lighting environment is rebound at group(1) after the sky pass).
         */
        commands: { op: string; index?: number; pipeline?: unknown }[];
        /** label of every `beginRenderPass` in call order (so a test can assert
         *  the sun shadow depth pass IS or is NOT encoded). */
        passes: string[];
        /** number of GPU textures allocated after the harness is constructed */
        createdTextures: number;
        /** label and size of every texture allocated, in call order */
        textures: { label: string; width: number; height: number }[];
        /** label of every texture whose `destroy()` fired (shadow depth-texture
         *  release on toggle-off). */
        destroyedTextures: string[];
        /** every buffer handed to `RenderPipeline.setEntityColorTableBuffer` (#6076) */
        boundColorTables: unknown[];
    };
    knobs: {
        /** 'texture' = getCurrentTexture succeeds; 'null' = returns null */
        textureMode: 'texture' | 'null';
        visibilityCompilation: Promise<GPURenderPipeline> | null;
        /** make command encoding throw (mid-encode device fault) */
        encodeThrows: boolean;
        /** make queue.submit() throw after the color readback has been encoded */
        submitThrows: boolean;
        /** #6881: faults after a Picker owns transient readback buffers. */
        pickFault: 'id-copy' | 'depth-encode' | 'depth-copy' | 'finish' | 'mapped-range' | null;
        /** make popErrorScope() reject (device lost while scope pending) */
        popRejects: boolean;
        /**
         * The GPU device behind the stub is gone (destroyed by us, or lost to a
         * driver reset / GPU-process crash). Set automatically by
         * `device.destroy()`; set by hand to model an involuntary loss, where
         * the device object stays wired up but every map rejects.
         */
        gpuDead: boolean;
        /**
         * Park every `mapAsync` instead of resolving it, so a test can land a
         * teardown *while a readback is in flight* — the window no entry guard
         * can close. `settlePendingMaps()` decides how each parked map ends.
         */
        deferMaps: boolean;
    };
    render(options?: RenderOptions): void;
    /** flush the popErrorScope() promise chains */
    settle(): Promise<void>;
    /** number of `mapAsync` calls currently parked (deferMaps) */
    pendingMaps(): number;
    loseDevice(): void;
    /** complete every parked map: resolve it, or reject it with `reason` */
    settlePendingMaps(reason?: unknown): void;
}

const OPAQUE_PIPELINE = { label: 'opaque', getBindGroupLayout: () => ({}) };
const TRANSPARENT_PIPELINE = { label: 'transparent' };
const GHOST_PIPELINE = { label: 'ghost' };

function makeHarness(): Harness {
    const stats: Harness['stats'] = { push: 0, pop: 0, submissions: 0, draws: [], createdBuffers: [], mapAsync: 0, writes: [], gpuBytes: new Map(), commands: [], passes: [], createdTextures: 0, textures: [], destroyedTextures: [], boundColorTables: [] };
    const knobs: Harness['knobs'] = {
        textureMode: 'texture', visibilityCompilation: null, encodeThrows: false, submitThrows: false, popRejects: false, gpuDead: false,
        deferMaps: false, pickFault: null,
    };
    let loseDevice!: () => void;
    const lost = new Promise<void>((resolve) => { loseDevice = resolve; });
    const parkedMaps: { resolve: () => void; reject: (e: unknown) => void }[] = [];

    const makeBuffer = (desc: { size: number; usage?: number }): FakeBuffer => {
        const buf: FakeBuffer & { _ab: ArrayBuffer } = {
            size: desc.size,
            destroyed: 0,
            _ab: new ArrayBuffer(desc.size),
            getMappedRange() {
                if (knobs.pickFault === 'mapped-range' && ((desc.usage ?? 0) & GPUBufferUsage.MAP_READ)) {
                    throw new Error('boom mapped range');
                }
                return this._ab;
            },
            mapAsync() {
                stats.mapAsync++;
                // Same failure mode as the browser: a map issued against a dead
                // device rejects rather than resolving.
                if (knobs.gpuDead) {
                    return Promise.reject(new DOMException(MAP_ASYNC_ABORT, 'AbortError'));
                }
                if (knobs.deferMaps) {
                    return new Promise<void>((resolve, reject) => { parkedMaps.push({ resolve, reject }); });
                }
                return Promise.resolve();
            },
            unmap() { /* no-op */ },
            destroy() { this.destroyed++; },
        };
        stats.createdBuffers.push(buf);
        return buf;
    };

    let boundVertexBuffer: unknown = null;
    const pass = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            if (prop === 'setVertexBuffer') {
                return (slot: number, buf: unknown) => { if (slot === 0) boundVertexBuffer = buf; };
            }
            if (prop === 'setPipeline') {
                return (pipeline: unknown) => { stats.commands.push({ op: 'setPipeline', pipeline }); };
            }
            if (prop === 'setBindGroup') {
                return (index: number) => { stats.commands.push({ op: 'setBindGroup', index }); };
            }
            if (prop === 'drawIndexed') {
                return () => {
                    stats.commands.push({ op: 'drawIndexed' });
                    stats.draws.push(boundVertexBuffer);
                };
            }
            // The sky pass issues a NON-indexed draw (pass.draw(3)); record it
            // so a test can pin the env rebind to AFTER the sky draw, not merely
            // after the sky pipeline was set (the boundary Greptile/CodeRabbit
            // flagged on #2669).
            if (prop === 'draw') {
                return () => { stats.commands.push({ op: 'draw' }); };
            }
            return () => undefined;
        },
    });

    const encoder = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            if (prop === 'beginRenderPass') {
                return (desc?: { label?: string }) => {
                    stats.passes.push(desc?.label ?? '');
                    if (knobs.encodeThrows) throw new Error('boom mid-encode');
                    return pass;
                };
            }
            if (prop === 'copyTextureToBuffer') return () => {
                if (knobs.pickFault === 'id-copy') throw new Error('boom ID copy');
            };
            if (prop === 'copyBufferToBuffer') return () => {
                if (knobs.pickFault === 'depth-copy') throw new Error('boom depth copy');
            };
            if (prop === 'beginComputePass') return () => {
                if (knobs.pickFault === 'depth-encode') throw new Error('boom depth encode');
                return pass;
            };
            if (prop === 'finish') return () => {
                if (knobs.pickFault === 'finish') throw new Error('boom encoder finish');
                return {};
            };
            return () => undefined;
        },
    });

    const queue = {
        // Copied eagerly: the renderer reuses one scratch array for every
        // per-mesh uniform, so holding the reference would read back only the
        // LAST value written in the frame.
        writeBuffer(buffer: unknown, offset: number, data: ArrayBufferView | ArrayBuffer) {
            const floats = ArrayBuffer.isView(data)
                ? new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
                : new Float32Array(data.slice(0));
            stats.writes.push({ buffer, offset, floats });
            const written = new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
            const previous = stats.gpuBytes.get(buffer);
            const held = new Uint8Array(Math.max(previous?.length ?? 0, offset + written.length));
            if (previous) held.set(previous);
            held.set(written, offset);
            stats.gpuBytes.set(buffer, held);
        },
        writeTexture() { /* no-op */ },
        copyExternalImageToTexture() { /* no-op */ },
        submit() { if (knobs.submitThrows) throw new Error('boom on submit'); stats.submissions++; },
        onSubmittedWorkDone() { return Promise.resolve(); },
    };
    const fakeGpuDevice = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            switch (prop) {
                case 'lost': return lost;
                case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024 };
                case 'queue': return queue;
                case 'pushErrorScope': return () => { stats.push++; };
                case 'popErrorScope': return () => {
                    stats.pop++;
                    return knobs.popRejects
                        ? Promise.reject(new Error('Instance dropped in popErrorScope'))
                        : Promise.resolve(null);
                };
                case 'createCommandEncoder': return () => encoder;
                case 'createBuffer': return (desc: { size: number }) => makeBuffer(desc);
                case 'createBindGroup': return () => ({});
                case 'createTexture': return (desc: { label?: string; size: { width: number; height: number } }) => {
                    stats.createdTextures++;
                    stats.textures.push({ label: desc.label ?? '', width: desc.size.width, height: desc.size.height });
                    return {
                        width: desc.size.width,
                        height: desc.size.height,
                        createView: () => ({}),
                        destroy() { stats.destroyedTextures.push(desc.label ?? ''); },
                    };
                };
                // Picker builds real pipelines in its constructor and binds
                // through the auto layout, so both arms must return objects.
                case 'createShaderModule': return () => ({});
                case 'createRenderPipelineAsync': return () => knobs.visibilityCompilation ?? Promise.resolve({ getBindGroupLayout: () => ({}) });
                case 'createComputePipeline':
                case 'createRenderPipeline': return () => ({ getBindGroupLayout: () => ({}) });
                // Destroying a device also completes every map still pending
                // against it — with an AbortError, exactly as Chromium does.
                case 'destroy': return () => {
                    knobs.gpuDead = true;
                    for (const m of parkedMaps.splice(0)) {
                        m.reject(new DOMException(MAP_ASYNC_ABORT, 'AbortError'));
                    }
                };
                default: return () => undefined;
            }
        },
    });

    const fakeContext = {
        configure() { /* no-op */ },
        getCurrentTexture() {
            return knobs.textureMode === 'texture' ? { createView: () => ({}) } : null;
        },
    };

    const canvas = {
        width: 256,
        height: 256,
        getBoundingClientRect: () => ({ width: 256, height: 256 }),
    } as unknown as HTMLCanvasElement;

    const renderer = new Renderer(canvas);
    // Wire the stub GPU into the real WebGPUDevice wrapper (init() needs a
    // browser); keep lastWidth/lastHeight in sync so no reconfigure fires.
    const wdev = renderer['device'] as unknown as Record<string, unknown>;
    wdev['device'] = fakeGpuDevice;
    wdev['context'] = fakeContext;
    wdev['canvas'] = canvas;
    wdev['contextConfigured'] = true;
    wdev['lastWidth'] = 256;
    wdev['lastHeight'] = 256;
    const visibility = new OpaqueVisibilityPass(fakeGpuDevice as unknown as GPUDevice, 1);
    // Permissive pipeline stub: draw-state getters return inert objects,
    // sizing predicates return stable values, everything else no-ops.
    (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy(
        {} as Record<string | symbol, unknown>,
        {
            get(_t, prop) {
                switch (prop) {
                    case 'visibility': return visibility;
                    case 'needsResize': return () => false;
                    case 'getSampleCount': return () => 1;
                    case 'getMultisampleTextureView': return () => null;
                    case 'getUniformBufferSize': return () => MESH_UNIFORM_BYTES; // the real block size: arena slots stage exactly this many bytes
                    case 'getQuantizedPipelineVariant': return () => null;
                    // Stable identities so a test can tell which pipeline drew what.
                    case 'getPipeline': return () => OPAQUE_PIPELINE;
                    // Opaque draws resolve through opaquePipeline (its twin or the base); the
                    // stub answers with the base, as before the twins compile.
                    case 'opaquePipeline': return (kind: string) => kind === 'instanced' ? {} : OPAQUE_PIPELINE;
                    case 'getTransparentPipeline': return () => TRANSPARENT_PIPELINE;
                    case 'getGhostPipeline': return () => GHOST_PIPELINE;
                    case 'setEntityColorTableBuffer': return (buffer: unknown) => { stats.boundColorTables.push(buffer); };
                    default: return () => ({});
                }
            },
        },
    );

    return {
        renderer,
        stats,
        knobs,
        render(options: RenderOptions = {}) {
            // Post passes need real GPU textures — keep them off in the stub.
            renderer.render({ visualEnhancement: { enabled: false }, ...options });
        },
        async settle() {
            // Two microtask turns flush the then/catch chains on popErrorScope.
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        },
        pendingMaps() { return parkedMaps.length; },
        loseDevice() { knobs.gpuDead = true; loseDevice(); },
        settlePendingMaps(reason?: unknown) {
            for (const m of parkedMaps.splice(0)) {
                if (reason === undefined) m.resolve(); else m.reject(reason);
            }
        },
    };
}

/**
 * The concrete `Scene`, not the narrowed `SceneContents` that `getScene()`
 * publishes. These render-path tests reach for internals (`partialBatchCache`,
 * `addMeshData`, `getTexturedMeshes`) that are deliberately absent from the
 * published surface, the same way they already reach `renderer['device']` and
 * `renderer['pipeline']`.
 */
function sceneOf(h: Harness): Scene {
    return h.renderer['scene'];
}

function triangle(expressId: number, color: [number, number, number, number], modelIndex?: number): MeshData {
    return {
        expressId,
        modelIndex,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color,
    } as MeshData;
}

const GREY: [number, number, number, number] = [0.5, 0.5, 0.5, 1];
const RED: [number, number, number, number] = [0.8, 0.1, 0.1, 1];

/** Build two real colour batches: grey {1, 2} and red {3}. */
function seedBatches(h: Harness): { grey: BatchedMesh; red: BatchedMesh } {
    const scene = sceneOf(h);
    const device = h.renderer['device'].getDevice();
    const pipeline = h.renderer['pipeline'] as never;
    scene.appendToBatches([triangle(1, GREY), triangle(2, GREY), triangle(3, RED)], device, pipeline, false);
    const batches = scene.getBatchedMeshes();
    assert.strictEqual(batches.length, 2, 'expected one grey and one red batch');
    // Strip bounds so the default camera cannot frustum-cull the fixtures.
    for (const b of batches) b.bounds = undefined;
    const grey = batches.find((b) => b.expressIds.includes(1))!;
    const red = batches.find((b) => b.expressIds.includes(3))!;
    return { grey, red };
}

// #8564 round 5: section resolution used to persist the visible Gaussian union
// into fit bounds. Exercise the real render/submit path, not just layer callbacks.
for (const action of ['hide', 'remove'] as const) {
    for (const keepSection of [false, true]) {
        it(`#8564 section render preserves model/annotation bounds after ${action}, section=${keepSection}`, async () => {
            const h = makeHarness();
            const fields = h.renderer as unknown as Record<string, unknown>;
            fields.ready = true;
            const layer = fields.gaussianLayer as Record<string, unknown>;
            (layer.slot as Record<string, unknown>).createBackend = async (): Promise<GaussianBackend> => ({
                upstreamReverseZ: true,
                createScene: () => ({ gpuBytes: 64, async replaceSource() {}, updateRows() {}, setFilter() {}, encode() {}, destroy() {} }),
            });
            const mesh = triangle(1, GREY);
            mesh.positions = new Float32Array([0, 0, 0, 100, 0, 0, 0, 100, 100]);
            assert.equal(h.renderer.loadGeometry([mesh]).ok, true);
            // Keep the real overlay/bounds facade, stubbing only its GPU renderer.
            (fields.overlays as Record<string, unknown>).section2DOverlayRenderer = new Proxy({}, { get: () => () => undefined });
            h.renderer.setLineOverlay('annotation', new Float32Array([-20, -20, -20, 120, 120, 120]));
            const persistent = structuredClone(h.renderer.getModelBounds());
            assert.deepEqual(persistent, { min: { x: -20, y: -20, z: -20 }, max: { x: 120, y: 120, z: 120 } });
            const camera = h.renderer.getCamera();
            camera.setProjectionMode('orthographic');
            camera.setPosition(-200, 50, 50);
            camera.setTarget(0, 50, 50);
            const attributes = {
                count: 1, positions: new Float32Array([500, 50, 50]), scales: new Float32Array([1, 1, 1]),
                rotations: new Float32Array([1, 0, 0, 0]), colors: new Float32Array([1, 0, 0, 1]),
                opacities: new Float32Array([1]), sphericalHarmonics: new Float32Array(), sphericalHarmonicsDegree: 0 as const,
            };
            const handle = await h.renderer.gaussianSplats.add({ attributes, placement: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, modelIndex: 0 }, { qualification: 'internal-unqualified' });
            const render = (enabled: boolean) => {
                const before = h.stats.submissions;
                h.render({ sectionPlane: { enabled, axis: 'side', position: 50 } });
                assert.equal(h.stats.submissions, before + 1, 'the actual section frame submits successfully');
            };
            // Reverse-Z orthographic clip depth for a point 700m along +X from
            // this eye: view z=-700, and the public projection must map to [0,1].
            const centreClipDepth = () => {
                const m = camera.getProjMatrix().m;
                return -700 * m[10] + m[14];
            };
            try {
                render(true);
                assert.equal(h.renderer.getSectionPlaneFrames()[0].distance, 250, 'transient slider spans IFC 0..100 plus the visible centre at 500');
                assert.deepEqual(h.renderer.getModelBounds(), persistent, 'section rendering cannot pollute fit bounds or drop annotations');
                assert.deepEqual(camera.getSceneBounds(), persistent, 'persistent camera bounds also retain annotations');
                assert.ok(centreClipDepth() >= 0 && centreClipDepth() <= 1, 'visible centre is inside the rendered near/far interval');
                render(keepSection);
                if (action === 'hide') h.renderer.gaussianSplats.setVisible(handle, false);
                else h.renderer.gaussianSplats.remove(handle);
                render(keepSection);
                assert.equal(h.renderer.getSectionPlaneFrames()[0].distance, 50, 'slider returns to IFC bounds after withdrawal');
                assert.deepEqual(h.renderer.getModelBounds(), persistent, 'fits retain only model/annotation bounds');
                assert.deepEqual(camera.getSceneBounds(), persistent);
                assert.ok(centreClipDepth() < 0, 'withdrawn far centre no longer inflates the rendered depth interval');
                assert.equal(h.renderer.getDiagnostics().errors, 0);
            } finally {
                h.renderer.gaussianSplats.remove(handle);
                h.renderer.destroy();
                await h.settle();
            }
        });
    }
}

describe('canonical render submission result (#6709)', () => {
    it('reports a new submitted frame while preserving render() void behavior', () => {
        const h = makeHarness();
        assert.strictEqual(h.renderer.renderWithResult({ visualEnhancement: { enabled: false } }), true);
        assert.strictEqual(h.stats.submissions, 1, 'the actual render body reached queue.submit');
        assert.strictEqual(h.renderer.render({ visualEnhancement: { enabled: false } }), undefined);
        assert.strictEqual(h.stats.submissions, 2, 'the void API uses that same render body');
    });

    for (const failure of ['uninitialized', 'pipeline', 'collapsed', 'texture', 'encode', 'submit'] as const) {
        it(`reports ${failure} refusal instead of claiming the previous submission`, async () => {
            const h = makeHarness();
            h.render();
            assert.strictEqual(h.stats.submissions, 1, 'seed one genuine canonical submission');
            if (failure === 'uninitialized') h.renderer['device'].destroy();
            if (failure === 'pipeline') h.renderer['pipeline'] = null;
            if (failure === 'collapsed') h.renderer.getCanvas().getBoundingClientRect = () => ({ width: 0, height: 0 } as DOMRect);
            if (failure === 'texture') h.knobs.textureMode = 'null';
            if (failure === 'encode') h.knobs.encodeThrows = true;
            if (failure === 'submit') h.knobs.submitThrows = true;
            const warn = mock.method(console, 'warn', () => {});
            try {
                assert.strictEqual(h.renderer.renderWithResult({ visualEnhancement: { enabled: false } }), false);
                await h.settle();
                assert.strictEqual(h.stats.submissions, 1, 'no new command buffer was submitted');
                assert.strictEqual(h.stats.push, h.stats.pop, 'existing validation scope ownership is preserved');
            } finally { warn.mock.restore(); }
        });
    }

    it('contains pre-encoding restoration failure and recovers through the same path', () => {
        const h = makeHarness();
        const restore = mock.method(sceneOf(h), 'restoreAllEvicted', () => { throw new RangeError('controlled restoration failure'); });
        const warn = mock.method(console, 'warn', () => {});
        try {
            assert.strictEqual(h.renderer.renderWithResult({ restoreEvictedForCapture: true }), false);
            assert.strictEqual(h.stats.submissions, 0);
            assert.strictEqual(h.renderer.getDiagnostics().errors, 1, 'the existing containment reports the error');
            restore.mock.restore();
            assert.strictEqual(h.renderer.renderWithResult({ visualEnhancement: { enabled: false } }), true);
            assert.strictEqual(h.stats.submissions, 1);
        } finally { restore.mock.restore(); warn.mock.restore(); }
    });
});

// #9002: render() is what notes the pick clip, so a cut change moves
// getPickClipRevision() (the viewer's Measure Point Live reading, #8886). A
// capture render's cleared or swapped clip is restored by the next frame, so it
// must not count as a change; a real change around a capture still does.
describe('pick clip revision wiring (#9002)', () => {
    const cut = (distance: number): RenderOptions => ({ sectionPlane: { axis: 'side', position: 50, enabled: true, normal: [0, 1, 0], distance } });

    it('a cut change bumps the revision; the same cut on the next frame does not', () => {
        const h = makeHarness();
        h.render();
        const uncut = h.renderer.getPickClipRevision();
        h.render(cut(2));
        const cutRev = h.renderer.getPickClipRevision();
        assert.ok(cutRev > uncut, 'adding a section kept the revision');
        h.render(cut(2));
        assert.strictEqual(h.renderer.getPickClipRevision(), cutRev, 'an unchanged cut bumped the revision');
        h.render(cut(3));
        assert.ok(h.renderer.getPickClipRevision() > cutRev, 'moving the section kept the revision');
        h.render();
        assert.ok(h.renderer.getPickClipRevision() > cutRev + 1, 'removing the section kept the revision');
    });

    it('a capture render with the clip cleared does not outlive its frame', () => {
        const h = makeHarness();
        h.render(cut(2));
        const before = h.renderer.getPickClipRevision();
        // idsBcfViewpoints captures with the section, extra planes and clip box cleared.
        assert.strictEqual(h.renderer.renderWithResult({ sectionPlane: undefined, restoreEvictedForCapture: true, visualEnhancement: { enabled: false } }), true);
        const during = h.renderer.getPickClipRevision();
        // A pick until the next frame reads through the cleared clip: it must not match the cut's revision.
        assert.notStrictEqual(during, before, 'the capture frame\'s cleared clip shares the cut\'s revision');
        h.render(cut(2));
        assert.strictEqual(h.renderer.getPickClipRevision(), before, 'restoring the cut after a capture left a new revision, ending Live');
        h.render(cut(2));
        assert.strictEqual(h.renderer.getPickClipRevision(), before);
        assert.notStrictEqual(during, before, 'a reading taken during the capture would survive the restore');
    });

    it('a real cut change across a capture still bumps the revision', () => {
        const h = makeHarness();
        h.render(cut(2));
        const before = h.renderer.getPickClipRevision();
        h.renderer.renderWithResult({ restoreEvictedForCapture: true, visualEnhancement: { enabled: false } });
        const during = h.renderer.getPickClipRevision();
        h.render(cut(3));
        const moved = h.renderer.getPickClipRevision();
        assert.ok(moved !== before && moved !== during, 'a cut moved during the capture reused an earlier revision');
        h.renderer.renderWithResult({ ...cut(3), restoreEvictedForCapture: true, visualEnhancement: { enabled: false } });
        assert.strictEqual(h.renderer.getPickClipRevision(), moved, 'a capture of the same cut moved the revision');
        h.render();
        assert.ok(h.renderer.getPickClipRevision() !== moved, 'removing the cut after a capture kept the revision');
    });
});

describe('render() error-scope balance', () => {
    it('pops the scope on a null-current-texture frame', async () => {
        const h = makeHarness();
        h.knobs.textureMode = 'null';
        h.render();
        await h.settle();
        assert.strictEqual(h.stats.push, 1);
        assert.strictEqual(h.stats.pop, 1);
    });

    it('pops the scope when encoding throws mid-frame, and keeps counts balanced across mixed frames', async () => {
        const h = makeHarness();
        h.knobs.encodeThrows = true;
        h.render();
        await h.settle();
        assert.strictEqual(h.stats.push, 1);
        assert.strictEqual(h.stats.pop, 1);
        assert.strictEqual(h.renderer.getDiagnostics().errors, 1);

        // A throwing frame, a null-texture frame, and normal frames — every
        // pushed scope must be popped exactly once, incl. past the capture
        // window (first 5 renders) where neither is called.
        h.knobs.encodeThrows = false;
        h.knobs.textureMode = 'null';
        h.render();
        h.knobs.textureMode = 'texture';
        for (let i = 0; i < 6; i++) h.render();
        await h.settle();
        assert.strictEqual(h.stats.push, h.stats.pop);
        assert.ok(h.stats.push < 8, 'capture window must stop pushing after the first renders');
    });

    it('logs (not swallows) a popErrorScope rejection and invalidates the context', async () => {
        const h = makeHarness();
        h.knobs.popRejects = true;
        const warn = mock.method(console, 'warn', () => undefined);
        try {
            h.render();
            await h.settle();
            const logged = warn.mock.calls.some((c) =>
                String(c.arguments[0]).includes('popErrorScope rejected'));
            assert.ok(logged, 'rejection must be logged, not silently caught');
        } finally {
            warn.mock.restore();
        }
        // The wrapper marks the context for reconfiguration on loss evidence.
        assert.strictEqual(h.renderer['device']['contextConfigured'], false);
    });

    it('logs the rejection from the null-texture bail-out path too', async () => {
        const h = makeHarness();
        h.knobs.popRejects = true;
        h.knobs.textureMode = 'null';
        const warn = mock.method(console, 'warn', () => undefined);
        try {
            h.render();
            await h.settle();
            const logged = warn.mock.calls.some((c) =>
                String(c.arguments[0]).includes('popErrorScope rejected'));
            assert.ok(logged);
        } finally {
            warn.mock.restore();
        }
    });
});

describe('captureColorFrame() lifecycle (#5051 strict GPU evidence)', () => {
    it('cancels a discarded orthographic capture and permits a fresh capture after async validation (#6729)', async () => {
        const h = makeHarness();
        let finish!: (pipeline: GPURenderPipeline) => void;
        h.knobs.visibilityCompilation = new Promise(resolve => { finish = resolve; });
        const pipeline = h.renderer['pipeline']!;
        const module = {} as GPUShaderModule;
        pipeline.visibility.register(OPAQUE_PIPELINE as unknown as GPURenderPipeline, {
            layout: 'auto', vertex: { module, entryPoint: 'vs_main' },
            fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
            depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
        }, mainShaderSource);
        h.renderer.getCamera().setProjectionMode('orthographic');
        try {
            let settled = false;
            const discarded = h.renderer.captureColorFrame();
            void discarded.then(() => { settled = true; });
            h.renderer.consumeRenderRequest(); h.render(); await h.settle();
            assert.equal(h.stats.submissions, 0, 'a compiling frame never submits');
            assert.equal(settled, true, 'an unsubmitted frame must not retain a coalesced capture');
            assert.equal(await discarded, null);
            finish(OPAQUE_PIPELINE as unknown as GPURenderPipeline);
            await pipeline.visibility.prepare(); await h.settle();
            h.renderer.consumeRenderRequest();
            const fresh = h.renderer.captureColorFrame();
            assert.notStrictEqual(fresh, discarded, 'the discarded request cannot absorb a later capture');
            h.render();
            assert.ok(await fresh, 'a validated replacement frame supplies actual readback bytes');
            assert.equal(h.stats.submissions, 1); assert.equal(h.stats.mapAsync, 1);
        } finally { finish(OPAQUE_PIPELINE as unknown as GPURenderPipeline); h.renderer.destroy(); }
    });

    it('coalesces concurrent callers into one bounded next-frame readback', async () => {
        const h = makeHarness();
        const first = h.renderer.captureColorFrame();
        const second = h.renderer.captureColorFrame();
        assert.strictEqual(first, second, 'only one in-flight color capture may allocate GPU readback memory');
        const texturesBefore = h.stats.createdTextures;

        h.renderer.consumeRenderRequest();
        h.render();
        const frame = await first;

        assert.ok(frame, 'the submitted production frame resolves its color copy');
        assert.deepStrictEqual([frame.width, frame.height], [256, 256]);
        assert.strictEqual(h.stats.mapAsync, 1, 'exactly one color buffer is mapped');
        assert.strictEqual(h.stats.createdTextures, texturesBefore, 'capture reuses the canvas texture at every viewport size');
        assert.strictEqual(h.renderer.peekRenderRequest(), false, 'capture reuses the presented frame without scheduling another');
    });

    it('retries a transient context skip but bounds unavailable-frame polling', async () => {
        const h = makeHarness();
        h.knobs.textureMode = 'null';
        const pending = h.renderer.captureColorFrame();

        h.renderer.consumeRenderRequest();
        h.render();
        assert.strictEqual(h.renderer.peekRenderRequest(), true, 'one unavailable canvas texture requests another frame');

        h.knobs.textureMode = 'texture';
        h.renderer.consumeRenderRequest();
        h.render();
        assert.ok(await pending, 'the next submitted production frame resolves actual color bytes');

        const unavailable = makeHarness();
        unavailable.knobs.textureMode = 'null';
        const bounded = unavailable.renderer.captureColorFrame();
        for (let attempt = 0; attempt <= 3; attempt++) {
            unavailable.renderer.consumeRenderRequest();
            unavailable.render();
        }
        assert.strictEqual(await bounded, null, 'three transient retries never create a perpetual requestAnimationFrame loop');
        assert.strictEqual(unavailable.renderer.peekRenderRequest(), false, 'the bounded capture releases its final dirty request');
    });

    it('settles a pending color capture on teardown, device loss, or a contained encode failure', async () => {
        const destroyed = makeHarness();
        const pendingDestroy = destroyed.renderer.captureColorFrame();
        destroyed.renderer.destroy();
        assert.strictEqual(await pendingDestroy, null, 'destroy cannot leave an E2E capture promise suspended');

        const lost = makeHarness();
        const pendingLoss = lost.renderer.captureColorFrame();
        const lossWarn = mock.method(console, 'warn', () => undefined);
        try {
            lost.renderer['handleDeviceLost']({ message: 'driver reset', reason: 'unknown' });
        } finally {
            lossWarn.mock.restore();
        }
        assert.strictEqual(await pendingLoss, null, 'device loss cannot leave an E2E capture promise suspended');

        const inFlight = makeHarness();
        inFlight.knobs.deferMaps = true;
        const pendingInFlightLoss = inFlight.renderer.captureColorFrame();
        inFlight.renderer.consumeRenderRequest();
        inFlight.render();
        assert.strictEqual(inFlight.pendingMaps(), 1, 'the loss lands while the submitted color readback is mapped');
        const warn = mock.method(console, 'warn', () => undefined);
        try {
            inFlight.renderer['handleDeviceLost']({ message: 'driver reset', reason: 'unknown' });
            assert.strictEqual(await pendingInFlightLoss, null, 'device loss settles an already-submitted capture without another frame');
        } finally {
            warn.mock.restore();
            inFlight.settlePendingMaps();
            await inFlight.settle();
        }
        const failed = makeHarness();
        failed.knobs.encodeThrows = true;
        const pendingFailure = failed.renderer.captureColorFrame();
        failed.render();
        assert.strictEqual(await pendingFailure, null, 'a contained render failure cannot publish partial color evidence');

        const submitFailure = makeHarness();
        submitFailure.render(); // Allocate shared frame resources before measuring the readback.
        const beforeReadback = submitFailure.stats.createdBuffers.length;
        submitFailure.knobs.submitThrows = true;
        const pendingSubmitFailure = submitFailure.renderer.captureColorFrame();
        submitFailure.render();
        assert.strictEqual(await pendingSubmitFailure, null, 'a failed submit cannot publish partial color evidence');
        assert.strictEqual(
            submitFailure.stats.createdBuffers.at(-1)!.destroyed,
            1,
            'the current frame readback buffer is freed when queue.submit() throws',
        );
        assert.strictEqual(submitFailure.stats.createdBuffers.length, beforeReadback + 1, 'the assertion observes the color readback, not setup buffers');
    });

    it('settles an unencoded capture when re-initialization tears down the active GPU stack', async () => {
        const h = makeHarness();
        const pending = h.renderer.captureColorFrame();
        h.renderer['device'].init = async () => { throw new Error('replacement init failed'); };

        await assert.rejects(h.renderer.init(), /replacement init failed/);
        assert.strictEqual(await pending, null, 'a failed replacement cannot strand a capture owned by the old stack');
    });
});

describe('destroy() lifecycle', () => {
    it('is idempotent and render() after destroy() is a silent skip', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render();
        assert.doesNotThrow(() => h.renderer.destroy());
        assert.doesNotThrow(() => h.renderer.destroy());
        const skipsBefore = h.renderer.getDiagnostics().skips;
        assert.doesNotThrow(() => h.render());
        assert.strictEqual(h.renderer.getDiagnostics().skips, skipsBefore + 1);
        assert.strictEqual(h.renderer.getDiagnostics().errors, 0);
    });

    it('destroy() frees batch buffers exactly once', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);
        h.renderer.destroy();
        h.renderer.destroy();
        assert.strictEqual((grey.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual((red.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
    });
});

describe('lighting environment bind ordering', () => {
    // Regression: switching the WebGPU "Environment" preset away from Default
    // enables the procedural sky, whose pipeline has an incompatible layout
    // (its own group(0), no group(1)). Drawing the sky invalidates the
    // per-frame lighting group(1) binding on conformant WebGPU
    // implementations; the flat batch loop re-sets only group(0) per batch, so
    // when the env was bound BEFORE the sky pass every non-Default preset drew
    // no geometry ("the model disappears when I change the environment") on
    // strict drivers. The env must be (re)bound at group(1) AFTER the sky pass
    // and BEFORE the first geometry draw.
    it('rebinds the environment at group(1) after the sky draw, before geometry', () => {
        const h = makeHarness();
        seedBatches(h);
        h.stats.commands.length = 0;
        h.render({ environment: { skyEnabled: true, sunDirection: [0.45, 0.83, 0.33] } });

        const cmds = h.stats.commands;
        const firstPipeline = cmds.findIndex((c) => c.op === 'setPipeline');
        // The sky pass's own non-indexed draw — the real boundary the env
        // rebind must clear. Anchoring on this (not just on a setPipeline)
        // is what rejects a rebind issued before the sky actually drew.
        const skyDraw = cmds.findIndex((c) => c.op === 'draw');
        const firstGeometryDraw = cmds.findIndex((c) => c.op === 'drawIndexed');
        assert.ok(firstPipeline >= 0, 'the sky pass must set a pipeline');
        assert.ok(skyDraw > firstPipeline, 'the sky must draw after its pipeline is set');
        assert.ok(firstGeometryDraw > skyDraw, 'geometry must draw after the sky');
        const envBind = cmds.findIndex(
            (c, i) => c.op === 'setBindGroup' && c.index === 1 && i > skyDraw && i < firstGeometryDraw,
        );
        assert.ok(envBind >= 0, 'group(1) must be re-bound after the sky draw and before geometry');
    });

    it('binds the environment at group(1) before geometry with the sky off (Default preset)', () => {
        const h = makeHarness();
        seedBatches(h);
        h.stats.commands.length = 0;
        h.render();

        const cmds = h.stats.commands;
        const firstDraw = cmds.findIndex((c) => c.op === 'drawIndexed');
        assert.ok(firstDraw >= 0, 'geometry must draw');
        const envBind = cmds.findIndex(
            (c, i) => c.op === 'setBindGroup' && c.index === 1 && i < firstDraw,
        );
        assert.ok(envBind >= 0, 'group(1) must be bound before the first geometry draw');
    });

    // #9060: the main layout pads group(2). WebGPU before gpuweb#4946 rejects
    // a draw with any layout slot unbound, empty or not, so every frame was
    // invalid ("No bind group set at group index 2") and nothing rendered.
    for (const skyEnabled of [false, true]) {
        it(`binds the group(2) padding after the sky and before geometry (sky ${skyEnabled ? 'on' : 'off'})`, () => {
            const h = makeHarness();
            seedBatches(h);
            h.stats.commands.length = 0;
            h.render(skyEnabled ? { environment: { skyEnabled: true, sunDirection: [0.45, 0.83, 0.33] } } : {});

            const cmds = h.stats.commands;
            const skyDraw = cmds.findIndex((c) => c.op === 'draw');
            const firstGeometryDraw = cmds.findIndex((c) => c.op === 'drawIndexed');
            assert.ok(firstGeometryDraw >= 0, 'geometry must draw');
            assert.equal(skyDraw >= 0, skyEnabled);
            const paddingBind = cmds.findIndex(
                (c, i) => c.op === 'setBindGroup' && c.index === 2 && i > skyDraw && i < firstGeometryDraw,
            );
            assert.ok(paddingBind >= 0, 'group(2) must be bound before the first geometry draw');
        });
    }
});

describe('visibility epoch drives the batched draw path', () => {
    it('sees an IN-PLACE mutation of the hiddenIds Set (regression: reference-compare epoch)', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);

        const hidden = new Set<number>();
        h.render({ hiddenIds: hidden });
        assert.ok(h.stats.draws.includes(grey.vertexBuffer), 'grey batch draws while nothing is hidden');
        assert.ok(h.stats.draws.includes(red.vertexBuffer));

        // Mutate the SAME Set in place: id 1 hides, grey batch {1,2} becomes
        // partially visible and must be replaced by a sub-batch clone.
        hidden.add(1);
        h.stats.draws.length = 0;
        h.render({ hiddenIds: hidden });
        assert.ok(!h.stats.draws.includes(grey.vertexBuffer),
            'partially hidden batch must not draw from its own buffers');
        assert.ok(h.stats.draws.includes(red.vertexBuffer), 'red batch is unaffected');
        const scene = sceneOf(h);
        assert.strictEqual(scene['partialBatchCache'].size, 1, 'a partial sub-batch was built');

        // Mutate in place again: id 2 hides too, the grey batch is now fully
        // hidden — the batched path must notice (no grey geometry at all).
        hidden.add(2);
        h.stats.draws.length = 0;
        h.render({ hiddenIds: hidden });
        const greyIshDraws = h.stats.draws.filter((d) => d !== red.vertexBuffer);
        assert.strictEqual(greyIshDraws.length, 0, 'fully hidden batch (and its sub-batch) must not draw');
    });

    it('does NOT rebuild caches for a fresh Set with identical content', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render({ hiddenIds: new Set([1]) });
        const version = h.renderer['_visibilityVersion'];
        const buffersAfterFirst = h.stats.createdBuffers.length;

        h.render({ hiddenIds: new Set([1]) });
        assert.strictEqual(h.renderer['_visibilityVersion'], version, 'same content, new reference: no epoch bump');
        assert.strictEqual(h.stats.createdBuffers.length, buffersAfterFirst, 'no partial sub-batch rebuild');
    });

    it('treats empty hidden set, undefined, and null isolation as the same no-filter state', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render({});
        const version = h.renderer['_visibilityVersion'];
        h.render({ hiddenIds: new Set() });
        h.render({ hiddenIds: undefined, isolatedIds: null });
        h.render({ isolatedIds: undefined });
        assert.strictEqual(h.renderer['_visibilityVersion'], version);
    });

    it('rapid hide -> show-all -> same set -> different set: partial caches drop and rebuild, buffers destroyed exactly once', () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = sceneOf(h);

        h.render({ hiddenIds: new Set([1]) });
        assert.strictEqual(scene['partialBatchCache'].size, 1);
        const firstClone = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        const firstVb = firstClone.vertexBuffer as unknown as FakeBuffer;

        // Show all: the return-to-fully-visible transition must free the clone.
        h.render({});
        assert.strictEqual(scene['partialBatchCache'].size, 0, 'partial caches dropped on show-all');
        assert.strictEqual(firstVb.destroyed, 1);

        // Hide the SAME set again: a fresh clone is built (old one stays freed).
        h.render({ hiddenIds: new Set([1]) });
        assert.strictEqual(scene['partialBatchCache'].size, 1);
        const secondClone = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        assert.notStrictEqual(secondClone, firstClone, 'dropped clone must not be resurrected');
        assert.strictEqual(firstVb.destroyed, 1, 'no double-destroy of the dropped clone');

        // Different set while filtering holds: in-place invalidation replaces
        // the clone and frees the previous one exactly once.
        h.render({ hiddenIds: new Set([2]) });
        assert.strictEqual((secondClone.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual(scene['partialBatchCache'].size, 1);

        // Back to show-all: everything freed exactly once, nothing twice.
        h.render({});
        assert.strictEqual(scene['partialBatchCache'].size, 0);
        assert.strictEqual(firstVb.destroyed, 1);
        assert.strictEqual((secondClone.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        for (const buf of h.stats.createdBuffers) {
            assert.ok(buf.destroyed <= 1, 'a VRAM-tracked buffer was destroyed more than once');
        }
    });
});

describe('residency records a batch drawn only as a partial sub-batch (#9034)', () => {
    // Any use, own buffers or pieces: a subset draw keeps the pieces warm (#9050).
    const lastDrawn = (h: Harness, batch: BatchedMesh) => sceneOf(h)['lastDrawnFrame'].getAnyUse(batch.id);
    const frame = (h: Harness) => sceneOf(h)['residencyFrame'];
    const IDLE_FRAMES = 100; // well past MIN_EVICTION_AGE_FRAMES (30)

    for (const [label, filter] of [
        ['hide', { hiddenIds: new Set([1, 3]) }],
        ['isolate', { isolatedIds: new Set([2]) }],
    ] as const) {
        it(`${label}: the partially visible batch stays fresh and warm; the undrawn batch still ages out`, () => {
            const h = makeHarness();
            const { grey, red } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1); // everything is over budget
            for (let i = 0; i < IDLE_FRAMES; i++) h.render(filter);

            // grey {1,2} draws only as its {2} sub-batch.
            assert.strictEqual(scene['partialBatchCache'].size, 1, 'grey draws as a partial sub-batch');
            assert.strictEqual(lastDrawn(h, grey), frame(h), 'partial-only batch is recorded as drawn this frame');
            assert.ok(sceneOf(h).getMeshDataPieces(2)?.length, 'partial-only batch keeps the CPU pieces its subset draws from');
            // red {3} is hidden / not isolated: never drawn, so it must still age out.
            assert.strictEqual(red.gpuResident, false, 'a batch that is truly not drawn is still evicted');
            assert.strictEqual(lastDrawn(h, red), undefined);
        });
    }

    it('a GPU-evicted parent drawn as a partial sub-batch is not demoted cold by the host pass', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);
        const scene = sceneOf(h);
        let coldLoads = 0;
        scene.setColdGeometryProvider({ loadMeshesInBounds: async () => { coldLoads++; return []; } });
        scene.setGpuResidencyBudget(1);
        scene.setHostResidencyBudget(1);

        // Everything hidden: both batches age out of the GPU tier (warm: CPU kept).
        // The host pass runs on the first post-submit hook only, before anything
        // is GPU-evicted, so nothing goes cold yet.
        for (let i = 0; i < 40; i++) h.render({ hiddenIds: new Set([1, 2, 3]) });
        assert.strictEqual(grey.gpuResident, false);
        assert.strictEqual(red.gpuResident, false);
        assert.ok(scene.getMeshDataPieces(2), 'still warm before the host pass');

        // Reveal id 2: grey draws its {2} sub-batch from CPU meshData while the
        // parent stays GPU-evicted (nothing processes the restore queue here).
        // Run past the host pass cadence (every 120 post-submit hooks).
        for (let i = 0; i < 130; i++) h.render({ hiddenIds: new Set([1, 3]) });
        assert.ok(scene['partialBatchCache'].size >= 1, 'grey draws as a partial sub-batch');
        assert.strictEqual(lastDrawn(h, grey), frame(h), 'GPU-evicted parent of a drawn sub-batch is recorded');
        assert.ok(scene.getMeshDataPieces(2)?.length, 'on-screen geometry keeps its CPU pieces (picks, snaps)');
        assert.ok(!scene['coldBuckets'].has(grey.colorKey), 'on-screen bucket is not demoted cold');
        // red is never drawn: the host pass still demotes it.
        assert.strictEqual(scene.getMeshDataPieces(3), undefined, 'undrawn bucket is still demoted cold');
        assert.ok(scene['coldBuckets'].has(red.colorKey));
        // The subset reads warm pieces, so nothing asks for grey's own buffers
        // (#9050) and nothing ever needed the provider.
        assert.strictEqual(scene.hasResidencyRestoreWork(), false);
        assert.strictEqual(coldLoads, 0, 'on-screen geometry never needed a cold restore');
    });
});

describe('a partial-only parent releases its own GPU buffers but keeps its CPU pieces (#9050)', () => {
    const IDLE_FRAMES = 100; // well past MIN_EVICTION_AGE_FRAMES (30)
    const device = (h: Harness) => h.renderer['device'].getDevice();
    const pipeline = (h: Harness) => h.renderer['pipeline'] as never;
    const greyOf = (h: Harness) => sceneOf(h).getBatchedMeshes().find((b) => b.expressIds.includes(2))!;
    const subBatchKeys = (h: Harness) => [...sceneOf(h)['partialBatchCacheKeys'].keys()];

    for (const [label, filter] of [
        ['hide', { hiddenIds: new Set([1, 3]) }],
        ['isolate', { isolatedIds: new Set([2]) }],
    ] as const) {
        it(`${label}: the parent's full buffers are evicted, the sub-batch keeps drawing, nothing asks for a GPU rebuild`, () => {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1); // everything is over budget
            for (let i = 0; i < IDLE_FRAMES; i++) h.render(filter);

            assert.strictEqual(grey.gpuResident, false, 'nothing reads the parent buffers, so the GPU tier frees them');
            assert.ok(scene.getMeshDataPieces(2)?.length, 'the parent stays warm: the sub-batch is cut from its CPU pieces');
            assert.strictEqual(scene['partialBatchCache'].size, 1, 'the {2} sub-batch is cached');
            const sub = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
            assert.notStrictEqual(sub.gpuResident, false);
            const drawsBefore = h.stats.draws.length;
            h.render(filter);
            assert.ok(h.stats.draws.length > drawsBefore, 'the sub-batch is still drawn');
            assert.strictEqual(scene.hasResidencyRestoreWork(), false, 'a warm parent drawn only as a subset is not rebuilt on the GPU');
        });
    }

    it('the host pass still keeps a partial-only parent warm after its GPU buffers are gone', () => {
        const h = makeHarness();
        const { red } = seedBatches(h);
        const scene = sceneOf(h);
        let coldLoads = 0;
        scene.setColdGeometryProvider({ loadMeshesInBounds: async () => { coldLoads++; return []; } });
        scene.setGpuResidencyBudget(1);
        scene.setHostResidencyBudget(1);
        for (let i = 0; i < 260; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(greyOf(h).gpuResident, false);
        assert.ok(scene.getMeshDataPieces(2)?.length, 'on-screen geometry keeps its CPU pieces (picks, snaps, sub-batch rebuilds)');
        assert.ok(!scene['coldBuckets'].has(greyOf(h).colorKey));
        assert.ok(scene['coldBuckets'].has(red.colorKey), 'the undrawn bucket is still demoted cold');
        assert.strictEqual(coldLoads, 0);
    });

    it('isolate off and back on: the parent is rebuilt on the transition frame, the stale sub-batch slot is freed, isolate evicts it again', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        const oldSlot = subBatchKeys(h)[0];
        const oldSub = scene['partialBatchCache'].get(scene['partialBatchCacheKeys'].get(oldSlot)!) as BatchedMesh;

        // Hide only red: grey is fully visible again (filtering stays active,
        // so the show-all drop of every partial cache does not run). Its subset
        // was on screen last frame, so the parent is rebuilt in this very frame.
        const drawsBefore = h.stats.draws.length;
        h.render({ hiddenIds: new Set([3]) });
        assert.ok(h.stats.draws.length > drawsBefore, 'the elements on screen are drawn on the transition frame');
        const rebuilt = greyOf(h);
        assert.notStrictEqual(rebuilt, grey);
        assert.notStrictEqual(rebuilt.gpuResident, false);
        assert.strictEqual(scene.hasResidencyRestoreWork(), false, 'nothing left for the time-sliced queue');
        assert.ok(!subBatchKeys(h).includes(oldSlot), 'the sub-batch cut from the replaced shell is not orphaned');
        assert.strictEqual((oldSub.vertexBuffer as unknown as FakeBuffer).destroyed, 1);

        // Isolate again: the rebuilt parent is partial-only and ages out again.
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(rebuilt.gpuResident, false);
        assert.strictEqual(scene.hasResidencyRestoreWork(), false);
        assert.strictEqual(scene['partialBatchCache'].size, 1);
        for (const buf of h.stats.createdBuffers) assert.ok(buf.destroyed <= 1, 'a buffer was destroyed more than once');
    });

    it('a sub-batch on screen survives its parent\'s eviction', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        let evictedAt = -1;
        for (let i = 0; i < IDLE_FRAMES && evictedAt < 0; i++) {
            h.render({ isolatedIds: new Set([2]) });
            if (grey.gpuResident === false) evictedAt = i;
        }
        assert.ok(evictedAt >= 0, 'parent evicted');
        assert.strictEqual(scene['partialBatchCache'].size, 1);
        const sub = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 0, 'not destroyed with the parent');
        const createdBefore = h.stats.createdBuffers.length;
        const drawsBefore = h.stats.draws.length;
        h.render({ isolatedIds: new Set([2]) });
        assert.ok(h.stats.draws.length > drawsBefore, 'the frame after eviction still draws the subset');
        assert.strictEqual([...scene['partialBatchCache'].values()][0], sub, 'the same sub-batch, not a rebuild');
        assert.strictEqual(h.stats.createdBuffers.length, createdBefore);
        assert.deepStrictEqual([...sub.expressIds], [2]);
    });

    it('a capture under the same isolate leaves the parent evicted and draws the same sub-batch (#9227)', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        const sub = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        h.stats.draws.length = 0;
        h.render({ isolatedIds: new Set([2]), restoreEvictedForCapture: true });
        assert.strictEqual(greyOf(h), grey, 'not rebuilt: the capture draws it as the same subset');
        assert.strictEqual(grey.gpuResident, false);
        assert.ok(h.stats.draws.includes(sub.vertexBuffer), 'the capture draws the cached sub-batch');
        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 0, 'not cut again');
        assert.deepStrictEqual([...scene['partialBatchCache'].values()], [sub]);
        // Red, hidden and never drawn as a subset, is rebuilt for the capture as before.
        assert.notStrictEqual(sceneOf(h).getBatchedMeshes().find((b) => b.expressIds.includes(3))!.gpuResident, false);
    });

    it('a capture still rebuilds an evicted batch it reveals whose subset was not on screen', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ hiddenIds: new Set([1, 2]) });
        assert.strictEqual(grey.gpuResident, false);
        h.stats.draws.length = 0;
        h.render({ restoreEvictedForCapture: true });
        assert.notStrictEqual(greyOf(h).gpuResident, false);
        assert.ok(h.stats.draws.includes(greyOf(h).vertexBuffer), 'complete in the capture frame');
    });

    it('a capture that shows a subset parent whole rebuilds it past the per-frame cap', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        scene['subsetResidency'].rebuildBudgetMs = 0;
        h.stats.draws.length = 0;
        h.render({ restoreEvictedForCapture: true });
        assert.notStrictEqual(greyOf(h).gpuResident, false, 'a capture must be complete: no cap');
        assert.ok(h.stats.draws.includes(greyOf(h).vertexBuffer));
    });

    it('a cold parent waiting for its pieces under isolate counts as not resident (#9227)', () => {
        const h = makeHarness();
        seedBatches(h);
        coldGrey(h);
        h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(h.renderer.getFrameStats()?.batchesNotResident, 1, 'its subset is missing this frame');
    });

    it('show-all after isolate past the per-frame cap: the isolated subset stands in until the queue rebuilds the parent (#9227)', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        const sub = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        scene['subsetResidency'].rebuildBudgetMs = 0;
        h.stats.draws.length = 0;
        h.render({});
        assert.strictEqual(greyOf(h), grey, 'not rebuilt past the cap');
        assert.ok(h.stats.draws.includes(sub.vertexBuffer), 'the element on screen stays on screen');
        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 0);
        scene.processResidencyRestores(device(h), pipeline(h), Infinity);
        assert.notStrictEqual(greyOf(h).gpuResident, false);
        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 1, 'freed with the replaced shell');
        assert.strictEqual(scene['partialBatchCache'].size, 0);
    });

    it('a full draw and a subset draw of the same parent in one frame keep its own buffers resident, in either order', () => {
        for (const order of ['full-first', 'subset-first'] as const) {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1);
            for (let i = 0; i < IDLE_FRAMES; i++) {
                scene.beginResidencyFrame();
                if (order === 'full-first') { scene.recordBatchDrawn(grey); scene.recordBatchSubsetDrawn(grey); }
                else { scene.recordBatchSubsetDrawn(grey); scene.recordBatchDrawn(grey); }
                scene.enforceGpuBudget();
            }
            assert.notStrictEqual(grey.gpuResident, false, `${order}: the full draw reads the parent buffers`);
        }
    });

    it('a cold partial-only parent is restored to warm only: the subset reappears without a parent GPU rebuild', async () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = sceneOf(h);
        const source = [triangle(1, GREY), triangle(2, GREY), triangle(3, RED)];
        let coldLoads = 0;
        scene.setColdGeometryProvider({ loadMeshesInBounds: async () => { coldLoads++; return source.map((m) => ({ ...m })); } });
        scene.setGpuResidencyBudget(1);
        scene.setHostResidencyBudget(1);
        // Everything hidden: both batches go GPU-evicted, then cold.
        for (let i = 0; i < 260; i++) h.render({ hiddenIds: new Set([1, 2, 3]) });
        const grey = greyOf(h);
        assert.ok(scene['coldBuckets'].has(grey.colorKey), 'grey went cold while hidden');
        grey.bounds = { min: [-1, -1, -1], max: [2, 2, 2] }; // the disk fetch is by bounds

        h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(scene.hasResidencyRestoreWork(), true, 'the subset needs its CPU pieces back');
        const createdBefore = h.stats.createdBuffers.length;
        assert.strictEqual(scene.processResidencyRestores(device(h), pipeline(h), Infinity), 0, 'cold: the disk fetch starts');
        await Promise.all(scene['coldRestoresInFlight'].values());
        assert.ok(scene.getMeshDataPieces(2)?.length, 'warm again');
        assert.ok(scene.processResidencyRestores(device(h), pipeline(h), Infinity) > 0, 'the completed warm restore asks for a render');
        assert.strictEqual(h.stats.createdBuffers.length, createdBefore, 'no parent GPU buffers were rebuilt');
        assert.strictEqual(greyOf(h).gpuResident, false);
        const drawsBefore = h.stats.draws.length;
        h.render({ isolatedIds: new Set([2]) });
        assert.ok(h.stats.draws.length > drawsBefore, 'the subset draws from the restored pieces');
        assert.strictEqual(coldLoads, 1);
        // Revealing the whole batch rebuilds it in that frame: its subset was on screen.
        h.render({ hiddenIds: new Set([3]) });
        assert.notStrictEqual(greyOf(h).gpuResident, false);
        assert.strictEqual(scene.hasResidencyRestoreWork(), false);
    });

    // Shared set-up: grey {1,2} cold (hidden past both passes), provider ready.
    const coldGrey = (h: Harness) => {
        const scene = sceneOf(h);
        const source = [triangle(1, GREY), triangle(2, GREY), triangle(3, RED)];
        scene.setColdGeometryProvider({ loadMeshesInBounds: async () => source.map((m) => ({ ...m })) });
        scene.setGpuResidencyBudget(1);
        scene.setHostResidencyBudget(1);
        for (let i = 0; i < 260; i++) h.render({ hiddenIds: new Set([1, 2, 3]) });
        const grey = greyOf(h);
        assert.ok(scene['coldBuckets'].has(grey.colorKey));
        grey.bounds = { min: [-1, -1, -1], max: [2, 2, 2] }; // the disk fetch is by bounds
        return grey;
    };

    it('a warm-only cold restore that repartitions keeps every chunk warm-only and leaves no stale mark', async () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = sceneOf(h);
        const grey = coldGrey(h);
        h.render({ isolatedIds: new Set([2]) });
        scene['cachedMaxBufferSize'] = 1; // every restored piece needs its own chunk
        scene.processResidencyRestores(device(h), pipeline(h), Infinity);
        await Promise.all(scene['coldRestoresInFlight'].values());
        const chunks = scene.getBatchedMeshes().filter((b) => b.expressIds.includes(1) || b.expressIds.includes(2));
        assert.strictEqual(chunks.length, 2, 'grey split into two chunks');
        assert.ok(!chunks.includes(grey));
        const createdBefore = h.stats.createdBuffers.length;
        assert.ok(scene.processResidencyRestores(device(h), pipeline(h), Infinity) > 0);
        assert.strictEqual(h.stats.createdBuffers.length, createdBefore, 'no chunk was rebuilt on the GPU');
        assert.ok(chunks.every((b) => b.gpuResident === false));
        assert.deepStrictEqual([...scene['subsetResidency'].warmOnly], [], 'no stale warm-only mark');
        // The split put {2} in a chunk of its own, which isolate {2} now shows
        // whole: that chunk's own buffers are wanted, the {1} chunk's are not.
        for (const b of chunks) b.bounds = undefined; // the default camera must not cull the fixture
        h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(scene.processResidencyRestores(device(h), pipeline(h), Infinity), 1);
        const shown = scene.getBatchedMeshes().find((b) => b.expressIds.includes(2))!;
        const hidden = scene.getBatchedMeshes().find((b) => b.expressIds.includes(1))!;
        assert.notStrictEqual(shown.gpuResident, false);
        assert.strictEqual(hidden.gpuResident, false);
        shown.bounds = undefined;
        const drawsBefore = h.stats.draws.length;
        h.render({ isolatedIds: new Set([2]) });
        assert.ok(h.stats.draws.length > drawsBefore, 'the restored chunk draws');
    });

    it('isolate cleared while a warm-only cold restore is in flight: the full draw still gets its GPU rebuild', async () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = sceneOf(h);
        coldGrey(h);
        h.render({ isolatedIds: new Set([2]) });
        scene.processResidencyRestores(device(h), pipeline(h), Infinity); // disk fetch in flight
        h.render({ hiddenIds: new Set([3]) });                            // grey fully visible now
        await Promise.all(scene['coldRestoresInFlight'].values());
        scene.processResidencyRestores(device(h), pipeline(h), Infinity);
        assert.notStrictEqual(greyOf(h).gpuResident, false, 'the full draw\'s request wins over the earlier subset request');
    });

    it('a cold demotion frees the sub-batch VRAM of a parent no longer drawn at all', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setColdGeometryProvider({ loadMeshesInBounds: async () => [] });
        scene.setGpuResidencyBudget(1);
        scene.setHostResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        const sub = scene['partialBatchCache'].get(scene['partialBatchCacheKeys'].get(subBatchKeys(h)[0])!) as BatchedMesh;
        // Grey leaves the view entirely (only red is isolated): nothing asks for
        // its slot again, so only the cold demotion can free it.
        for (let i = 0; i < 260; i++) h.render({ isolatedIds: new Set([3]) });
        assert.ok(scene['coldBuckets'].has(grey.colorKey));
        assert.ok(!subBatchKeys(h).some((k) => k.startsWith(`${grey.colorKey}:${grey.id}`)), 'the cold parent\'s slot is released');
        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
    });

    it('without a host budget, the sub-batch of an evicted parent that leaves the view is freed after the eviction age', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        const sub = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        for (let i = 0; i < 10; i++) h.render({ isolatedIds: new Set([3]) });
        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 0, 'kept while it may come right back');
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([3]) });
        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 1, 'freed once idle');
        assert.ok(!subBatchKeys(h).some((k) => k.startsWith(`${grey.colorKey}:${grey.id}`)));
        assert.strictEqual(scene['subsetResidency'].parents.size, 0);
        // Showing it again cuts a fresh subset from the warm pieces.
        const drawsBefore = h.stats.draws.length;
        h.render({ isolatedIds: new Set([2]) });
        assert.ok(h.stats.draws.length > drawsBefore);
    });

    it('show-all after isolate draws the formerly isolated elements on the transition frame', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        h.stats.draws.length = 0;
        h.render({});
        assert.notStrictEqual(greyOf(h).gpuResident, false, 'rebuilt in the transition frame');
        assert.ok(h.stats.draws.length > 0, 'drawn in the transition frame');
        assert.strictEqual(scene['partialBatchCache'].size, 0);
        assert.strictEqual(scene['subsetResidency'].parents.size, 0);
    });

    it('past the per-frame cap, a subset parent shown whole falls back to the queue, which keeps frames coming', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        scene['subsetResidency'].rebuildBudgetMs = 0;
        h.render({});
        assert.strictEqual(greyOf(h), grey, 'not rebuilt past the cap');
        assert.strictEqual(scene.hasResidencyRestoreWork(), true, 'queued: the app loop rebuilds it and requests a render');
        assert.ok(scene.processResidencyRestores(device(h), pipeline(h), Infinity) >= 1); // red, undrawn under isolate, too
        assert.notStrictEqual(greyOf(h).gpuResident, false);
    });

    it('with sun shadows on, the un-isolate frame rebuilds the parent once in the shadow pass and the colour pass draws that rebuild', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        h.renderer.setModelBounds(UNIT_BOUNDS);
        scene.setGpuResidencyBudget(1);
        const sun = { sunShadows: { enabled: true } } as const;
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ ...sun, isolatedIds: new Set([2]) });
        assert.strictEqual(grey.gpuResident, false);
        const residency = scene['subsetResidency'];
        const rebuild = residency.rebuildEvicted.bind(residency);
        let rebuilds = 0;
        residency.rebuildEvicted = ((...args: Parameters<typeof rebuild>) => { rebuilds++; return rebuild(...args); }) as typeof rebuild;
        // draws[] and the drawIndexed commands stay index-aligned: clear both.
        h.stats.draws.length = 0;
        h.stats.commands.length = 0;
        h.render({ ...sun });
        assert.strictEqual(rebuilds, 1, 'one rebuild, shared by both passes');
        assert.notStrictEqual(greyOf(h).gpuResident, false);
        // Only the colour pass draws through OPAQUE_PIPELINE; the shadow pass's
        // draws of the same buffers must not satisfy this.
        const colourDrawsOf = (vertexBuffer: GPUBuffer): number => {
            let pipeline: unknown = null;
            let draw = 0;
            let n = 0;
            for (const c of h.stats.commands) {
                if (c.op === 'setPipeline') pipeline = c.pipeline;
                if (c.op === 'drawIndexed' && h.stats.draws[draw++] === vertexBuffer && pipeline === OPAQUE_PIPELINE) n++;
            }
            return n;
        };
        assert.ok(colourDrawsOf(greyOf(h).vertexBuffer) > 0, 'the colour pass draws the rebuilt parent in the transition frame');
        assert.ok(!scene['residencyRestoreQueue'].has(greyOf(h).colorKey), 'grey was not skipped into the queue');
    });

    it('a subset drawn only as a shadow caster does not qualify its parent for the un-isolate rebuild', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ hiddenIds: new Set([1, 2]) });
        assert.strictEqual(grey.gpuResident, false);
        scene.beginResidencyFrame();
        scene.recordBatchSubsetDrawn(grey, false); // the shadow pass cast {2}; the view did not show it
        h.render({});
        assert.strictEqual(greyOf(h), grey, 'not rebuilt synchronously');
        assert.strictEqual(scene.hasResidencyRestoreWork(), true);
        assert.ok(scene.getMeshDataPieces(2)?.length, 'its pieces still count as used');
    });

    it('an evicted batch whose subset was NOT on screen is still restored through the time-sliced queue', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.setGpuResidencyBudget(1);
        for (let i = 0; i < IDLE_FRAMES; i++) h.render({ hiddenIds: new Set([1, 2]) });
        assert.strictEqual(grey.gpuResident, false);
        h.render({});
        assert.strictEqual(greyOf(h), grey, 'not rebuilt synchronously');
        assert.strictEqual(scene.hasResidencyRestoreWork(), true);
    });

    describe('a fully visible batch drawn only as X-Ray alpha or promotion sub-batches (#9136)', () => {
        // Grey {1, 2} resolves to two alphas: {1} faded, {2} native. Red {3} stays uniform.
        const XRAY = { transparencyOverrides: new Map([[1, 0.18]]) } as const;
        const TRANSPARENT: [number, number, number, number] = [0.2, 0.4, 0.8, 0.4];
        /** Count every rebuild of the batch holding `expressId`, synchronous or queued: both go through rebuildEvicted. */
        const countRebuilds = (scene: Scene, expressId: number): { n: number } => {
            const residency = scene['subsetResidency'];
            const rebuild = residency.rebuildEvicted.bind(residency);
            const count = { n: 0 };
            residency.rebuildEvicted = ((...args: Parameters<typeof rebuild>) => {
                if (args[1].expressIds.includes(expressId)) count.n++;
                return rebuild(...args);
            }) as typeof rebuild;
            return count;
        };
        /** The sub-batches cut from `batch`, by slot. */
        const subBatchesOf = (h: Harness, batch: BatchedMesh): BatchedMesh[] => subBatchKeys(h)
            .filter((k) => k.startsWith(`${batch.colorKey}:${batch.id}:`))
            .map((k) => sceneOf(h)['partialBatchCache'].get(sceneOf(h)['partialBatchCacheKeys'].get(k)!) as BatchedMesh);
        /** Seed glass {4, 5}: natively transparent, with {4} carrying a promoting override. */
        const seedGlass = (h: Harness): BatchedMesh => {
            const scene = sceneOf(h);
            scene.appendToBatches([triangle(4, TRANSPARENT), triangle(5, TRANSPARENT)], device(h), pipeline(h), false);
            const glass = scene.getBatchedMeshes().find((b) => b.expressIds.includes(4))!;
            glass.bounds = undefined;
            scene.setColorOverrides(new Map([[4, [1, 0, 0, 1]]]), device(h), pipeline(h));
            return glass;
        };
        /** One frame plus the app loop's restore drain, the way the viewer drives it. */
        const frame = (h: Harness, options: RenderOptions) => {
            h.render(options);
            sceneOf(h).processResidencyRestores(device(h), pipeline(h), Infinity);
        };

        it('X-Ray alpha split: the parent\'s own buffers are evicted, both alpha groups keep drawing, nothing asks for a GPU rebuild', () => {
            const h = makeHarness();
            const { grey, red } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1);
            const rebuilds = countRebuilds(scene, 1);
            for (let i = 0; i < IDLE_FRAMES; i++) h.render(XRAY);

            assert.strictEqual(grey.gpuResident, false, 'nothing reads the parent buffers, so the GPU tier frees them');
            assert.notStrictEqual(red.gpuResident, false, 'a uniform batch drawn whole keeps its own buffers');
            assert.ok(scene.getMeshDataPieces(1)?.length && scene.getMeshDataPieces(2)?.length, 'the pieces stay warm');
            assert.strictEqual(scene['partialBatchCache'].size, 2, 'one sub-batch per alpha group');
            const subs = [...scene['partialBatchCache'].values()] as BatchedMesh[];
            const drawsBefore = h.stats.draws.length;
            h.render(XRAY);
            const drawn = h.stats.draws.slice(drawsBefore);
            for (const sub of subs) assert.ok(drawn.includes(sub.vertexBuffer), 'each alpha group is still drawn');
            assert.strictEqual(scene.hasResidencyRestoreWork(), false, 'no GPU rebuild is queued');
            assert.strictEqual(rebuilds.n, 0, 'and none happened synchronously');
        });

        it('promotion split: a transparent batch with mixed overrides frees its own buffers, both sub-batches keep drawing', () => {
            const h = makeHarness();
            seedBatches(h);
            const scene = sceneOf(h);
            const glass = seedGlass(h);
            scene.setGpuResidencyBudget(1);
            const rebuilds = countRebuilds(scene, 4);
            for (let i = 0; i < IDLE_FRAMES; i++) frame(h, {});

            assert.strictEqual(glass.gpuResident, false, 'the :promoted and :remaining sub-batches never read the parent buffers');
            assert.ok(scene.getMeshDataPieces(4)?.length && scene.getMeshDataPieces(5)?.length);
            const slots = subBatchKeys(h).filter((k) => k.startsWith(`${glass.colorKey}:${glass.id}`));
            assert.deepStrictEqual(slots.map((k) => k.slice(k.lastIndexOf(':'))).sort(), [':promoted', ':remaining']);
            const drawsBefore = h.stats.draws.length;
            h.render({});
            const drawn = h.stats.draws.slice(drawsBefore);
            for (const slot of slots) {
                const sub = scene['partialBatchCache'].get(scene['partialBatchCacheKeys'].get(slot)!) as BatchedMesh;
                assert.ok(drawn.includes(sub.vertexBuffer), `${slot} is still drawn`);
            }
            assert.strictEqual(rebuilds.n, 0);
            assert.strictEqual(scene.getBatchedMeshes().find((b) => b.expressIds.includes(4)), glass, 'the same shell, never rebuilt');
        });

        it('no thrash: with the app loop draining restores every frame, the parent is evicted once and never rebuilt', () => {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1);
            const rebuilds = countRebuilds(scene, 1);
            const residency = scene['subsetResidency'];
            const noteEvicted = residency.noteEvicted.bind(residency);
            let greyEvictions = 0;
            residency.noteEvicted = ((batch: BatchedMesh) => { if (batch.expressIds.includes(1)) greyEvictions++; noteEvicted(batch); }) as typeof noteEvicted;
            let evictedAt = -1;
            for (let i = 0; i < 3 * IDLE_FRAMES; i++) {
                frame(h, XRAY);
                if (evictedAt < 0 && grey.gpuResident === false) evictedAt = i;
                if (evictedAt >= 0) {
                    assert.strictEqual(greyOf(h), grey, `frame ${i}: the evicted shell was replaced by a rebuild`);
                    assert.strictEqual(grey.gpuResident, false, `frame ${i}: the parent buffers came back`);
                }
            }
            assert.ok(evictedAt >= 0, 'the parent was evicted');
            assert.strictEqual(greyEvictions, 1, 'evicted exactly once');
            assert.strictEqual(rebuilds.n, 0, 'never rebuilt, neither synchronously nor through the queue');
        });

        it('a cold parent under X-Ray gets its pieces back, not its GPU buffers, and then splits', async () => {
            const h = makeHarness();
            seedBatches(h);
            const scene = sceneOf(h);
            coldGrey(h);
            const rebuilds = countRebuilds(scene, 1);
            h.render(XRAY);
            assert.ok(scene['subsetResidency'].warmOnly.has(greyOf(h).colorKey), 'queued for its pieces only');
            scene.processResidencyRestores(device(h), pipeline(h), Infinity);
            await Promise.all(scene['coldRestoresInFlight'].values());
            scene.processResidencyRestores(device(h), pipeline(h), Infinity);
            assert.ok(scene.getMeshDataPieces(1)?.length && scene.getMeshDataPieces(2)?.length, 'warm again');
            assert.strictEqual(rebuilds.n, 0, 'no parent GPU rebuild');
            const grey = greyOf(h);
            assert.strictEqual(grey.gpuResident, false);
            grey.bounds = undefined;
            const drawsBefore = h.stats.draws.length;
            h.render(XRAY);
            const subs = subBatchesOf(h, grey);
            assert.strictEqual(subs.length, 2, 'one sub-batch per alpha group');
            const drawn = h.stats.draws.slice(drawsBefore);
            for (const sub of subs) assert.ok(drawn.includes(sub.vertexBuffer), 'each alpha group draws from the restored pieces');
            scene.processResidencyRestores(device(h), pipeline(h), Infinity);
            assert.strictEqual(rebuilds.n, 0);
            assert.strictEqual(greyOf(h), grey);
        });

        it('a cold transparent batch with mixed promotion gets its pieces back, not its GPU buffers', async () => {
            const h = makeHarness();
            seedBatches(h);
            const scene = sceneOf(h);
            let glass = seedGlass(h);
            scene.setColorOverrides(new Map(), device(h), pipeline(h)); // no split while it goes cold
            const source = [triangle(1, GREY), triangle(2, GREY), triangle(3, RED), triangle(4, TRANSPARENT), triangle(5, TRANSPARENT)];
            scene.setColdGeometryProvider({ loadMeshesInBounds: async () => source.map((m) => ({ ...m })) });
            scene.setGpuResidencyBudget(1);
            scene.setHostResidencyBudget(1);
            for (let i = 0; i < 260; i++) h.render({ hiddenIds: new Set([1, 2, 3, 4, 5]) });
            glass = scene.getBatchedMeshes().find((b) => b.expressIds.includes(4))!;
            assert.ok(scene['coldBuckets'].has(glass.colorKey), 'glass went cold while hidden');
            glass.bounds = { min: [-1, -1, -1], max: [2, 2, 2] }; // the disk fetch is by bounds
            scene.setColorOverrides(new Map([[4, [1, 0, 0, 1]]]), device(h), pipeline(h));
            const rebuilds = countRebuilds(scene, 4);
            h.render({ hiddenIds: new Set([1, 2, 3]) });
            assert.ok(scene['subsetResidency'].warmOnly.has(glass.colorKey), 'queued for its pieces only');
            scene.processResidencyRestores(device(h), pipeline(h), Infinity);
            await Promise.all(scene['coldRestoresInFlight'].values());
            scene.processResidencyRestores(device(h), pipeline(h), Infinity);
            assert.ok(scene.getMeshDataPieces(4)?.length && scene.getMeshDataPieces(5)?.length, 'warm again');
            glass = scene.getBatchedMeshes().find((b) => b.expressIds.includes(4))!;
            glass.bounds = undefined;
            const drawsBefore = h.stats.draws.length;
            h.render({ hiddenIds: new Set([1, 2, 3]) });
            const subs = subBatchesOf(h, glass);
            assert.strictEqual(subs.length, 2, ':promoted and :remaining');
            const drawn = h.stats.draws.slice(drawsBefore);
            for (const sub of subs) assert.ok(drawn.includes(sub.vertexBuffer));
            scene.processResidencyRestores(device(h), pipeline(h), Infinity);
            assert.strictEqual(rebuilds.n, 0, 'no parent GPU rebuild');
            assert.strictEqual(glass.gpuResident, false);
        });

        it('X-Ray still on but the batch no longer splits: rebuilt and drawn whole on that frame, its alpha slots retired', () => {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1);
            for (let i = 0; i < IDLE_FRAMES; i++) h.render(XRAY);
            assert.strictEqual(grey.gpuResident, false);
            const oldSubs = subBatchesOf(h, grey);
            assert.strictEqual(oldSubs.length, 2);
            h.stats.draws.length = 0;
            h.render({ transparencyOverrides: new Map([[3, 0.18]]) }); // grey uniform again; X-Ray stays active
            const rebuilt = greyOf(h);
            assert.notStrictEqual(rebuilt, grey);
            assert.notStrictEqual(rebuilt.gpuResident, false);
            assert.ok(h.stats.draws.includes(rebuilt.vertexBuffer), 'drawn whole on the transition frame');
            assert.ok(!scene['residencyRestoreQueue'].has(rebuilt.colorKey));
            assert.deepStrictEqual(subBatchesOf(h, grey), [], 'the old alpha slots are gone');
            for (const sub of oldSubs) assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        });

        it('X-Ray cleared: the evicted parent is rebuilt and drawn on the transition frame', () => {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1);
            for (let i = 0; i < IDLE_FRAMES; i++) h.render(XRAY);
            assert.strictEqual(grey.gpuResident, false);
            h.stats.draws.length = 0;
            h.render({});
            const rebuilt = greyOf(h);
            assert.notStrictEqual(rebuilt, grey);
            assert.notStrictEqual(rebuilt.gpuResident, false, 'rebuilt in the transition frame');
            assert.ok(h.stats.draws.includes(rebuilt.vertexBuffer), 'drawn whole in the transition frame');
            assert.ok(!scene['residencyRestoreQueue'].has(rebuilt.colorKey));
        });

        it('an evicted batch that cannot be partitioned is restored whole under X-Ray, not left waiting for pieces', () => {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1);
            for (let i = 0; i < IDLE_FRAMES; i++) h.render({ hiddenIds: new Set([1, 2]) }); // grey undrawn: evicted, still warm
            assert.strictEqual(grey.gpuResident, false);
            scene.canPartitionBatch = () => false; // e.g. a colour-merged piece
            frame(h, XRAY);
            assert.ok(!scene['subsetResidency'].warmOnly.has(grey.colorKey), 'no pieces-only restore for a warm batch');
            const rebuilt = greyOf(h);
            assert.notStrictEqual(rebuilt.gpuResident, false, 'the whole-batch fallback asked for its own buffers back');
            h.stats.draws.length = 0;
            h.render(XRAY);
            assert.ok(h.stats.draws.includes(rebuilt.vertexBuffer), 'drawn whole at the batch-wide alpha');
        });

        it('regression guard: a resident batch that cannot be partitioned still draws whole under X-Ray and keeps its own buffers', () => {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            scene.setGpuResidencyBudget(1);
            scene.canPartitionBatch = () => false; // e.g. a colour-merged piece
            const rebuilds = countRebuilds(scene, 1);
            for (let i = 0; i < IDLE_FRAMES; i++) frame(h, XRAY);
            assert.notStrictEqual(grey.gpuResident, false, 'the whole-batch fallback reads its own buffers');
            assert.strictEqual(scene['partialBatchCache'].size, 0);
            assert.strictEqual(rebuilds.n, 0);
        });

        it('with sun shadows on, the shadow pass casts the parent whole, so it stays resident and is never rebuilt', () => {
            const h = makeHarness();
            const { grey } = seedBatches(h);
            const scene = sceneOf(h);
            h.renderer.setModelBounds(UNIT_BOUNDS);
            scene.setGpuResidencyBudget(1);
            const rebuilds = countRebuilds(scene, 1);
            for (let i = 0; i < IDLE_FRAMES; i++) frame(h, { ...XRAY, sunShadows: { enabled: true } });
            assert.notStrictEqual(grey.gpuResident, false, 'the shadow pass reads its own buffers');
            assert.strictEqual(greyOf(h), grey);
            assert.strictEqual(rebuilds.n, 0);
            assert.strictEqual(scene['partialBatchCache'].size, 2, 'the colour pass still splits it');
        });

        describe('follow-ups (#9227)', () => {
            /** The pipeline the colour pass bound for each draw of `vertexBuffer`. */
            const pipelinesOf = (h: Harness, vertexBuffer: GPUBuffer): unknown[] => {
                let bound: unknown = null;
                let draw = 0;
                const out: unknown[] = [];
                for (const c of h.stats.commands) {
                    if (c.op === 'setPipeline') bound = c.pipeline;
                    if (c.op === 'drawIndexed' && h.stats.draws[draw++] === vertexBuffer) out.push(bound);
                }
                return out;
            };
            const evictedUnderXRay = (h: Harness, options: RenderOptions = XRAY) => {
                const { grey } = seedBatches(h);
                sceneOf(h).setGpuResidencyBudget(1);
                for (let i = 0; i < IDLE_FRAMES; i++) h.render(options);
                assert.strictEqual(grey.gpuResident, false);
                const subs = subBatchesOf(h, grey);
                assert.strictEqual(subs.length, 2);
                return { grey, subs };
            };

            it('X-Ray cleared past the rebuild cap: the alpha sub-batches stand in, opaque, until the queue rebuilds the parent', () => {
                const h = makeHarness();
                const { grey, subs } = evictedUnderXRay(h);
                const scene = sceneOf(h);
                scene['subsetResidency'].rebuildBudgetMs = 0;
                for (let frame = 0; frame < 3; frame++) {
                    h.stats.draws.length = 0;
                    h.stats.commands.length = 0;
                    h.render({});
                    assert.strictEqual(greyOf(h), grey, `frame ${frame}: not rebuilt past the cap`);
                    for (const sub of subs) {
                        assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 0, `frame ${frame}: kept`);
                        assert.deepStrictEqual(pipelinesOf(h, sub.vertexBuffer), [OPAQUE_PIPELINE], `frame ${frame}: drawn once, at the native alpha`);
                    }
                }
                assert.strictEqual(scene.hasResidencyRestoreWork(), true, 'the rebuild is queued');
                scene.processResidencyRestores(device(h), pipeline(h), Infinity);
                const rebuilt = greyOf(h);
                assert.notStrictEqual(rebuilt, grey);
                for (const sub of subs) assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 1, 'freed with the replaced shell');
                h.stats.draws.length = 0;
                h.render({});
                assert.ok(h.stats.draws.includes(rebuilt.vertexBuffer));
                assert.strictEqual(scene['partialBatchCache'].size, 0);
            });

            it('X-Ray cleared while hide stays on, past the cap: the alpha slot sweep keeps the stand-ins', () => {
                const h = makeHarness();
                const hideRed = { hiddenIds: new Set([3]) };
                const { grey, subs } = evictedUnderXRay(h, { ...XRAY, ...hideRed });
                sceneOf(h)['subsetResidency'].rebuildBudgetMs = 0;
                h.stats.draws.length = 0;
                h.render(hideRed);
                assert.strictEqual(greyOf(h), grey);
                for (const sub of subs) {
                    assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 0);
                    assert.ok(h.stats.draws.includes(sub.vertexBuffer), 'each alpha group stands in');
                }
            });

            it('stand-ins of a parent that then leaves the view are freed after the eviction age', () => {
                const h = makeHarness();
                const { subs } = evictedUnderXRay(h);
                const scene = sceneOf(h);
                scene['subsetResidency'].rebuildBudgetMs = 0;
                h.render({});
                for (let i = 0; i < IDLE_FRAMES; i++) h.render({ hiddenIds: new Set([1, 2]) });
                for (const sub of subs) assert.strictEqual((sub.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
                assert.strictEqual(scene['partialBatchCache'].size, 0);
                assert.strictEqual(scene['subsetResidency'].parents.size, 0);
            });

            it('a capture under the same X-Ray neither rebuilds the parent nor cuts its alpha sub-batches again', () => {
                const h = makeHarness();
                const { grey, subs } = evictedUnderXRay(h);
                const scene = sceneOf(h);
                const rebuilds = countRebuilds(scene, 1);
                const createdBefore = h.stats.createdBuffers.length;
                h.stats.draws.length = 0;
                h.render({ ...XRAY, restoreEvictedForCapture: true });
                assert.strictEqual(rebuilds.n, 0, 'the capture draws the split from the warm pieces');
                assert.strictEqual(greyOf(h), grey);
                assert.deepStrictEqual(subBatchesOf(h, grey), subs, 'the same sub-batches');
                for (const sub of subs) assert.ok(h.stats.draws.includes(sub.vertexBuffer));
                assert.strictEqual(h.stats.createdBuffers.length, createdBefore, 'no GPU allocation for the capture');
                for (let i = 0; i < IDLE_FRAMES; i++) h.render(XRAY);
                assert.strictEqual(rebuilds.n, 0, 'nothing for the budget to evict again');
            });

            it('a cold parent waiting for its pieces under X-Ray counts as not resident', () => {
                const h = makeHarness();
                seedBatches(h);
                coldGrey(h);
                h.render({ ...XRAY, hiddenIds: new Set([3]) });
                assert.ok(sceneOf(h)['subsetResidency'].warmOnly.has(greyOf(h).colorKey), 'waiting for its pieces');
                assert.strictEqual(h.renderer.getFrameStats()?.batchesNotResident, 1, 'missing this frame');
            });
        });

        describe('a transparent batch with mixed promotion that cannot be partitioned draws whole (#9220)', () => {
            /** The pipeline of every colour-pass draw from `vertexBuffer`, in order. */
            const pipelinesDrawing = (h: Harness, vertexBuffer: GPUBuffer): unknown[] => {
                const out: unknown[] = [];
                let pipeline: unknown = null;
                let draw = 0;
                for (const c of h.stats.commands) {
                    if (c.op === 'setPipeline') pipeline = c.pipeline;
                    if (c.op === 'drawIndexed' && h.stats.draws[draw++] === vertexBuffer) out.push(pipeline);
                }
                return out;
            };
            /** Indices the colour pass drew from `batch` and every sub-batch cut from it (any slot). */
            const indicesDrawnFrom = (h: Harness, batch: BatchedMesh): number => {
                const scene = sceneOf(h);
                const subs = subBatchKeys(h)
                    .filter((k) => k === `${batch.colorKey}:${batch.id}` || k.startsWith(`${batch.colorKey}:${batch.id}:`))
                    .map((k) => scene['partialBatchCache'].get(scene['partialBatchCacheKeys'].get(k)!) as BatchedMesh);
                return [batch, ...subs].reduce((n, b) => n + b.indexCount * pipelinesDrawing(h, b.vertexBuffer).length, 0);
            };
            const clearFrame = (h: Harness) => { h.stats.draws.length = 0; h.stats.commands.length = 0; };
            /**
             * Glass {4, 5} whose merged piece holds BOTH entities, tagged per vertex, beside a
             * plain piece of {5}: the batch lists 4 and 5, and {4} carries a promoting override.
             * Promoted {4} and remaining {5} would each pull the merged piece in.
             */
            const seedMergedGlass = (h: Harness, extra: MeshData[] = []): BatchedMesh => {
                const scene = sceneOf(h);
                const merged = { ...triangle(4, TRANSPARENT), entityIds: new Uint32Array([4, 5, 5]) } as MeshData;
                scene.appendToBatches([merged, triangle(5, TRANSPARENT), ...extra], device(h), pipeline(h), false);
                const glass = scene.getBatchedMeshes().find((b) => b.expressIds.includes(4))!;
                glass.bounds = undefined;
                assert.deepStrictEqual([...new Set(glass.expressIds)].sort(), [4, 5, ...extra.map((m) => m.expressId)].sort(), 'setup: one batch');
                assert.strictEqual(scene.canPartitionBatch(glass), false, 'setup: a colour-merged piece');
                scene.setColorOverrides(new Map([[4, [1, 0, 0, 1]]]), device(h), pipeline(h));
                return glass;
            };

            it('under geometryReleased, a transparent batch with one promoted member still draws, whole', () => {
                const h = makeHarness();
                seedBatches(h);
                const scene = sceneOf(h);
                const glass = seedGlass(h);
                scene.releaseGeometryData();
                assert.strictEqual(scene.isGeometryDataReleased(), true, 'setup: released');
                clearFrame(h);
                h.render({});
                assert.deepStrictEqual(pipelinesDrawing(h, glass.vertexBuffer), [TRANSPARENT_PIPELINE], 'drawn once, whole, at its native routing');
                assert.strictEqual(indicesDrawnFrom(h, glass), 6, 'both triangles');
                assert.strictEqual(scene['partialBatchCache'].size, 0, 'no sub-batch asked for: there is no CPU geometry to cut one from');
            });

            it('a colour-merged piece in a fully visible batch is drawn exactly once, and the batch keeps its own buffers', () => {
                const h = makeHarness();
                seedBatches(h);
                const scene = sceneOf(h);
                const glass = seedMergedGlass(h);
                assert.strictEqual(glass.indexCount, 6, 'setup: the merged piece and the plain {5}');
                scene.setGpuResidencyBudget(1);
                const rebuilds = countRebuilds(scene, 4);
                for (let i = 0; i < IDLE_FRAMES; i++) frame(h, {});
                clearFrame(h);
                h.render({});
                assert.strictEqual(indicesDrawnFrom(h, glass), 6, 'each triangle once: the merged piece is not drawn again');
                assert.deepStrictEqual(pipelinesDrawing(h, glass.vertexBuffer), [TRANSPARENT_PIPELINE], 'whole, at its native routing');
                assert.strictEqual(scene['partialBatchCache'].size, 0);
                assert.notStrictEqual(glass.gpuResident, false, 'the whole draw reads its own buffers, so they stay');
                assert.strictEqual(scene.getBatchedMeshes().find((b) => b.expressIds.includes(4)), glass, 'never rebuilt');
                assert.strictEqual(rebuilds.n, 0, 'no evict/rebuild cycle');
            });

            it('under hide, a colour-merged piece in the visible subset is drawn exactly once', () => {
                const h = makeHarness();
                seedBatches(h);
                const scene = sceneOf(h);
                const glass = seedMergedGlass(h, [triangle(6, TRANSPARENT)]);
                clearFrame(h);
                h.render({ hiddenIds: new Set([6]) });
                assert.deepStrictEqual(subBatchKeys(h).filter((k) => k.startsWith(`${glass.colorKey}:${glass.id}:`)), [], 'no :promoted / :remaining slots');
                const slot = scene['partialBatchCacheKeys'].get(`${glass.colorKey}:${glass.id}`);
                assert.ok(slot !== undefined, 'one sub-batch for the visible subset');
                const sub = scene['partialBatchCache'].get(slot) as BatchedMesh;
                assert.strictEqual(sub.indexCount, 6, 'the merged piece once, beside the plain {5}');
                assert.deepStrictEqual(pipelinesDrawing(h, sub.vertexBuffer), [TRANSPARENT_PIPELINE]);
                assert.strictEqual(indicesDrawnFrom(h, glass), 6);
            });

            it('regression guard: a partitionable transparent batch under hide still splits by promotion', () => {
                const h = makeHarness();
                seedBatches(h);
                const scene = sceneOf(h);
                scene.appendToBatches([4, 5, 6].map((id) => triangle(id, TRANSPARENT)), device(h), pipeline(h), false);
                const glass = scene.getBatchedMeshes().find((b) => b.expressIds.includes(4))!;
                glass.bounds = undefined;
                assert.strictEqual(scene.canPartitionBatch(glass), true, 'setup');
                scene.setColorOverrides(new Map([[4, [1, 0, 0, 1]]]), device(h), pipeline(h));
                h.render({ hiddenIds: new Set([6]) });
                const slots = subBatchKeys(h).filter((k) => k.startsWith(`${glass.colorKey}:${glass.id}`));
                assert.deepStrictEqual(slots.map((k) => k.slice(k.lastIndexOf(':'))).sort(), [':promoted', ':remaining']);
            });
        });
    });
});

describe('hydrated selection meshes across renders', () => {
    // #2985. Renderer.createMeshFromData is the only place a MeshData becomes an
    // individual GPU Mesh, and it is what the GPU pick pass indexes into — so a
    // representation item dropped HERE cannot be reported by any pick, however
    // correct picker.ts is. Tested through the real render() + real Scene
    // because the method needs a device; the rest of the pick contract lives in
    // pick-item-id.test.ts.
    it('hydration carries the source geometryItemId onto the individual mesh', () => {
        const ITEM = 4638; // deliberately unlike the expressId below
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const withItem = { ...triangle(7, GREY), geometryItemId: ITEM } as MeshData;
        scene.appendToBatches([withItem, triangle(8, RED)], device, h.renderer['pipeline'] as never, false);
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;

        h.render({ selectedId: 7 });
        const hydrated = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 7);
        assert.strictEqual(hydrated.length, 1, 'selecting the entity hydrates its mesh');
        assert.strictEqual(hydrated[0].geometryItemId, ITEM);

        // And a piece with no item identity leaves the key readable as absent
        // rather than as a plausible id.
        h.render({ selectedId: 8 });
        const plain = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 8);
        assert.strictEqual(plain.length, 1);
        assert.strictEqual(plain[0].geometryItemId, undefined);
    });

    // A colour-merged piece's item id belongs to no single entity in it, so
    // hydration must withhold it exactly as the CPU raycaster does — one click
    // must not answer two ways either side of the pick-mesh budget (#2985).
    //
    // Called DIRECTLY, not through a render: both in-tree callers reach this
    // method via Scene.getMeshDataPieces, which splits a merged piece per
    // entity and — as a side effect of rebuilding the literal, not by any
    // stated rule — carries neither entityIds nor geometryItemId forward. This
    // method is public, so it owns the rule rather than inheriting that
    // accident, and a raw merged MeshData is what tests the rule.
    it('createMeshFromData withholds a colour-merged batch id, matching the CPU raycast', () => {
        const ITEM = 4638;
        const h = makeHarness();
        const scene = sceneOf(h);
        const merged = {
            ...triangle(9, GREY),
            geometryItemId: ITEM,
            entityIds: new Uint32Array([9, 10, 10]),
        } as MeshData;
        h.renderer.createMeshFromData(merged);

        const made = scene.getMeshes().filter((m) => m.expressId === 9);
        assert.strictEqual(made.length, 1, 'the mesh was created');
        assert.strictEqual(made[0].geometryItemId, undefined);

        // Positive control: the same call on an UNMERGED piece does report it,
        // so the assertion above is the merge rule and not a dead field.
        h.renderer.createMeshFromData({ ...triangle(11, GREY), geometryItemId: ITEM } as MeshData);
        const plainItem = scene.getMeshes().filter((m) => m.expressId === 11);
        assert.strictEqual(plainItem.length, 1);
        assert.strictEqual(plainItem[0].geometryItemId, ITEM);
    });

    it('selection thrash: earlier selections are disposed, the current one is kept', () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = sceneOf(h);

        const hydratedFor = (id: number) =>
            scene.getMeshes().filter((m) => m.hydrated && m.expressId === id);

        h.render({ selectedId: 1 });
        assert.strictEqual(hydratedFor(1).length, 1, 'selected entity hydrates an individual mesh');
        const mesh1 = hydratedFor(1)[0];

        h.render({ selectedId: 2 });
        assert.strictEqual(hydratedFor(1).length, 0, 'previous selection is disposed');
        assert.strictEqual((mesh1.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual(hydratedFor(2).length, 1);
        const mesh2 = hydratedFor(2)[0];

        h.render({ selectedId: 3 });
        assert.strictEqual((mesh2.vertexBuffer as unknown as FakeBuffer).destroyed, 1);
        assert.strictEqual(hydratedFor(3).length, 1);

        h.render({});
        assert.strictEqual(scene.getMeshes().filter((m) => m.hydrated).length, 0, 'deselect frees everything');
        for (const buf of h.stats.createdBuffers) {
            assert.ok(buf.destroyed <= 1, 'hydrated mesh buffer double-destroyed');
        }
    });

    it('same express id in two federated models: switching models disposes the other model\'s mesh', () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = sceneOf(h);
        // Two models share express id 42 (federation reuses local ids).
        scene.addMeshData(triangle(42, GREY, 0));
        scene.addMeshData(triangle(42, RED, 1));

        h.render({ selectedId: 42, selectedModelIndex: 0 });
        const model0 = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 42);
        assert.strictEqual(model0.length, 1);
        assert.strictEqual(model0[0].modelIndex, 0);

        // Same express id, different model — the model-0 mesh must be freed
        // (an id-only snapshot would keep it resident and drawing).
        h.render({ selectedId: 42, selectedModelIndex: 1 });
        const hydrated = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 42);
        assert.strictEqual(hydrated.length, 1, 'exactly one model\'s mesh stays hydrated');
        assert.strictEqual(hydrated[0].modelIndex, 1);
        assert.strictEqual((model0[0].vertexBuffer as unknown as FakeBuffer).destroyed, 1);

        h.render({});
        assert.strictEqual(scene.getMeshes().filter((m) => m.hydrated).length, 0);
    });

    // #4382, a follow-up on #2985: RenderOptions.selectedItemId narrows the
    // whole-product highlight to one representation item. End-to-end through
    // the real render() loop (unlike scene-level tests, this also proves
    // index.ts's own selectedMeshes/hydration filtering, not just Scene's).
    it('RenderOptions.selectedItemId hydrates and highlights only the matching representation item', () => {
        const ITEM_A = 301;
        const ITEM_B = 302;
        const h = makeHarness();
        seedBatches(h);
        const scene = sceneOf(h);
        scene.addMeshData({ ...triangle(50, GREY), geometryItemId: ITEM_A } as MeshData);
        scene.addMeshData({ ...triangle(50, GREY), geometryItemId: ITEM_B } as MeshData);

        h.render({ selectedId: 50, selectedItemId: ITEM_A });
        let hydrated = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 50);
        assert.strictEqual(hydrated.length, 1, 'only the item-A piece hydrates');
        assert.strictEqual(hydrated[0].geometryItemId, ITEM_A);
        const itemAMesh = hydrated[0];

        // Switching the item within the SAME still-selected product replaces
        // the highlight cleanly: item A's piece is disposed (not left
        // resident alongside item B's).
        h.render({ selectedId: 50, selectedItemId: ITEM_B });
        hydrated = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 50);
        assert.strictEqual(hydrated.length, 1, 'item A is disposed, only item B hydrates');
        assert.strictEqual(hydrated[0].geometryItemId, ITEM_B);
        assert.strictEqual((itemAMesh.vertexBuffer as unknown as FakeBuffer).destroyed, 1);

        // Dropping selectedItemId (whole product again) is the ordinary path
        // and must be unaffected: both pieces hydrate.
        h.render({ selectedId: 50 });
        hydrated = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 50);
        assert.strictEqual(hydrated.length, 2, 'whole-product selection hydrates every piece');
    });
});

describe('drawables outside the RTE eye envelope (#6128)', () => {
    /**
     * One mesh at the camera and one 3,000 km away (a stray element, or a
     * second model on another grid). The far one cannot be represented in the
     * camera's RTE frame; both passes must skip it rather than throw.
     */
    function seedNearAndFar(h: Harness): { near: Mesh; far: Mesh } {
        h.renderer.createMeshFromData(triangle(21, GREY));
        h.renderer.createMeshFromData({ ...triangle(22, RED), origin: [3_000_000, 0, 0] } as MeshData);
        const meshes = sceneOf(h).getMeshes();
        return {
            near: meshes.find((m) => m.expressId === 21)!,
            far: meshes.find((m) => m.expressId === 22)!,
        };
    }

    it('pick() resolves instead of throwing a camera-relative envelope RangeError', async () => {
        const h = makeHarness();
        seedNearAndFar(h);
        const picker = new Picker(h.renderer['device'], 256, 256);
        (h.renderer as unknown as Record<string, unknown>)['picker'] = picker;
        h.renderer['pickingManager'].setPicker(picker);

        assert.strictEqual(await h.renderer.pick(10, 10), null);
        assert.strictEqual(h.stats.mapAsync, 1, 'the pick pass ran to its combined readback (#6881)');
        assert.deepStrictEqual(await h.renderer.pickRect(0, 0, 8, 8), new Set());
    });

    it('the colour frame draws the near mesh, skips the far one, and does not degrade', () => {
        const h = makeHarness();
        const { near, far } = seedNearAndFar(h);
        h.render();
        assert.strictEqual(h.renderer['frameContainedThrow'], false, 'the frame completed');
        assert.ok(h.stats.draws.includes(near.vertexBuffer), 'the near mesh is drawn');
        assert.ok(!h.stats.draws.includes(far.vertexBuffer), 'the far mesh is skipped');
    });
});

/**
 * Regression for #1901: an unhandled `AbortError` from `mapAsync` on every
 * click after the GPU device went away.
 *
 * `render()` has always early-returned on a destroyed/lost device; the pick
 * path did not. A pick is a full GPU round trip ending in a `mapAsync`
 * readback, so once the device is gone that readback rejects — and the DOM
 * click/contextmenu handlers that reach here are `async` listeners whose
 * promise nobody awaits, so the rejection escapes unhandled. Not a one-shot
 * teardown race: the picker stays dead, so it fired once per click (three
 * aborts 0.8 s apart in one production session).
 *
 * Every assertion below is on `stats.mapAsync`, not just on the returned
 * value: the fix must short-circuit BEFORE the GPU call. A try/catch around
 * the readback would still report a non-zero count and fail these.
 */
describe('pick path survives a dead GPU device (#1901)', () => {
    /** Wire a REAL Picker into the renderer (init() needs a browser). */
    function installPicker(h: Harness): Picker {
        const picker = new Picker(h.renderer['device'], 256, 256);
        (h.renderer as unknown as Record<string, unknown>)['picker'] = picker;
        h.renderer['pickingManager'].setPicker(picker);
        return picker;
    }

    /** Model an involuntary loss (driver reset / GPU-process crash). */
    function loseDevice(h: Harness): void {
        h.knobs.gpuDead = true;
        h.renderer['handleDeviceLost']({ message: 'device lost', reason: 'unknown' });
    }

    it('positive control: a healthy pick really does reach the mapAsync readback', async () => {
        const h = makeHarness();
        installPicker(h);
        // Resolves null because the stub reads back a zeroed sample (no hit);
        // the readback COUNT is what proves the pass ran, not the value.
        assert.strictEqual(await h.renderer.pick(10, 10), null);
        assert.strictEqual(h.stats.mapAsync, 1, 'pick() maps the combined ID/depth readback (#6881)');

        h.stats.mapAsync = 0;
        assert.deepStrictEqual(await h.renderer.pickRect(0, 0, 8, 8), new Set());
        assert.strictEqual(h.stats.mapAsync, 1, 'pickRect() maps the rect readback');
    });

    it('pick() after destroy() resolves null instead of rejecting with AbortError', async () => {
        const h = makeHarness();
        installPicker(h);
        h.renderer.destroy();

        h.stats.mapAsync = 0;
        assert.strictEqual(await h.renderer.pick(10, 10), null);
        assert.strictEqual(h.stats.mapAsync, 0, 'guard must fire before the GPU readback');
    });

    it('pick() after an involuntary device loss resolves null instead of rejecting', async () => {
        const h = makeHarness();
        installPicker(h);
        // The production shape: renderer still mounted, canvas frozen, user
        // keeps clicking. Every click used to mint an unhandled rejection.
        loseDevice(h);

        h.stats.mapAsync = 0;
        for (let i = 0; i < 3; i++) {
            assert.strictEqual(await h.renderer.pick(10, 10), null);
        }
        assert.strictEqual(h.stats.mapAsync, 0, 'no click may reach the GPU readback');
    });

    it('pickRect() resolves an empty set after destroy() and after device loss', async () => {
        const destroyed = makeHarness();
        installPicker(destroyed);
        destroyed.renderer.destroy();
        destroyed.stats.mapAsync = 0;
        assert.deepStrictEqual(await destroyed.renderer.pickRect(0, 0, 8, 8), new Set());
        assert.strictEqual(destroyed.stats.mapAsync, 0);

        const lost = makeHarness();
        installPicker(lost);
        loseDevice(lost);
        lost.stats.mapAsync = 0;
        assert.deepStrictEqual(await lost.renderer.pickRect(0, 0, 8, 8), new Set());
        assert.strictEqual(lost.stats.mapAsync, 0);
    });

    it('Picker itself is inert after destroy() (it is a public export, usable standalone)', async () => {
        const h = makeHarness();
        const picker = installPicker(h);
        const viewProj = new Float32Array(16);
        picker.destroy();
        h.knobs.gpuDead = true;

        h.stats.mapAsync = 0;
        assert.strictEqual(await picker.pick(10, 10, 256, 256, [], viewProj), null);
        assert.deepStrictEqual(await picker.pickRect(0, 0, 8, 8, 256, 256, [], viewProj), new Set());
        assert.strictEqual(h.stats.mapAsync, 0);
    });

    it('destroy() clears the picker the PickingManager holds, not just the renderer\'s', () => {
        const h = makeHarness();
        installPicker(h);
        h.renderer.destroy();
        assert.strictEqual(h.renderer['pickingManager']['picker'], null,
            'a dangling manager reference keeps driving destroyed GPU resources');
    });
});

/**
 * Second half of #1901: the window the entry guards CANNOT close.
 *
 * A pick that was perfectly legal when it started is still aborted if the
 * device dies between `queue.submit()` and the `mapAsync` settling — the
 * canvas unmounts, the model reloads (`Renderer.destroy()` ends in
 * `device.destroy()`), or the driver resets. Same `AbortError`, same async
 * stack (the awaiting `pick` frames are preserved), same unhandled rejection,
 * because the DOM listeners that reach here are `async` functions nobody
 * awaits.
 *
 * These tests deliberately let the readback RUN (`stats.mapAsync > 0`) — that
 * is the whole point, the guard already fired for everything it can see.
 */
describe('pick path survives the device dying mid-readback (#1901)', () => {
    function installPicker(h: Harness): Picker {
        const picker = new Picker(h.renderer['device'], 256, 256);
        (h.renderer as unknown as Record<string, unknown>)['picker'] = picker;
        h.renderer['pickingManager'].setPicker(picker);
        return picker;
    }

    /**
     * The picker allocates its id/depth targets and per-mesh slot buffers on
     * its first pick and keeps them; they are not per-pick transients. Warm it
     * so an allocation count taken afterwards measures one pick's own buffers.
     */
    async function warm(h: Harness, picker: Picker): Promise<Picker> {
        await picker.pick(0, 0, 64, 64, [], new Float32Array(16));
        h.stats.mapAsync = 0;
        return picker;
    }

    /**
     * Run the pick up to the point where it is parked on `mapAsync`. Boxed in
     * an object because `await` unwraps a promise-of-a-promise — returning the
     * in-flight promise directly would await the very thing we want to keep
     * parked.
     */
    async function park(h: Harness, start: () => Promise<unknown>): Promise<{ inflight: Promise<unknown> }> {
        h.knobs.deferMaps = true;
        const inflight = start();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        assert.ok(h.pendingMaps() > 0, 'pick should be parked on the mapAsync readback');
        return { inflight };
    }

    for (const kind of ['point', 'rectangle'] as const) {
        it(`suppresses a completed-map result after device loss and releases exactly once: ${kind} (#6881)`, async () => {
            const h = makeHarness();
            const picker = await warm(h, installPicker(h));
            const before = h.stats.createdBuffers.length;
            const { inflight } = await park(h, () => kind === 'point'
                ? picker.pick(0, 0, 64, 64, [], new Float32Array(16))
                : picker.pickRect(0, 0, 8, 8, 64, 64, [], new Float32Array(16)));
            // Native Chromium can complete the map, then invalidate the range
            // before its consumer resumes. Delivery remains parked here.
            h.knobs.pickFault = 'mapped-range';
            h.loseDevice();
            await Promise.resolve();
            h.settlePendingMaps();
            assert.deepStrictEqual(await inflight, kind === 'point' ? null : new Set());
            const owned = h.stats.createdBuffers.slice(before);
            assert.strictEqual(owned.length, kind === 'point' ? 3 : 1);
            picker.destroy();
            for (const buffer of owned) assert.strictEqual(buffer.destroyed, 1);
        });
    }

    it('pick() parked on mapAsync when destroy() lands resolves null, not AbortError', async () => {
        const h = makeHarness();
        installPicker(h);
        const { inflight } = await park(h, () => h.renderer.pick(10, 10));
        h.renderer.destroy();
        assert.strictEqual(await inflight, null);
        assert.ok(h.stats.mapAsync > 0, 'the readback really was in flight');
    });

    it('pickRect() parked on mapAsync when destroy() lands resolves empty, not AbortError', async () => {
        const h = makeHarness();
        installPicker(h);
        const { inflight } = await park(h, () => h.renderer.pickRect(0, 0, 8, 8));
        h.renderer.destroy();
        assert.deepStrictEqual(await inflight, new Set());
    });

    it('an involuntary loss mid-readback degrades the same way', async () => {
        const h = makeHarness();
        installPicker(h);
        const { inflight } = await park(h, () => h.renderer.pick(10, 10));
        h.knobs.gpuDead = true;
        h.renderer['handleDeviceLost']({ message: 'device lost', reason: 'unknown' });
        h.settlePendingMaps(new DOMException(MAP_ASYNC_ABORT, 'AbortError'));
        assert.strictEqual(await inflight, null);
    });

    it('overlapping picks are all released, not just the newest', async () => {
        const h = makeHarness();
        installPicker(h);
        h.knobs.deferMaps = true;
        const first = h.renderer.pick(10, 10);
        for (let i = 0; i < 3; i++) await Promise.resolve();
        const second = h.renderer.pick(20, 20);
        for (let i = 0; i < 3; i++) await Promise.resolve();
        // Without this the case can pass vacuously: if the picks need more
        // microtask turns to reach mapAsync than we spun, destroy() lands
        // before submit and both settle via the ENTRY guard, never exercising
        // the overlapping-in-flight release this case exists to cover.
        // #6881: each pick maps one staging buffer containing both ID and depth.
        assert.strictEqual(h.pendingMaps(), 2, 'both picks must be parked on their readbacks');
        h.renderer.destroy();
        const settled = await Promise.allSettled([first, second]);
        assert.deepStrictEqual(settled.map((s) => s.status), ['fulfilled', 'fulfilled']);
    });

    for (const path of ['point', 'rectangle'] as const) {
        it(`direct ${path} teardown rejects completed old data (#6881 lifecycle)`, async () => {
            const h = makeHarness();
            const picker = installPicker(h);
            const before = h.stats.createdBuffers.length;
            const { inflight } = await park(h, () => path === 'point'
                ? picker.pick(0, 0, 64, 64, [], new Float32Array(16))
                : picker.pickRect(0, 0, 0, 0, 64, 64, [], new Float32Array(16)));
            const owned = h.stats.createdBuffers.slice(before);
            // Stated byte-layout input, not a GPU oracle: instanced ID 123 at
            // staging byte zero. A map completed before destroy may be delivered
            // afterwards without rejecting (e.g. a delayed promise continuation).
            new Uint32Array(owned[0].getMappedRange())[0] = 0x40000000 | 123;
            h.settlePendingMaps();
            picker.destroy(); // lands before the awaiting continuation resumes
            assert.deepEqual(await inflight, path === 'point' ? null : new Set());
            assert.ok(owned.every(buffer => buffer.destroyed === 1),
                'every transient resource must still be released exactly once');
        });
    }

    for (const path of ['point', 'rectangle'] as const) {
        it(`direct ${path} teardown releases all overlapping pending readbacks (#6881 lifecycle)`, async () => {
            const h = makeHarness();
            const picker = installPicker(h);
            const before = h.stats.createdBuffers.length;
            const start = () => path === 'point'
                ? picker.pick(0, 0, 64, 64, [], new Float32Array(16))
                : picker.pickRect(0, 0, 0, 0, 64, 64, [], new Float32Array(16));
            const first = await park(h, start);
            const mapsPerCall = h.pendingMaps();
            const second = await park(h, start);
            const owned = h.stats.createdBuffers.slice(before);
            assert.equal(h.pendingMaps(), mapsPerCall * 2, 'both calls reached the async boundary');
            assert.ok(owned.length >= 2, 'both calls allocated owned readbacks');
            picker.destroy();
            const releasedBeforeDelivery = owned.every(buffer => buffer.destroyed === 1);
            // Drain even the failing baseline: never leave parked fixture work.
            h.settlePendingMaps();
            await Promise.all([first.inflight, second.inflight]);
            assert.ok(releasedBeforeDelivery, 'destroy releases without waiting for promise delivery');
            assert.ok(owned.every(buffer => buffer.destroyed === 1), 'late finally must not double-release');
        });
    }

    it('point-pick transient allocation stays bounded across viewport sizes (#6881)', async () => {
        for (const [width, height] of [[64, 64], [1292, 1047]]) {
            const h = makeHarness();
            const picker = await warm(h, installPicker(h));
            const before = h.stats.createdBuffers.length;
            const { inflight } = await park(h, () => picker.pick(0, 0, width, height, [], new Float32Array(16)));
            const owned = h.stats.createdBuffers.slice(before);
            assert.ok(owned.reduce((bytes, buffer) => bytes + buffer.size, 0) <= 268,
                'point picking must not allocate a viewport-sized depth readback');
            h.settlePendingMaps();
            await inflight;
            assert.ok(owned.every(buffer => buffer.destroyed === 1), 'all per-pick resources are released once');
            picker.destroy();
        }
    });

    for (const fault of ['id-copy', 'depth-encode', 'depth-copy', 'finish', 'submit', 'mapped-range'] as const) {
        it(`point-pick releases every owned buffer when ${fault} fails (#6881)`, async () => {
            const h = makeHarness();
            const picker = await warm(h, installPicker(h));
            const before = h.stats.createdBuffers.length;
            if (fault === 'submit') h.knobs.submitThrows = true;
            else h.knobs.pickFault = fault;
            try {
                await assert.rejects(picker.pick(0, 0, 64, 64, [], new Float32Array(16)), /boom/);
                const owned = h.stats.createdBuffers.slice(before);
                assert.strictEqual(owned.length, fault === 'id-copy' ? 1 : 3,
                    'fault must occur after the expected transient allocations');
                assert.strictEqual(h.stats.mapAsync, fault === 'mapped-range' ? 1 : 0,
                    'fault must occur at the requested encoding or mapped-read boundary');
                assert.ok(owned.every(buffer => buffer.destroyed === 1),
                    'every transient buffer must be released exactly once on propagation');
            } finally {
                picker.destroy();
            }
        });
    }

    for (const fault of ['id-copy', 'finish', 'submit', 'mapped-range'] as const) {
        it(`rectangle-pick releases its staging buffer when ${fault} fails (#6881)`, async () => {
            const h = makeHarness();
            const picker = await warm(h, installPicker(h));
            const before = h.stats.createdBuffers.length;
            if (fault === 'submit') h.knobs.submitThrows = true;
            else h.knobs.pickFault = fault;
            try {
                await assert.rejects(picker.pickRect(0, 0, 8, 8, 64, 64, [], new Float32Array(16)), /boom/);
                const owned = h.stats.createdBuffers.slice(before);
                assert.strictEqual(owned.length, 1, 'rectangle fault must reach its staging allocation');
                assert.strictEqual(h.stats.mapAsync, fault === 'mapped-range' ? 1 : 0,
                    'fault must occur at the requested encoding or mapped-read boundary');
                assert.strictEqual(owned[0].destroyed, 1, 'staging must be released exactly once');
            } finally {
                picker.destroy();
            }
        });
    }

    it('a REAL readback fault still propagates — the catch is not a blanket swallow', async () => {
        const h = makeHarness();
        installPicker(h);
        const { inflight } = await park(h, () => h.renderer.pick(10, 10));
        // Validation failures reject with OperationError, never AbortError.
        h.settlePendingMaps(new DOMException('Buffer is already mapped', 'OperationError'));
        await assert.rejects(inflight, /already mapped/);

        const rect = makeHarness();
        installPicker(rect);
        const rectInflight = await park(rect, () => rect.renderer.pickRect(0, 0, 8, 8));
        rect.settlePendingMaps(new DOMException('Buffer is already mapped', 'OperationError'));
        await assert.rejects(rectInflight.inflight, /already mapped/);
    });

    it('a REAL readback fault still frees the readback buffers on its way out', async () => {
        // #1901: the abort path released the readbacks but the rethrow path did
        // not, so every real fault leaked its GPU allocation for the life of the
        // device. Promise.all rejects the moment ONE map fails, so the other
        // buffer can be mapped and live at that point — both must be freed.
        const h = makeHarness();
        await warm(h, installPicker(h));
        const before = h.stats.createdBuffers.length;
        const { inflight } = await park(h, () => h.renderer.pick(10, 10));
        h.settlePendingMaps(new DOMException('Buffer is already mapped', 'OperationError'));
        await assert.rejects(inflight, /already mapped/);

        const readbacks = h.stats.createdBuffers.slice(before);
        assert.strictEqual(readbacks.length, 3, 'pick() owns staging, coordinates and depth output (#6881)');
        for (const buf of readbacks) {
            assert.ok(buf.destroyed > 0, 'a readback buffer survived the rethrow — leaked');
        }
    });
});

/**
 * The other half of #2985's GPU route: `Picker.pick` is where a decoded texel
 * becomes the `PickResult` a host sees, and every other test of that mapping
 * stubs `picker.pick` and calls `resolvePickSample` directly. One
 * unconditional call, so the exposure is far smaller than `Scene.raycast`'s —
 * but the harness already runs a REAL `Picker` against the stub GPU, so
 * closing it costs one test rather than a browser lane.
 *
 * The readback is seeded by hand: the stub's pick target is zero-filled, which
 * decodes as "no hit" and returns before the mapping runs at all. Writing
 * (index + 1) into the parked colour readback is what the pick pass would have
 * written for a hit on mesh 0.
 */
describe('Picker.pick maps a real readback onto the picked item (#2985)', () => {
    it('carries the hit mesh\'s geometryItemId out onto the PickResult', async () => {
        const ITEM = 4638;
        const h = makeHarness();
        const picker = new Picker(h.renderer['device'], 256, 256);
        const mesh = {
            expressId: 7,
            modelIndex: 2,
            geometryItemId: ITEM,
            vertexBuffer: {},
            indexBuffer: {},
            indexCount: 3,
        } as unknown as Mesh;

        const before = h.stats.createdBuffers.length;
        h.knobs.deferMaps = true;
        const inflight = picker.pick(4, 4, 256, 256, [mesh], new Float32Array(16));
        for (let i = 0; i < 5; i++) await Promise.resolve();
        assert.ok(h.pendingMaps() > 0, 'the pick must be parked on its readbacks');

        // The combined ID/depth readback is the pick's only 256-byte buffer;
        // `pick` reads texel 0 of it as a u32 (#6881).
        const colour = h.stats.createdBuffers.slice(before).filter((b) => b.size === 256);
        assert.strictEqual(colour.length, 1, 'expected exactly one colour readback');
        new Uint32Array(colour[0].getMappedRange())[0] = 1; // mesh 0, written as index + 1

        h.settlePendingMaps();
        const result = await inflight;
        assert.strictEqual(result?.expressId, 7);
        assert.strictEqual(result?.modelIndex, 2);
        assert.strictEqual(result?.geometryItemId, ITEM, 'the pick collapsed to the product');
    });

    it('leaves the key absent for a mesh with no item identity', async () => {
        const h = makeHarness();
        const picker = new Picker(h.renderer['device'], 256, 256);
        const mesh = {
            expressId: 7, modelIndex: 2, vertexBuffer: {}, indexBuffer: {}, indexCount: 3,
        } as unknown as Mesh;

        const before = h.stats.createdBuffers.length;
        h.knobs.deferMaps = true;
        const inflight = picker.pick(4, 4, 256, 256, [mesh], new Float32Array(16));
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const colour = h.stats.createdBuffers.slice(before).filter((b) => b.size === 256);
        new Uint32Array(colour[0].getMappedRange())[0] = 1;

        h.settlePendingMaps();
        const result = await inflight;
        assert.ok(result && !('geometryItemId' in result), 'expected the key to be absent');
    });
});

/**
 * #1973 — the textured sub-pass must carry each mesh's per-element `origin` as
 * its model translation. It used to hoist `tpl[28..30] = 0` out of the loop,
 * which was right only for the orphan type-geometry path (absolute positions,
 * `origin == 0`) and drew every textured occurrence offset by `-origin`.
 *
 * The scene-side bookkeeping is covered in `scene-textured-origin.test.ts`;
 * this asserts the value that actually reaches the GPU.
 */
function texturedTriangle(expressId: number, origin?: [number, number, number]): MeshData {
    return {
        expressId,
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        color: [1, 1, 1, 1],
        uvs: new Float32Array([0, 0, 1, 0, 0, 1]),
        texture: { width: 1, height: 1, rgba: new Uint8Array([255, 255, 255, 255]), repeatS: false, repeatT: false },
        ...(origin ? { origin } : {}),
    };
}

function isArenaSlot(target: unknown): target is MeshUniformSlot {
    return typeof target === 'object' && target !== null && 'release' in target && 'offset' in target;
}

/**
 * The uniform blocks `target` received, oldest first. A colour batch's arena
 * slot reports what the frame's flush queued for it on the GPU, not its CPU
 * mirror, so a stale flush fails here (mesh-uniform-arena.ts); a standalone
 * uniform buffer reports each write.
 */
function uniformBlocks(h: Harness, target: unknown): Float32Array[] {
    if (isArenaSlot(target)) {
        const held = h.stats.gpuBytes.get(target.buffer);
        if (!held || held.length < target.offset + target.size) return [];
        return [new Float32Array(held.slice(target.offset, target.offset + target.size).buffer)];
    }
    return h.stats.writes.filter((w) => w.buffer === target).map((w) => w.floats);
}

/** The last uniform block `target` received with at least `minFloats` floats. */
function lastBlock(h: Harness, target: unknown, minFloats: number): Float32Array | null {
    return uniformBlocks(h, target).filter((b) => b.length >= minFloats).at(-1) ?? null;
}

/** The model-matrix translation column of the uniform written for `tm`. */
function translationFor(h: Harness, target: unknown): number[] | null {
    const block = lastBlock(h, target, 31);
    return block ? [block[28], block[29], block[30]] : null;
}

/** RTE drawable delta lanes appended after the legacy + quantized uniform ABI. */
function rteDeltaFor(h: Harness, target: unknown): Float32Array | null {
    return lastBlock(h, target, 84)?.slice(76, 84) ?? null;
}

describe('textured sub-pass carries the per-element origin (#1973)', () => {
    const ORIGIN: [number, number, number] = [12.5, 10.5, -3.25];

    function seedTextured(h: Harness, meshes: MeshData[]) {
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        scene.appendToBatches(meshes, device, pipeline, false);
        return scene.getTexturedMeshes();
    }

    it('writes the mesh origin into the model translation', () => {
        const h = makeHarness();
        const textured = seedTextured(h, [texturedTriangle(1, ORIGIN)]);
        assert.strictEqual(textured.length, 1);

        h.stats.writes.length = 0;
        h.render();

        assert.deepStrictEqual(translationFor(h, textured[0].uniformBuffer), ORIGIN);
    });

    it('writes zero for a mesh whose positions are already absolute', () => {
        // The #961 orphan type-geometry path: `transform_mesh_local` leaves
        // positions in world space and sets no origin.
        const h = makeHarness();
        const textured = seedTextured(h, [texturedTriangle(1)]);

        h.stats.writes.length = 0;
        h.render();

        assert.deepStrictEqual(translationFor(h, textured[0].uniformBuffer), [0, 0, 0]);
    });

    it('gives each textured mesh its OWN origin, not the last one written', () => {
        // The bug class this replaces was a single hoisted write shared by every
        // mesh in the pass, so per-mesh divergence is the property that matters.
        const h = makeHarness();
        const other: [number, number, number] = [-4, 0.5, 88];
        const textured = seedTextured(h, [texturedTriangle(1, ORIGIN), texturedTriangle(2, other)]);
        assert.strictEqual(textured.length, 2);

        h.stats.writes.length = 0;
        h.render();

        assert.deepStrictEqual(translationFor(h, textured[0].uniformBuffer), ORIGIN);
        assert.deepStrictEqual(translationFor(h, textured[1].uniformBuffer), other);
    });

    it('keeps a centimetre residual at a 5,000 km textured origin (#5049)', () => {
        const h = makeHarness();
        const origin: [number, number, number] = [5_000_000.015625, 0, 0];
        const textured = seedTextured(h, [texturedTriangle(1, origin)]);
        h.renderer['camera'].setPosition(5_000_000, 0, 10);
        h.renderer['camera'].setTarget(5_000_000, 0, 0);

        h.stats.writes.length = 0;
        h.render();

        const packed = rteDeltaFor(h, textured[0].uniformBuffer);
        assert.ok(packed, 'textured draw must upload RTE high/low origin lanes');
        assert.equal(rteRelativePositionF32([0, 0, 0], packed)[0], 0.015625);
    });
});

describe('batched RTE draw uniforms (#5049)', () => {
    it('uses one high/low camera-relative origin for flat and quantized batches', () => {
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        scene.appendToBatches([triangle(1, [0.4, 0.5, 0.6, 1])], device, h.renderer['pipeline'] as never, false);
        const batch = scene.getBatchedMeshes()[0];
        batch.origin = [5_000_000.015625, 0, 0];
        batch.bounds = undefined;
        batch.quantized = { min: [1, 2, 3], step: 0.001 };
        h.renderer['camera'].setPosition(5_000_000, 0, 10);
        h.renderer['camera'].setTarget(5_000_000, 0, 0);

        h.stats.writes.length = 0;
        h.render();

        const slot = batch.uniformSlot!;
        const packed = rteDeltaFor(h, slot);
        assert.ok(packed, 'flat batch must receive the appended RTE lanes');
        assert.equal(rteRelativePositionF32([0, 0, 0], packed)[0], 0.015625);
        const write = h.stats.writes.find((w) => w.buffer === slot.buffer
            && w.offset <= slot.offset && slot.offset + slot.size <= w.offset + w.floats.byteLength);
        assert.ok(write, 'the frame flush must upload the batch uniform block');
        const block = write.floats.slice((slot.offset - write.offset) / 4, (slot.offset - write.offset + slot.size) / 4);
        assert.equal(new Uint32Array(block.buffer)[44] & 0x10000, 0x10000);
        assert.deepStrictEqual(Array.from(block.slice(56, 60)), [1, 2, 3, Math.fround(0.001)]);
    });
});

describe('batch uniforms reach the GPU in one write per arena page', () => {
    /** Queue writes aimed at the arena pages the batches share. */
    function arenaWrites(h: Harness, batches: BatchedMesh[]): number {
        const pages = new Set(batches.map((b) => b.uniformSlot!.buffer));
        return h.stats.writes.filter((w) => pages.has(w.buffer as GPUBuffer)).length;
    }

    it('a moving camera rewrites every drawn batch with ONE queue write; a still one writes none', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);
        assert.strictEqual(grey.uniformSlot!.buffer, red.uniformSlot!.buffer, 'batches share one arena page');
        h.render();
        h.stats.writes.length = 0;
        h.renderer['camera'].setPosition(3, 4, 12);
        h.render();
        assert.strictEqual(arenaWrites(h, [grey, red]), 1, 'two drawn batches, one queue operation');
        assert.strictEqual(lastBlock(h, grey.uniformSlot, 36)?.[32], Math.fround(GREY[0]));
        assert.strictEqual(lastBlock(h, red.uniformSlot, 36)?.[32], Math.fround(RED[0]));
        h.stats.writes.length = 0;
        h.render();
        assert.strictEqual(arenaWrites(h, [grey, red]), 0, 'unchanged camera and state: nothing to upload');
    });

    it('binds each redundant pipeline once across consecutive batches', () => {
        const h = makeHarness();
        seedBatches(h);
        h.stats.commands.length = 0;
        h.render();
        const sets = h.stats.commands.filter((c) => c.op === 'setPipeline');
        for (let i = 1; i < sets.length; i++) {
            assert.notStrictEqual(sets[i]!.pipeline, sets[i - 1]!.pipeline, `setPipeline #${i} re-binds the bound pipeline`);
        }
    });
});

describe('individual mesh RTE fallback (#5049)', () => {
    it('keeps a 5,000-km centimetre origin through the no-batch opaque draw', () => {
        const h = makeHarness();
        const origin: [number, number, number] = [5_000_000.015625, 0, 0];
        h.renderer['createMeshFromData']({ ...triangle(91, GREY), origin });
        const mesh = sceneOf(h).getMeshes()[0];
        h.renderer['camera'].setPosition(5_000_000, 0, 10);
        h.renderer['camera'].setTarget(5_000_000, 0, 0);

        h.stats.writes.length = 0;
        h.render();

        const packed = rteDeltaFor(h, mesh.uniformBuffer);
        assert.ok(packed, 'no-batch mesh must write RTE drawable lanes');
        assert.equal(rteRelativePositionF32([0, 0, 0], packed)[0], 0.015625);
        const write = h.stats.writes.find(candidate => candidate.buffer === mesh.uniformBuffer)!;
        assert.equal(new Uint32Array(write.floats.buffer)[44] & 0x10000, 0x10000, 'shader selects RTE projection');
    });
});

describe('X-Ray fades the entity, not its colour batch (#4129)', () => {
    /**
     * The alpha (uniform float 35) of the LAST block `target` received,
     * compared against the f32 the GPU actually receives.
     */
    function assertAlpha(h: Harness, target: unknown, expected: number, message?: string): void {
        const actual = lastBlock(h, target, 36)?.[35] ?? null;
        assert.strictEqual(actual, Math.fround(expected), message ?? `expected alpha ${expected}`);
    }

    /** The cached sub-batch whose id set is exactly `ids`. */
    function subBatchFor(h: Harness, ids: number[]): BatchedMesh {
        const found = [...sceneOf(h)['partialBatchCache'].values()].filter(
            (b) => b.expressIds.length === ids.length && ids.every((id) => b.expressIds.includes(id)),
        );
        assert.strictEqual(found.length, 1, `expected exactly one sub-batch for {${ids}}`);
        return found[0];
    }

    it('draws the named entity faded and its batchmate solid, in one frame', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);

        // The reported case: one id in the caller's X-Ray set, and the grey
        // batch holds a second, unrelated entity at the same colour.
        h.render({ transparencyOverrides: new Map([[1, 0.18]]) });

        assert.ok(!h.stats.draws.includes(grey.vertexBuffer),
            'the mixed batch must not draw whole — that is what faded the batchmate');
        const faded = subBatchFor(h, [1]);
        const solid = subBatchFor(h, [2]);
        assert.ok(h.stats.draws.includes(faded.vertexBuffer), 'the X-Rayed entity draws');
        assert.ok(h.stats.draws.includes(solid.vertexBuffer), 'so does the entity nobody asked to fade');
        assertAlpha(h, faded.uniformSlot, 0.18);
        assertAlpha(h, solid.uniformSlot, 1, 'batchmate keeps the batch colour alpha');
        assert.ok(h.stats.draws.includes(red.vertexBuffer), 'an untouched batch still draws whole');
    });

    it('leaves a batch alone when every entity in it is X-Rayed alike', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);

        h.render({ transparencyOverrides: new Map([[1, 0.18], [2, 0.18]]) });

        assert.strictEqual(sceneOf(h)['partialBatchCache'].size, 0, 'no sub-batch worth building');
        assert.ok(h.stats.draws.includes(grey.vertexBuffer));
        assertAlpha(h, grey.uniformSlot, 0.18);
    });

    it('keeps a ghost-excepted entity solid without co-selecting it', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);

        h.render({ ghostExceptIds: new Set([2]) });

        assert.ok(!h.stats.draws.includes(grey.vertexBuffer));
        assertAlpha(h, subBatchFor(h, [1]).uniformSlot, DEFAULT_GHOST_ALPHA);
        assertAlpha(h, subBatchFor(h, [2]).uniformSlot, 1);
    });

    it('draws context ghosts with the ghost pipeline, and an X-Ray override with the transparent one', () => {
        const h = makeHarness();
        const { red } = seedBatches(h);
        const pipelineOfDraw = (vertexBuffer: GPUBuffer): unknown => {
            let pipeline: unknown = null;
            let draw = 0;
            for (const c of h.stats.commands) {
                if (c.op === 'setPipeline') pipeline = c.pipeline;
                if (c.op === 'drawIndexed' && h.stats.draws[draw++] === vertexBuffer) return pipeline;
            }
            return undefined;
        };

        h.render({ ghostExceptIds: new Set([2]) });
        assert.strictEqual(pipelineOfDraw(subBatchFor(h, [1]).vertexBuffer), GHOST_PIPELINE, 'the ghosted batchmate');
        assert.strictEqual(pipelineOfDraw(red.vertexBuffer), GHOST_PIPELINE, 'a wholly ghosted batch');
        assert.strictEqual(pipelineOfDraw(subBatchFor(h, [2]).vertexBuffer), OPAQUE_PIPELINE, 'the excepted entity');

        h.stats.commands.length = 0;
        h.stats.draws.length = 0;
        h.render({ transparencyOverrides: new Map([[1, 0.18]]) });
        assert.strictEqual(pipelineOfDraw(subBatchFor(h, [1]).vertexBuffer), TRANSPARENT_PIPELINE, 'an override keeps full shading');
    });

    it('re-splits when the X-Ray set changes and frees the clones when it clears', () => {
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);

        h.render({ transparencyOverrides: new Map([[1, 0.18]]) });
        const firstFaded = subBatchFor(h, [1]);
        const firstVb = firstFaded.vertexBuffer as unknown as FakeBuffer;

        // Same content, fresh Map: the epoch must NOT bump, so no rebuild.
        const buffersAfterFirst = h.stats.createdBuffers.length;
        h.render({ transparencyOverrides: new Map([[1, 0.18]]) });
        assert.strictEqual(h.stats.createdBuffers.length, buffersAfterFirst, 'identical content rebuilt the split');
        assert.strictEqual(subBatchFor(h, [1]), firstFaded);

        // Move the X-Ray to the other entity: both slots re-key by content.
        h.stats.draws.length = 0;
        h.render({ transparencyOverrides: new Map([[2, 0.18]]) });
        assertAlpha(h, subBatchFor(h, [2]).uniformSlot, 0.18);
        assertAlpha(h, subBatchFor(h, [1]).uniformSlot, 1);
        assert.strictEqual(firstVb.destroyed, 1, 'the superseded clone is freed exactly once');

        // X-Ray off: the batch draws whole again and the clones are released.
        h.stats.draws.length = 0;
        h.render({});
        assert.strictEqual(scene['partialBatchCache'].size, 0, 'X-Ray clones leaked past the last X-Ray frame');
        assert.ok(h.stats.draws.includes(grey.vertexBuffer));
        assertAlpha(h, grey.uniformSlot, 1);
        for (const buf of h.stats.createdBuffers) {
            assert.ok(buf.destroyed <= 1, 'a VRAM-tracked buffer was destroyed more than once');
        }
    });

    it('splits only the VISIBLE subset when hide/isolate is also active', () => {
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        scene.appendToBatches([triangle(1, GREY), triangle(2, GREY), triangle(3, GREY)], device, pipeline, false);
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;

        h.render({ hiddenIds: new Set([3]), transparencyOverrides: new Map([[1, 0.18]]) });

        assertAlpha(h, subBatchFor(h, [1]).uniformSlot, 0.18);
        assertAlpha(h, subBatchFor(h, [2]).uniformSlot, 1);
        assert.strictEqual(scene['partialBatchCache'].size, 2, 'the hidden id must not reach either sub-batch');
    });

    it('draws every faded sub-batch after every solid one, so no ghost is painted over', () => {
        // A ghost writes no depth, so an opaque draw that lands after it covers
        // it completely. With two split batches in one frame the naive order
        // (per parent) interleaves them; the pass has to be split by routing.
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        scene.appendToBatches(
            [triangle(1, GREY), triangle(2, GREY), triangle(3, RED), triangle(4, RED)],
            device, pipeline, false,
        );
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;

        h.render({ transparencyOverrides: new Map([[1, 0.18], [3, 0.18]]) });

        // "No solid draw lands after any ghost" = max(every solid index) <
        // min(every faded index). The solid side therefore has to measure its
        // LAST draw: with indexOf, a solid buffer recorded twice (early and
        // late) would report the early index and the assertion would pass while
        // a late opaque draw erased the ghost — failing open.
        const first = (ids: number[]) => h.stats.draws.indexOf(subBatchFor(h, ids).vertexBuffer);
        const last = (ids: number[]) => h.stats.draws.lastIndexOf(subBatchFor(h, ids).vertexBuffer);
        const lastSolid = Math.max(last([2]), last([4]));
        const firstFaded = Math.min(first([1]), first([3]));
        assert.ok(firstFaded >= 0 && lastSolid >= 0, 'every sub-batch drew');
        assert.ok(lastSolid < firstFaded, 'a solid sub-batch drew after a ghost and would erase it');
    });

    it('resolves X-Ray once per X-Ray edit, not once per frame', () => {
        // The resolution walks every id of every batch, which an orbit would
        // otherwise repeat each frame for an X-Ray that has not changed.
        const h = makeHarness();
        const { grey } = seedBatches(h);

        h.render({ ghostExceptIds: new Set([2]) });
        const first = h.renderer['_xrayAlpha'];
        assert.ok(first !== null);

        h.render({ ghostExceptIds: new Set([2]) });
        assert.strictEqual(h.renderer['_xrayAlpha'], first, 'identical content resolved X-Ray again');

        h.render({ ghostExceptIds: new Set([1]) });
        assert.notStrictEqual(h.renderer['_xrayAlpha'], first, 'a changed X-Ray kept the old resolution');
        assert.ok(!h.stats.draws.includes(grey.vertexBuffer));
        assertAlpha(h, subBatchFor(h, [2]).uniformSlot, DEFAULT_GHOST_ALPHA);
        assertAlpha(h, subBatchFor(h, [1]).uniformSlot, 1);
    });

    it('holds the X-Ray it resolved when the caller later mutates a set it has replaced', () => {
        // The tracker compares the set passed THIS frame with its own copy, so
        // the resolution it keeps must not read a set the caller still owns.
        // A batch already resolved keeps its answer, so the stale read shows on
        // the next batch the resolution meets: here, one rebuilt by new geometry.
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        scene.appendToBatches([triangle(1, GREY), triangle(2, GREY)], device, pipeline, false);
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;
        const ghostA = new Set([2]);
        const selectedA = new Set<number>();

        h.render({ ghostExceptIds: ghostA, selectedIds: selectedA });
        h.render({ ghostExceptIds: new Set([2]), selectedIds: new Set<number>() });
        ghostA.clear();
        selectedA.add(1);
        scene.appendToBatches([triangle(3, GREY)], device, pipeline, false);
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;
        h.render({ ghostExceptIds: new Set([2]), selectedIds: new Set<number>() });

        assertAlpha(h, subBatchFor(h, [1, 3]).uniformSlot, DEFAULT_GHOST_ALPHA);
        assertAlpha(h, subBatchFor(h, [2]).uniformSlot, 1);
    });

    it('re-splits when SELECTION changes, since selection exempts an entity from fading', () => {
        // Selection is an input to the split (a selected entity is exempt), so it
        // has to reach the sub-batch cache epoch. It did not: the epoch fast path
        // returns a cached clone without ever looking at the id set it was asked
        // for, so the slots kept their old membership. User-visible as: X-Ray an
        // element, select it, deselect it — and it stays solid.
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        scene.appendToBatches(
            [triangle(1, GREY), triangle(2, GREY), triangle(3, GREY)], device, pipeline, false,
        );
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;
        const overrides = () => new Map([[1, 0.18], [2, 0.18]]);

        // Entity 1 selected → exempt → it belongs to the SOLID group.
        h.render({ transparencyOverrides: overrides(), selectedIds: new Set([1]) });
        assertAlpha(h, subBatchFor(h, [2]).uniformSlot, 0.18);
        assertAlpha(h, subBatchFor(h, [1, 3]).uniformSlot, 1);

        // Deselect: entity 1 is X-Rayed again and must rejoin the faded group.
        h.render({ transparencyOverrides: overrides() });
        assertAlpha(h, subBatchFor(h, [1, 2]).uniformSlot, 0.18);
        assertAlpha(h, subBatchFor(h, [3]).uniformSlot, 1);
    });

    it('frees the sub-batch slots of a batch that stops splitting while X-Ray stays on', () => {
        // The clones live outside the GPU residency budget, and the wholesale
        // drop only fires once hide/isolate AND X-Ray are all off — so a batch
        // that stops needing a split mid-session used to pin its slots for the
        // rest of that session.
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);

        h.render({ transparencyOverrides: new Map([[1, 0.18]]) });
        const faded = subBatchFor(h, [1]);
        const solid = subBatchFor(h, [2]);
        assert.strictEqual(scene['partialBatchCache'].size, 2);

        // Move the X-Ray onto the OTHER batch: grey is uniform again and draws
        // whole, so neither of its slots can ever be revisited.
        h.render({ transparencyOverrides: new Map([[3, 0.18]]) });

        assert.ok(h.stats.draws.includes(grey.vertexBuffer), 'the un-split batch draws whole again');
        assert.strictEqual((faded.vertexBuffer as unknown as FakeBuffer).destroyed, 1, 'orphaned slot leaked');
        assert.strictEqual((solid.vertexBuffer as unknown as FakeBuffer).destroyed, 1, 'orphaned slot leaked');
        assert.ok(
            ![...scene['partialBatchCache'].values()].some((b) => b === faded || b === solid),
            'a retired clone must not stay reachable in the cache',
        );
    });

    it('frees a batch\'s sub-batch clones when the batch itself is rebuilt', () => {
        // Every other path that destroys a parent batch clears the partial cache
        // (residency eviction drops that batch's slots; finalize/release/clear
        // drop all of them). A bucket rebuild did not, and a rebuilt batch gets a
        // NEW id — which is baked into its slot keys — so the old slots became
        // unreachable with their GPU buffers still alive. Reachable whenever more
        // geometry lands in a bucket while hide/isolate is on: a federated model
        // add, or a late chunk of the same one.
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        scene.appendToBatches([triangle(1, GREY), triangle(2, GREY)], device, pipeline, false);
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;

        h.render({ hiddenIds: new Set([2]) });
        assert.strictEqual(scene['partialBatchCache'].size, 1, 'setup: a clone exists for the visible subset');
        const clone = [...scene['partialBatchCache'].values()][0] as BatchedMesh;
        const cloneVb = clone.vertexBuffer as unknown as FakeBuffer;

        // More geometry into the SAME bucket → the parent batch is rebuilt.
        scene.appendToBatches([triangle(3, GREY)], device, pipeline, false);

        assert.strictEqual(cloneVb.destroyed, 1, 'the rebuilt parent left its sub-batch clone pinned');
        assert.ok(
            ![...scene['partialBatchCache'].values()].some((b) => b === clone),
            'a freed clone must not stay reachable in the cache',
        );
    });

    it('falls back to the whole batch when its geometry cannot be partitioned', () => {
        // A colour-merged piece carries many entities in ONE MeshData tagged per
        // vertex, so it cannot be handed to one subset without handing it to the
        // other too. The documented degradation is the pre-#4129 fade, never
        // missing or double-drawn geometry.
        const h = makeHarness();
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        const merged = triangle(1, GREY) as MeshData & { entityIds: Uint32Array };
        merged.entityIds = new Uint32Array([1, 1, 1]);
        scene.appendToBatches([merged, triangle(2, GREY)], device, pipeline, false);
        const batch = scene.getBatchedMeshes()[0];
        batch.bounds = undefined;
        assert.strictEqual(scene.canPartitionBatch(batch), false);

        h.render({ transparencyOverrides: new Map([[1, 0.18]]) });

        assert.strictEqual(scene['partialBatchCache'].size, 0);
        assert.ok(h.stats.draws.includes(batch.vertexBuffer), 'geometry must not go missing');
        assertAlpha(h, batch.uniformSlot, 0.18, 'batch-wide minimum, as documented');
    });
});

const UNIT_BOUNDS = { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } };

// The sun shadow depth pre-pass is opt-in (RenderOptions.sunShadows). These
// drive the REAL render() loop and read the encoded pass labels, so "no shadow
// pass was encoded" is actually observed rather than assumed — the gap the
// #2670 review flagged (the label lived only in shadow-pass.ts, in no test).
describe('sun shadow pass (#2670 review)', () => {
    it('encodes no shadow-depth-pass on the default off path', () => {
        const h = makeHarness();
        seedBatches(h);
        h.renderer.setModelBounds(UNIT_BOUNDS);
        h.render(); // sunShadows absent → off
        assert.ok(
            !h.stats.passes.includes('shadow-depth-pass'),
            'the zero-cost off path must not encode the depth pre-pass',
        );
        assert.strictEqual(h.renderer['shadowPass'], null, 'no ShadowPass constructed while off');
    });

    it('encodes exactly one shadow-depth-pass when enabled', () => {
        const h = makeHarness();
        seedBatches(h);
        h.renderer.setModelBounds(UNIT_BOUNDS);
        h.render({ sunShadows: { enabled: true } });
        assert.strictEqual(
            h.stats.passes.filter((l) => l === 'shadow-depth-pass').length,
            1,
            'enabling shadows must encode the depth pre-pass exactly once',
        );
    });

    it('frees the depth texture and stops encoding the pass on toggle-off', () => {
        const h = makeHarness();
        seedBatches(h);
        h.renderer.setModelBounds(UNIT_BOUNDS);
        h.render({ sunShadows: { enabled: true } });
        const freedBefore = h.stats.destroyedTextures.filter((l) => l === 'shadow-depth').length;

        h.stats.passes.length = 0;
        h.render({ sunShadows: { enabled: false } });

        assert.ok(
            !h.stats.passes.includes('shadow-depth-pass'),
            'the toggle-off frame must not encode the depth pass',
        );
        assert.strictEqual(
            h.stats.destroyedTextures.filter((l) => l === 'shadow-depth').length,
            freedBefore + 1,
            'toggle-off must release the depth texture, not hold it for the session',
        );
        assert.strictEqual(
            h.renderer['shadowPass'],
            null,
            'ShadowPass is nulled so a later re-enable reconstructs it lazily',
        );
    });
});

describe('rendered clipping query for exact correspondence picking (#4381)', () => {
    it('reports actual section, terrain and box clipping and clears on an unclipped frame', async () => {
        const h = makeHarness();
        seedBatches(h);
        h.render();
        assert.equal(h.renderer.hasActiveClipping(), false);
        h.render({ sectionPlane: { enabled: true, axis: 'down', position: 50 } });
        assert.equal(h.renderer.hasActiveClipping(), true);
        h.render({ sectionPlane: { enabled: false, axis: 'down', position: 50 } });
        assert.equal(h.renderer.hasActiveClipping(), false);
        h.render({ terrainClipY: 0 });
        assert.equal(h.renderer.hasActiveClipping(), true, 'zero is an active terrain elevation');
        const clipBox = { enabled: true, min: [0,0,0] as [number,number,number], max: [1,1,1] as [number,number,number] };
        h.render({ clipBox });
        clipBox.enabled = false;
        assert.equal(h.renderer.hasActiveClipping(), true, 'query describes the rendered snapshot, not mutated options');
        h.render({ clipBox });
        assert.equal(h.renderer.hasActiveClipping(), false);
        await h.settle();
        h.renderer.destroy();
    });
});

// Ambient occlusion (#5384) is `visualEnhancement.contactShading`. These drive
// the real render() loop and read the encoded pass labels and the textures the
// frame allocates, so "AO ran at half resolution" is observed, not assumed.
describe('ambient occlusion post pass (#5384)', () => {
    const AO_PASSES = ['ao', 'ao-blur-h', 'ao-blur-v', 'ao-composite'];
    const aoFrame = (quality: 'off' | 'low' | 'high'): RenderOptions => ({
        visualEnhancement: {
            enabled: true,
            contactShading: { quality, intensity: 0.8, radius: 1 },
            separationLines: { enabled: false },
        },
    });
    const aoTargets = (h: Harness) => h.stats.textures.filter((t) => t.label === 'ao-target' || t.label === 'ao-scratch');

    it('encodes AO, a separable blur and the composite after the scene pass', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render(aoFrame('low'));
        const firstAo = h.stats.passes.indexOf('ao');
        assert.ok(firstAo > 0, `expected the AO passes after the scene pass, got ${JSON.stringify(h.stats.passes)}`);
        assert.deepStrictEqual(h.stats.passes.slice(firstAo, firstAo + 4), AO_PASSES);
    });

    it('works at half resolution on low and full resolution on high', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render(aoFrame('low'));
        assert.deepStrictEqual(
            aoTargets(h).map((t) => [t.width, t.height]),
            [[128, 128], [128, 128]],
            'the 256 px canvas gets 128 px AO and blur targets',
        );
        h.stats.textures.length = 0;
        h.render(aoFrame('high'));
        assert.deepStrictEqual(aoTargets(h).map((t) => [t.width, t.height]), [[256, 256], [256, 256]]);
        assert.ok(h.stats.destroyedTextures.includes('ao-target'), 'the half-resolution target is released on the switch');
    });

    it('allocates nothing while off and releases its targets when switched off', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render(aoFrame('off'));
        assert.ok(!h.stats.passes.includes('ao'), 'no AO pass while off');
        assert.deepStrictEqual(aoTargets(h), [], 'no AO targets while off');

        h.render(aoFrame('low'));
        assert.ok(h.stats.passes.includes('ao'));
        h.stats.passes.length = 0;
        h.render(aoFrame('off'));
        assert.ok(!h.stats.passes.includes('ao'), 'the toggle-off frame must not encode AO');
        assert.deepStrictEqual(
            h.stats.destroyedTextures.filter((l) => l === 'ao-target' || l === 'ao-scratch').sort(),
            ['ao-scratch', 'ao-target'],
            'toggle-off must release the screen-sized targets, not hold them for the session',
        );
    });

    it('keeps its targets across frames of the same size and quality', () => {
        const h = makeHarness();
        seedBatches(h);
        h.render(aoFrame('low'));
        h.render(aoFrame('low'));
        assert.strictEqual(aoTargets(h).length, 2, 'targets are created once, not per frame');
        assert.strictEqual(h.stats.passes.filter((l) => l === 'ao-composite').length, 2);
    });

    it('releases its targets when the renderer is destroyed', async () => {
        const h = makeHarness();
        seedBatches(h);
        h.render(aoFrame('low'));
        await h.settle();
        h.renderer.destroy();
        assert.deepStrictEqual(
            h.stats.destroyedTextures.filter((l) => l === 'ao-target' || l === 'ao-scratch').sort(),
            ['ao-scratch', 'ao-target'],
        );
    });
});

/**
 * #5623 review — the textured draw path called `packMeshMaterial(tpl)` with
 * neither the authored alpha nor `tm.material`, so every textured mesh
 * silently got the opaque-dielectric default no matter what it was authored
 * as. Fixed to `packMeshMaterial(tpl, tm.color[3], tm.material)`, matching
 * the flat/batched call sites. Asserted at the level that actually caught the
 * bug: the material row of the uniform buffer the real render() loop writes
 * for a textured draw, not the source text of the call site.
 */
describe('the textured draw path passes authored alpha and material to packMeshMaterial (#5623 review)', () => {
    function seedTextured(h: Harness, meshes: MeshData[]) {
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        const pipeline = h.renderer['pipeline'] as never;
        scene.appendToBatches(meshes, device, pipeline, false);
        return scene.getTexturedMeshes();
    }

    /** The material row (metallic, roughness, transmission flag) of the uniform written for `tm`. */
    function materialRowFor(h: Harness, target: unknown): number[] | null {
        const at = MESH_UNIFORM_OFFSET.metallicRoughness;
        const block = lastBlock(h, target, at + 4);
        return block ? [block[at], block[at + 1], block[at + 2]] : null;
    }

    it('gives an opaque textured mesh the default dielectric', () => {
        const h = makeHarness();
        const textured = seedTextured(h, [texturedTriangle(1)]);

        h.stats.writes.length = 0;
        h.render();

        const row = materialRowFor(h, textured[0].uniformBuffer);
        assert.ok(row, 'expected the textured draw to write the material row');
        assert.equal(row![1], Math.fround(0.9), 'roughness: default dielectric');
        assert.equal(row![2], 0, 'transmission flag: not glass');
    });

    it('gives a textured mesh with an authored translucent tint the glass roughness and transmission flag, not the opaque default', () => {
        const h = makeHarness();
        const mesh = texturedTriangle(1);
        mesh.color = [1, 1, 1, 0.4]; // translucent authored tint
        const textured = seedTextured(h, [mesh]);
        assert.strictEqual(textured.length, 1);

        h.stats.writes.length = 0;
        h.render();

        const row = materialRowFor(h, textured[0].uniformBuffer);
        assert.ok(row, 'expected the textured draw to write the material row');
        // Before the fix this was 0.9 / 0 (the opaque default), because
        // packMeshMaterial(tpl) never saw the authored alpha at all.
        assert.equal(row![1], Math.fround(0.05), 'roughness: expected GLASS_ROUGHNESS from the authored alpha');
        assert.equal(row![2], 1, 'transmission flag: expected glass from the authored alpha');
    });

    it('reads a material attached to the textured mesh, once one is set, the same way the flat/batched paths read mesh.material', () => {
        // Nothing wires this from MeshData yet (#5582: IFC-authored specular is
        // not extracted). This proves the DRAW PATH reads `tm.material` at
        // all — the exact argument the #5623 review found silently dropped —
        // independent of who eventually populates it.
        const h = makeHarness();
        const textured = seedTextured(h, [texturedTriangle(1)]);
        (textured[0] as { material?: unknown }).material = { baseColor: [1, 1, 1, 1], metallic: 0.8, roughness: 0.2 };

        h.stats.writes.length = 0;
        h.render();

        const row = materialRowFor(h, textured[0].uniformBuffer);
        assert.ok(row, 'expected the textured draw to write the material row');
        assert.equal(row![0], Math.fround(0.8), 'metallic override reaches the uniform');
        assert.equal(row![1], Math.fround(0.2), 'roughness override reaches the uniform');
    });
});

describe('colour overrides shade from the entity colour table, not overlay copies (#6076)', () => {
    const BLUE: [number, number, number, number] = [0.125, 0.25, 0.875, 1]; // f32-exact: the table stores f32
    const GREEN: [number, number, number, number] = [0.125, 0.875, 0.25, 1];

    /** overrideParams (x = anchor, y = mode bits) of the LAST uniform write into `buffer`. */
    function overrideLanes(h: Harness, target: unknown): number[] | null {
        const block = uniformBlocks(h, target).at(-1);
        if (!block) return null;
        return [...new Uint32Array(block.buffer, block.byteOffset + MESH_UNIFORM_OFFSET.overrideParams * 4, 4)];
    }

    /** The pipeline bound when the draw that used `vertexBuffer` fired. */
    function pipelineOfDraw(h: Harness, vertexBuffer: GPUBuffer): unknown {
        let pipeline: unknown = null;
        let draw = 0;
        for (const c of h.stats.commands) {
            if (c.op === 'setPipeline') pipeline = c.pipeline;
            if (c.op === 'drawIndexed' && h.stats.draws[draw++] === vertexBuffer) return pipeline;
        }
        return undefined;
    }

    function setOverrides(h: Harness, overrides: Map<number, [number, number, number, number]>): void {
        sceneOf(h).setColorOverrides(overrides, h.renderer['device'].getDevice(), h.renderer['pipeline']!);
    }

    it('allocates and uploads nothing but the table, and adds no draw calls', async () => {
        const { OVERRIDE_PARAM_PAINT, OVERRIDE_PARAM_EMPHASIZE } = await requireColorTable();
        const h = makeHarness();
        const { grey, red } = seedBatches(h);
        h.render();
        const baseline = h.renderer.getFrameStats()?.drawCalls;
        assert.ok(baseline !== undefined && baseline > 0, 'sanity: the batches drew');

        const createdBefore = h.stats.createdBuffers.length;
        h.stats.writes.length = 0;
        setOverrides(h, new Map([[1, BLUE], [3, BLUE]]));
        const created = h.stats.createdBuffers.slice(createdBefore);
        assert.equal(created.length, 1, 'no overlay vertex/index/uniform buffers');
        assert.equal(h.stats.writes.length, 1, 'one upload');

        h.stats.writes.length = 0;
        h.stats.commands.length = 0;
        h.stats.draws.length = 0;
        h.render();
        assert.equal(h.renderer.getFrameStats()?.drawCalls, baseline, 'the same draw calls as without overrides');
        const table = sceneOf(h).getEntityColorTable().getBuffer();
        assert.equal(created[0], table, 'the one allocation is the colour table');
        assert.equal(h.stats.boundColorTables.at(-1), table, 'the frame binds the scene table at group(1)');
        assert.deepEqual(overrideLanes(h, red.uniformSlot), [3, OVERRIDE_PARAM_PAINT, 0, 0], 'red batch paints from its anchor');
        assert.deepEqual(overrideLanes(h, grey.uniformSlot), [1, OVERRIDE_PARAM_PAINT, 0, 0], 'grey batch paints from its anchor');

        h.render({ emphasizeOverrides: true });
        assert.deepEqual(overrideLanes(h, red.uniformSlot), [3, OVERRIDE_PARAM_PAINT | OVERRIDE_PARAM_EMPHASIZE, 0, 0], 'emphasizeOverrides reaches the draw');
    });

    it('holds the colour at the entity slot, and clearing empties the table without touching a batch', async () => {
        const { lookupEntityColor } = await requireColorTable();
        const h = makeHarness();
        const { grey } = seedBatches(h);
        setOverrides(h, new Map([[2, GREEN]]));
        const image = sceneOf(h).getEntityColorTable().getImage();
        assert.deepEqual(lookupEntityColor(image, 2), GREEN);
        assert.equal(lookupEntityColor(image, 1), null);
        assert.equal(lookupEntityColor(image, 3), null);

        const createdBefore = h.stats.createdBuffers.length;
        h.stats.writes.length = 0;
        sceneOf(h).clearColorOverrides();
        assert.equal(h.stats.createdBuffers.length, createdBefore, 'clearing allocates nothing');
        const table = sceneOf(h).getEntityColorTable().getBuffer();
        assert.deepEqual(h.stats.writes.map((w) => w.buffer), [table], 'clearing rewrites only the table');
        assert.deepEqual([...new Uint32Array(h.stats.writes[0].floats.buffer)], [0, 0, 0, 0], 'header reset: count 0');
        assert.equal(lookupEntityColor(sceneOf(h).getEntityColorTable().getImage(), 2), null);

        h.stats.writes.length = 0;
        h.render();
        assert.deepEqual(overrideLanes(h, grey.uniformSlot), [1, 0, 0, 0], 'the entity anchor remains, with painting disabled after clearing');
    });

    it('keeps colour overrides available after CPU geometry is released (#6148 review)', async () => {
        const { lookupEntityColor, OVERRIDE_PARAM_PAINT } = await requireColorTable();
        const h = makeHarness();
        const { grey } = seedBatches(h);
        const scene = sceneOf(h);
        scene.releaseGeometryData();
        assert.equal(scene.isGeometryDataReleased(), true);

        setOverrides(h, new Map([[2, GREEN]]));
        assert.deepEqual(lookupEntityColor(scene.getEntityColorTable().getImage(), 2), GREEN);
        h.render();
        assert.deepEqual(overrideLanes(h, grey.uniformSlot), [1, OVERRIDE_PARAM_PAINT, 0, 0]);
    });

    it('paints a mesh that streams in AFTER the override without another setColorOverrides call', async () => {
        const { lookupEntityColor, OVERRIDE_PARAM_PAINT } = await requireColorTable();
        const h = makeHarness();
        seedBatches(h);
        setOverrides(h, new Map([[9, GREEN]]));
        const createdAfterOverride = h.stats.createdBuffers.length;
        const scene = sceneOf(h);
        scene.appendToBatches([triangle(9, [0.3, 0.3, 0.3, 1])], h.renderer['device'].getDevice(), h.renderer['pipeline']!, false);
        const late = scene.getBatchedMeshes().find((b) => b.expressIds.includes(9));
        assert.ok(late, 'sanity: the late mesh is batched');
        late.bounds = undefined;
        const table: unknown = scene.getEntityColorTable().getBuffer();
        assert.ok(
            h.stats.createdBuffers.slice(createdAfterOverride).every((b) => b !== table),
            'the table is not rebuilt for the late mesh',
        );

        h.stats.writes.length = 0;
        h.render();
        assert.deepEqual(overrideLanes(h, late.uniformSlot), [9, OVERRIDE_PARAM_PAINT, 0, 0]);
        assert.deepEqual(lookupEntityColor(scene.getEntityColorTable().getImage(), 9), GREEN);
    });

    it('paints entities of one bucket whose ids span 2^24, and still promotes them (#6076 review)', async () => {
        const { ENTITY_LANE_ID_SPAN, OVERRIDE_PARAM_PAINT, lookupEntityColor, resolveLaneEntityId } = await requireColorTable();
        // Same model, colour and cell: before page-keyed buckets these two
        // shared one batch whose ids span more than 2^24, the anchor was
        // refused, and both drew unpainted — while routing still promoted them.
        const h = makeHarness();
        const scene = sceneOf(h);
        const low = 10;
        const high = 10 + ENTITY_LANE_ID_SPAN + 100;
        const glass: [number, number, number, number] = [0.6, 0.8, 0.9, 0.4];
        scene.appendToBatches([triangle(low, glass), triangle(high, glass)], h.renderer['device'].getDevice(), h.renderer['pipeline']!, false);
        const batches = scene.getBatchedMeshes();
        for (const b of batches) b.bounds = undefined;
        setOverrides(h, new Map([[low, [1, 0, 0, 1]], [high, [1, 0, 0, 1]]]));
        h.render();
        for (const id of [low, high]) {
            const batch = batches.find((b) => b.expressIds.includes(id));
            assert.ok(batch, `batch for ${id}`);
            assert.deepEqual(overrideLanes(h, batch.uniformSlot), [Math.min(...batch.expressIds), OVERRIDE_PARAM_PAINT, 0, 0], `${id} paints`);
            assert.equal(resolveLaneEntityId(Math.min(...batch.expressIds), id & 0xFFFFFF), id, `${id} resolves to itself`);
            assert.deepEqual(lookupEntityColor(scene.getEntityColorTable().getImage(), id), [1, 0, 0, 1]);
            assert.equal(pipelineOfDraw(h, batch.vertexBuffer), OPAQUE_PIPELINE, `${id} is promoted to opaque`);
        }
    });

    for (const [label, finalize] of [
        ['finalizeStreaming', (s: Scene, d: GPUDevice, p: RenderPipeline) => { s.finalizeStreaming(d, p); }],
        ['finalizeStreamingAsync', (s: Scene, d: GPUDevice, p: RenderPipeline) => s.finalizeStreamingAsync(d, p)],
    ] as const) {
        it(`paints the batch ${label} installs after a mid-stream override, with no re-apply`, async () => {
            const { OVERRIDE_PARAM_PAINT } = await requireColorTable();
            const h = makeHarness();
            const scene = sceneOf(h);
            const device = h.renderer['device'].getDevice();
            const pipeline = h.renderer['pipeline']!;
            scene.appendToBatches([triangle(11, GREY), triangle(12, GREY)], device, pipeline, true);
            setOverrides(h, new Map([[12, GREEN]]));
            const table = scene.getEntityColorTable().getBuffer();
            await finalize(scene, device, pipeline);
            const finalBatch = scene.getBatchedMeshes().find((b) => b.expressIds.includes(12));
            assert.ok(finalBatch, 'finalized batch holds entity 12');
            finalBatch.bounds = undefined;
            assert.equal(scene.getEntityColorTable().getBuffer(), table, 'finalize does not touch the table');
            h.stats.writes.length = 0;
            h.render();
            assert.deepEqual(overrideLanes(h, finalBatch.uniformSlot), [11, OVERRIDE_PARAM_PAINT, 0, 0]);
        });
    }

    it('keeps the opaque promotion of a transparent entity with an override at alpha >= 0.2, and paints only there', async () => {
        const { OVERRIDE_PARAM_PAINT } = await requireColorTable();
        const h = makeHarness();
        const scene = sceneOf(h);
        const glass: [number, number, number, number] = [0.6, 0.8, 0.9, 0.4];
        scene.appendToBatches([triangle(4, glass), triangle(5, [0.2, 0.7, 0.3, 0.4])], h.renderer['device'].getDevice(), h.renderer['pipeline']!, false);
        const batches = scene.getBatchedMeshes();
        for (const b of batches) b.bounds = undefined;
        const promoted = batches.find((b) => b.expressIds.includes(4));
        const ghost = batches.find((b) => b.expressIds.includes(5));
        assert.ok(promoted && ghost && promoted !== ghost, 'sanity: two colour batches');

        // 0.5 is a deliberate colour: promoted to the opaque pipeline and painted.
        // 0.15 is ghost-tier: stays transparent, and a transparent draw never paints.
        setOverrides(h, new Map([[4, [1, 0, 0, 0.5]], [5, [1, 0, 0, 0.15]]]));
        h.render();
        assert.equal(pipelineOfDraw(h, promoted.vertexBuffer), OPAQUE_PIPELINE, 'alpha >= 0.2 override promotes to opaque');
        assert.deepEqual(overrideLanes(h, promoted.uniformSlot), [4, OVERRIDE_PARAM_PAINT, 0, 0]);
        assert.equal(pipelineOfDraw(h, ghost.vertexBuffer), TRANSPARENT_PIPELINE, 'ghost-tier override stays transparent');
        assert.deepEqual(overrideLanes(h, ghost.uniformSlot), [5, 0, 0, 0], 'a transparent draw keeps its entity anchor with painting disabled');
    });
});

/**
 * #5746: the derivative edge darkening in `main.wgsl.ts` read flags.z (enabled)
 * and flags.w (intensity x 1000) off every mesh uniform. It is gone, the edge
 * pass (#5385) is the one edge source, and the two lanes stay in the struct
 * only for layout. `edgeContrast` is still accepted, so a caller passing it
 * must not put anything back into those lanes on any draw path.
 */
describe('mesh uniforms leave the freed edge lanes zero (#5746)', () => {
    const FLAGS = MESH_UNIFORM_OFFSET.flags;

    /** flags as u32 for every write that landed on one of `buffers`. */
    function flagsWrittenTo(h: Harness, targets: Set<unknown>): Uint32Array[] {
        return [...targets].flatMap((t) => uniformBlocks(h, t))
            .filter((b) => b.length >= FLAGS + 4)
            .map((b) => new Uint32Array(b.buffer, b.byteOffset + FLAGS * 4, 4));
    }

    it('batched, selected-individual and textured draws write 0 to flags.z and flags.w with edgeContrast on', () => {
        const h = makeHarness();
        const { grey, red } = seedBatches(h);
        const scene = sceneOf(h);
        const device = h.renderer['device'].getDevice();
        scene.appendToBatches([texturedTriangle(9)], device, h.renderer['pipeline'] as never, false);
        const textured = scene.getTexturedMeshes();
        assert.strictEqual(textured.length, 1);

        h.stats.writes.length = 0;
        // Post passes stay off (the stub GPU has no textures for them); the
        // mesh uniforms are what the old edge block read.
        h.render({
            selectedId: 1,
            visualEnhancement: {
                enabled: true,
                edgeContrast: { enabled: true, intensity: 3 },
                contactShading: { quality: 'off' },
                separationLines: { enabled: false },
            },
        });

        const selected = scene.getMeshes().filter((m) => m.hydrated && m.expressId === 1);
        assert.strictEqual(selected.length, 1, 'selection hydrates an individual mesh');
        const buffers = new Set<unknown>([
            grey.uniformSlot, red.uniformSlot, textured[0].uniformBuffer, selected[0].uniformBuffer,
        ]);
        const flags = flagsWrittenTo(h, buffers);
        assert.ok(flags.length >= 4, `expected a uniform write per draw, got ${flags.length}`);
        // Positive control: the lanes are read at the right offset, because
        // the selected mesh's flags.x carries its selection bit.
        assert.ok(
            flagsWrittenTo(h, new Set([selected[0].uniformBuffer])).some((f) => (f[0] & 1) === 1),
            'selected mesh uniform carries flags.x bit 0',
        );
        for (const f of flags) {
            assert.strictEqual(f[2], 0, 'flags.z (was edgeEnabled) must stay 0');
            assert.strictEqual(f[3], 0, 'flags.w (was edgeIntensityMilli) must stay 0');
        }
    });
});

/**
 * Opaque draws pick the discard-free / no-object-id twin only on frames where
 * it draws the same pixels (opaque-draw-variants.ts): no clipping of any kind,
 * and the object id only while the edge pass reads it.
 */
describe('per-frame opaque draw mode', () => {
    type Mode = { discardFree: boolean; objectId: boolean };
    function recordModes(h: Harness): { kind: string; mode: Mode }[] {
        const modes: { kind: string; mode: Mode }[] = [];
        const stub = h.renderer['pipeline'] as unknown as Record<string | symbol, unknown>;
        (h.renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy(stub, {
            get(target, prop) {
                if (prop === 'opaquePipeline') return (kind: string, mode: Mode) => { modes.push({ kind, mode }); return OPAQUE_PIPELINE; };
                return Reflect.get(target, prop);
            },
        });
        return modes;
    }

    it('an unclipped perspective frame without edges asks for the discard-free twin without object-id writes', () => {
        const h = makeHarness();
        seedBatches(h);
        const modes = recordModes(h);
        h.render();
        assert.ok(modes.length >= 2, 'both colour batches resolve their pipeline');
        for (const { kind, mode } of modes) {
            assert.strictEqual(kind, 'flat');
            assert.deepStrictEqual(mode, { discardFree: true, objectId: false });
        }
    });

    it('a section plane, clip box or terrain clip keeps the discards', () => {
        const box = { enabled: true, min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
        for (const clip of [
            { sectionPlane: { enabled: true, axis: 'down', position: 50 } },
            { clipBox: box },
            { terrainClipY: 0 },
        ] as RenderOptions[]) {
            const h = makeHarness();
            seedBatches(h);
            const modes = recordModes(h);
            h.render(clip);
            assert.ok(modes.length > 0);
            assert.ok(modes.every(({ mode }) => !mode.discardFree), JSON.stringify(clip));
        }
    });
});

describe('the GPU picker allocates on its first pick', () => {
    it('holds no id/depth targets or 100K mesh slots until a pick, then sizes them to it', async () => {
        const h = makeHarness();
        const texturesBefore = h.stats.textures.length;
        const picker = new Picker(h.renderer['device'], 256, 256);
        assert.strictEqual(h.stats.textures.length, texturesBefore, 'construction allocates no texture');
        assert.deepStrictEqual(picker.renderTargets(), [null, null]);
        assert.ok(!h.stats.createdBuffers.some((b) => b.size >= 1024 * 1024), 'no megabyte-scale slot buffer up front');

        (h.renderer as unknown as Record<string, unknown>)['picker'] = picker;
        h.renderer['pickingManager'].setPicker(picker);
        await h.renderer.pick(10, 10);
        const pickTextures = h.stats.textures.slice(texturesBefore).filter((t) => t.label.startsWith('pick-'));
        assert.deepStrictEqual(pickTextures.map((t) => [t.label, t.width, t.height]), [['pick-id', 256, 256], ['pick-depth', 256, 256]]);
        assert.ok(picker.renderTargets().every((t) => t !== null));

        await h.renderer.pick(20, 20);
        assert.strictEqual(h.stats.textures.filter((t) => t.label.startsWith('pick-')).length, 2, 'a same-size pick reuses them');
    });
});

// #8564 option B: the nearest-glass split driven through the REAL renderFrame. The stub
// pass log shows where transparent IFC draws: held out of the main pass, replayed
// depth-only for P1 and the layer count, and drawn between the two splat passes.
describe('#8564 nearest-glass split in the render loop', () => {
    const GLASS: [number, number, number, number] = [0.2, 0.4, 0.8, 0.5];
    const glassDescriptor = {
        layout: {}, vertex: { module: {}, entryPoint: 'vs_main' },
        fragment: { module: {}, entryPoint: 'fs_main', targets: [{ format: 'bgra8unorm' }, { format: 'rgba8unorm' }] },
        depthStencil: { format: 'depth24plus-stencil8', depthWriteEnabled: false, depthCompare: 'greater' }, multisample: { count: 1 },
    } as unknown as GPURenderPipelineDescriptor;

    async function splitHarness(options: { transparent?: boolean; splats?: boolean; depthInterval?: boolean } = {}) {
        const h = makeHarness();
        const fields = h.renderer as unknown as Record<string, unknown>;
        fields.ready = true;
        const stub = fields.pipeline as Record<string, unknown>;
        fields.pipeline = new Proxy(stub, { get: (target, key) => key === 'getDepthFormat' ? () => 'depth24plus-stencil8' : Reflect.get(target, key) });
        (stub.visibility as OpaqueVisibilityPass).register(TRANSPARENT_PIPELINE as unknown as GPURenderPipeline, glassDescriptor, mainShaderSource);
        const layer = fields.gaussianLayer as Record<string, unknown>;
        (layer.slot as Record<string, unknown>).createBackend = async (): Promise<GaussianBackend> => ({
            upstreamReverseZ: true, upstreamDepthInterval: options.depthInterval ?? true,
            createScene: () => ({ gpuBytes: 64, async replaceSource() {}, updateRows() {}, setFilter() {}, destroy() {},
                encode: (_target, _camera, interval) => { h.stats.commands.push({ op: `splats:${interval?.compare ?? 'all'}` }); } }),
        });
        const passes = h.stats.passes;
        const push = passes.push.bind(passes);
        passes.push = (...labels: string[]) => { for (const label of labels) h.stats.commands.push({ op: `pass:${label}` }); return push(...labels); };
        const scene = sceneOf(h);
        scene.appendToBatches([triangle(1, GREY), ...(options.transparent === false ? [] : [triangle(2, GLASS)])], h.renderer['device'].getDevice(), h.renderer['pipeline'] as never, false);
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;
        if (options.splats !== false) {
            const attributes = {
                count: 1, positions: new Float32Array([0, 0, 0]), scales: new Float32Array([1, 1, 1]),
                rotations: new Float32Array([1, 0, 0, 0]), colors: new Float32Array([1, 0, 0, 1]),
                opacities: new Float32Array([1]), sphericalHarmonics: new Float32Array(), sphericalHarmonicsDegree: 0 as const,
            };
            await h.renderer.gaussianSplats.add({ attributes, placement: { matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }, modelIndex: 0 }, { qualification: 'internal-unqualified' });
        }
        const named = (pipeline: unknown) => (pipeline as { label?: string } | undefined)?.label;
        const frame = (options: RenderOptions = {}) => { h.stats.commands.length = 0; h.render(options); return h.stats.commands.map((c) => c.op === 'setPipeline'
            ? (c.pipeline === TRANSPARENT_PIPELINE ? 'glass' : c.pipeline === OPAQUE_PIPELINE ? 'opaque' : ['overlay', 'reference-image'].includes(named(c.pipeline) ?? '') ? named(c.pipeline)! : 'variant')
            : c.op).filter((op) => op !== 'setBindGroup'); };
        const report = () => h.renderer.gaussianSplats.getStats().compositionReport;
        const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
        return { h, frame, report, tick };
    }
    /** The ops from the main pass's first draw to its end, i.e. before any Gaussian pass. */
    const mainPass = (ops: string[]) => ops.slice(0, ops.findIndex((op) => op.startsWith('pass:ifc-lite-gaussian') || op.startsWith('splats:')));

    it('splits a splat frame around transparent IFC once the depth-only variants exist', async () => {
        const { h, frame, report, tick } = await splitHarness();
        try {
            const first = frame();
            assert.ok(mainPass(first).includes('glass'), 'while compiling, transparent IFC draws in the main pass as before');
            assert.deepEqual(first.filter((op) => op.startsWith('splats:')), ['splats:all']);
            assert.equal(report()?.composition, 'over-transparent-approximate');
            assert.equal(report()?.fallback, 'pipelines-compiling');
            await tick();
            const ops = frame();
            assert.ok(!mainPass(ops).includes('glass'), 'transparent IFC is held out of the main pass');
            const at = (op: string) => ops.indexOf(op);
            assert.deepEqual(['pass:ifc-lite-gaussian-nearest-transparent', 'pass:ifc-lite-gaussian-transparent-layers', 'splats:less-equal', 'pass:ifc-lite-gaussian-transparent', 'splats:greater'].map(at).every((index, i, all) => index >= 0 && (i === 0 || index > all[i - 1])), true, ops.join(' '));
            assert.deepEqual(ops.slice(at('pass:ifc-lite-gaussian-nearest-transparent') + 1, at('pass:ifc-lite-gaussian-transparent-layers')), ['variant', 'drawIndexed'], 'P1 replays the glass draw depth-only');
            assert.deepEqual(ops.slice(at('pass:ifc-lite-gaussian-transparent') + 1, at('splats:greater')), ['glass', 'drawIndexed'], 'the held draw replays between the splat passes');
            assert.equal(report()?.composition, 'nearest-glass-split');
            assert.equal(report()?.transparentLayers, 'unknown');
            await tick();
            assert.equal(report()?.transparentLayers, 'single', 'the frame\'s own occlusion count read back as zero and was published');
            assert.equal(h.renderer.getDiagnostics().errors, 0);
        } finally {
            h.renderer.destroy();
            await h.settle();
        }
    });

    it('keeps the single splat pass, unchanged, without transparent IFC', async () => {
        const { h, frame, report, tick } = await splitHarness({ transparent: false });
        try {
            frame();
            await tick();
            const ops = frame();
            assert.ok(!ops.some((op) => op.startsWith('pass:ifc-lite-gaussian')));
            assert.deepEqual(ops.filter((op) => op.startsWith('splats:')), ['splats:all']);
            assert.equal(report()?.composition, 'no-transparent');
        } finally {
            h.renderer.destroy();
            await h.settle();
        }
    });

    /** Spy every pass descriptor, texture and pipeline compile of the stub device. */
    function spyDevice(h: Harness) {
        const wdev = h.renderer['device'] as unknown as Record<string, unknown>;
        const raw = wdev['device'] as Record<string, unknown>;
        const spy = { passes: [] as GPURenderPassDescriptor[], textures: [] as string[], compiles: 0, querySets: 0 };
        wdev['device'] = new Proxy(raw, { get: (target, key) => {
            const member = Reflect.get(target, key) as (...args: unknown[]) => unknown;
            if (key === 'createCommandEncoder') return () => new Proxy(member() as Record<string, unknown>, { get: (encoder, method) => method === 'beginRenderPass'
                ? (d: GPURenderPassDescriptor) => { spy.passes.push(d); return (encoder.beginRenderPass as (d: unknown) => unknown)(d); } : Reflect.get(encoder, method) });
            if (key === 'createTexture') return (d: GPUTextureDescriptor) => { spy.textures.push(d.label ?? ''); return member(d); };
            if (key === 'createRenderPipelineAsync') return (d: unknown) => { spy.compiles++; return member(d); };
            if (key === 'createQuerySet') return (d: unknown) => { spy.querySets++; return member(d); };
            return member;
        } });
        return spy;
    }

    // #8564 review: IFC-only scenes must provably pay nothing for the split.
    for (const scene of ['no splats', 'hidden splats'] as const) {
        it(`records no extra pass, attachment, texture, query or pipeline with ${scene}`, async () => {
            const { h, frame } = await splitHarness({ splats: scene === 'hidden splats' });
            try {
                if (scene === 'hidden splats') {
                    const layer = (h.renderer as unknown as Record<string, unknown>).gaussianLayer as { records: Map<unknown, { handle: unknown }> };
                    assert.equal(layer.records.size, 1, 'a resident asset exists, only hidden');
                    for (const record of layer.records.values()) h.renderer.gaussianSplats.setVisible(record.handle as never, false);
                }
                const spy = spyDevice(h);
                for (let i = 0; i < 3; i++) {
                    const ops = frame();
                    assert.ok(mainPass(ops).includes('glass') && ops.indexOf('glass') > ops.indexOf('opaque'), 'transparent IFC draws in the main pass');
                    assert.ok(!ops.some((op) => op.startsWith('pass:ifc-lite-gaussian') || op.startsWith('splats:')));
                    await new Promise((resolve) => setTimeout(resolve, 0));
                }
                assert.deepEqual(spy.passes.filter((d) => d.label?.startsWith('ifc-lite-gaussian')), []);
                const main = spy.passes.filter((d) => d.colorAttachments.length === 2);
                assert.equal(main.length, 3, 'one main pass per frame');
                for (const d of main) {
                    const [colour, ids] = d.colorAttachments as GPURenderPassColorAttachment[];
                    assert.equal(colour.loadOp, 'clear');
                    assert.equal(colour.storeOp, 'store', 'the stub has no MSAA, so the swapchain is stored as before');
                    assert.equal(ids.loadOp, 'clear');
                    assert.equal(d.depthStencilAttachment?.stencilStoreOp, 'discard');
                }
                assert.deepEqual(spy.textures.filter((label) => label.includes('gaussian')), []);
                assert.equal(spy.compiles, 0, 'no depth-only variant compiles');
                assert.equal(spy.querySets, 0);
                const layer = (h.renderer as unknown as Record<string, unknown>).gaussianLayer as { glass: { split: unknown } };
                assert.equal(layer.glass.split, null, 'the split never allocated its per-device state');
            } finally {
                h.renderer.destroy();
                await h.settle();
            }
        });
    }

    for (const [why, setup] of [
        ['single-pass-mode', (h: Harness) => h.renderer.gaussianSplats.setCompositionMode('single-pass')],
        ['upstream-interval-missing', () => {}],
    ] as const) {
        it(`reports ${why} and composites over transparent IFC in one pass`, async () => {
            const { h, frame, report, tick } = await splitHarness({ depthInterval: why !== 'upstream-interval-missing' });
            try {
                setup(h);
                frame();
                await tick();
                const ops = frame();
                assert.ok(mainPass(ops).includes('glass'));
                assert.deepEqual(ops.filter((op) => op.startsWith('splats:') || op.startsWith('pass:ifc-lite-gaussian')), ['splats:all']);
                assert.equal(report()?.composition, 'over-transparent-approximate');
                assert.equal(report()?.fallback, why);
            } finally {
                h.renderer.destroy();
                await h.settle();
            }
        });
    }

    it('#8564 review F3: split frames draw reference images and overlays after transparent IFC and before the splats in front, as single passes do', async () => {
        const { h, frame, report, tick } = await splitHarness();
        const fields = h.renderer as unknown as Record<string, Record<string, unknown>>;
        const drawsWith = (label: string) => (pass: GPURenderPassEncoder) => { pass.setPipeline({ label } as unknown as GPURenderPipeline); pass.draw(3); };
        fields.referenceImages.draw = drawsWith('reference-image');
        fields.overlays.draw = drawsWith('overlay');
        try {
            frame();
            await tick();
            const ops = frame();
            const at = (op: string, from = 0) => ops.indexOf(op, from);
            const glassPass = at('pass:ifc-lite-gaussian-transparent');
            assert.ok(glassPass > 0 && !mainPass(ops).includes('overlay') && !mainPass(ops).includes('reference-image'), ops.join(' '));
            assert.deepEqual(ops.slice(glassPass + 1, at('splats:greater')), ['glass', 'drawIndexed', 'reference-image', 'draw', 'overlay', 'draw'],
                'glass, then reference images and overlays in their established order, then the splats in front');
            assert.ok(at('splats:less-equal') < glassPass);
            assert.equal(report()?.composition, 'nearest-glass-split');
            assert.equal(report()?.laterOverBehindSplats, true, 'drawing them after the splats behind the glass is disclosed');
            h.renderer.gaussianSplats.setCompositionMode('single-pass');
            const single = frame();
            assert.deepEqual(single.filter((op) => ['glass', 'reference-image', 'overlay', 'splats:all'].includes(op)), ['glass', 'reference-image', 'overlay', 'splats:all'],
                'the single pass has the same relative order');
        } finally {
            h.renderer.destroy();
            await h.settle();
        }
    });
});

// #8564 review (Codex on 372b9ec): established draw order is preserved.
describe('#8564 review: draw order around transparent IFC', () => {
    it('#8564 review F2: IFC-only frames draw transparent partial batches where they always did, before selection hydration and transparent instances', () => {
        const h = makeHarness();
        const scene = sceneOf(h);
        const glassColour: [number, number, number, number] = [0.2, 0.4, 0.8, 0.5];
        scene.appendToBatches([triangle(1, GREY), triangle(2, GREY), triangle(3, glassColour), triangle(4, glassColour)], h.renderer['device'].getDevice(), h.renderer['pipeline'] as never, false);
        for (const b of scene.getBatchedMeshes()) b.bounds = undefined;
        const hydrate = h.renderer.createMeshFromData.bind(h.renderer);
        h.renderer.createMeshFromData = (piece) => { h.stats.commands.push({ op: 'hydrate' }); return hydrate(piece); };
        try {
            h.stats.commands.length = 0;
            h.render({ hiddenIds: new Set([4]), selectedId: 1 }); // glass {3,4} with 4 hidden: one transparent sub-batch
            const ops = h.stats.commands.map((c) => c.op === 'setPipeline' && c.pipeline === TRANSPARENT_PIPELINE ? 'glass' : c.op);
            const glass = ops.indexOf('glass'), hydration = ops.indexOf('hydrate');
            assert.ok(glass >= 0 && hydration >= 0, ops.join(' '));
            assert.equal(ops[glass + 1], 'setBindGroup');
            assert.ok(ops.indexOf('drawIndexed', glass) < hydration, `transparent sub-batch draws before selection hydration, as at 750b33165a: ${ops.join(' ')}`);
        } finally {
            h.renderer.destroy();
        }
    });

});
