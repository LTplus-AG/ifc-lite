/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { describe, it, mock } from 'node:test';
import assert from 'node:assert';
import { Renderer } from './index.js';
import { Picker } from './picker.js';
import type { MeshData, RenderOptions, BatchedMesh } from './types.js';

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
(globalThis as Record<string, unknown>).GPUTextureUsage = {
    COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16,
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
        /** vertex buffer bound at slot 0 when each drawIndexed fired */
        draws: unknown[];
        createdBuffers: FakeBuffer[];
        /** how many times a readback buffer was actually mapped */
        mapAsync: number;
    };
    knobs: {
        /** 'texture' = getCurrentTexture succeeds; 'null' = returns null */
        textureMode: 'texture' | 'null';
        /** make command encoding throw (mid-encode device fault) */
        encodeThrows: boolean;
        /** make popErrorScope() reject (device lost while scope pending) */
        popRejects: boolean;
        /**
         * The GPU device behind the stub is gone (destroyed by us, or lost to a
         * driver reset / GPU-process crash). Set automatically by
         * `device.destroy()`; set by hand to model an involuntary loss, where
         * the device object stays wired up but every map rejects.
         */
        gpuDead: boolean;
    };
    render(options?: RenderOptions): void;
    /** flush the popErrorScope() promise chains */
    settle(): Promise<void>;
}

function makeHarness(): Harness {
    const stats: Harness['stats'] = { push: 0, pop: 0, draws: [], createdBuffers: [], mapAsync: 0 };
    const knobs: Harness['knobs'] = {
        textureMode: 'texture', encodeThrows: false, popRejects: false, gpuDead: false,
    };

    const makeBuffer = (desc: { size: number }): FakeBuffer => {
        const buf: FakeBuffer & { _ab: ArrayBuffer } = {
            size: desc.size,
            destroyed: 0,
            _ab: new ArrayBuffer(desc.size),
            getMappedRange() { return this._ab; },
            mapAsync() {
                stats.mapAsync++;
                // Same failure mode as the browser: a map issued against a dead
                // device rejects rather than resolving.
                return knobs.gpuDead
                    ? Promise.reject(new DOMException(MAP_ASYNC_ABORT, 'AbortError'))
                    : Promise.resolve();
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
            if (prop === 'drawIndexed') {
                return () => { stats.draws.push(boundVertexBuffer); };
            }
            return () => undefined;
        },
    });

    const encoder = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            if (prop === 'beginRenderPass') {
                return () => {
                    if (knobs.encodeThrows) throw new Error('boom mid-encode');
                    return pass;
                };
            }
            if (prop === 'finish') return () => ({});
            return () => undefined;
        },
    });

    const queue = {
        writeBuffer() { /* no-op */ },
        submit() { /* no-op */ },
        onSubmittedWorkDone() { return Promise.resolve(); },
    };
    const fakeGpuDevice = new Proxy({} as Record<string | symbol, unknown>, {
        get(_t, prop) {
            switch (prop) {
                case 'limits': return { maxTextureDimension2D: 8192, maxBufferSize: 256 * 1024 * 1024 };
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
                case 'createTexture': return (desc: { size: { width: number; height: number } }) => ({
                    width: desc.size.width,
                    height: desc.size.height,
                    createView: () => ({}),
                    destroy() { /* no-op */ },
                });
                // Picker builds real pipelines in its constructor and binds
                // through the auto layout, so both arms must return objects.
                case 'createShaderModule': return () => ({});
                case 'createRenderPipeline': return () => ({ getBindGroupLayout: () => ({}) });
                case 'destroy': return () => { knobs.gpuDead = true; };
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
    // Permissive pipeline stub: draw-state getters return inert objects,
    // sizing predicates return stable values, everything else no-ops.
    (renderer as unknown as Record<string, unknown>)['pipeline'] = new Proxy(
        {} as Record<string | symbol, unknown>,
        {
            get(_t, prop) {
                switch (prop) {
                    case 'needsResize': return () => false;
                    case 'getSampleCount': return () => 1;
                    case 'getMultisampleTextureView': return () => null;
                    case 'getUniformBufferSize': return () => 240;
                    case 'getQuantizedPipelineVariant': return () => null;
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
    };
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
    const scene = h.renderer.getScene();
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
        const scene = h.renderer.getScene();
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
        const scene = h.renderer.getScene();

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

describe('hydrated selection meshes across renders', () => {
    it('selection thrash: earlier selections are disposed, the current one is kept', () => {
        const h = makeHarness();
        seedBatches(h);
        const scene = h.renderer.getScene();

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
        const scene = h.renderer.getScene();
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
        assert.strictEqual(h.stats.mapAsync, 2, 'pick() maps the colour + depth readbacks');

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
